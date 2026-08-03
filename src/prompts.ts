import type { AdmittedEvent } from './types.js';
import type { RecentMessage } from './dws.js';

interface MessageEnvelope {
  sender: string;
  time: string;
  content: string;
}

export function batchPrompt(events: AdmittedEvent[]): string {
  return messagePrompt(events.map((event) => ({
    sender: event.senderName ?? event.senderId ?? '未知',
    time: event.occurredAt ?? event.receivedAt,
    content: messageContent(event.content, event.quotedMessage, event.forwardedMessages),
  })));
}

export function recentMessagesPrompt(messages: RecentMessage[]): string {
  return messagePrompt(messages);
}

function messagePrompt(messages: MessageEnvelope[]): string {
  const rendered = messages
    .map((message, index) => `消息 ${index + 1}\n发送者：${message.sender}\n时间：${message.time}\n内容：${message.content}`)
    .join('\n\n');
  return `以下是收到的消息：\n\n${rendered}\n\n处理完成后只返回一个 JSON：\n- 不需要回复：{"action":"silent","replyText":""}\n- 需要回复：{"action":"reply","replyText":"回复内容"}`;
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
