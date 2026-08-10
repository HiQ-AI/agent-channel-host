import type { Conversation, DeliveryRun, NormalizedEvent } from './types.js';

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
  backfill?(
    targets: Array<{ conversation: Conversation; start: Date }>,
    until: Date,
    onEvent: (event: NormalizedEvent) => void,
  ): Promise<number>;
  pollSelfMessages?(
    targets: Array<{ conversation: Conversation; start: Date }>,
    until: Date,
    onEvent: (event: NormalizedEvent) => void,
  ): Promise<number>;
  pollSelfChat?(
    start: Date,
    until: Date,
    onEvent: (event: NormalizedEvent) => void,
  ): Promise<number>;
  selfChatExternalId?(): string | null;
  stop(): Promise<void>;
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
  deliver(prompt: string): Promise<DeliveryRun>;
  steer(prompt: string): Promise<{ turnId: string }>;
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
