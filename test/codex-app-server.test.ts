import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { defaultConfig } from '../src/config.js';
import { CodexAppServerSession, type CodexAppServerIdentity } from '../src/codex-app-server.js';
import { CodexAppServerHost } from '../src/codex-app-server-host.js';
import { Store } from '../src/store.js';

const fakeCodex = resolve('test', 'fixtures', 'fake-codex.mjs');

test('后台 App Server 新建与恢复 thread 均固定完全访问且永不询问', async () => {
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'non-interactive-user', title: '后台私聊', responsibility: '', mode: 'reply',
  });
  const config = defaultConfig('non-interactive', '.', 'Agent');
  const identity = fakeIdentity();
  const appServer = await CodexAppServerHost.start(config, identity);

  const first = new CodexAppServerSession(config, conversation, identity, store, appServer);
  await first.start();
  assert.equal((await first.deliver('普通消息')).status, 'completed');
  const sessionId = first.currentSessionId;
  await first.stop();

  const resumed = new CodexAppServerSession(config, conversation, identity, store, appServer);
  await resumed.start();
  assert.equal(resumed.currentSessionId, sessionId);
  assert.equal((await resumed.deliver('恢复消息')).status, 'completed');
  await resumed.stop();
  await appServer.stop();
  store.close();
});

test('后台 App Server 意外发出审批请求时立即失败，不悬挂 turn', async () => {
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'approval-user', title: '审批私聊', responsibility: '', mode: 'reply',
  });
  const config = defaultConfig('approval', '.', 'Agent');
  const identity = fakeIdentity();
  const appServer = await CodexAppServerHost.start(config, identity);
  const session = new CodexAppServerSession(config, conversation, identity, store, appServer);
  await session.start();
  const startedAt = Date.now();
  await assert.rejects(session.deliver('APPROVAL_REQUEST'), /禁止交互请求：item\/commandExecution\/requestApproval/);
  assert.ok(Date.now() - startedAt < 2_000, '审批请求应立即失败');
  await session.stop();
  await appServer.stop();
  store.close();
});

test('活动 turn steer 原样携带 expectedTurnId 与 clientUserMessageId', async () => {
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'steer-user', title: '介入私聊', responsibility: '', mode: 'reply',
  });
  const config = defaultConfig('steer', '.', 'Agent');
  const identity = fakeIdentity();
  const appServer = await CodexAppServerHost.start(config, identity);
  const session = new CodexAppServerSession(config, conversation, identity, store, appServer);
  try {
    await session.start();
    const delivery = session.deliver('ACTIVE_STEER');
    await waitFor(() => session.currentTurnId === 'fake-turn');
    assert.deepEqual(
      await session.steer('调整方向', 'fake-turn', 'human-request-app-server'),
      { turnId: 'fake-turn' },
    );
    await assert.rejects(session.steer('过期方向', 'stale-turn', 'ignored'), /活动 turn 已变化/);
    assert.equal((await delivery).status, 'completed');
  } finally {
    await session.stop();
    await appServer.stop();
    store.close();
  }
});

test('空闲 thread 启动 turn 原样携带 clientUserMessageId 并立即返回 turnId', async () => {
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'start-user', title: '空闲启动私聊', responsibility: '', mode: 'reply',
  });
  const config = defaultConfig('start-turn', '.', 'Agent');
  const identity = fakeIdentity();
  const appServer = await CodexAppServerHost.start(config, identity);
  const session = new CodexAppServerSession(config, conversation, identity, store, appServer);
  try {
    await session.start();
    const started = await session.startTurn('HUMAN_START', 'human-start-request');
    assert.equal(started.turnId, 'fake-turn');
    assert.deepEqual(await started.completion, { turnId: 'fake-turn', status: 'completed' });
    assert.equal(session.currentTurnId, null);
  } finally {
    await session.stop();
    await appServer.stop();
    store.close();
  }
});

