import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDecision } from '../src/app-server.js';

test('结构化决策 fail closed', () => {
  assert.doesNotThrow(() => validateDecision({
    action: 'silent', responsibilityMatch: false, category: 'out_of_scope', replyText: '', reasonCode: 'outside',
    workType: 'discussion', delegation: 'not_required',
  }, '- Agent代回'));
  assert.throws(() => validateDecision({
    action: 'reply', responsibilityMatch: true, category: 'question', replyText: '没有签名', reasonCode: 'inside',
    workType: 'discussion', delegation: 'not_required',
  }, '- Agent代回'), /必须有正文/);
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
  };
  assert.doesNotThrow(() => validateDecision(decision, '- Agent代回', {
    spawnedSubagentThreadIds: ['child-thread'], waitedForSubagent: false, mainWorkItems: [],
  }));
  assert.throws(() => validateDecision(decision, '- Agent代回'), /真实派发/);
  assert.throws(() => validateDecision(decision, '- Agent代回', {
    spawnedSubagentThreadIds: ['child-thread'], waitedForSubagent: true, mainWorkItems: [],
  }), /不得等待/);
  assert.throws(() => validateDecision(decision, '- Agent代回', {
    spawnedSubagentThreadIds: ['child-thread'], waitedForSubagent: false, mainWorkItems: ['fileChange'],
  }), /禁止直接实施/);
});
