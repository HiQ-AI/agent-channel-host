import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { defaultConfig } from '../src/config.js';
import { CodexAppServerSession, type CodexAppServerIdentity } from '../src/codex-app-server.js';
import { Store } from '../src/store.js';

const fakeCodex = resolve('test', 'fixtures', 'fake-codex.mjs');

test('后台 App Server 新建与恢复 thread 均固定完全访问且永不询问', async () => {
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'non-interactive-user', title: '后台私聊', responsibility: '', mode: 'reply',
  });
  const config = defaultConfig('non-interactive', '.', 'Agent');
  const identity = fakeIdentity();

  const first = new CodexAppServerSession(config, conversation, identity, store);
  await first.start();
  assert.equal((await first.deliver('普通消息')).status, 'completed');
  const activity = first.readActivity();
  assert.deepEqual(activity.entries.map(({ kind, label }) => ({ kind, label })), [
    { kind: 'status', label: '状态' }, { kind: 'reasoning', label: '思考摘要' },
    { kind: 'tool', label: '命令' }, { kind: 'assistant', label: 'Agent' },
    { kind: 'status', label: '状态' },
  ]);
  assert.equal(activity.entries[2]?.result, 'tests passed');
  const sessionId = first.currentSessionId;
  await first.stop();

  const resumed = new CodexAppServerSession(config, conversation, identity, store);
  await resumed.start();
  assert.equal(resumed.currentSessionId, sessionId);
  assert.equal((await resumed.deliver('恢复消息')).status, 'completed');
  await resumed.stop();
  store.close();
});

test('后台 App Server 意外发出审批请求时立即失败，不悬挂 turn', async () => {
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'approval-user', title: '审批私聊', responsibility: '', mode: 'reply',
  });
  const session = new CodexAppServerSession(defaultConfig('approval', '.', 'Agent'), conversation, fakeIdentity(), store);
  await session.start();
  const startedAt = Date.now();
  await assert.rejects(session.deliver('APPROVAL_REQUEST'), /禁止交互请求：item\/commandExecution\/requestApproval/);
  assert.ok(Date.now() - startedAt < 2_000, '审批请求应立即失败');
  await session.stop();
  store.close();
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
  const session = new CodexAppServerSession(defaultConfig('generation', '.', 'Agent'), conversation, fakeIdentity(), store);
  try {
    await session.start();
    assert.equal(store.getConversation(conversation.id)?.sessionGeneration, 1);
    assert.equal(store.getSession(conversation.id)?.generation, 1);
    assert.equal(store.getSession(conversation.id)?.providerSessionId, 'old-session');
  } finally {
    await session.stop();
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
