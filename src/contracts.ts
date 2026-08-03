import type { Conversation, DecisionRun, NormalizedEvent, OutboxRecord } from './types.js';

export class ChannelDeliveryUnknownError extends Error {
  constructor(readonly reasonCode: string) {
    super(`delivery_unknown:${reasonCode}`);
    this.name = 'ChannelDeliveryUnknownError';
  }
}

export interface ChannelDescriptor {
  channelId: string;
  profileId: string;
  label: string;
}

export interface ChannelHandlers {
  onEvent(event: NormalizedEvent): void;
  onFatal(error: Error): void;
}

export interface ChannelAdapter {
  readonly descriptor: ChannelDescriptor;
  start(handlers: ChannelHandlers): Promise<void>;
  stop(): Promise<void>;
  send(conversation: Conversation, record: Pick<OutboxRecord, 'text' | 'uuid'>): Promise<void>;
}

export interface RuntimeDescriptor {
  runtimeId: string;
  label: string;
  model: string | null;
  protocolFingerprint: string;
  contextRecovery: 'runtime-native' | 'adapter-managed' | 'unavailable';
}

export interface AgentSession {
  start(): Promise<unknown>;
  runDecision(prompt: string, shouldInterrupt?: () => boolean): Promise<DecisionRun>;
  interruptActive(): Promise<boolean>;
  stop(): Promise<void>;
  readonly currentSessionId: string | null;
  readonly processId: number | null;
  hasBackgroundWork?(): boolean;
}

export interface RuntimeAdapter {
  readonly descriptor: RuntimeDescriptor;
  createSession(conversation: Conversation): AgentSession;
}