test('协议升级后仍恢复 Conversation 原 session 且 generation 不变', async () => {
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'generation-user', title: '版本升级私聊', responsibility: '', mode: 'reply',
  });
  const now = new Date().toISOString();
  store.saveSession({
    conversationId: conversation.id,
    runtimeId: 'codex',
    providerSessionId: 'old-session',
    generation: 1,
    lifecycle: 'ready',
    protocolFingerprint: 'old-fingerprint',
    runtimeCwd: resolve('.'),
    bootstrapTurnId: null,
    createdAt: now,
    updatedAt: now,
  });
  const config = defaultConfig('generation', '.', 'Agent');
  const identity = fakeIdentity();
  const appServer = await CodexAppServerHost.start(config, identity);
  const session = new CodexAppServerSession(config, conversation, identity, store, appServer);
  try {
    await session.start();
    assert.equal(store.getConversation(conversation.id)?.sessionGeneration, 1);
    assert.equal(store.getSession(conversation.id)?.generation, 1);
    assert.equal(store.getSession(conversation.id)?.providerSessionId, 'old-session');
  } finally {
    await session.stop();
    await appServer.stop();
    store.close();
  }
});

test('两个 Conversation 共用一个 WebSocket App Server，临时客户端断开不影响活动 turn', async () => {
  const store = new Store(':memory:');
  const firstConversation = store.addConversation({
    kind: 'direct', externalId: 'parallel-a', title: '并行 A', responsibility: '', mode: 'reply',
  });
  const secondConversation = store.addConversation({
    kind: 'direct', externalId: 'parallel-b', title: '并行 B', responsibility: '', mode: 'reply',
  });
  const now = new Date().toISOString();
  for (const [conversation, threadId] of [[firstConversation, 'parallel-thread-a'], [secondConversation, 'parallel-thread-b']] as const) {
    store.saveSession({
      conversationId: conversation.id, runtimeId: 'codex', providerSessionId: threadId,
      generation: 1, lifecycle: 'ready', protocolFingerprint: 'test', runtimeCwd: resolve('.'),
      bootstrapTurnId: null, createdAt: now, updatedAt: now,
    });
  }
  const config = defaultConfig('parallel', '.', 'Agent');
  const identity = fakeIdentity();
  const appServer = await CodexAppServerHost.start(config, identity);
  const first = new CodexAppServerSession(config, firstConversation, identity, store, appServer);
  const second = new CodexAppServerSession(config, secondConversation, identity, store, appServer);
  try {
    await Promise.all([first.start(), second.start()]);
    assert.equal(first.processId, appServer.processId);
    assert.equal(second.processId, appServer.processId);
    const firstDelivery = first.deliver('ACTIVE_STEER');
    const secondDelivery = second.deliver('ACTIVE_STEER');
    await waitFor(() => first.currentTurnId !== null && second.currentTurnId !== null);
    assert.notEqual(first.currentTurnId, second.currentTurnId);
    const temporaryMessages: Array<Record<string, unknown>> = [];
    const temporary = await appServer.connect(
      (message) => temporaryMessages.push(JSON.parse(message) as Record<string, unknown>),
      () => undefined,
    );
    temporary.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'temporary', version: '1' } } }));
    await waitFor(() => temporaryMessages.some((message) => message.id === 1));
    temporary.send(JSON.stringify({ method: 'initialized', params: {} }));
    temporary.send(JSON.stringify({ id: 2, method: 'thread/read', params: { threadId: first.currentSessionId } }));
    await waitFor(() => temporaryMessages.some((message) => message.id === 2));
    temporary.send(JSON.stringify({
      id: 3, method: 'turn/steer', params: {
        threadId: first.currentSessionId, expectedTurnId: first.currentTurnId,
        input: [{ type: 'text', text: '临时客户端纠偏' }], clientUserMessageId: 'temporary-message',
      },
    }));
    await waitFor(() => temporaryMessages.some((message) => message.id === 3));
    assert.deepEqual(temporaryMessages.find((message) => message.id === 3)?.result, {
      turnId: 'turn-parallel-thread-a',
    });
    temporary.close();
    assert.deepEqual(await Promise.all([firstDelivery, secondDelivery]), [
      { turnId: 'turn-parallel-thread-a', status: 'completed' },
      { turnId: 'turn-parallel-thread-b', status: 'completed' },
    ]);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
    await appServer.stop();
    store.close();
  }
});

function fakeIdentity(): CodexAppServerIdentity {
  return {
    version: 'fake-codex',
    fingerprint: 'fake-codex:app-server-v1-turn-steer',
    command: { kind: 'node-script', file: process.execPath, target: fakeCodex },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待条件超时');
}
