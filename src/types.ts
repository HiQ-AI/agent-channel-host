export type ConversationKind = 'group' | 'direct';
export type ConversationMode = 'shadow' | 'reply';
export type ConversationLifecycle = 'resident' | 'idle';
export const MAX_IDLE_TIMEOUT_MINUTES = 35_791;

export interface Conversation {
  id: string;
  kind: ConversationKind;
  externalId: string;
  title: string;
  responsibility: string;
  mode: ConversationMode;
  sessionLifecycle: ConversationLifecycle;
  idleTimeoutMinutes: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NormalizedEvent {
  fingerprint: string;
  eventId: string | null;
  messageId: string | null;
  conversationExternalId: string;
  kind: ConversationKind;
  senderId: string | null;
  senderName: string | null;
  content: unknown;
  quotedMessage: unknown;
  forwardedMessages: unknown;
  occurredAt: string | null;
  receivedAt: string;
  source: Record<string, unknown>;
}

export interface AdmittedEvent extends NormalizedEvent {
  id: string;
  conversationId: string;
  sequence: number;
}

export interface Decision {
  action: 'silent' | 'reply' | 'escalate';
  responsibilityMatch: boolean;
  category: string;
  replyText: string;
  reasonCode: string;
  workType: 'discussion' | 'implementation';
  delegation: 'not_required' | 'started';
}

export interface ProtocolIdentity {
  codexVersion: string;
  schemaSha256: string;
  schemaPath: string;
  command: import('./command.js').ResolvedCommand;
}

export interface SessionRecord {
  conversationId: string;
  threadId: string;
  lifecycle: 'provisioning' | 'ready' | 'failed';
  codexVersion: string;
  schemaSha256: string;
  runtimeCwd: string;
  bootstrapTurnId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutboxRecord {
  id: string;
  conversationId: string;
  inboundEventId: string;
  inputSequence: number;
  uuid: string;
  text: string;
  state: 'pending' | 'sending' | 'submitted' | 'failed' | 'suppressed';
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GroupOnboardingRecord {
  conversationId: string;
  state: 'pending' | 'prepared' | 'sending' | 'submitted' | 'failed';
  historyCount: number | null;
  historyLoadedAt: string | null;
  introTurnId: string | null;
  introText: string | null;
  introUuid: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
