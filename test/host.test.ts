import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config.js';
import type { AgentSession, ChannelAdapter, ChannelHandlers, RuntimeAdapter } from '../src/contracts.js';
import { EventDrivenScheduler } from '../src/host.js';
import { normalizeDwsEvent } from '../src/dws.js';
import { Store } from '../src/store.js';
import type { Conversation, DecisionRun, OutboxRecord } from '../src/types.js';

class FakeChannel implements ChannelAdapter {
  readonly descriptor = { channelId: 'dingtalk', profileId: 'default', label: 'Fake Channel' };
  sent = 0;
  async start(_handlers: ChannelHandlers): Promise<void> {}
  async stop(): Promise<void> {}
  async send(_conversation: Conversation, _record: Pick<OutboxRecord, 'text' | 'uuid'>): Promise<void> {
    this.sent += 1;
  }
}

class FakeSession implements AgentSession {
  currentSessionId = 'session-fixed-123456789';
  processId = 2468;
  prompts: string[] = [];
  interrupts = 0;
  stopped = 0;
  blockFirst = false;
  blockStart = false;
  private resolveActive: ((result: DecisionRun) => void) | null = null;
  private resolveStart: (() => void) | null = null;

  async start(): Promise<void> {
    if (this.blockStart) await new Promise<void>((resolve) => { this.resolveStart = resolve; });
  }

  releaseStart(): void {
    this.resolveStart?.();
    this.resolveStart = null;
  }

  runDecision(prompt: string): Promise<DecisionRun> {
    this.prompts.push(prompt);
    if (this.blockFirst && this.prompts.length === 1) {
      return new Promise((resolve) => { this.resolveActive = resolve; });
    }
    return Promise.resolve(silentRun(`turn-${this.prompts.length}`));
  }

  async interruptActive(): Promise<boolean> {
    if (!this.resolveActive) return false;
    this.interrupts += 1;
    const resolve = this.resolveActive;
    this.resolveActive = null;
    resolve({ turnId: 'turn-interrupted', status: 'interrupted', decision: null, subagentThreadId: null });
    return true;
  }

  async stop(): Promise<void> {
    this.stopped += 1;
  }
}

class FakeRuntime implements RuntimeAdapter {
  readonly descriptor = {
    runtimeId: 'codex', label: 'Fake Runtime', model: 'fake', protocolFingerprint: 'fake:v1',
  };
  readonly sessions: FakeSession[] = [];
  blockFirst = false;
  blockStart = false;

  createSession(_conversation: Conversation): AgentSession {
    const session = new FakeSession();
    session.blockFirst = this.blockFirst;
    session.blockStart = this.blockStart;
    this.sessions.push(session);
    return session;
  }
}

test('ready signal 将 burst 聚合为一次 turn，warm TTL 后释放 Worker', async () => {
  const config = defaultConfig('scheduler-burst', '.', 'Agent', 'role');
  config.runtime.quietWindowMilliseconds = 20;
  config.runtime.maxBatchMessages = 20;
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'burst-user', title: 'Burst 私聊', responsibility: '回答问题', mode: 'shadow',
    workerWarmSeconds: 2,
  });
  const channel = new FakeChannel();
  const runtime = new FakeRuntime();
  const scheduler = new EventDrivenScheduler(
    config,
    store,
    new Map([['dingtalk\0default', channel]]),
    new Map([['codex', runtime]]),
    () => undefined,
    (error) => { throw error; },
    10,
  );
  try {
    for (let index = 1; index <= 3; index += 1) {
      admit(store, conversation, `burst-${index}`);
      scheduler.signal(conversation.id);
    }
    await waitFor(() => store.status().processed === 3);
    assert.equal(runtime.sessions.length, 1);
    assert.equal(runtime.sessions[0]!.prompts.length, 1);
    assert.match(runtime.sessions[0]!.prompts[0]!, /消息 1/);
    assert.match(runtime.sessions[0]!.prompts[0]!, /消息 3/);
    assert.equal(scheduler.activeWorkerCount(), 1);
    await waitFor(() => runtime.sessions[0]!.stopped === 1);
    assert.equal(scheduler.activeWorkerCount(), 0);
    assert.equal(store.getWorker(conversation.id)?.state, 'stopped');
  } finally {
    await scheduler.stop();
    store.close();
  }
});

