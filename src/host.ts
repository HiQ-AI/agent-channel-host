import { join } from 'node:path';
import type { HostConfig } from './config.js';
import { instanceDir, statePath } from './paths.js';
import { Store } from './store.js';
import { verifyCodexProtocol } from './protocol.js';
import { OwnerLock } from './owner-lock.js';
import { DwsEventOwner, DwsSender, normalizeDwsEvent } from './dws.js';
import { AppServerSession } from './app-server.js';
import { ConversationActor } from './actor.js';
import type { Conversation } from './types.js';

export async function runHost(config: HostConfig): Promise<void> {
  const store = new Store(statePath(config.instance));
  const lock = new OwnerLock(config.instance, config.runtime.dwsProfile);
  const actors = new Map<string, ConversationActor>();
  const actorStarts = new Map<string, Promise<ConversationActor>>();
  const actorClosures = new Map<string, Promise<void>>();
  const directIdleTimers = new Map<string, NodeJS.Timeout>();
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
  const sender = new DwsSender(config);
  let events: DwsEventOwner | null = null;
  let leaseTimer: NodeJS.Timeout | null = null;

  try {
    await lock.acquire();
    if (!store.acquireLease('host', lock.ownerId, Date.now(), 30_000)) {
      throw new Error('instance 数据库 lease 已被其他 Host 持有');
    }
    leaseTimer = setInterval(() => {
      if (!store.renewLease('host', lock.ownerId, Date.now(), 30_000)) {
        requestStop(new Error('Host lease 丢失'));
      }
    }, 10_000);
    const protocol = await verifyCodexProtocol(config, join(instanceDir(config.instance), 'protocol'));
    log({ type: 'PROTOCOL_VERIFIED', codexVersion: protocol.codexVersion, schemaSha256: protocol.schemaSha256 });

    const ensureActor = (conversation: Conversation): Promise<ConversationActor> => {
      const existing = actors.get(conversation.id);
      if (existing) return Promise.resolve(existing);
      const closing = actorClosures.get(conversation.id);
      if (closing) return closing.then(() => ensureActor(conversation));
      const starting = actorStarts.get(conversation.id);
      if (starting) return starting;
      const session = new AppServerSession(config, conversation, protocol, store);
      const actor = new ConversationActor(config, conversation, session, store, sender, log, requestStop);
      const promise = actor.start().then(() => {
        actors.set(conversation.id, actor);
        actorStarts.delete(conversation.id);
        return actor;
      }).catch((error) => {
        actorStarts.delete(conversation.id);
        throw error;
      });
      actorStarts.set(conversation.id, promise);
      return promise;
    };

    for (const conversation of store.listConversations(true).filter((item) => item.kind === 'group')) {
      await ensureActor(conversation);
    }

    events = new DwsEventOwner(config, (raw) => {
      const normalized = normalizeDwsEvent(raw);
      if (!normalized) {
        log({ type: 'EVENT_REJECTED', reason: 'unsupported-shape' });
        return;
      }
      const conversation = store.findEnabledConversation(normalized.kind, normalized.conversationExternalId);
      if (!conversation) {
        log({
          type: 'EVENT_REJECTED', reason: 'conversation-not-authorized', kind: normalized.kind,
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
      void ensureActor(conversation)
        .then((actor) => {
          actor.submit(admitted.event!);
          if (conversation.kind === 'direct') {
            const existingTimer = directIdleTimers.get(conversation.id);
            if (existingTimer) clearTimeout(existingTimer);
            const timer = setTimeout(() => {
              directIdleTimers.delete(conversation.id);
              const current = actors.get(conversation.id);
              if (!current) return;
              actors.delete(conversation.id);
              const closing = current.stop()
                .then(() => log({ type: 'DIRECT_SESSION_IDLE_CLOSED', conversationId: conversation.id }))
                .catch((error) => requestStop(error as Error))
                .finally(() => actorClosures.delete(conversation.id));
              actorClosures.set(conversation.id, closing);
            }, config.runtime.directMessageIdleMinutes * 60_000);
            directIdleTimers.set(conversation.id, timer);
          }
        })
        .catch((error) => requestStop(error as Error));
    }, (error) => requestStop(error));
    await events.start();
    log({ type: 'HOST_READY', pid: process.pid, conversations: store.listConversations(true).length });

    const signalHandler = () => requestStop();
    process.once('SIGINT', signalHandler);
    process.once('SIGTERM', signalHandler);
    await stopSignal;
    process.removeListener('SIGINT', signalHandler);
    process.removeListener('SIGTERM', signalHandler);
  } finally {
    if (leaseTimer) clearInterval(leaseTimer);
    for (const timer of directIdleTimers.values()) clearTimeout(timer);
    directIdleTimers.clear();
    await events?.stop().catch((error) => log({ type: 'DWS_STOP_ERROR', error: (error as Error).message }));
    await Promise.all([...actors.values()].map((actor) => actor.stop().catch((error) => {
      log({ type: 'ACTOR_STOP_ERROR', conversationId: actor.conversation.id, error: (error as Error).message });
    })));
    await Promise.all([...actorClosures.values()].map((closing) => closing.catch(() => undefined)));
    store.releaseLease('host', lock.ownerId);
    store.close();
    await lock.release();
    log({ type: 'HOST_STOPPED', fatal: fatal ? (fatal as Error).message : null });
  }
  if (fatal) throw fatal;
}
