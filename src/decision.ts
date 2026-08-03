import type { ConversationContextUpdate, Decision } from './types.js';

export interface TurnEvidence {
  spawnedSubagentCallIds: string[];
  spawnedSubagentThreadIds: string[];
  waitedForSubagent: boolean;
  mainWorkItems: string[];
}

export function emptyTurnEvidence(): TurnEvidence {
  return { spawnedSubagentCallIds: [], spawnedSubagentThreadIds: [], waitedForSubagent: false, mainWorkItems: [] };
}

export function validateDecision(value: Decision, signature: string, evidence = emptyTurnEvidence()): void {
  if (!value || typeof value !== 'object' || !['silent', 'reply', 'escalate'].includes(value.action)) {
    throw new Error('Agent 决策 action 无效');
  }
  if (typeof value.responsibilityMatch !== 'boolean' || typeof value.category !== 'string'
    || typeof value.replyText !== 'string' || typeof value.reasonCode !== 'string'
    || !['discussion', 'implementation'].includes(value.workType)
    || !['not_required', 'started'].includes(value.delegation)) {
    throw new Error('Agent 决策字段类型无效');
  }
  validateContextUpdate(value.contextUpdate);
  if (value.action === 'silent' && value.replyText !== '') throw new Error('silent 决策 replyText 必须为空');
  if (value.action !== 'silent' && (!value.replyText.trim() || !value.replyText.trimEnd().endsWith(signature))) {
    throw new Error(`非 silent 决策必须有正文并以“${signature}”结尾`);
  }
  if (evidence.mainWorkItems.length > 0) {
    throw new Error(`主会话禁止直接实施：${evidence.mainWorkItems.join(',')}`);
  }
  if (value.workType === 'implementation') {
    const actuallyDelegated = evidence.spawnedSubagentCallIds.length > 0 || evidence.spawnedSubagentThreadIds.length > 0;
    if (value.delegation !== 'started' || !actuallyDelegated) {
      throw new Error('实施类决策必须真实派发后台 subagent');
    }
    if (value.action !== 'reply') throw new Error('派发后台 subagent 后必须立即回复接手状态');
    if (evidence.waitedForSubagent) throw new Error('主会话派发后不得等待后台 subagent 完成');
  } else if (value.delegation !== 'not_required'
    || evidence.spawnedSubagentCallIds.length > 0
    || evidence.spawnedSubagentThreadIds.length > 0) {
    throw new Error('讨论类决策不得伪造或启动实施委派');
  }
}

function validateContextUpdate(value: ConversationContextUpdate | null): void {
  if (value === null) return;
  if (!value || typeof value !== 'object' || typeof value.currentTopic !== 'string') {
    throw new Error('contextUpdate 格式无效');
  }
  if (value.currentTopic.length > 300) throw new Error('contextUpdate.currentTopic 过长');
  let total = value.currentTopic.length;
  for (const [name, items] of Object.entries({
    facts: value.facts,
    decisions: value.decisions,
    commitments: value.commitments,
    openQuestions: value.openQuestions,
  })) {
    if (!Array.isArray(items) || items.length > 20 || items.some((item) => typeof item !== 'string' || item.length > 500)) {
      throw new Error(`contextUpdate.${name} 无效`);
    }
    total += items.reduce((sum, item) => sum + item.length, 0);
  }
  if (total > 8_000) throw new Error('contextUpdate 总长度超过 8000 字符');
}
