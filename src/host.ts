import type { HostConfig } from './config.js';
import type { ChannelAdapter, RuntimeAdapter } from './contracts.js';
import { statePath } from './paths.js';
import { Store } from './store.js';
import { OwnerLock } from './owner-lock.js';
import { DwsChannelAdapter } from './dws.js';
import { CodexRuntimeAdapter } from './codex-runtime.js';
import { ConversationWorker } from './actor.js';
import type { Conversation } from './types.js';

interface WorkerHandle {
  worker: ConversationWorker;
  leaseTimer: NodeJS.Timeout;
}

export class EventDrivenScheduler {
  private readonly workers = new Map<string, WorkerHandle>();
  private readonly starts = new Map<string, Promise<WorkerHandle>>();
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

  private ensureWorker(conversation: Conversation): Promise<WorkerHandle> {
    const existing = this.workers.get(conversation.id);
    if (existing) return Promise.resolve(existing);
    const closing = this.closures.get(conversation.id);
    if (closing) return closing.then(() => this.ensureWorker(conversation));
    const starting = this.starts.get(conversation.id);
    if (starting) return starting;

    const runtime = this.runtimes.get(conversation.runtimeId);
    if (!runtime) return Promise.reject(new Error(`没有 runtime adapter：${conversation.runtimeId}`));
    const channel = this.channels.get(channelKey(conversation.channelId, conversation.channelProfileId));
    if (!channel) {
      return Promise.reject(new Error(`没有 channel adapter：${conversation.channelId}/${conversation.channelProfileId}`));
    }
    const session = runtime.createSession(conversation);
    const worker = new ConversationWorker(
      this.config,
      conversation,
      session,
      this.store,
      channel,
      this.log,
      (idleWorker) => this.scheduleWarmRelease(idleWorker),
      this.fatal,
    );
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
      this.workers.set(conversation.id, handle);
      return handle;
    }).catch((error) => {
      this.starts.delete(conversation.id);
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
    const delayMs = worker.conversation.workerWarmSeconds * this.secondMs;
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

export async function runHost(config: HostConfig): Promise<void> {
  const store = new Store(statePath(config.instance));
  const lock = new OwnerLock(config.instance, config.channel.profile);
  const log = (record: Record<string, unknown>) => {
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), instance: config.instance, ...record })}\n`);
  };
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
  const channel = new DwsChannelAdapter(config);
  const channels = new Map([[channelKey(channel.descriptor.channelId, channel.descriptor.profileId), channel as ChannelAdapter]]);

  try {
    await lock.acquire();
    if (!store.acquireLease('host', lock.ownerId, Date.now(), 30_000)) {
      throw new Error('instance 数据库 lease 已被其他 Host 持有');
    }
    leaseTimer = setInterval(() => {
      if (!store.renewLease('host', lock.ownerId, Date.now(), 30_000)) requestStop(new Error('Host lease 丢失'));
    }, 10_000);
    leaseTimer.unref();

    store.setRuntimeAdapter({
      runtimeId: config.runtime.id, label: 'Codex CLI', state: 'starting',
      model: config.runtime.model,
    });
    let runtime: CodexRuntimeAdapter;
    try {
      runtime = await CodexRuntimeAdapter.create(config, store);
    } catch (error) {
      store.setRuntimeAdapter({
        runtimeId: config.runtime.id, label: 'Codex CLI', state: 'error',
        model: config.runtime.model, error: (error as Error).message,
      });
      throw error;
    }
    runtimeInitialized = true;
    store.setRuntimeAdapter({
      runtimeId: runtime.descriptor.runtimeId,
      label: runtime.descriptor.label,
      state: 'ready',
      model: runtime.descriptor.model,
      protocolFingerprint: runtime.descriptor.protocolFingerprint,
    });
    const runtimes = new Map([[runtime.descriptor.runtimeId, runtime as RuntimeAdapter]]);
    log({
      type: 'RUNTIME_VERIFIED', runtimeId: runtime.descriptor.runtimeId,
      model: runtime.descriptor.model, protocolFingerprintPrefix: runtime.descriptor.protocolFingerprint.slice(0, 20),
    });
    scheduler = new EventDrivenScheduler(config, store, channels, runtimes, log, requestStop);

    const descriptor = channel.descriptor;
    store.setChannelConnection({
      ...descriptor,
      state: 'starting',
      ownerPid: process.pid,
      connectedAt: null,
      lastEventAt: null,
    });
    await channel.start({
      onEvent: (normalized) => {
        store.noteChannelEvent(normalized.channelId, normalized.channelProfileId, normalized.receivedAt);
        const conversation = store.findEnabledConversation(
          normalized.channelId,
          normalized.channelProfileId,
          normalized.kind,
          normalized.conversationExternalId,
        );
        if (!conversation) {
          log({
            type: 'EVENT_REJECTED', reason: 'conversation-not-authorized',
            channelId: normalized.channelId, kind: normalized.kind,
            fingerprintPrefix: normalized.fingerprint.slice(0, 12),
          });
          return;
        }
        const admitted = store.admitEvent(conversation, normalized);
        if (!admitted.admitted || !admitted.event) {
          log({ type: 'EVENT_DUPLICATE', conversationId: conversation.id, fingerprintPrefix: normalized.fingerprint.slice(0, 12) });
          return;
        }
        log({ type: 'EVENT_ADMITTED', conversationId: conversation.id, sequence: admitted.event.sequence });
        scheduler?.signal(conversation.id);
      },
      onFatal: (error) => {
        store.setChannelConnection({ ...descriptor, state: 'error', ownerPid: process.pid, error: error.message });
        requestStop(error);
      },
    });
    const connectedAt = new Date().toISOString();
    store.setChannelConnection({ ...descriptor, state: 'ready', ownerPid: process.pid, connectedAt });
    const recovered = scheduler.reconcile();
    if (recovered.length > 0) log({ type: 'PENDING_RECONCILED', conversations: recovered.length });
    log({
      type: 'HOST_READY', pid: process.pid, channels: channels.size, runtimes: runtimes.size,
      conversations: store.listConversations(true).length, activeWorkers: scheduler.activeWorkerCount(),
    });

    const signalHandler = () => requestStop();
    process.once('SIGINT', signalHandler);
    process.once('SIGTERM', signalHandler);
    await stopSignal;
    process.removeListener('SIGINT', signalHandler);
    process.removeListener('SIGTERM', signalHandler);
  } catch (error) {
    fatal = error instanceof Error ? error : new Error(String(error));
    log({ type: 'HOST_FATAL', error: fatal.message });
  } finally {
    const fatalError = fatal as Error | null;
    if (leaseTimer) clearInterval(leaseTimer);
    await scheduler?.stop();
    await channel.stop().catch((error) => log({ type: 'CHANNEL_STOP_ERROR', error: (error as Error).message }));
    store.setChannelConnection({
      ...channel.descriptor,
      state: fatalError ? 'error' : 'stopped',
      ownerPid: null,
      error: fatalError?.message ?? null,
    });
    if (runtimeInitialized) {
      store.setRuntimeAdapter({
        runtimeId: config.runtime.id, label: 'Codex CLI', state: fatalError ? 'error' : 'stopped',
        model: config.runtime.model, error: fatalError?.message ?? null,
      });
    }
    store.releaseLease('host', lock.ownerId);
    store.close();
    await lock.release();
    log({ type: 'HOST_STOPPED', fatal: fatal ? (fatal as Error).message : null });
  }
  if (fatal) throw fatal;
}

function channelKey(channelId: string, profileId: string): string {
  return `${channelId}\u0000${profileId}`;
}
