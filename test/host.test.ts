import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultConfig } from '../src/config.js';
import type { AgentSession, ChannelAdapter, ChannelHandlers, RuntimeAdapter } from '../src/contracts.js';
import { EventDrivenScheduler, resolveEventConversation, runHost } from '../src/host.js';
import { normalizeDwsEvent } from '../src/dws.js';
import { Store } from '../src/store.js';
import type { Conversation, DecisionRun, OutboxRecord } from '../src/types.js';

class FakeChannel implements ChannelAdapter {
  readonly descriptor = { channelId: 'dingtalk', profileId: 'default', label: 'Fake Channel' };
  started = 0;
  sent = 0;
  stopped = 0;
  async start(_handlers: ChannelHandlers): Promise<void> { this.started += 1; }
  async stop(): Promise<void> { this.stopped += 1; }
  async send(_conversation: Conversation, _record: Pick<OutboxRecord, 'text' | 'uuid'>): Promise<void> {
    this.sent += 1;
  }
}

class FakeOwnerLock {
  acquired = 0;
  released = 0;
  constructor(readonly ownerId: string) {}
  async acquire(): Promise<void> { this.acquired += 1; }
  async release(): Promise<void> { this.released += 1; }
}

class FakeSession implements AgentSession {
  currentSessionId = 'session-fixed-123456789';
  processId = 2468;
  prompts: string[] = [];
  interrupts = 0;
  stopped = 0;
  blockFirst = false;
  blockStart = false;
  failFirst = false;
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
    if (this.failFirst && this.prompts.length === 1) {
      return Promise.reject(new Error('模拟会话级决策失败'));
    }
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
    contextRecovery: 'adapter-managed' as const,
  };
  readonly sessions: FakeSession[] = [];
  blockFirst = false;
  blockStart = false;
  failFirst = false;

  createSession(_conversation: Conversation): AgentSession {
    const session = new FakeSession();
    session.blockFirst = this.blockFirst;
    session.blockStart = this.blockStart;
    session.failFirst = this.failFirst;
    this.sessions.push(session);
    return session;
  }
}

test('会话级决策失败不升级为 Host fatal，后续消息仍由同一 Channel 处理', async () => {
  const config = defaultConfig('scheduler-decision-isolation', '.', 'Agent', 'role');
  config.scheduling.quietWindowMilliseconds = 0;
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'decision-isolation-user', title: '隔离私聊',
    responsibility: '回答问题', mode: 'shadow', workerWarmSeconds: 60,
  });
  const runtime = new FakeRuntime();
  runtime.failFirst = true;
  const fatalErrors: Error[] = [];
  const scheduler = new EventDrivenScheduler(
    config,
    store,
    new Map([['dingtalk\0default', new FakeChannel()]]),
    new Map([['codex', runtime]]),
    () => undefined,
    (error) => fatalErrors.push(error),
    10,
  );
  try {
    admit(store, conversation, 'decision-failure-1');
    scheduler.signal(conversation.id);
    await waitFor(() => store.status().failed_messages === 1);
    assert.deepEqual(fatalErrors, []);

    admit(store, conversation, 'decision-recovery-2');
    scheduler.signal(conversation.id);
    await waitFor(() => store.status().processed === 1);
    assert.deepEqual(fatalErrors, []);
    assert.equal(runtime.sessions.length, 1);
    assert.equal(runtime.sessions[0]!.prompts.length, 2);
  } finally {
    await scheduler.stop();
    store.close();
  }
});

