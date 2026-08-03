import { createHash, randomUUID } from 'node:crypto';
import type { HostConfig } from './config.js';
import type { AgentSession, ChannelAdapter } from './contracts.js';
import type { AdmittedEvent, Conversation, Decision, DecisionRun } from './types.js';
import type { Store } from './store.js';
import { delay } from './process-utils.js';
import { fetchRecentGroupHistory, type RecentGroupHistory } from './dws.js';
import { PRODUCT_ID } from './product.js';
import { batchPrompt, groupOnboardingPrompt } from './prompts.js';

export class ConversationWorker {
  readonly workerId = randomUUID();
  private draining: Promise<void> | null = null;
  private started = false;
  private closed = false;
  private signalGeneration = 0;
  private lastSignalAtMs = 0;
  private turnActive = false;
  private cancelRequested = false;

  constructor(
    private readonly config: HostConfig,
    readonly conversation: Conversation,
    private readonly session: AgentSession,
    private readonly store: Store,
    private readonly sender: Pick<ChannelAdapter, 'send'>,
    private readonly log: (record: Record<string, unknown>) => void,
    private readonly onIdle: (worker: ConversationWorker) => void = () => undefined,
    private readonly loadGroupHistory: (conversation: Conversation) => Promise<RecentGroupHistory>
      = (target) => fetchRecentGroupHistory(config, target),
  ) {}

  get processId(): number | null {
    return this.session.processId;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const now = new Date().toISOString();
    this.store.setWorkerState({
      conversationId: this.conversation.id,
      workerId: this.workerId,
      runtimeId: this.conversation.runtimeId,
      state: 'starting',
      processId: null,
      startedAt: now,
    });
    try {
      let history: RecentGroupHistory | null = null;
      if (this.conversation.kind === 'group') {
        const onboarding = this.store.getGroupOnboarding(this.conversation.id);
        if (!onboarding) throw new Error(`群 onboarding 状态不存在：${this.conversation.id}`);
        if (!onboarding.introText) history = await this.loadGroupHistory(this.conversation);
      }
      await this.session.start();
      if (this.conversation.kind === 'group') await this.onboardGroup(history);
      this.started = true;
      this.store.setWorkerState({
        conversationId: this.conversation.id,
        workerId: this.workerId,
        runtimeId: this.conversation.runtimeId,
        state: 'warm',
        processId: this.session.processId,
        claimedFromSequence: null,
        claimedToSequence: null,
        startedAt: now,
      });
      this.log({
        type: 'WORKER_READY', conversationId: this.conversation.id, workerIdPrefix: this.workerId.slice(0, 8),
        runtimeId: this.conversation.runtimeId, processId: this.session.processId,
        providerSessionPrefix: this.session.currentSessionId?.slice(0, 12) ?? null,
      });
    } catch (error) {
      this.store.setWorkerState({
        conversationId: this.conversation.id,
        workerId: this.workerId,
        runtimeId: this.conversation.runtimeId,
        state: 'error',
        processId: this.session.processId,
        error: (error as Error).message,
        startedAt: now,
      });
      throw error;
    }
  }

