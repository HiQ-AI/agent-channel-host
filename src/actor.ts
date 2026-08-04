import { createHash, randomUUID } from 'node:crypto';
import type { HostConfig } from './config.js';
import type { AgentSession } from './contracts.js';
import type { AdmittedEvent, Conversation, NormalizedEvent } from './types.js';
import type { Store } from './store.js';
import { delay } from './process-utils.js';
import { fetchRecentGroupHistory, type RecentGroupHistory } from './dws.js';
import { batchPrompt } from './prompts.js';

export class ConversationWorker {
  readonly workerId = randomUUID();
  private draining: Promise<void> | null = null;
  private started = false;
  private closed = false;
  private blockedAfterError = false;
  private signalGeneration = 0;
  private lastSignalAtMs = 0;
  private activeEvents: AdmittedEvent[] | null = null;
  private steering: Promise<void> | null = null;
  private steerRequested = false;
  private steeringError: Error | null = null;

  constructor(
    private readonly config: HostConfig,
    readonly conversation: Conversation,
    private readonly session: AgentSession,
    private readonly store: Store,
    private readonly log: (record: Record<string, unknown>) => void,
    private readonly onIdle: (worker: ConversationWorker) => void = () => undefined,
    private readonly loadGroupHistory: (conversation: Conversation) => Promise<RecentGroupHistory>
      = (target) => fetchRecentGroupHistory(config, target),
  ) {}

  get processId(): number | null { return this.session.processId; }

  async start(): Promise<void> {
    if (this.started) return;
    const now = new Date().toISOString();
    this.store.setWorkerState({
      conversationId: this.conversation.id, workerId: this.workerId,
      runtimeId: this.conversation.runtimeId, state: 'starting', processId: null, startedAt: now,
    });
    try {
      let history: RecentGroupHistory | null = null;
      if (this.conversation.kind === 'group') {
        const onboarding = this.store.getGroupOnboarding(this.conversation.id);
        if (!onboarding) throw new Error(`群 onboarding 状态不存在：${this.conversation.id}`);
        if (!['completed', 'submitted', 'delivered', 'delivery_unknown'].includes(onboarding.state)) {
          history = await this.loadGroupHistory(this.conversation);
        }
      }
      await this.session.start();
      if (this.conversation.kind === 'group') await this.deliverRecentHistory(history);
      this.started = true;
      this.store.setWorkerState({
        conversationId: this.conversation.id, workerId: this.workerId,
        runtimeId: this.conversation.runtimeId, state: 'warm', processId: this.session.processId,
        claimedFromSequence: null, claimedToSequence: null, startedAt: now,
      });
      this.log({
        type: 'WORKER_READY', conversationId: this.conversation.id,
        workerIdPrefix: this.workerId.slice(0, 8), runtimeId: this.conversation.runtimeId,
        processId: this.session.processId, providerSessionPrefix: this.session.currentSessionId?.slice(0, 12) ?? null,
      });
    } catch (error) {
      this.store.setWorkerState({
        conversationId: this.conversation.id, workerId: this.workerId,
        runtimeId: this.conversation.runtimeId, state: 'error', processId: this.session.processId,
        error: (error as Error).message, startedAt: now,
      });
      throw error;
    }
  }

  private async deliverRecentHistory(history: RecentGroupHistory | null): Promise<void> {
    const onboarding = this.store.getGroupOnboarding(this.conversation.id);
    if (!onboarding) throw new Error(`群 onboarding 状态不存在：${this.conversation.id}`);
    if (['completed', 'submitted', 'delivered', 'delivery_unknown'].includes(onboarding.state)) return;
    if (!history) throw new Error('群 onboarding 缺少最近消息上下文');
    this.store.markGroupHistoryLoaded(this.conversation.id, history.count);
    for (const message of history.messages) {
      this.store.admitEvent(this.conversation, historyEvent(this.conversation, message), 'history');
    }
    const events = this.store.claimPendingEvents(
      this.conversation,
      this.workerId,
      Math.max(1, history.messages.length),
      'history',
    );
    if (events.length > 0) {
      try {
        this.activeEvents = [...events];
        this.steeringError = null;
        const result = await this.session.deliver(batchPrompt(this.conversation, events));
        await this.awaitSteeringIdle();
        const deliveredEvents = this.activeEvents;
        this.activeEvents = null;
        if (result.status !== 'completed') {
          this.store.releaseClaimedEvents(deliveredEvents, this.workerId);
          throw new Error('群最近消息未成功传入 runtime');
        }
        this.store.recordBatchDecision(deliveredEvents, this.workerId, result.turnId, 'completed', null, null);
        this.log({
          type: 'GROUP_HISTORY_DELIVERED', conversationId: this.conversation.id,
          sequences: deliveredEvents.map((event) => event.sequence), turnIdPrefix: result.turnId.slice(0, 12),
        });
      } catch (error) {
        const failedEvents = this.activeEvents ?? events;
        this.activeEvents = null;
        this.store.recordBatchDecision(failedEvents, this.workerId, null, 'failed', null, null, (error as Error).message);
        throw error;
      }
    }
    this.store.refreshGroupOnboardingFromHistory(this.conversation.id);
    this.log({ type: 'GROUP_HISTORY_COMPLETED', conversationId: this.conversation.id, historyCount: history.count });
  }

  signal(): void {
    if (this.closed) throw new Error('conversation worker 已关闭');
    if (this.blockedAfterError) return;
    this.signalGeneration += 1;
    this.lastSignalAtMs = Date.now();
    this.store.setWorkerState({
      conversationId: this.conversation.id, workerId: this.workerId,
      runtimeId: this.conversation.runtimeId, state: this.draining ? 'running' : 'warm',
      processId: this.session.processId, lastSignalAt: new Date(this.lastSignalAtMs).toISOString(),
    });
    if (this.activeEvents) this.startSteer();
    else if (this.started && !this.draining) this.startDrain();
  }

