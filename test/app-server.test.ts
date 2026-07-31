import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDecision } from '../src/app-server.js';

test('结构化决策 fail closed', () => {
  assert.doesNotThrow(() => validateDecision({
    action: 'silent', responsibilityMatch: false, category: 'out_of_scope', replyText: '', reasonCode: 'outside',
  }, '- Agent代回'));
  assert.throws(() => validateDecision({
    action: 'reply', responsibilityMatch: true, category: 'question', replyText: '没有签名', reasonCode: 'inside',
  }, '- Agent代回'), /必须有正文/);
});
