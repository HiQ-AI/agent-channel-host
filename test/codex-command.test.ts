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

const conversation: Conversation = {
  id: 'conversation', channelId: 'dingtalk', channelProfileId: 'default', kind: 'group',
  externalId: 'group', title: '测试群', responsibility: '回答测试问题', mode: 'shadow',
  runtimeId: 'codex', workerWarmSeconds: 30, policyVersion: 1, enabled: true,
  createdAt: '2026-01-01', updatedAt: '2026-01-01',
};

test('结构化决策 fail closed', () => {
  assert.doesNotThrow(() => validateDecision({
    action: 'silent', responsibilityMatch: false, category: 'out_of_scope', replyText: '', reasonCode: 'outside',
    workType: 'discussion', delegation: 'not_required',
    contextUpdate: null,
  }, '- Agent代回'));
  assert.throws(() => validateDecision({
    action: 'reply', responsibilityMatch: true, category: 'question', replyText: '没有签名', reasonCode: 'inside',
    workType: 'discussion', delegation: 'not_required',
    contextUpdate: null,
  }, '- Agent代回'), /必须有正文/);
});

test('新建与 resume 使用同一命令协议并显式携带 session ID', () => {
  const config = defaultConfig('test', '.', 'Agent', 'role');
  const created = buildCodexExecArgs(config, conversation, 'schema.json', 'hello', null);
  assert.deepEqual(created.slice(0, 4), ['exec', '--dangerously-bypass-hook-trust', '--json', '--output-schema']);
  assert.ok(created.includes('--sandbox'));
  assert.ok(created.some((arg) => arg.startsWith('developer_instructions=')));
  const resumed = buildCodexExecArgs(config, conversation, 'schema.json', 'again', 'session-1');
  assert.deepEqual(resumed.slice(0, 5), ['exec', 'resume', '--dangerously-bypass-hook-trust', '--json', '--output-schema']);
  assert.deepEqual(resumed.slice(-2), ['session-1', 'again']);
});

test('JSONL collector 校验精确 resume 并提取结构化结果与执行证据', () => {
  const collector = new CodexJsonlCollector('session-1');
  collector.accept('{"type":"thread.started","thread_id":"session-1"}');
  collector.accept('{"type":"item.completed","item":{"type":"command_execution","command":"git status"}}');
  collector.accept('{"type":"item.completed","item":{"type":"agent_message","text":"{\\"action\\":\\"silent\\"}"}}');
  collector.accept('{"type":"turn.completed"}');
  assert.equal(collector.providerSessionId, 'session-1');
  assert.equal(collector.turnCompleted, true);
  assert.equal(collector.agentMessage, '{"action":"silent"}');
  assert.deepEqual(collector.evidence.mainWorkItems, ['commandexecution']);
  const delegated = new CodexJsonlCollector('session-1');
  delegated.accept('{"type":"item.completed","item":{"id":"spawn-call-1","type":"collab_tool_call","tool":"spawn_agent","status":"completed","receiver_thread_ids":[]}}');
  assert.deepEqual(delegated.evidence.spawnedSubagentCallIds, ['spawn-call-1']);
  assert.deepEqual(delegated.evidence.spawnedSubagentThreadIds, []);
  const failedDelegation = new CodexJsonlCollector('session-1');
  failedDelegation.accept('{"type":"item.completed","item":{"id":"spawn-call-failed","type":"collab_tool_call","tool":"spawn_agent","status":"failed","receiver_thread_ids":[]}}');
  assert.deepEqual(failedDelegation.evidence.spawnedSubagentCallIds, []);
  const waited = new CodexJsonlCollector('session-1');
  waited.accept('{"type":"item.started","item":{"id":"wait-call","type":"collab_tool_call","tool":"wait","status":"in_progress","receiver_thread_ids":[]}}');
  assert.equal(waited.evidence.waitedForSubagent, true);
  const wrong = new CodexJsonlCollector('session-1');
  assert.throws(() => wrong.accept('{"type":"thread.started","thread_id":"session-2"}'), /未精确恢复/);
  assert.throws(() => wrong.accept('not-json'), /非法 JSONL/);
});

test('实施类决策必须有真实后台派发证据且主会话不能等待或直接实施', () => {
  const decision = {
    action: 'reply' as const,
    responsibilityMatch: true,
    category: 'implementation',
    replyText: '已经交给后台 worker 处理，我继续看群。\n\n- Agent代回',
    reasonCode: 'delegated',
    workType: 'implementation' as const,
    delegation: 'started' as const,
    contextUpdate: null,
  };
  assert.doesNotThrow(() => validateDecision(decision, '- Agent代回', {
    spawnedSubagentCallIds: ['spawn-call'], spawnedSubagentThreadIds: [], waitedForSubagent: false, mainWorkItems: [],
  }));
  assert.throws(() => validateDecision(decision, '- Agent代回'), /真实派发/);
  assert.throws(() => validateDecision(decision, '- Agent代回', {
    spawnedSubagentCallIds: ['spawn-call'], spawnedSubagentThreadIds: [], waitedForSubagent: true, mainWorkItems: [],
  }), /不得等待/);
  assert.throws(() => validateDecision(decision, '- Agent代回', {
    spawnedSubagentCallIds: ['spawn-call'], spawnedSubagentThreadIds: [], waitedForSubagent: false, mainWorkItems: ['filechange'],
  }), /禁止直接实施/);
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
    assert.equal(resumed.decision?.category, 'resume');
    assert.equal(second.currentSessionId, 'fake-session-fixed');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('活动命令可取消，超时与非零退出 fail closed', async () => {
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

    config.runtime.turnTimeoutSeconds = 1;
    const timedOut = new CodexCommandSession(config, addFakeConversation(store, 'timeout-user'), identity, store);
    await timedOut.start();
    await assert.rejects(timedOut.runDecision('SLOW'), /超时/);
    assert.equal(timedOut.processId, null);
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
