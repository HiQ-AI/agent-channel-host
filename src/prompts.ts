import type { AdmittedEvent, Conversation } from './types.js';
import type { RecentMessage } from './dws.js';

interface MessageEnvelope {
  sender: string;
  senderId?: string | null;
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

export function shouldInjectResponsibilityReminder(
  responsibility: string,
  lastCompletedResponsibility: string | null,
  completedTurnsSinceReminder: number,
  interval: number,
): boolean {
  return responsibility.length > 0 && (
    responsibility !== lastCompletedResponsibility
    || (interval > 0 && completedTurnsSinceReminder >= interval)
  );
}

export function nextResponsibilityReminderCount(current: number, injected: boolean, interval: number): number {
  if (interval === 0) return 0;
  return injected ? 1 : current + 1;
}

export function batchPrompt(conversation: Conversation, events: AdmittedEvent[]): string {
  return messagePrompt(conversation, events.map((event) => ({
    sender: event.senderName ?? event.senderId ?? '未知',
    senderId: event.senderId,
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
  const mentionHint = conversation.kind === 'group' && messages.some((message) => message.senderId)
    ? '\n\n如需 @ 发送者，必须使用对应的发送者ID调用 Channel 的实际 @ 能力；仅在正文写 @姓名 不会产生实际 @。'
    : '';
  const rendered = messages
    .map((message, index) => [
      `消息 ${index + 1}`,
      `发送者：${message.sender}`,
      ...(message.senderId ? [`发送者ID：${message.senderId}`] : []),
      `时间：${message.time}`,
      `内容：${message.content}`,
    ].join('\n'))
    .join('\n\n');
  return `${source}${mentionHint}\n\n以下是收到的消息：\n\n${rendered}`;
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