  private async onboardGroup(history: RecentGroupHistory | null): Promise<void> {
    let onboarding = this.store.getGroupOnboarding(this.conversation.id);
    if (!onboarding) throw new Error(`群 onboarding 状态不存在：${this.conversation.id}`);
    if (!onboarding.introText) {
      if (!history) throw new Error('群 onboarding 缺少最近消息上下文');
      const current = this.store.getConversation(this.conversation.id);
      if (!current) throw new Error(`conversation 不存在：${this.conversation.id}`);
      const result = await this.session.runDecision(groupOnboardingPrompt(this.config, current, history));
      if (
        result.status !== 'completed'
        || result.decision?.action !== 'reply'
        || result.decision.workType !== 'discussion'
        || result.decision.delegation !== 'not_required'
      ) {
        throw new Error('群 onboarding 未生成纯讨论型自我介绍');
      }
      onboarding = this.store.prepareGroupOnboarding(
        this.conversation.id,
        history.count,
        result.turnId,
        result.decision.replyText,
        deterministicOnboardingUuid(this.conversation),
      );
      this.log({
        type: 'GROUP_ONBOARDING_PREPARED', conversationId: this.conversation.id,
        historyCount: history.count, introTurnIdPrefix: result.turnId.slice(0, 12),
      });
    }
    if (onboarding.state === 'submitted') return;
    if (this.conversation.mode !== 'reply') {
      this.log({ type: 'GROUP_ONBOARDING_DEFERRED', conversationId: this.conversation.id, reason: 'shadow-mode' });
      return;
    }
    const claimed = this.store.claimGroupOnboardingIntro(this.conversation.id);
    if (!claimed) return;
    if (!claimed.introText || !claimed.introUuid) throw new Error('群 onboarding 发送记录不完整');
    try {
      await this.sender.send(this.conversation, { text: claimed.introText, uuid: claimed.introUuid });
      this.store.finishGroupOnboardingIntro(this.conversation.id, 'submitted', null);
      this.log({ type: 'GROUP_ONBOARDING_SUBMITTED', conversationId: this.conversation.id });
    } catch (error) {
      this.store.finishGroupOnboardingIntro(this.conversation.id, 'failed', (error as Error).message);
      this.log({ type: 'GROUP_ONBOARDING_FAILED', conversationId: this.conversation.id, error: (error as Error).message });
    }
  }

  signal(): void {
    if (this.closed) throw new Error('conversation worker 已关闭');
    this.signalGeneration += 1;
    this.lastSignalAtMs = Date.now();
    this.store.setWorkerState({
      conversationId: this.conversation.id,
      workerId: this.workerId,
      runtimeId: this.conversation.runtimeId,
      state: this.draining ? 'running' : 'warm',
      processId: this.session.processId,
      lastSignalAt: new Date(this.lastSignalAtMs).toISOString(),
    });
    if (this.draining) {
      if (this.turnActive && !this.cancelRequested) {
        this.cancelRequested = true;
        void this.session.interruptActive()
          .then((interrupted) => {
            if (interrupted) this.log({ type: 'TURN_CANCEL_REQUESTED', conversationId: this.conversation.id });
          })
          .catch((error) => this.onError(error as Error, []));
      }
      return;
    }
    this.startDrain();
  }

  isBusy(): boolean {
    return this.draining !== null || Boolean(this.session.hasBackgroundWork?.());
  }

  private startDrain(): void {
    this.draining = this.drain().finally(() => {
      this.draining = null;
      if (!this.closed && this.store.pendingEventCount(this.conversation.id) > 0) this.startDrain();
      else if (!this.closed) this.onIdle(this);
    });
  }

  private async drain(): Promise<void> {
    while (!this.closed) {
      await this.waitForQuietWindow();
      const claimedGeneration = this.signalGeneration;
      const events = this.store.claimPendingEvents(
        this.conversation,
        this.workerId,
        this.config.scheduling.maxBatchMessages,
        Date.now(),
        Math.max(300_000, this.config.runtime.turnTimeoutSeconds * 2_000),
      );
      if (events.length === 0) break;
      const first = events[0]!.sequence;
      const last = events.at(-1)!.sequence;
      this.store.setWorkerState({
        conversationId: this.conversation.id,
        workerId: this.workerId,
        runtimeId: this.conversation.runtimeId,
        state: 'running',
        processId: this.session.processId,
        claimedFromSequence: first,
        claimedToSequence: last,
      });
      try {
        this.cancelRequested = false;
        this.turnActive = true;
        let result: DecisionRun;
        try {
          result = await this.session.runDecision(
            batchPrompt(events, this.store.findRelevantMembers(this.conversation.id, events)),
            () => this.signalGeneration > claimedGeneration,
          );
        } finally {
          this.turnActive = false;
        }
        if (result.status === 'interrupted') {
          this.store.releaseClaimedEvents(events, this.workerId);
          this.log({
            type: 'BATCH_INTERRUPTED', conversationId: this.conversation.id,
            fromSequence: first, toSequence: last, turnIdPrefix: result.turnId.slice(0, 12),
          });
          continue;
        }
        this.store.recordBatchDecision(
          events,
          this.workerId,
          result.turnId,
          'completed',
          result.decision,
          result.subagentThreadId,
        );
        this.log({
          type: 'BATCH_COMPLETED', conversationId: this.conversation.id,
          fromSequence: first, toSequence: last, count: events.length,
          action: result.decision?.action ?? null,
        });
        if (result.decision) await this.handleDecision(events.at(-1)!, result.decision);
      } catch (error) {
        this.store.recordBatchDecision(events, this.workerId, null, 'failed', null);
        this.onError(error as Error, events);
        break;
      }
    }
    if (!this.closed) {
      this.store.setWorkerState({
        conversationId: this.conversation.id,
        workerId: this.workerId,
        runtimeId: this.conversation.runtimeId,
        state: 'warm',
        processId: this.session.processId,
        claimedFromSequence: null,
        claimedToSequence: null,
      });
    }
  }

