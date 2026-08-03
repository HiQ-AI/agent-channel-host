import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultConfig } from '../src/config.js';
import {
  buildCodexExecArgs, CodexCommandSession, CodexJsonlCollector, type CodexCommandIdentity,
} from '../src/codex-command.js';
import { validateDecision } from '../src/decision.js';
import { Store } from '../src/store.js';
import type { Conversation } from '../src/types.js';

test('结构化决策 fail closed', () => {
  assert.doesNotThrow(() => validateDecision({ action: 'silent', replyText: '' }));
  assert.doesNotThrow(() => validateDecision({ action: 'reply', replyText: '无需 Host 签名约束' }));
  assert.throws(() => validateDecision({ action: 'silent', replyText: '不应有正文' }), /必须为空/);
  assert.throws(() => validateDecision({
    action: 'reply', replyText: '正文', category: 'Host 不应要求的字段',
  } as never), /只能包含/);
});

test('新建与 resume 使用同一命令协议并显式携带 session ID', () => {
  const config = defaultConfig('test', '.', 'Agent', 'role');
  const created = buildCodexExecArgs(config, 'schema.json', 'hello', null);
  assert.deepEqual(created.slice(0, 3), ['exec', '--json', '--output-schema']);
  assert.equal(created.some((arg) => arg.includes('approval_policy')), false);
  assert.equal(created.some((arg) => arg.includes('sandbox_mode')), false);
  assert.equal(created.some((arg) => arg.includes('network_access')), false);
  assert.equal(created.includes('--sandbox'), false);
  assert.equal(created.some((arg) => arg.includes('developer_instructions')), false);
  assert.equal(created.some((arg) => arg.includes('hooks.SessionStart')), false);
  const resumed = buildCodexExecArgs(config, 'schema.json', 'again', 'session-1');
  assert.deepEqual(resumed.slice(0, 4), ['exec', 'resume', '--json', '--output-schema']);
  assert.deepEqual(resumed.slice(-2), ['session-1', 'again']);
});

test('JSONL collector 校验精确 resume；Agent 工具事件不影响最小返回', () => {
  const collector = new CodexJsonlCollector('session-1');
  collector.accept('{"type":"thread.started","thread_id":"session-1"}');
  collector.accept('{"type":"item.completed","item":{"type":"command_execution","command":"git status"}}');
  collector.accept('{"type":"item.completed","item":{"type":"agent_message","text":"{\\"action\\":\\"silent\\",\\"replyText\\":\\"\\"}"}}');
  collector.accept('{"type":"turn.completed"}');
  assert.equal(collector.providerSessionId, 'session-1');
  assert.equal(collector.turnCompleted, true);
  assert.equal(collector.agentMessage, '{"action":"silent","replyText":""}');
  const wrong = new CodexJsonlCollector('session-1');
  assert.throws(() => wrong.accept('{"type":"thread.started","thread_id":"session-2"}'), /未精确恢复/);
  assert.throws(() => wrong.accept('not-json'), /非法 JSONL/);
});

test('命令进程退出后以同一 provider session ID 精确 resume', async () => {
  const root = resolve('.test-codex-command-state');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const store = new Store(resolve(root, 'state.sqlite3'));
  const config = defaultConfig('command-test', process.cwd(), 'Agent', 'role');
  const identity = fakeIdentity();
  try {
    const stored = addFakeConversation(store, 'resume-user');
    const first = new CodexCommandSession(config, stored, identity, store);
    assert.deepEqual(await first.start(), { mode: 'new', providerSessionId: null });
    assert.equal((await first.runDecision('first')).status, 'completed');
    assert.equal(first.currentSessionId, 'fake-session-fixed');
    assert.equal(first.processId, null);
    assert.equal(store.getSession(stored.id)?.lifecycle, 'ready');

    const second = new CodexCommandSession(config, stored, identity, store);
    assert.deepEqual(await second.start(), { mode: 'resumed', providerSessionId: 'fake-session-fixed' });
    const resumed = await second.runDecision('second');
    assert.deepEqual(resumed.decision, { action: 'silent', replyText: '' });
    assert.equal(second.currentSessionId, 'fake-session-fixed');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('协议不兼容时提升 generation 并新建 session，不向旧 transcript 重灌指令', async () => {
  const root = resolve('.test-codex-command-rotation-state');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const store = new Store(resolve(root, 'state.sqlite3'));
  const config = defaultConfig('command-rotation', process.cwd(), 'Agent', 'role');
  const identity = fakeIdentity();
  try {
    const stored = addFakeConversation(store, 'rotation-user');
    store.saveSession({
      conversationId: stored.id,
      runtimeId: 'codex',
      providerSessionId: 'old-provider-session',
      generation: 1,
      lifecycle: 'ready',
      protocolFingerprint: 'old-protocol',
      runtimeCwd: config.runtime.cwd,
      bootstrapTurnId: 'old-turn',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    });
    const session = new CodexCommandSession(config, stored, identity, store);
    assert.deepEqual(await session.start(), { mode: 'new', providerSessionId: null });
    assert.equal(store.getSession(stored.id), null);
    assert.equal(store.getConversation(stored.id)?.sessionGeneration, 2);
    await session.runDecision('new-generation');
    assert.equal(store.getSession(stored.id)?.providerSessionId, 'fake-session-fixed');
    assert.equal(store.getSession(stored.id)?.generation, 2);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('活动命令可取消，且非零退出 fail closed', async () => {
  const root = resolve('.test-codex-command-failure-state');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const store = new Store(resolve(root, 'state.sqlite3'));
  const config = defaultConfig('command-failure', process.cwd(), 'Agent', 'role');
  const identity = fakeIdentity();
  try {
    const interrupted = new CodexCommandSession(config, addFakeConversation(store, 'interrupt-user'), identity, store);
    await interrupted.start();
    const active = interrupted.runDecision('SLOW');
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    assert.notEqual(interrupted.processId, null);
    assert.equal(await interrupted.interruptActive(), true);
    assert.equal((await active).status, 'interrupted');
    assert.equal(interrupted.processId, null);

    const failed = new CodexCommandSession(config, addFakeConversation(store, 'failed-user'), identity, store);
    await failed.start();
    await assert.rejects(failed.runDecision('FAIL'), /退出异常：code=7.*simulated failure/);

    (config.runtime as unknown as Record<string, unknown>).turnTimeoutSeconds = 1;
    const noTurnTimeout = new CodexCommandSession(config, addFakeConversation(store, 'no-timeout-user'), identity, store);
    await noTurnTimeout.start();
    assert.equal((await noTurnTimeout.runDecision('SLOW_SHORT')).status, 'completed');

  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

function fakeIdentity(): CodexCommandIdentity {
  return {
    version: 'codex-cli 0.145.0',
    fingerprint: 'codex-cli 0.145.0:exec-jsonl-v1:test',
    command: {
      kind: 'node-script',
      file: process.execPath,
      target: resolve('test', 'fixtures', 'fake-codex.mjs'),
    },
    decisionSchemaPath: resolve('schemas', 'decision-output.schema.json'),
  };
}

function addFakeConversation(store: Store, externalId: string): Conversation {
  return store.addConversation({
    kind: 'direct', externalId, title: externalId, responsibility: '测试', mode: 'shadow',
    channelId: 'dingtalk', channelProfileId: 'default', runtimeId: 'codex', workerWarmSeconds: 0,
  });
}
