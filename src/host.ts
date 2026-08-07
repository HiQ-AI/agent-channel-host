import { MINIMUM_NODE_VERSION, type HostConfig } from './config.js';
import { assertMinimumToolVersion } from './tool-version.js';
import type { AgentActivitySnapshot, ChannelAdapter, RuntimeAdapter } from './contracts.js';
import { statePath } from './paths.js';
import { Store } from './store.js';
import { OwnerLock } from './owner-lock.js';
import { DwsChannelAdapter } from './dws.js';
import { CodexRuntimeAdapter } from './codex-runtime.js';
import { ConversationWorker } from './actor.js';
import type { AdmittedEvent, Conversation, NormalizedEvent } from './types.js';
import { anonymousConversationTitle, discoveredConversationTitle, isGeneratedConversationTitle } from './conversation-title.js';
import { randomUUID } from 'node:crypto';

export interface HostControl {
  submitConversationInput(conversationId: string, text: string): void;
  readAgentActivity(conversationId: string): AgentActivitySnapshot;
}

interface WorkerHandle {
  worker: ConversationWorker;
  leaseTimer: NodeJS.Timeout;
}

export interface HostRunOptions {
  signal?: AbortSignal;
  handleProcessSignals?: boolean;
  log?: (record: Record<string, unknown>) => void;
  channel?: ChannelAdapter;
  runtime?: RuntimeAdapter;
  ownerLock?: { ownerId: string; acquire(): Promise<void>; release(): Promise<void> };
  onControlReady?: (control: HostControl) => void;
}

export interface ConversationResolution {
  conversation: Conversation | null;
  created: boolean;
  reason: 'authorized' | 'auto-created' | 'subscription-none' | 'conversation-disabled' | 'conversation-not-authorized';
}

export function resolveEventConversation(
  config: HostConfig,
  store: Store,
  event: NormalizedEvent,
): ConversationResolution {
  const subscription = event.kind === 'group'
    ? config.channel.subscriptions.groups
    : config.channel.subscriptions.directs;
  if (subscription === 'none') {
    return { conversation: null, created: false, reason: 'subscription-none' };
  }
  const existing = store.findConversation(
    event.channelId,
    event.channelProfileId,
    event.kind,
    event.conversationExternalId,
  );
  if (existing) {
    if (!existing.enabled) return { conversation: null, created: false, reason: 'conversation-disabled' };
    const discoveredTitle = discoveredConversationTitle(event);
    if (discoveredTitle && isGeneratedConversationTitle(existing.title, event.kind, event.conversationExternalId)) {
      store.setConversationTitle(existing.id, discoveredTitle);
      return { conversation: store.getConversation(existing.id) ?? existing, created: false, reason: 'authorized' };
    }
    return { conversation: existing, created: false, reason: 'authorized' };
  }
  if (subscription === 'selected') {
    return { conversation: null, created: false, reason: 'conversation-not-authorized' };
  }
  let created: Conversation;
  try {
    created = store.addConversation({
      channelId: event.channelId,
      channelProfileId: event.channelProfileId,
      kind: event.kind,
      externalId: event.conversationExternalId,
      title: discoveredConversationTitle(event) || anonymousConversationTitle(event.kind, event.conversationExternalId),
      responsibility: '',
      mode: event.kind === 'group' ? config.channel.defaultModes.groups : config.channel.defaultModes.directs,
      runtimeId: config.runtime.id,
    });
  } catch (error) {
    const concurrent = store.findConversation(
      event.channelId,
      event.channelProfileId,
      event.kind,
      event.conversationExternalId,
    );
    if (!concurrent) throw error;
    return concurrent.enabled
      ? { conversation: concurrent, created: false, reason: 'authorized' }
      : { conversation: null, created: false, reason: 'conversation-disabled' };
  }
  return { conversation: created, created: true, reason: 'auto-created' };
}

export class EventDrivenScheduler {
  private readonly workers = new Map<string, WorkerHandle>();
  private readonly starts = new Map<string, Promise<WorkerHandle>>();
  private readonly startingWorkers = new Map<string, ConversationWorker>();
  private readonly closures = new Map<string, Promise<void>>();
  private readonly warmTimers = new Map<string, NodeJS.Timeout>();
  private stopping = false;

