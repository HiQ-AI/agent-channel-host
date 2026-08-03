import { createHash } from 'node:crypto';
import type { Conversation, ConversationKind, NormalizedEvent } from './types.js';

export function discoveredConversationTitle(event: NormalizedEvent): string | null {
  const conversationTitle = event.conversationTitle?.trim();
  if (event.kind === 'group') return conversationTitle || null;
  return event.senderName?.trim() || conversationTitle || null;
}

export function anonymousConversationTitle(kind: ConversationKind, externalId: string): string {
  return `${kind === 'group' ? '群聊' : '私聊'} · ${conversationDigest(externalId)}`;
}

export function isGeneratedConversationTitle(title: string, kind: ConversationKind, externalId: string): boolean {
  const digest = conversationDigest(externalId);
  return title === anonymousConversationTitle(kind, externalId)
    || title === `${kind === 'group' ? '未命名群聊' : '未命名私聊'} · ${digest}`;
}

export function displayConversationTitle(
  conversation: Pick<Conversation, 'kind' | 'externalId' | 'title'>,
  memberDisplayName: string | null,
): string {
  if (conversation.kind !== 'direct' || !memberDisplayName?.trim()) return conversation.title;
  return isGeneratedConversationTitle(conversation.title, conversation.kind, conversation.externalId)
    ? memberDisplayName.trim()
    : conversation.title;
}

function conversationDigest(externalId: string): string {
  return createHash('sha256').update(externalId).digest('hex').slice(0, 8);
}
