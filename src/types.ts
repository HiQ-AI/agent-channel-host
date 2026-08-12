export type ConversationKind = 'group' | 'direct';
export const CONVERSATION_MODES = ['shadow', 'reply'] as const;
export type ConversationMode = typeof CONVERSATION_MODES[number];
export const DEFAULT_WORKER_WARM_SECONDS = 300;
export const MAX_WORKER_WARM_SECONDS = 2_147_483;
export const DEFAULT_RESPONSIBILITY_REMINDER_INTERVAL = 15;
export const MAX_RESPONSIBILITY_REMINDER_INTERVAL = 99;
export const MAX_RECOVERY_ATTEMPTS = 3;

export interface Conversation {
  id: string;
  channelId: string;
  channelProfileId: string;
  kind: ConversationKind;
  purpose: 'channel' | 'wake';
  externalId: string;
  title: string;
  responsibility: string;
  mode: ConversationMode;
  runtimeId: string;
  workerWarmSeconds: number;
  responsibilityReminderInterval: number;
  policyVersion: number;
  sessionGeneration: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationContextUpdate {
  currentTopic: string;
  facts: string[];
  decisions: string[];
  commitments: string[];
  openQuestions: string[];
}

export interface ConversationContext extends ConversationContextUpdate {
  conversationId: string;
  version: number;
  throughSequence: number;
  updatedAt: string;
}

export interface ConversationMember {
  conversationId: string;
  externalUserId: string;
  displayName: string | null;
  organizationRole: string;
  conversationRole: string;
  responsibilityBoundary: string;
  source: 'message' | 'manual';
  version: number;
  updatedAt: string;
}

export interface NormalizedEvent {
  channelId: string;
  channelProfileId: string;
  fingerprint: string;
  eventId: string | null;
  messageId: string | null;
  conversationExternalId: string;
  conversationTitle: string | null;
  kind: ConversationKind;
  senderId: string | null;
  senderName: string | null;
  content: unknown;
  quotedMessage: unknown;
  forwardedMessages: unknown;
  occurredAt: string | null;
  receivedAt: string;
  source: Record<string, unknown>;
  wakeWordInstruction?: string;
}

export interface AdmittedEvent extends NormalizedEvent {
  id: string;
  conversationId: string;
  sequence: number;
  ingress: 'live' | 'history' | 'self_poll' | 'continuation';
}

export interface SelfMessagePollState {
  conversationId: string;
  scannedThroughAt: string;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export interface SessionRecord {
  conversationId: string;
  runtimeId: string;
  providerSessionId: string;
  generation: number;
  lifecycle: 'provisioning' | 'ready' | 'failed';
  protocolFingerprint: string;
  runtimeCwd: string;
  bootstrapTurnId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryRun {
  turnId: string;
  status: 'completed' | 'interrupted';
}

export type WorkerState = 'starting' | 'running' | 'warm' | 'stopped' | 'error';
export type ChannelConnectionState = 'starting' | 'ready' | 'stopped' | 'error';

export interface RuntimeWorkerRecord {
  conversationId: string;
  workerId: string | null;
  runtimeId: string;
  state: WorkerState;
  processId: number | null;
  claimedFromSequence: number | null;
  claimedToSequence: number | null;
  lastSignalAt: string | null;
  warmUntil: string | null;
  error: string | null;
  startedAt: string | null;
  updatedAt: string;
}

export interface OutboxRecord {
  id: string;
  conversationId: string;
  inboundEventId: string;
  inputSequence: number;
  uuid: string;
  text: string;
  state: 'pending' | 'sending' | 'submitted' | 'failed' | 'suppressed' | 'delivery_unknown';
  attemptCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GroupOnboardingRecord {
  conversationId: string;
  state: 'pending' | 'prepared' | 'sending' | 'forwarded' | 'submitted' | 'delivered' | 'failed' | 'delivery_unknown';
  historyCount: number | null;
  historyLoadedAt: string | null;
  introTurnId: string | null;
  introText: string | null;
  introUuid: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