test('ready signal 将 burst 聚合为一次 turn，warm TTL 后释放 Worker', async () => {
  const config = defaultConfig('scheduler-burst', '.', 'Agent', 'role');
  config.scheduling.quietWindowMilliseconds = 20;
  config.scheduling.maxBatchMessages = 20;
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
  config.scheduling.quietWindowMilliseconds = 0;
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
  config.scheduling.quietWindowMilliseconds = 0;
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
  config.scheduling.quietWindowMilliseconds = 0;
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

test('Host 重启后重新处理可恢复 failed message，并继续使用原 Conversation', async () => {
  const root = resolve('.test-host-failed-recovery');
  const path = resolve(root, 'state.sqlite3');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const config = defaultConfig('scheduler-failed-recovery', '.', 'Agent', 'role');
  config.scheduling.quietWindowMilliseconds = 0;
  let store = new Store(path);
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'failed-recovery-user', title: '失败恢复私聊', responsibility: '回答问题', mode: 'shadow',
  });
  admit(store, conversation, 'failed-before-restart');
  const firstRuntime = new FakeRuntime();
  firstRuntime.failFirst = true;
  const firstScheduler = new EventDrivenScheduler(
    config,
    store,
    new Map([['dingtalk\0default', new FakeChannel()]]),
    new Map([['codex', firstRuntime]]),
    () => undefined,
  );
  try {
    firstScheduler.signal(conversation.id);
    await waitFor(() => store.status().failed_messages === 1);
  } finally {
    await firstScheduler.stop();
    store.close();
  }

  store = new Store(path);
  const secondRuntime = new FakeRuntime();
  const secondScheduler = new EventDrivenScheduler(
    config,
    store,
    new Map([['dingtalk\0default', new FakeChannel()]]),
    new Map([['codex', secondRuntime]]),
    () => undefined,
  );
  try {
    assert.deepEqual(secondScheduler.reconcile(), [conversation.id]);
    await waitFor(() => store.status().processed === 1);
    assert.equal(store.status().failed_messages, 0);
    assert.equal(secondRuntime.sessions.length, 1);
    assert.match(secondRuntime.sessions[0]!.prompts[0]!, /failed-before-restart/);
  } finally {
    await secondScheduler.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('可嵌入 Host 由 AbortSignal 停止，第二个 owner 不覆盖运行状态', async () => {
  const root = resolve('.test-embedded-host');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const previous = process.env.AGENT_CHANNEL_HOME;
  process.env.AGENT_CHANNEL_HOME = root;
  const config = defaultConfig('embedded-host', '.', 'Agent', 'role');
  const channel = new FakeChannel();
  const runtime = new FakeRuntime();
  const owner = new FakeOwnerLock('owner-1');
  const abort = new AbortController();
  try {
    const running = runHost(config, {
      signal: abort.signal,
      handleProcessSignals: false,
      channel,
      runtime,
      ownerLock: owner,
      log: () => undefined,
    });
    await waitFor(() => {
      const observer = new Store(resolve(root, 'instances', 'embedded-host', 'state.sqlite3'));
      try { return observer.status().hostState === 'running'; } finally { observer.close(); }
    });
    const secondChannel = new FakeChannel();
    await assert.rejects(runHost(config, {
      handleProcessSignals: false,
      channel: secondChannel,
      runtime: new FakeRuntime(),
      ownerLock: new FakeOwnerLock('owner-2'),
      log: () => undefined,
    }), /lease 已被其他 Host 持有/);
    assert.equal(secondChannel.stopped, 0);
    const observer = new Store(resolve(root, 'instances', 'embedded-host', 'state.sqlite3'));
    try { assert.equal(observer.status().hostState, 'running'); } finally { observer.close(); }
    abort.abort();
    await running;
    assert.equal(channel.stopped, 1);
    assert.equal(owner.released, 1);
  } finally {
    if (previous === undefined) delete process.env.AGENT_CHANNEL_HOME;
    else process.env.AGENT_CHANNEL_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('Channel disabled 时 Host 不启动 Channel 且不获取其 owner', async () => {
  const root = resolve('.test-disabled-channel-host');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const previous = process.env.AGENT_CHANNEL_HOME;
  process.env.AGENT_CHANNEL_HOME = root;
  const config = defaultConfig('disabled-channel', '.', 'Agent', 'role');
  config.channel.enabled = false;
  const channel = new FakeChannel();
  const runtime = new FakeRuntime();
  const owner = new FakeOwnerLock('disabled-owner');
  const abort = new AbortController();
  try {
    const running = runHost(config, {
      signal: abort.signal,
      handleProcessSignals: false,
      channel,
      runtime,
      ownerLock: owner,
      log: () => undefined,
    });
    await waitFor(() => {
      const observer = new Store(resolve(root, 'instances', 'disabled-channel', 'state.sqlite3'));
      try { return observer.status().hostState === 'running'; } finally { observer.close(); }
    });
    const observer = new Store(resolve(root, 'instances', 'disabled-channel', 'state.sqlite3'));
    try {
      assert.equal((observer.status().channels as Array<{ state: string }>)[0]?.state, 'disabled');
    } finally {
      observer.close();
    }
    assert.equal(channel.started, 0);
    assert.equal(owner.acquired, 0);
    abort.abort();
    await running;
    assert.equal(channel.stopped, 0);
    assert.equal(owner.released, 0);
  } finally {
    if (previous === undefined) delete process.env.AGENT_CHANNEL_HOME;
    else process.env.AGENT_CHANNEL_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('Channel 订阅范围与新会话默认模式独立，名称优先取群名或人员姓名且已有 mode 不被覆盖', () => {
  const config = defaultConfig('subscription-policy', '.', '翠丝', '负责编辑器答疑');
  const store = new Store(':memory:');
  try {
    const groupEvent = normalizeDwsEvent({
      type: 'user_im_message_receive_group_all', event_id: 'group-policy-1', conversation_id: 'group-policy',
      conversation_title: '编辑器讨论群', content: '问题',
    })!;
    assert.equal(resolveEventConversation(config, store, groupEvent).reason, 'conversation-not-authorized');
    assert.equal(store.listConversations().length, 0);

    config.channel.subscriptions.groups = 'all';
    config.channel.defaultModes.groups = 'reply';
    const auto = resolveEventConversation(config, store, groupEvent);
    assert.equal(auto.reason, 'auto-created');
    assert.equal(auto.conversation?.title, '编辑器讨论群');
    assert.equal(auto.conversation?.responsibility, config.identity.role);
    assert.equal(auto.conversation?.mode, 'reply');
    assert.equal(store.listConversations().length, 1);

    config.channel.defaultModes.groups = 'shadow';
    assert.equal(resolveEventConversation(config, store, groupEvent).conversation?.mode, 'reply');

    store.setConversationEnabled(auto.conversation!.id, false);
    assert.equal(resolveEventConversation(config, store, groupEvent).reason, 'conversation-disabled');
    config.channel.subscriptions.groups = 'none';
    assert.equal(resolveEventConversation(config, store, groupEvent).reason, 'subscription-none');

    const directEvent = normalizeDwsEvent({
      type: 'user_im_message_receive_o2o_all', event_id: 'direct-policy-1',
      sender_open_dingtalk_id: 'direct-policy', sender_name: '同事甲', content: '私聊',
    })!;
    assert.equal(resolveEventConversation(config, store, directEvent).reason, 'conversation-not-authorized');
    config.channel.subscriptions.directs = 'all';
    config.channel.defaultModes.directs = 'reply';
    const direct = resolveEventConversation(config, store, directEvent);
    assert.equal(direct.reason, 'auto-created');
    assert.equal(direct.conversation?.title, '同事甲');
    assert.equal(direct.conversation?.mode, 'reply');

    const anonymous = normalizeDwsEvent({
      type: 'user_im_message_receive_o2o_all', event_id: 'direct-policy-2',
      sender_open_dingtalk_id: 'direct-anonymous', content: '私聊',
    })!;
    const anonymousConversation = resolveEventConversation(config, store, anonymous).conversation!;
    assert.match(anonymousConversation.title, /^私聊 · [0-9a-f]{8}$/);
    assert.doesNotMatch(anonymousConversation.title, /未命名/);
    const namedLater = normalizeDwsEvent({
      type: 'user_im_message_receive_o2o_all', event_id: 'direct-policy-3',
      sender_open_dingtalk_id: 'direct-anonymous', sender_name: '后来取得姓名', content: '再次私聊',
    })!;
    assert.equal(resolveEventConversation(config, store, namedLater).conversation?.title, '后来取得姓名');
  } finally {
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
      contextUpdate: null,
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
