import type { Decision } from './types.js';

export function validateDecision(value: Decision): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent 返回必须是 JSON object');
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'action' || keys[1] !== 'replyText') {
    throw new Error('Agent 返回只能包含 action 和 replyText');
  }
  if (value.action !== 'silent' && value.action !== 'reply') {
    throw new Error('Agent 返回 action 无效');
  }
  if (typeof value.replyText !== 'string') throw new Error('Agent 返回 replyText 必须是字符串');
  if (value.action === 'silent' && value.replyText !== '') throw new Error('silent 的 replyText 必须为空');
  if (value.action === 'reply' && !value.replyText.trim()) throw new Error('reply 的 replyText 不能为空');
}
