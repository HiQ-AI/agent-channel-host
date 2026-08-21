import { createHash, randomUUID } from 'node:crypto';
import type { HostConfig } from './config.js';
import type { AgentSession } from './contracts.js';
import type { AdmittedEvent, Conversation, NormalizedEvent, RuntimeIntervention } from './types.js';
import type { Store } from './store.js';
import { delay } from './process-utils.js';
import { fetchRecentGroupHistory, type RecentGroupHistory } from './dws.js';
import { batchPrompt } from './prompts.js';

export class ConversationWorker {
  readonly workerId = randomUUID();
  private draining: Promise<void> | null = null;
  private started = false;
  private closed = false;
  private signalGeneration = 0;
  private lastSignalAtMs = 0;
  private activeEvents: AdmittedEvent[] | null = null;
  private steering: Promise<void> | null = null;
  private steerRequested = false;
  private steerTail: Promise<void> = Promise.resolve();
  private interventionProcessing: Promise<void> | null = null;
  private externalDraining: Promise<void> | null = null;

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
        if (!['forwarded', 'submitted', 'delivered', 'delivery_unknown'].includes(onboarding.state)) {
          history = await this.loadGroupHistory(this.conversation);
        }
      }
      await this.session.start();
      this.refreshInterventionTarget();
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
    if (['forwarded', 'submitted', 'delivered', 'delivery_unknown'].includes(onboarding.state)) return;
    if (!history) throw new Error('群 onboarding 缺少最近消息上下文');
    this.store.markGroupHistoryLoaded(this.conversation.id, history.count);
    for (const message of history.messages) {
      this.store.admitEvent(this.conversation, historyEvent(this.conversation, message), 'history');
    }
    const events = this.store.claimPendingEvents(
      this.conversation,
      this.workerId,
      Math.max(1, history.messages.length),
      ['history'],
    );
    if (events.length > 0) {
      try {
        this.activeEvents = [...events];
        const result = await this.session.deliver(batchPrompt(this.conversation, events));
        await this.awaitSteeringIdle();
        const deliveredEvents = this.activeEvents;
        this.activeEvents = null;
        if (result.status !== 'completed') {
          this.store.releaseClaimedEvents(deliveredEvents, this.workerId);
          throw new Error('群最近消息未成功传入 runtime');
        }
        this.store.markBatchForwarded(deliveredEvents, this.workerId, result.turnId);
        this.log({
          type: 'GROUP_HISTORY_FORWARDED', conversationId: this.conversation.id,
          sequences: deliveredEvents.map((event) => event.sequence), turnIdPrefix: result.turnId.slice(0, 12),
        });
      } catch (error) {
        const failedEvents = this.activeEvents ?? events;
        this.activeEvents = null;
        this.store.markBatchFailed(failedEvents, this.workerId, (error as Error).message);
        throw error;
      }
    }
    this.store.refreshGroupOnboardingFromHistory(this.conversation.id);
    this.log({ type: 'GROUP_HISTORY_COMPLETED', conversationId: this.conversation.id, historyCount: history.count });
  }

  signal(): void {
    if (this.closed) throw new Error('conversation worker 已关闭');
    this.signalGeneration += 1;
    this.lastSignalAtMs = Date.now();
    this.store.setWorkerState({
      conversationId: this.conversation.id, workerId: this.workerId,
      runtimeId: this.conversation.runtimeId, state: this.draining ? 'running' : 'warm',
      processId: this.session.processId, lastSignalAt: new Date(this.lastSignalAtMs).toISOString(),
    });
    if (this.activeEvents) this.startSteer();
    else if (this.started && !this.draining && !this.interventionProcessing) this.startDrain();
  }

  isBusy(): boolean {
    return this.draining !== null || this.externalDraining !== null || Boolean(this.session.hasBackgroundWork?.());
  }

  isDeliveringTurn(): boolean {
    return this.draining !== null || this.externalDraining !== null || this.activeEvents !== null;
  }

  refreshInterventionTarget(): void {
    const threadId = this.session.currentSessionId;
    const turnId = this.session.currentTurnId ?? null;
    this.store.setInterventionTarget({
      conversationId: this.conversation.id,
      threadId,
      turnId,
      canIntervene: Boolean(threadId && turnId && this.session.supportsActiveSteer),
      canStartTurn: Boolean(threadId && !turnId && this.session.supportsTurnStart && !this.closed),
      workerId: this.closed ? null : this.workerId,
    });
  }

  processInterventions(): void {
    if (this.closed || !this.started || this.interventionProcessing) return;
    this.refreshInterventionTarget();
    if (this.draining && !this.session.currentTurnId) return;
    this.interventionProcessing = this.processOneIntervention()
      .catch((error) => this.log({
        type: 'INTERVENTION_PROCESS_ERROR', conversationId: this.conversation.id,
        error: (error as Error).message,
      }))
      .finally(() => {
        this.interventionProcessing = null;
        this.refreshInterventionTarget();
        if (!this.closed && !this.externalDraining && !this.draining
          && this.store.pendingEventCount(this.conversation.id) > 0) this.startDrain();
      });
  }

  private async processOneIntervention(): Promise<void> {
    const intervention = this.store.claimIntervention(this.conversation.id, this.workerId);
    if (!intervention) return;
    await this.withSteerLock(async () => this.applyIntervention(intervention));
  }

  private async applyIntervention(intervention: RuntimeIntervention): Promise<void> {
    const actualThreadId = this.session.currentSessionId;
    const actualTurnId = this.session.currentTurnId ?? null;
    const reject = (code: string, message: string, state: 'rejected' | 'expired' = 'rejected') => {
      this.store.finishIntervention({
        requestId: intervention.requestId,
        workerId: this.workerId,
        state,
        resultCode: code,
        resultMessage: message,
        actualThreadId,
        actualTurnId,
      });
      this.log({
        type: 'INTERVENTION_REJECTED', conversationId: this.conversation.id,
        requestId: intervention.requestId, code,
      });
    };
    if (Date.parse(intervention.expiresAt) <= Date.now()) {
      reject('expired', '指令在执行前已过期', 'expired');
      return;
    }
    if (!this.store.getConversation(this.conversation.id)?.enabled) {
      reject('conversation_disabled', 'Conversation 已禁用');
      return;
    }
    if (actualThreadId !== intervention.expectedThreadId) {
      reject('thread_mismatch', '当前 threadId 与 expectedThreadId 不一致');
      return;
    }
    try {
      if (actualTurnId) {
        if (!this.session.supportsActiveSteer) {
          reject('steer_unsupported', '当前 runtime session 不支持活动 turn 介入');
          return;
        }
        if (!intervention.expectedTurnId || actualTurnId !== intervention.expectedTurnId) {
          reject('turn_mismatch', '当前 turnId 与 expectedTurnId 不一致');
          return;
        }
        const accepted = await this.session.steer(
          interventionPrompt(intervention.instruction),
          intervention.expectedTurnId,
          intervention.requestId,
        );
        if (accepted.turnId !== intervention.expectedTurnId) {
          reject('turn_mismatch', 'session.steer 未确认 expectedTurnId');
          return;
        }
        this.finishIntervention(intervention, 'steered', '消息已介入预期活动 turn', actualThreadId, accepted.turnId);
        this.log({
          type: 'INTERVENTION_STEERED', conversationId: this.conversation.id,
          requestId: intervention.requestId, turnIdPrefix: accepted.turnId.slice(0, 12),
        });
        return;
      }
      if (intervention.expectedTurnId) {
        reject('turn_mismatch', '预期活动 turn 已结束，不会降级创建下一 turn');
        return;
      }
      if (!this.session.supportsTurnStart || !this.session.startTurn) {
        reject('start_unsupported', '当前 runtime session 不支持从空闲状态启动 turn');
        return;
      }
      const started = await this.session.startTurn(
        interventionPrompt(intervention.instruction), intervention.requestId,
      );
      this.observeExternalTurn(started.turnId, started.completion);
      this.finishIntervention(intervention, 'started', '消息已在原 thread 创建新 turn', actualThreadId, started.turnId);
      this.log({
        type: 'INTERVENTION_TURN_STARTED', conversationId: this.conversation.id,
        requestId: intervention.requestId, turnIdPrefix: started.turnId.slice(0, 12),
      });
    } catch (error) {
      reject(actualTurnId ? 'steer_failed' : 'start_failed', (error as Error).message);
    }
  }

  private finishIntervention(
    intervention: RuntimeIntervention,
    resultCode: 'steered' | 'started',
    resultMessage: string,
    actualThreadId: string,
    actualTurnId: string,
  ): void {
    this.store.finishIntervention({
      requestId: intervention.requestId, workerId: this.workerId, state: 'succeeded',
      resultCode, resultMessage, actualThreadId, actualTurnId,
    });
  }

  private observeExternalTurn(
    turnId: string,
    completion: Promise<import('./types.js').DeliveryRun>,
  ): void {
    this.activeEvents = [];
    const observed = (async () => {
      try {
        const result = await completion;
        await this.awaitSteeringIdle();
        const events = this.activeEvents ?? [];
        if (events.length > 0) {
          if (result.status === 'completed') this.store.markBatchForwarded(events, this.workerId, result.turnId);
          else this.store.releaseClaimedEvents(events, this.workerId);
        }
        this.log({
          type: 'INTERVENTION_TURN_COMPLETED', conversationId: this.conversation.id,
          turnIdPrefix: turnId.slice(0, 12), status: result.status,
        });
      } catch (error) {
        const events = this.activeEvents ?? [];
        if (events.length > 0) this.store.markBatchFailed(events, this.workerId, (error as Error).message);
        this.log({
          type: 'INTERVENTION_TURN_FAILED', conversationId: this.conversation.id,
          turnIdPrefix: turnId.slice(0, 12), error: (error as Error).message,
        });
      } finally {
        this.activeEvents = null;
        this.refreshInterventionTarget();
      }
    })();
    this.externalDraining = observed.finally(() => {
      this.externalDraining = null;
      if (!this.closed && this.store.pendingEventCount(this.conversation.id) > 0) this.startDrain();
      else if (!this.closed) this.onIdle(this);
    });
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
        const prompt = batchPrompt(this.conversation, events);
        const started = this.session.startTurn
          ? await this.withSteerLock(() => this.session.startTurn!(prompt))
          : null;
        const result = started ? await started.completion : await this.session.deliver(prompt);
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
        this.store.markBatchForwarded(deliveredEvents, this.workerId, result.turnId);
        this.log({
          type: 'MESSAGE_FORWARDED', conversationId: this.conversation.id,
          sequences: deliveredEvents.map((event) => event.sequence), turnIdPrefix: result.turnId.slice(0, 12),
        });
      } catch (error) {
        const failedEvents = this.activeEvents ?? events;
        this.activeEvents = null;
        this.store.markBatchFailed(failedEvents, this.workerId, (error as Error).message);
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
      ['live', 'self_poll'],
    );
    if (events.length === 0) return;
    try {
      const accepted = await this.withSteerLock(
        () => this.session.steer(batchPrompt(this.conversation, events)),
      );
      this.activeEvents.push(...events);
      this.log({
        type: 'MESSAGE_STEERED', conversationId: this.conversation.id,
        sequences: events.map((event) => event.sequence), turnIdPrefix: accepted.turnId.slice(0, 12),
      });
    } catch (error) {
      // turn 可能在 signal 与 steer 之间结束。保留新消息为 pending，待当前
      // deliver 收尾后由 drain 作为下一 turn 投递，不能因此封死 Worker。
      this.store.releaseClaimedEvents(events, this.workerId);
      this.log({
        type: 'MESSAGE_STEER_FAILED', conversationId: this.conversation.id,
        sequences: events.map((event) => event.sequence), error: (error as Error).message,
      });
    }
  }

  private async awaitSteeringIdle(): Promise<void> {
    while (this.steering) await this.steering;
  }

  private withSteerLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.steerTail.then(operation, operation);
    this.steerTail = result.then(() => undefined, () => undefined);
    return result;
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
    await this.interventionProcessing?.catch(() => undefined);
    await this.steerTail.catch(() => undefined);
    await this.session.interruptActive().catch(() => false);
    await this.externalDraining?.catch(() => undefined);
    await this.draining?.catch(() => undefined);
    await this.session.stop();
    this.store.setWorkerState({
      conversationId: this.conversation.id, workerId: null,
      runtimeId: this.conversation.runtimeId, state: 'stopped', processId: null,
      claimedFromSequence: null, claimedToSequence: null,
    });
    this.store.setInterventionTarget({
      conversationId: this.conversation.id,
      threadId: this.session.currentSessionId,
      turnId: null,
      canIntervene: false,
      canStartTurn: false,
      workerId: null,
    });
  }
}

function interventionPrompt(instruction: string): string {
  return `# 人工介入\n\n${instruction}`;
}

function historyEvent(conversation: Conversation, message: { sender: string; senderId: string | null; time: string; content: string }): NormalizedEvent {
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
    senderId: message.senderId,
    senderName: message.sender,
    content: message.content,
    quotedMessage: null,
    forwardedMessages: null,
    occurredAt: message.time === '未知' ? null : message.time,
    receivedAt: new Date().toISOString(),
    source: {},
  };
}