test('Host 在 Worker 启动中停止时只关闭一次且不再投递 signal', async () => {
  const config = defaultConfig('scheduler-stop-starting', '.', 'Agent', 'role');
  config.runtime.quietWindowMilliseconds = 0;
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'starting-user', title: 'Starting 私聊', responsibility: '回答问题', mode: 'shadow',
  });
  const channel = new FakeChannel();
  const runtime = new FakeRuntime();
  runtime.blockStart = true;
  const scheduler = new EventDrivenScheduler(
    config,
    store,
    new Map([['dingtalk\0default', channel]]),
    new Map([['codex', runtime]]),
    () => undefined,
    (error) => { throw error; },
    10,
  );
  try {
    admit(store, conversation, 'starting-1');
    scheduler.signal(conversation.id);
    await waitFor(() => runtime.sessions.length === 1);
    const stopping = scheduler.stop();
    runtime.sessions[0]!.releaseStart();
    await stopping;
    assert.equal(runtime.sessions[0]!.stopped, 1);
    assert.equal(runtime.sessions[0]!.prompts.length, 0);
    assert.equal(scheduler.activeWorkerCount(), 0);
  } finally {
    store.close();
  }
});

test('active turn 内多条新消息只 cancel 一次，并把原 claim 与新消息重新合并', async () => {
  const config = defaultConfig('scheduler-cancel', '.', 'Agent', 'role');
  config.runtime.quietWindowMilliseconds = 0;
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'cancel-user', title: 'Cancel 私聊', responsibility: '回答问题', mode: 'shadow',
    workerWarmSeconds: 60,
  });
  const channel = new FakeChannel();
  const runtime = new FakeRuntime();
  runtime.blockFirst = true;
  const scheduler = new EventDrivenScheduler(
    config,
    store,
    new Map([['dingtalk\0default', channel]]),
    new Map([['codex', runtime]]),
    () => undefined,
    (error) => { throw error; },
    10,
  );
  try {
    admit(store, conversation, 'cancel-1');
    scheduler.signal(conversation.id);
    await waitFor(() => runtime.sessions[0]?.prompts.length === 1);
    admit(store, conversation, 'cancel-2');
    scheduler.signal(conversation.id);
    admit(store, conversation, 'cancel-3');
    scheduler.signal(conversation.id);
    await waitFor(() => store.status().processed === 3);
    const session = runtime.sessions[0]!;
    assert.equal(session.interrupts, 1);
    assert.equal(session.prompts.length, 2);
    assert.match(session.prompts[1]!, /消息 1/);
    assert.match(session.prompts[1]!, /消息 3/);
  } finally {
    await scheduler.stop();
    store.close();
  }
});

test('启动 reconciliation 释放旧 claim 并只唤醒有 pending work 的 conversation', async () => {
  const config = defaultConfig('scheduler-reconcile', '.', 'Agent', 'role');
  config.runtime.quietWindowMilliseconds = 0;
  const store = new Store(':memory:');
  const pending = store.addConversation({
    kind: 'direct', externalId: 'pending-user', title: 'Pending 私聊', responsibility: '回答问题', mode: 'shadow',
  });
  store.addConversation({
    kind: 'direct', externalId: 'quiet-user', title: 'Quiet 私聊', responsibility: '回答问题', mode: 'shadow',
  });
  admit(store, pending, 'recover-1');
  assert.equal(store.claimPendingEvents(pending, 'dead-worker', 20).length, 1);
  const channel = new FakeChannel();
  const runtime = new FakeRuntime();
  const scheduler = new EventDrivenScheduler(
    config,
    store,
    new Map([['dingtalk\0default', channel]]),
    new Map([['codex', runtime]]),
    () => undefined,
    (error) => { throw error; },
    10,
  );
  try {
    assert.deepEqual(scheduler.reconcile(), [pending.id]);
    await waitFor(() => store.status().processed === 1);
    assert.equal(runtime.sessions.length, 1);
  } finally {
    await scheduler.stop();
    store.close();
  }
});

function admit(store: Store, conversation: Conversation, id: string): void {
  const event = normalizeDwsEvent({
    type: 'user_im_message_receive_o2o_all', event_id: id,
    sender_open_dingtalk_id: conversation.externalId, content: id,
  })!;
  assert.equal(store.admitEvent(conversation, event).admitted, true);
}

function silentRun(turnId: string): DecisionRun {
  return {
    turnId,
    status: 'completed',
    decision: {
      action: 'silent', responsibilityMatch: false, category: 'test', replyText: '',
      reasonCode: 'test', workType: 'discussion', delegation: 'not_required',
    },
    subagentThreadId: null,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('等待条件超时');
}
