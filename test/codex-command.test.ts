import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultConfig } from '../src/config.js';
import {
  buildCodexExecArgs, CodexCommandSession, CodexJsonlCollector, type CodexCommandIdentity,
} from '../src/codex-command.js';
import { Store } from '../src/store.js';
import type { Conversation } from '../src/types.js';

test('新建与 resume 使用同一命令协议并显式携带 session ID', () => {
  const config = defaultConfig('test', '.', 'Agent');
  const created = buildCodexExecArgs(config, 'hello', null);
  assert.deepEqual(created.slice(0, 2), ['exec', '--json']);
  assert.equal(created.includes('--output-schema'), false);
  assert.equal(created.some((arg) => arg.includes('approval_policy')), false);
  assert.equal(created.some((arg) => arg.includes('sandbox_mode')), false);
  assert.equal(created.some((arg) => arg.includes('network_access')), false);
  assert.equal(created.includes('--sandbox'), false);
  assert.equal(created.some((arg) => arg.includes('developer_instructions')), false);
  assert.equal(created.some((arg) => arg.includes('hooks.SessionStart')), false);
  const resumed = buildCodexExecArgs(config, 'again', 'session-1');
  assert.deepEqual(resumed.slice(0, 3), ['exec', 'resume', '--json']);
  assert.deepEqual(resumed.slice(-2), ['session-1', 'again']);
});

test('命令参数不覆盖 runtime 的 developer instructions', () => {
  const config = defaultConfig('responsibility-prefix', '.', '仅本地名称');
  const args = buildCodexExecArgs(config, '本轮消息正文', 'session-1');
  assert.equal(args.some((arg) => arg.startsWith('developer_instructions=')), false);
  assert.deepEqual(args.slice(-2), ['session-1', '本轮消息正文']);
});

test('JSONL collector 校验精确 resume且忽略 Agent 输出内容', () => {
  const collector = new CodexJsonlCollector('session-1');
  collector.accept('{"type":"thread.started","thread_id":"session-1"}');
  collector.accept('{"type":"item.completed","item":{"type":"command_execution","command":"git status"}}');
  collector.accept('{"type":"item.completed","item":{"type":"agent_message","text":"{\\"action\\":\\"silent\\",\\"replyText\\":\\"\\"}"}}');
  collector.accept('{"type":"turn.completed"}');
  assert.equal(collector.providerSessionId, 'session-1');
  assert.equal(collector.turnCompleted, true);
  const wrong = new CodexJsonlCollector('session-1');
  assert.throws(() => wrong.accept('{"type":"thread.started","thread_id":"session-2"}'), /未精确恢复/);
  assert.throws(() => wrong.accept('not-json'), /非法 JSONL/);
});

test('命令进程退出后以同一 provider session ID 精确 resume', async () => {
  const root = resolve('.test-codex-command-state');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const store = new Store(resolve(root, 'state.sqlite3'));
  const config = defaultConfig('command-test', process.cwd(), 'Agent');
  const identity = fakeIdentity();
  try {
    const stored = addFakeConversation(store, 'resume-user');
    const first = new CodexCommandSession(config, stored, identity, store);
    assert.deepEqual(await first.start(), { mode: 'new', providerSessionId: null });
    assert.equal((await first.deliver('first')).status, 'completed');
    assert.equal(first.currentSessionId, 'fake-session-fixed');
    assert.equal(first.processId, null);
    assert.equal(store.getSession(stored.id)?.lifecycle, 'ready');

    const second = new CodexCommandSession(config, stored, identity, store);
    assert.deepEqual(await second.start(), { mode: 'resumed', providerSessionId: 'fake-session-fixed' });
    const resumed = await second.deliver('second');
    assert.equal(resumed.status, 'completed');
    assert.equal(second.currentSessionId, 'fake-session-fixed');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('会话职责在首轮、每 5 个已完成 turn 和变更后首轮提醒，失败不推进周期', async () => {
  const root = resolve('.test-codex-responsibility-reminder-state');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const store = new Store(resolve(root, 'state.sqlite3'));
  const config = defaultConfig('responsibility-reminder', process.cwd(), 'Agent');
  const conversation = addFakeConversation(store, 'responsibility-user');
  const session = new CodexCommandSession(config, conversation, fakeIdentity(), store);
  const marker = '只负责方案与分析';
  store.setConversationResponsibility(conversation.id, marker);
  try {
    await session.start();
    const prompts: string[] = [];
    for (let turn = 1; turn <= 6; turn += 1) {
      const result = await session.deliver(`ECHO_PROMPT turn-${turn}`);
      prompts.push(result.status);
    }
    assert.deepEqual(prompts, Array(6).fill('completed'));

    store.setConversationResponsibility(conversation.id, '更新后的职责');
    const changed = await session.deliver('ECHO_PROMPT changed');
    assert.equal(changed.status, 'completed');

    store.setConversationResponsibility(conversation.id, '失败后仍需提醒');
    await assert.rejects(session.deliver('FAIL'), /退出异常/);
    const retried = await session.deliver('ECHO_PROMPT retry');
    assert.equal(retried.status, 'completed');

    store.setConversationResponsibility(conversation.id, '');
    const empty = await session.deliver('ECHO_PROMPT empty');
    assert.equal(empty.status, 'completed');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('协议、版本或 cwd 变化时仍精确恢复 Conversation 原 session', async () => {
  const root = resolve('.test-codex-command-rotation-state');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const store = new Store(resolve(root, 'state.sqlite3'));
  const config = defaultConfig('command-rotation', process.cwd(), 'Agent');
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
      runtimeCwd: resolve('old-cwd'),
      bootstrapTurnId: 'old-turn',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    });
    const session = new CodexCommandSession(config, stored, identity, store);
    assert.deepEqual(await session.start(), { mode: 'resumed', providerSessionId: 'old-provider-session' });
    assert.equal(store.getConversation(stored.id)?.sessionGeneration, 1);
    await session.deliver('resume-original');
    assert.equal(store.getSession(stored.id)?.providerSessionId, 'old-provider-session');
    assert.equal(store.getSession(stored.id)?.generation, 1);
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
  const config = defaultConfig('command-failure', process.cwd(), 'Agent');
  const identity = fakeIdentity();
  try {
    const interrupted = new CodexCommandSession(config, addFakeConversation(store, 'interrupt-user'), identity, store);
    await interrupted.start();
    const active = interrupted.deliver('SLOW');
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    assert.notEqual(interrupted.processId, null);
    assert.equal(await interrupted.interruptActive(), true);
    assert.equal((await active).status, 'interrupted');
    assert.equal(interrupted.processId, null);

    const failed = new CodexCommandSession(config, addFakeConversation(store, 'failed-user'), identity, store);
    await failed.start();
    await assert.rejects(failed.deliver('FAIL'), /退出异常：code=7.*simulated failure/);

    (config.runtime as unknown as Record<string, unknown>).turnTimeoutSeconds = 1;
    const noTurnTimeout = new CodexCommandSession(config, addFakeConversation(store, 'no-timeout-user'), identity, store);
    await noTurnTimeout.start();
    assert.equal((await noTurnTimeout.deliver('SLOW_SHORT')).status, 'completed');

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
  };
}

function addFakeConversation(store: Store, externalId: string): Conversation {
  return store.addConversation({
    kind: 'direct', externalId, title: externalId, responsibility: '测试', mode: 'shadow',
    channelId: 'dingtalk', channelProfileId: 'default', runtimeId: 'codex', workerWarmSeconds: 0,
  });
}