  private async waitForQuietWindow(): Promise<void> {
    if (this.config.scheduling.quietWindowMilliseconds === 0) return;
    while (!this.closed) {
      const generation = this.signalGeneration;
      const remaining = this.lastSignalAtMs + this.config.scheduling.quietWindowMilliseconds - Date.now();
      if (remaining > 0) await delay(remaining);
      if (generation === this.signalGeneration) return;
    }
  }

  private async handleDecision(event: AdmittedEvent, decision: Decision): Promise<void> {
    const current = this.store.getConversation(this.conversation.id);
    if (!current?.enabled || current.mode !== 'reply' || decision.action !== 'reply') return;
    const record = this.store.enqueueOutbox(event, decision.replyText, deterministicUuid(event));
    if (!record) {
      this.log({ type: 'OUTBOX_SUPPRESSED', conversationId: this.conversation.id, sequence: event.sequence, reason: 'newer-message-admitted' });
      return;
    }
    const claimed = this.store.claimOutboxIfFresh(record.id);
    if (!claimed) return;
    try {
      await this.sender.send(this.conversation, claimed);
      this.store.finishOutbox(claimed.id, 'submitted', null);
      this.log({ type: 'OUTBOX_SUBMITTED', conversationId: this.conversation.id, sequence: event.sequence, uuid: claimed.uuid });
    } catch (error) {
      this.store.finishOutbox(claimed.id, 'failed', (error as Error).message);
      this.log({ type: 'OUTBOX_FAILED', conversationId: this.conversation.id, sequence: event.sequence, error: (error as Error).message });
    }
  }

  private onError(error: Error, events: AdmittedEvent[]): void {
    this.store.setWorkerState({
      conversationId: this.conversation.id,
      workerId: this.workerId,
      runtimeId: this.conversation.runtimeId,
      state: 'error',
      processId: this.session.processId,
      claimedFromSequence: null,
      claimedToSequence: null,
      error: error.message,
    });
    this.log({
      type: 'WORKER_ERROR', conversationId: this.conversation.id,
      sequences: events.map((event) => event.sequence), error: error.message,
    });
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.session.interruptActive().catch(() => false);
    await this.draining?.catch(() => undefined);
    await this.session.stop();
    this.store.setWorkerState({
      conversationId: this.conversation.id,
      workerId: null,
      runtimeId: this.conversation.runtimeId,
      state: 'stopped',
      processId: null,
      claimedFromSequence: null,
      claimedToSequence: null,
    });
  }
}

function deterministicUuid(event: AdmittedEvent): string {
  const hex = createHash('sha256').update(`${PRODUCT_ID}:${event.fingerprint}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function deterministicOnboardingUuid(conversation: Conversation): string {
  const hex = createHash('sha256').update(`${PRODUCT_ID}:onboarding:${conversation.channelId}:${conversation.channelProfileId}:${conversation.externalId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
