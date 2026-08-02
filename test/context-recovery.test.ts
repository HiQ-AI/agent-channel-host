import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultConfig } from '../src/config.js';
import { promptForSession } from '../src/codex-command.js';
import { normalizeDwsEvent } from '../src/dws.js';
import { batchPrompt, developerInstructions } from '../src/prompts.js';
import { publishRecoveryContext, readRecoveryContext } from '../src/recovery-context.js';
import { Store } from '../src/store.js';

test('checkpoint 与 batch decision 同步提交并按 sequence 版本化', () => {
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'member-1', title: '上下文私聊', responsibility: '回答问题', mode: 'shadow',
  });
  try {
    const admitted = store.admitEvent(conversation, normalizeDwsEvent({
      type: 'user_im_message_receive_o2o_all', event_id: 'context-1',
      sender_open_dingtalk_id: 'member-1', sender_name: '成员甲', content: '结论是采用方案 A',
    })!).event!;
    const claimed = store.claimPendingEvents(conversation, 'worker-1', 20);
    assert.equal(claimed.length, 1);
    store.recordBatchDecision(claimed, 'worker-1', 'turn-1', 'completed', {
      action: 'silent', responsibilityMatch: true, category: 'decision', replyText: '',
      reasonCode: 'recorded', workType: 'discussion', delegation: 'not_required',
      contextUpdate: {
        currentTopic: '编辑器方案', facts: ['方案 A 已完成评审'], decisions: ['采用方案 A'],
        commitments: ['成员甲明天补充数据'], openQuestions: ['上线日期未定'],
      },
    });
    assert.equal(store.status().processed, 1);
    assert.deepEqual(store.getConversationContext(conversation.id), {
      conversationId: conversation.id,
      version: 1,
      throughSequence: admitted.sequence,
      currentTopic: '编辑器方案',
      facts: ['方案 A 已完成评审'],
      decisions: ['采用方案 A'],
      commitments: ['成员甲明天补充数据'],
      openQuestions: ['上线日期未定'],
      updatedAt: store.getConversationContext(conversation.id)!.updatedAt,
    });
  } finally {
    store.close();
  }
});

test('成员资料独立更新，batch 只注入发送者和正文明确提到的成员', () => {
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'group', externalId: 'group-context', title: '成员群', responsibility: '讨论方案', mode: 'shadow',
  });
  try {
    const first = store.admitEvent(conversation, normalizeDwsEvent({
      type: 'user_im_message_receive_group_all', event_id: 'member-event-1', conversation_id: 'group-context',
      sender_open_dingtalk_id: 'member-1', sender_name: '成员甲', content: '请成员乙补充边界',
    })!).event!;
    store.updateConversationMember(conversation.id, 'member-1', { organizationRole: '产品经理' });
    store.updateConversationMember(conversation.id, 'member-2', {
      displayName: '成员乙', conversationRole: '编辑器负责人', responsibilityBoundary: '负责需求评审',
    });
    store.updateConversationMember(conversation.id, 'member-3', { displayName: '成员丙', organizationRole: '观察者' });
    const relevant = store.findRelevantMembers(conversation.id, [first]);
    assert.deepEqual(new Set(relevant.map((item) => item.displayName)), new Set(['成员甲', '成员乙']));
    const prompt = batchPrompt([first], relevant);
    assert.match(prompt, /产品经理/);
    assert.match(prompt, /编辑器负责人/);
    assert.doesNotMatch(prompt, /成员丙|观察者/);
  } finally {
    store.close();
  }
});

test('新 session 注入 checkpoint，普通 resume 不重复注入', () => {
  const config = defaultConfig('prompt-recovery', '.', 'Agent', '角色');
  const conversation = {
    ...newConversation(),
    responsibility: '回答编辑器问题',
  };
  const context = {
    conversationId: conversation.id,
    version: 3,
    throughSequence: 8,
    currentTopic: '编辑器性能',
    facts: ['复现条件已确认'],
    decisions: [],
    commitments: [],
    openQuestions: ['根因待确认'],
    updatedAt: '2026-08-02T00:00:00.000Z',
  };
  assert.match(promptForSession(config, conversation, context, '当前消息', null), /checkpoint 版本：3[\s\S]*当前消息/);
  assert.equal(promptForSession(config, conversation, context, '当前消息', 'session-1'), '当前消息');
  const instructions = developerInstructions(config, conversation);
  for (const section of ['# 身份', '# 决策', '# 权限', '# 输出']) assert.match(instructions, new RegExp(section));
  assert.doesNotMatch(instructions, /尽量|酌情|视情况/);
});

test('Codex compact hook 只在 compact 事件注入当前 recovery context', async () => {
  const root = resolve('.test-context-hook');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const store = new Store(resolve(root, 'state.sqlite3'));
  const config = defaultConfig('hook-test', '.', 'Agent', '角色');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'hook-member', title: 'Hook 私聊', responsibility: '回答问题', mode: 'shadow',
  });
  try {
    const path = await publishRecoveryContext(config, conversation, store);
    assert.equal((await readRecoveryContext(path)).contextVersion, 0);
    const output = await runHook(path, { hook_event_name: 'SessionStart', source: 'compact' });
    const body = JSON.parse(output) as { hookSpecificOutput: { additionalContext: string } };
    assert.match(body.hookSpecificOutput.additionalContext, /Host 恢复状态/);
    assert.match(body.hookSpecificOutput.additionalContext, /策略版本：1/);
    assert.equal(await runHook(path, { hook_event_name: 'SessionStart', source: 'resume' }), '');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

function newConversation() {
  return {
    id: 'conversation', channelId: 'dingtalk', channelProfileId: 'default', kind: 'group' as const,
    externalId: 'group', title: '测试群', responsibility: '职责', mode: 'shadow' as const,
    runtimeId: 'codex', workerWarmSeconds: 30, policyVersion: 1, enabled: true,
    createdAt: '2026-08-02', updatedAt: '2026-08-02',
  };
}

async function runHook(path: string, event: Record<string, unknown>): Promise<string> {
  const hook = resolve('dist', 'src', 'codex-compaction-hook.js');
  const child = spawn(process.execPath, [hook], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_CHANNEL_RECOVERY_CONTEXT: path },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.stdin.end(JSON.stringify(event));
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  assert.equal(code, 0, stderr);
  return stdout;
}