  constructor(
    private readonly config: HostConfig,
    private readonly store: Store,
    private readonly channels: Map<string, ChannelAdapter>,
    private readonly runtimes: Map<string, RuntimeAdapter>,
    private readonly log: (record: Record<string, unknown>) => void,
    private readonly fatal: (error: Error) => void = () => undefined,
    private readonly secondMs = 1_000,
  ) {}

  reconcile(): string[] {
    const conversationIds = this.store.recoverPendingWork();
    for (const conversationId of conversationIds) this.signal(conversationId);
    return conversationIds;
  }

  signal(conversationId: string): void {
    if (this.stopping) return;
    const conversation = this.store.getConversation(conversationId);
    if (!conversation?.enabled) return;
    this.clearWarmTimer(conversationId);
    const startingWorker = this.startingWorkers.get(conversationId);
    if (startingWorker) {
      startingWorker.signal();
      return;
    }
    void this.ensureWorker(conversation)
      .then(({ worker }) => {
        if (!this.stopping) worker.signal();
      })
      .catch((error) => {
        if (!this.stopping) this.fatal(error as Error);
      });
  }

  activeWorkerCount(): number {
    return this.workers.size + this.starts.size;
  }

  readAgentActivity(conversationId: string): AgentActivitySnapshot {
    const worker = this.workers.get(conversationId)?.worker ?? this.startingWorkers.get(conversationId);
    return worker?.readActivity() ?? {
      state: 'idle', revision: 0,
      message: '当前 Worker 未运行；发送消息后会启动并显示本次执行过程', entries: [],
    };
  }

  private ensureWorker(conversation: Conversation): Promise<WorkerHandle> {
    const existing = this.workers.get(conversation.id);
    if (existing) return Promise.resolve(existing);
    const closing = this.closures.get(conversation.id);
    if (closing) return closing.then(() => this.ensureWorker(conversation));
    const starting = this.starts.get(conversation.id);
    if (starting) return starting;

    const runtime = this.runtimes.get(conversation.runtimeId);
    if (!runtime) return Promise.reject(new Error(`没有 runtime adapter：${conversation.runtimeId}`));
    const session = runtime.createSession(conversation);
    const worker = new ConversationWorker(
      this.config,
      conversation,
      session,
      this.store,
      this.log,
      (idleWorker) => this.scheduleWarmRelease(idleWorker),
    );
    this.startingWorkers.set(conversation.id, worker);
    const leaseKey = `conversation:${conversation.id}`;
    if (!this.store.acquireLease(leaseKey, worker.workerId, Date.now(), 30_000)) {
      return Promise.reject(new Error(`conversation lease 已被其他 Worker 持有：${conversation.id}`));
    }
    const leaseTimer = setInterval(() => {
      if (!this.store.renewLease(leaseKey, worker.workerId, Date.now(), 30_000)) {
        this.fatal(new Error(`conversation lease 丢失：${conversation.id}`));
      }
    }, 10_000);
    leaseTimer.unref();
    const handle = { worker, leaseTimer };
    const promise = worker.start().then(() => {
      this.starts.delete(conversation.id);
      this.startingWorkers.delete(conversation.id);
      this.workers.set(conversation.id, handle);
      return handle;
    }).catch((error) => {
      this.starts.delete(conversation.id);
      this.startingWorkers.delete(conversation.id);
      clearInterval(leaseTimer);
      this.store.releaseLease(leaseKey, worker.workerId);
      throw error;
    });
    this.starts.set(conversation.id, promise);
    return promise;
  }

  private scheduleWarmRelease(worker: ConversationWorker): void {
    if (this.stopping || this.workers.get(worker.conversation.id)?.worker !== worker) return;
    this.clearWarmTimer(worker.conversation.id);
    const current = this.store.getConversation(worker.conversation.id);
    const delayMs = (current?.workerWarmSeconds ?? worker.conversation.workerWarmSeconds) * this.secondMs;
    const warmUntil = new Date(Date.now() + delayMs).toISOString();
    this.store.setWorkerState({
      conversationId: worker.conversation.id,
      workerId: worker.workerId,
      runtimeId: worker.conversation.runtimeId,
      state: 'warm',
      processId: worker.processId,
      claimedFromSequence: null,
      claimedToSequence: null,
      warmUntil,
    });
    const timer = setTimeout(() => void this.releaseIfIdle(worker), delayMs);
    timer.unref();
    this.warmTimers.set(worker.conversation.id, timer);
  }