  isBusy(): boolean { return this.draining !== null || Boolean(this.session.hasBackgroundWork?.()); }

  private startDrain(): void {
    this.draining = this.drain().finally(() => {
      this.draining = null;
      if (!this.closed && !this.blockedAfterError && this.store.pendingEventCount(this.conversation.id) > 0) this.startDrain();
      else if (!this.closed) this.onIdle(this);
    });
  }

  private async drain(): Promise<void> {
    while (!this.closed) {
      await this.waitForQuietWindow();
      const events = this.store.claimPendingEvents(
        this.conversation,
        this.workerId,
        this.config.scheduling.maxBatchMessages,
      );
      if (events.length === 0) break;
      this.store.setWorkerState({
        conversationId: this.conversation.id, workerId: this.workerId,
        runtimeId: this.conversation.runtimeId, state: 'running', processId: this.session.processId,
        claimedFromSequence: events[0]!.sequence, claimedToSequence: events.at(-1)!.sequence,
      });
      try {
        this.activeEvents = [...events];
        this.steeringError = null;
        const result = await this.session.deliver(batchPrompt(this.conversation, events));
        await this.awaitSteeringIdle();
        const deliveredEvents = this.activeEvents;
        this.activeEvents = null;
        if (result.status !== 'completed') {
          this.store.releaseClaimedEvents(deliveredEvents, this.workerId);
          this.log({
            type: 'MESSAGE_DELIVERY_INTERRUPTED', conversationId: this.conversation.id,
            sequences: deliveredEvents.map((event) => event.sequence), turnIdPrefix: result.turnId.slice(0, 12),
          });
          break;
        }
        this.store.recordBatchDecision(deliveredEvents, this.workerId, result.turnId, 'completed', null, null);
        this.log({
          type: 'MESSAGE_DELIVERED', conversationId: this.conversation.id,
          sequences: deliveredEvents.map((event) => event.sequence), turnIdPrefix: result.turnId.slice(0, 12),
        });
      } catch (error) {
        const failedEvents = this.activeEvents ?? events;
        this.activeEvents = null;
        this.store.recordBatchDecision(failedEvents, this.workerId, null, 'failed', null, null, (error as Error).message);
        this.onError(error as Error, failedEvents);
        break;
      }
    }
    if (!this.closed) {
      this.store.setWorkerState({
        conversationId: this.conversation.id, workerId: this.workerId,
        runtimeId: this.conversation.runtimeId, state: 'warm', processId: this.session.processId,
        claimedFromSequence: null, claimedToSequence: null,
      });
    }
  }

  private startSteer(): void {
    if (!this.activeEvents) return;
    if (this.steering) {
      this.steerRequested = true;
      return;
    }
    this.steering = this.steerPending().finally(() => {
      this.steering = null;
      if (this.activeEvents && this.steerRequested) {
        this.steerRequested = false;
        this.startSteer();
      }
    });
  }

  private async steerPending(): Promise<void> {
    await this.waitForQuietWindow();
    if (!this.activeEvents) return;
    const events = this.store.claimPendingEvents(
      this.conversation,
      this.workerId,
      this.config.scheduling.maxBatchMessages,
      'live',
    );
    if (events.length === 0) return;
    try {
      const accepted = await this.session.steer(batchPrompt(this.conversation, events));
      this.activeEvents.push(...events);
      this.log({
        type: 'MESSAGE_STEERED', conversationId: this.conversation.id,
        sequences: events.map((event) => event.sequence), turnIdPrefix: accepted.turnId.slice(0, 12),
      });
    } catch (error) {
      this.store.releaseClaimedEvents(events, this.workerId);
      this.steeringError = error as Error;
      this.log({
        type: 'MESSAGE_STEER_FAILED', conversationId: this.conversation.id,
        sequences: events.map((event) => event.sequence), error: (error as Error).message,
      });
    }
  }

  private async awaitSteeringIdle(): Promise<void> {
    while (this.steering) await this.steering;
    if (this.steeringError) throw new Error(`活动 turn 引导失败：${this.steeringError.message}`);
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

  private onError(error: Error, events: AdmittedEvent[]): void {
    if (this.steeringError) this.blockedAfterError = true;
    this.store.setWorkerState({
      conversationId: this.conversation.id, workerId: this.workerId,
      runtimeId: this.conversation.runtimeId, state: 'error', processId: this.session.processId,
      claimedFromSequence: null, claimedToSequence: null, error: error.message,
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
      conversationId: this.conversation.id, workerId: null,
      runtimeId: this.conversation.runtimeId, state: 'stopped', processId: null,
      claimedFromSequence: null, claimedToSequence: null,
    });
  }
}

function historyEvent(conversation: Conversation, message: { sender: string; time: string; content: string }): NormalizedEvent {
  const fingerprint = createHash('sha256').update(
    `history\0${conversation.channelProfileId}\0${conversation.externalId}\0${message.sender}\0${message.time}\0${message.content}`,
  ).digest('hex');
  return {
    channelId: conversation.channelId,
    channelProfileId: conversation.channelProfileId,
    fingerprint,
    eventId: null,
    messageId: null,
    conversationExternalId: conversation.externalId,
    conversationTitle: conversation.title,
    kind: 'group',
    senderId: null,
    senderName: message.sender,
    content: message.content,
    quotedMessage: null,
    forwardedMessages: null,
    occurredAt: message.time === '未知' ? null : message.time,
    receivedAt: new Date().toISOString(),
    source: {},
  };
}
