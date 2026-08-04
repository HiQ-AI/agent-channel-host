import type { AdmittedEvent, Conversation } from './types.js';
import type { RecentMessage } from './dws.js';

interface MessageEnvelope {
  sender: string;
  time: string;
  content: string;
}

export function conversationResponsibilityReminder(responsibility: string): string | null {
  const value = responsibility.trim();
  return value ? `# 会话职责提醒\n${value}` : null;
}

export function prependResponsibilityReminder(prompt: string, responsibility: string): string {
  const reminder = conversationResponsibilityReminder(responsibility);
  return reminder ? `${reminder}\n\n${prompt}` : prompt;
}

export function batchPrompt(conversation: Conversation, events: AdmittedEvent[]): string {
  return messagePrompt(conversation, events.map((event) => ({
    sender: event.senderName ?? event.senderId ?? '未知',
    time: event.occurredAt ?? event.receivedAt,
    content: messageContent(event.content, event.quotedMessage, event.forwardedMessages),
  })));
}

export function recentMessagesPrompt(conversation: Conversation, messages: RecentMessage[]): string {
  return messagePrompt(conversation, messages);
}

function messagePrompt(conversation: Conversation, messages: MessageEnvelope[]): string {
  const targetName = conversation.kind === 'group' ? '群名称' : '对方名称';
  const source = [
    '# 消息来源',
    `渠道：${conversation.channelId}`,
    `类型：${conversation.kind}`,
    `目标ID：${conversation.externalId}`,
    `${targetName}：${conversation.title}`,
  ].join('\n');
  const rendered = messages
    .map((message, index) => `消息 ${index + 1}\n发送者：${message.sender}\n时间：${message.time}\n内容：${message.content}`)
    .join('\n\n');
  return `${source}\n\n以下是收到的消息：\n\n${rendered}`;
}

export function messageContent(content: unknown, quoted: unknown, forwarded: unknown): string {
  const parts = [truncate(content) || '[空消息]'];
  const quotedText = truncate(quoted);
  const forwardedText = truncate(forwarded);
  if (quotedText) parts.push(`引用内容：${quotedText}`);
  if (forwardedText) parts.push(`合并转发内容：${forwardedText}`);
  return parts.join('\n');
}

function truncate(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length <= 30_000 ? text : `${text.slice(0, 30_000)}\n[已截断]`;
}