  private async releaseIfIdle(worker: ConversationWorker): Promise<void> {
    this.warmTimers.delete(worker.conversation.id);
    if (this.workers.get(worker.conversation.id)?.worker !== worker) return;
    if (this.store.pendingEventCount(worker.conversation.id) > 0) {
      worker.signal();
      return;
    }
    if (worker.isBusy()) {
      this.scheduleWarmRelease(worker);
      return;
    }
    const knownHandle = this.workers.get(worker.conversation.id) ?? null;
    this.workers.delete(worker.conversation.id);
    const leaseKey = `conversation:${worker.conversation.id}`;
    if (knownHandle) clearInterval(knownHandle.leaseTimer);
    const closing = worker.stop()
      .then(() => {
        this.store.releaseLease(leaseKey, worker.workerId);
        this.log({ type: 'WORKER_WARM_CLOSED', conversationId: worker.conversation.id });
      })
      .catch((error) => this.fatal(error as Error))
      .finally(() => {
        if (knownHandle) clearInterval(knownHandle.leaseTimer);
        this.closures.delete(worker.conversation.id);
      });
    this.closures.set(worker.conversation.id, closing);
    await closing;
  }

  private clearWarmTimer(conversationId: string): void {
    const timer = this.warmTimers.get(conversationId);
    if (timer) clearTimeout(timer);
    this.warmTimers.delete(conversationId);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.warmTimers.values()) clearTimeout(timer);
    this.warmTimers.clear();
    const starting = await Promise.allSettled(this.starts.values());
    const handlesByWorkerId = new Map<string, WorkerHandle>();
    for (const handle of this.workers.values()) handlesByWorkerId.set(handle.worker.workerId, handle);
    for (const result of starting) {
      if (result.status === 'fulfilled') handlesByWorkerId.set(result.value.worker.workerId, result.value);
    }
    const handles = [...handlesByWorkerId.values()];
    this.starts.clear();
    this.workers.clear();
    await Promise.all(handles.map(async ({ worker, leaseTimer }) => {
      clearInterval(leaseTimer);
      await worker.stop().catch((error) => {
        this.log({ type: 'WORKER_STOP_ERROR', conversationId: worker.conversation.id, error: (error as Error).message });
      });
      this.store.releaseLease(`conversation:${worker.conversation.id}`, worker.workerId);
    }));
    await Promise.all([...this.closures.values()].map((closing) => closing.catch(() => undefined)));
  }
}

export async function runHost(config: HostConfig, options: HostRunOptions = {}): Promise<void> {
  assertMinimumToolVersion('Node.js', MINIMUM_NODE_VERSION, process.version);
  const store = new Store(statePath(config.instance));
  const lock = options.ownerLock ?? new OwnerLock(config.instance, config.channel.profile);
  const sink = options.log ?? ((record: Record<string, unknown>) => {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  });
  const log = (record: Record<string, unknown>) => sink({
    at: new Date().toISOString(), instance: config.instance, ...record,
  });
  let fatal: Error | null = null;
  let stopResolve!: () => void;
  const stopSignal = new Promise<void>((resolve) => { stopResolve = resolve; });
  const requestStop = (error?: Error) => {
    if (error && !fatal) {
      fatal = error;
      log({ type: 'HOST_FATAL', error: error.message });
    }
    stopResolve();
  };
  let leaseTimer: NodeJS.Timeout | null = null;
  let scheduler: EventDrivenScheduler | null = null;
  let runtimeInitialized = false;
  let lockAcquired = false;
  let leaseAcquired = false;
  let channelOwned = false;
  let channelFatal: Error | null = null;
  const channel = config.channel.enabled ? options.channel ?? new DwsChannelAdapter(config) : null;
  const channels = new Map<string, ChannelAdapter>();
  if (channel) channels.set(channelKey(channel.descriptor.channelId, channel.descriptor.profileId), channel);
  const abortHandler = () => requestStop();
  if (options.signal?.aborted) requestStop();
  else options.signal?.addEventListener('abort', abortHandler, { once: true });
  const signalHandler = () => requestStop();

  try {
    if (options.signal?.aborted) return;
    if (channel) {
      await lock.acquire();
      lockAcquired = true;
    } else {
      store.setChannelConnection({
        channelId: config.channel.id,
        profileId: config.channel.profileId,
        label: 'DingTalk DWS',
        state: 'disabled',
        ownerPid: null,
      });
    }
    if (!store.acquireLease('host', lock.ownerId, Date.now(), 30_000)) {
      throw new Error('instance 数据库 lease 已被其他 Host 持有');
    }
    leaseAcquired = true;
    leaseTimer = setInterval(() => {
      if (!store.renewLease('host', lock.ownerId, Date.now(), 30_000)) requestStop(new Error('Host lease 丢失'));
    }, 10_000);
    leaseTimer.unref();

    store.setRuntimeAdapter({
      runtimeId: config.runtime.id, label: 'Codex CLI', state: 'starting',
      model: config.runtime.model,
    });
    let runtime: RuntimeAdapter;
    if (options.runtime) runtime = options.runtime;
    else {
      try {
        runtime = await CodexRuntimeAdapter.create(config, store);
      } catch (error) {
        store.setRuntimeAdapter({
          runtimeId: config.runtime.id, label: 'Codex CLI', state: 'error',
          model: config.runtime.model, error: (error as Error).message,
        });
        throw error;
      }
    }
    runtimeInitialized = true;
    store.setRuntimeAdapter({
      runtimeId: runtime.descriptor.runtimeId,
      label: runtime.descriptor.label,
      state: 'ready',
      model: runtime.descriptor.model,
      protocolFingerprint: runtime.descriptor.protocolFingerprint,
      contextRecovery: runtime.descriptor.contextRecovery,
    });
    const runtimes = new Map([[runtime.descriptor.runtimeId, runtime as RuntimeAdapter]]);
    log({
      type: 'RUNTIME_VERIFIED', runtimeId: runtime.descriptor.runtimeId,
      model: runtime.descriptor.model, protocolFingerprintPrefix: runtime.descriptor.protocolFingerprint.slice(0, 20),
    });
    scheduler = new EventDrivenScheduler(config, store, channels, runtimes, log, requestStop);
    let startupRecoveryComplete = false;
    const startupSignals = new Set<string>();
    const admitNormalized = (normalized: NormalizedEvent, ingress: AdmittedEvent['ingress'] = 'live') => {
      store.noteChannelEvent(normalized.channelId, normalized.channelProfileId, normalized.receivedAt);
      const resolution = resolveEventConversation(config, store, normalized);
      const conversation = resolution.conversation;
      if (!conversation) {
        log({
          type: 'EVENT_REJECTED', reason: resolution.reason,
          channelId: normalized.channelId, kind: normalized.kind,
          fingerprintPrefix: normalized.fingerprint.slice(0, 12), ingress,
        });
        return;
      }
      if (resolution.created) {
        log({
          type: 'CONVERSATION_AUTO_CREATED', conversationId: conversation.id,
          channelId: normalized.channelId, kind: normalized.kind, mode: conversation.mode,
        });
      }
      const admitted = store.admitEvent(conversation, normalized, ingress);
      if (!admitted.admitted || !admitted.event) {
        log({
          type: 'EVENT_DUPLICATE', conversationId: conversation.id,
          fingerprintPrefix: normalized.fingerprint.slice(0, 12), ingress,
        });
        return;
      }
      log({ type: 'EVENT_ADMITTED', conversationId: conversation.id, sequence: admitted.event.sequence, ingress });
      if (startupRecoveryComplete) scheduler?.signal(conversation.id);
      else startupSignals.add(conversation.id);
    };

    if (channel) {
      const descriptor = channel.descriptor;
      channelOwned = true;
      store.setChannelConnection({
        ...descriptor,
        state: 'starting',
        ownerPid: process.pid,
        connectedAt: null,
        lastEventAt: null,
      });
      try {
        await channel.start({
          onEvent: (normalized) => admitNormalized(normalized),
          onFatal: (error) => {
            channelFatal ??= error;
            store.setChannelConnection({ ...descriptor, state: 'error', ownerPid: process.pid, error: error.message });
            requestStop(error);
          },
        });
      } catch (error) {
        channelFatal = error instanceof Error ? error : new Error(String(error));
        throw channelFatal;
      }
      const connectedAt = new Date().toISOString();
      store.setChannelConnection({ ...descriptor, state: 'ready', ownerPid: process.pid, connectedAt });
      if (channel.backfill) {
        const until = new Date(connectedAt);
        const targets = store.listConversations(true).map((conversation) => ({
          conversation,
          start: store.conversationBackfillStart(conversation),
        }));
        const loaded = await channel.backfill(targets, until, (event) => admitNormalized(event, 'history'));
        log({ type: 'OFFLINE_BACKFILL_COMPLETED', conversations: targets.length, loaded, until: until.toISOString() });
      }
    }
    const recovered = scheduler.reconcile();
    startupRecoveryComplete = true;
    for (const conversationId of startupSignals) scheduler.signal(conversationId);
    options.onControlReady?.({
      readAgentActivity: (conversationId) => scheduler!.readAgentActivity(conversationId),
      submitConversationInput: (conversationId, text) => {
        const conversation = store.getConversation(conversationId);
        if (!conversation) throw new Error('Conversation 已不存在');
        if (!conversation.enabled) throw new Error('Conversation 已停用，不能发送给 Agent');
        const content = text.trim();
        if (!content) throw new Error('发送内容不能为空');
        const id = randomUUID();
        const now = new Date().toISOString();
        const admitted = store.admitEvent(conversation, {
          channelId: conversation.channelId,
          channelProfileId: conversation.channelProfileId,
          fingerprint: `view:${id}`,
          eventId: `view:${id}`,
          messageId: null,
          conversationExternalId: conversation.externalId,
          conversationTitle: conversation.title,
          kind: conversation.kind,
          senderId: null,
          senderName: 'View 用户（本人）',
          content,
          quotedMessage: null,
          forwardedMessages: null,
          occurredAt: now,
          receivedAt: now,
          source: { type: 'view_manual_input' },
        });
        if (!admitted.admitted) throw new Error('本地输入重复，未再次投递');
        scheduler?.signal(conversation.id);
        log({ type: 'VIEW_INPUT_ADMITTED', conversationId: conversation.id, sequence: admitted.event?.sequence });
      },
    });
    if (recovered.length > 0) log({ type: 'PENDING_RECONCILED', conversations: recovered.length });
    log({
      type: 'HOST_READY', pid: process.pid, channels: channels.size, runtimes: runtimes.size,
      conversations: store.listConversations(true).length, activeWorkers: scheduler.activeWorkerCount(),
    });

    if (options.handleProcessSignals !== false) {
      process.once('SIGINT', signalHandler);
      process.once('SIGTERM', signalHandler);
    }
    await stopSignal;
  } catch (error) {
    fatal = error instanceof Error ? error : new Error(String(error));
    log({ type: 'HOST_FATAL', error: fatal.message });
  } finally {
    const fatalError = fatal as Error | null;
    if (leaseTimer) clearInterval(leaseTimer);
    await scheduler?.stop();
    if (channelOwned && channel) {
      await channel.stop().catch((error) => log({ type: 'CHANNEL_STOP_ERROR', error: (error as Error).message }));
      store.setChannelConnection({
        ...channel.descriptor,
        state: fatalError ? 'error' : 'stopped',
        ownerPid: null,
        error: fatalError?.message ?? null,
      });
    }
    if (runtimeInitialized) {
      const runtimeError = fatalError && fatalError !== channelFatal ? fatalError : null;
      store.setRuntimeAdapter({
        runtimeId: config.runtime.id, label: 'Codex CLI', state: runtimeError ? 'error' : 'stopped',
        model: config.runtime.model, error: runtimeError?.message ?? null,
      });
    }
    if (leaseAcquired) store.releaseLease('host', lock.ownerId);
    store.close();
    if (lockAcquired) await lock.release();
    options.signal?.removeEventListener('abort', abortHandler);
    process.removeListener('SIGINT', signalHandler);
    process.removeListener('SIGTERM', signalHandler);
    log({ type: 'HOST_STOPPED', fatal: fatal ? (fatal as Error).message : null });
  }
  if (fatal) throw fatal;
}

function channelKey(channelId: string, profileId: string): string {
  return `${channelId}\u0000${profileId}`;
}
