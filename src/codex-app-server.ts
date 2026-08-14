import type WebSocket from 'ws';
import type { HostConfig } from './config.js';
import { assertMinimumToolVersion } from './tool-version.js';
import type { AgentSession } from './contracts.js';
import { execResolved, resolveCommand, type ResolvedCommand } from './command.js';
import { withTimeout } from './process-utils.js';
import type { CodexAppServerHost } from './codex-app-server-host.js';
import type { Store } from './store.js';
import type { Conversation, DeliveryRun, SessionRecord } from './types.js';
import {
  nextResponsibilityReminderCount, prependResponsibilityReminder, shouldInjectResponsibilityReminder,
} from './prompts.js';

type JsonObject = Record<string, unknown>;
type Pending = { resolve(value: unknown): void; reject(error: Error): void };
type Waiter = { turnId: string; resolve(params: JsonObject): void; reject(error: Error): void };

export interface CodexAppServerIdentity {
  version: string;
  fingerprint: string;
  command: ResolvedCommand;
}

const DRIVER_PROTOCOL = 'app-server-v3-shared-websocket-conversation-message';
const NON_INTERACTIVE_THREAD_OPTIONS = {
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
} as const;

export async function verifyCodexAppServer(config: HostConfig): Promise<CodexAppServerIdentity> {
  const command = await resolveCommand(config.runtime.command);
  const version = await execResolved(command, ['--version'], {
    cwd: config.runtime.cwd, encoding: 'utf8', timeout: config.runtime.startupTimeoutSeconds * 1_000, windowsHide: true,
  });
  const actualVersion = version.stdout.trim();
  assertMinimumToolVersion('Codex', config.runtime.version, actualVersion);
  const help = await execResolved(command, ['app-server', '--help'], {
    cwd: config.runtime.cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  if (!help.stdout.includes('--listen') || !help.stdout.includes('ws://IP:PORT')) {
    throw new Error('Codex App Server 缺少 WebSocket 控制面');
  }
  return { version: actualVersion, fingerprint: `${actualVersion}:${DRIVER_PROTOCOL}`, command };
}

export class CodexAppServerSession implements AgentSession {
  private socket: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private waiters: Waiter[] = [];
  private notifications = new Map<string, JsonObject>();
  private startedTurns = new Set<string>();
  private completedTurns = new Set<string>();
  private startedWaiters = new Map<string, Pending[]>();
  private requestId = 1;
  private providerSessionId: string | null = null;
  private activeTurnId: string | null = null;
  private stopping = false;
  private terminalError: Error | null = null;
  private completedTurnsSinceResponsibilityReminder = 0;
  private lastCompletedResponsibility: string | null = null;

  constructor(
    private readonly config: HostConfig,
    private readonly conversation: Conversation,
    private readonly identity: CodexAppServerIdentity,
    private readonly store: Store,
    private readonly appServer: CodexAppServerHost,
  ) {}

  get currentSessionId(): string | null { return this.providerSessionId; }
  get currentTurnId(): string | null { return this.activeTurnId; }
  get supportsActiveSteer(): boolean { return true; }
  get supportsTurnStart(): boolean { return true; }
  get processId(): number | null { return this.appServer.processId; }
  hasBackgroundWork(): boolean { return this.activeTurnId !== null; }

  async start(): Promise<void> {
    if (this.socket) throw new Error('Codex App Server session 已启动');
    this.terminalError = null;
    this.socket = await this.appServer.connect(
      (message) => this.onLine(message),
      (error) => this.failAll(error),
    );
    await this.request('initialize', { clientInfo: { name: 'agent-channel-host', version: '1.0.0' } });
    this.notify('initialized', {});
    const existing = this.store.getSession(this.conversation.id);
    if (existing) {
      const result = await this.request('thread/resume', {
        threadId: existing.providerSessionId,
        ...NON_INTERACTIVE_THREAD_OPTIONS,
      }) as JsonObject;
      this.providerSessionId = threadIdFrom(result);
      if (this.providerSessionId !== existing.providerSessionId) throw new Error('thread/resume 未精确恢复原 session');
      return;
    }
    const result = await this.request('thread/start', {
      model: this.config.runtime.model,
      cwd: this.config.runtime.cwd,
      serviceName: 'agent-channel-host',
      ...NON_INTERACTIVE_THREAD_OPTIONS,
    }) as JsonObject;
    this.providerSessionId = threadIdFrom(result);
    if (!this.providerSessionId) throw new Error('thread/start 未返回 thread id');
    const now = new Date().toISOString();
    this.store.saveSession(this.sessionRecord('provisioning', now, now));
  }

  async deliver(prompt: string): Promise<DeliveryRun> {
    const started = await this.startTurn(prompt);
    return started.completion;
  }

  async startTurn(
    prompt: string,
    clientUserMessageId?: string,
  ): Promise<{ turnId: string; completion: Promise<DeliveryRun> }> {
    if (!this.providerSessionId) throw new Error('Codex App Server session 尚未 start');
    if (this.activeTurnId) throw new Error('同一 conversation 已有活动 Codex turn');
    const conversation = this.store.getConversation(this.conversation.id);
    const responsibility = conversation?.responsibility.trim() ?? '';
    const reminderInterval = conversation?.responsibilityReminderInterval ?? 0;
    const inject = shouldInjectResponsibilityReminder(
      responsibility, this.lastCompletedResponsibility,
      this.completedTurnsSinceResponsibilityReminder, reminderInterval,
    );
    const effectivePrompt = inject ? prependResponsibilityReminder(prompt, responsibility) : prompt;
    const result = await this.request('turn/start', {
      threadId: this.providerSessionId,
      input: [{ type: 'text', text: effectivePrompt }],
      model: this.config.runtime.model,
      effort: this.config.runtime.effort,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
    }) as JsonObject;
    const turn = result.turn as JsonObject | undefined;
    const turnId = typeof turn?.id === 'string' ? turn.id : null;
    if (!turnId) throw new Error('turn/start 未返回 turn id');
    this.activeTurnId = turnId;
    return { turnId, completion: this.completeTurn(turnId, responsibility, inject, reminderInterval) };
  }

  private async completeTurn(
    turnId: string,
    responsibility: string,
    injectedResponsibility: boolean,
    reminderInterval: number,
  ): Promise<DeliveryRun> {
    try {
      const completed = await this.waitForCompletion(turnId);
      const status = (completed.turn as JsonObject | undefined)?.status;
      if (status === 'interrupted') return { turnId, status: 'interrupted' };
      if (status !== 'completed') throw new Error(`Codex turn 状态异常：${String(status)}`);
      const now = new Date().toISOString();
      const existing = this.store.getSession(this.conversation.id);
      this.store.saveSession(existing
        ? { ...existing, lifecycle: 'ready', updatedAt: now }
        : this.sessionRecord('ready', now, now));
      this.lastCompletedResponsibility = responsibility;
      this.completedTurnsSinceResponsibilityReminder = nextResponsibilityReminderCount(
        this.completedTurnsSinceResponsibilityReminder, injectedResponsibility, reminderInterval,
      );
      return { turnId, status: 'completed' };
    } finally {
      this.activeTurnId = null;
    }
  }

  async steer(
    prompt: string,
    expectedTurnId?: string,
    clientUserMessageId?: string,
  ): Promise<{ turnId: string }> {
    if (!this.providerSessionId || !this.activeTurnId) throw new Error('Codex 当前没有可引导的活动 turn');
    if (expectedTurnId && expectedTurnId !== this.activeTurnId) {
      throw new Error(`Codex 活动 turn 已变化：expected=${expectedTurnId}`);
    }
    const targetTurnId = this.activeTurnId;
    await this.waitForTurnStarted(targetTurnId);
    if (this.activeTurnId !== targetTurnId) throw new Error(`Codex 活动 turn 已变化：expected=${targetTurnId}`);
    const result = await this.request('turn/steer', {
      threadId: this.providerSessionId,
      expectedTurnId: targetTurnId,
      input: [{ type: 'text', text: prompt }],
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
    }) as JsonObject;
    const acceptedTurnId = typeof result.turnId === 'string' ? result.turnId : null;
    if (acceptedTurnId !== targetTurnId) throw new Error('turn/steer 未确认预期活动 turn');
    return { turnId: acceptedTurnId };
  }

  async interruptActive(): Promise<boolean> {
    if (!this.providerSessionId || !this.activeTurnId) return false;
    await this.request('turn/interrupt', { threadId: this.providerSessionId, turnId: this.activeTurnId });
    return true;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.interruptActive().catch(() => false);
    this.socket?.close();
    this.socket = null;
    this.failAll(new Error('Codex App Server session 已停止'));
  }

  private sessionRecord(lifecycle: SessionRecord['lifecycle'], createdAt: string, updatedAt: string): SessionRecord {
    const generation = this.store.getConversation(this.conversation.id)?.sessionGeneration;
    if (!generation) throw new Error(`conversation 不存在：${this.conversation.id}`);
    return {
      conversationId: this.conversation.id, runtimeId: this.config.runtime.id,
      providerSessionId: this.providerSessionId!, generation,
      lifecycle, protocolFingerprint: this.identity.fingerprint, runtimeCwd: this.config.runtime.cwd,
      bootstrapTurnId: null, createdAt, updatedAt,
    };
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    const id = this.requestId++;
    const response = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.send({ id, method, params });
    return withTimeout(response, this.config.runtime.startupTimeoutSeconds * 1_000, `Codex ${method}`)
      .catch((error) => {
        const tailText = this.appServer.errorTail;
        const tail = tailText ? `；stderr tail: ${tailText}` : '';
        throw new Error(`${(error as Error).message}${tail}`);
      });
  }

  private notify(method: string, params: JsonObject): void { this.send({ method, params }); }
  private send(message: JsonObject): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) throw new Error('Codex App Server WebSocket 未连接');
    this.socket.send(JSON.stringify(message));
  }

  private waitForCompletion(turnId: string): Promise<JsonObject> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    const buffered = this.notifications.get(turnId);
    if (buffered) {
      this.notifications.delete(turnId);
      return Promise.resolve(buffered);
    }
    return new Promise((resolve, reject) => this.waiters.push({ turnId, resolve, reject }));
  }

  private waitForTurnStarted(turnId: string): Promise<void> {
    if (this.startedTurns.has(turnId)) return Promise.resolve();
    if (this.completedTurns.has(turnId)) return Promise.reject(new Error('Codex turn 已结束，无法引导'));
    const ready = new Promise<void>((resolve, reject) => {
      const waiters = this.startedWaiters.get(turnId) ?? [];
      waiters.push({ resolve, reject });
      this.startedWaiters.set(turnId, waiters);
    });
    return withTimeout(ready, this.config.runtime.startupTimeoutSeconds * 1_000, 'Codex turn/started');
  }

  private onLine(line: string): void {
    let message: JsonObject;
    try { message = JSON.parse(line) as JsonObject; }
    catch (error) { this.failAll(new Error(`Codex App Server 输出非法 JSON：${(error as Error).message}`)); return; }
    if (typeof message.method === 'string' && message.id !== undefined) {
      this.rejectUnexpectedServerRequest(message);
      return;
    }
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'turn/started') {
      const params = message.params as JsonObject;
      const turnId = typeof (params.turn as JsonObject | undefined)?.id === 'string'
        ? String((params.turn as JsonObject).id) : null;
      if (!turnId) return;
      this.startedTurns.add(turnId);
      for (const waiter of this.startedWaiters.get(turnId) ?? []) waiter.resolve(undefined);
      this.startedWaiters.delete(turnId);
      return;
    }
    if (message.method !== 'turn/completed') return;
    const params = message.params as JsonObject;
    const turnId = typeof (params.turn as JsonObject | undefined)?.id === 'string'
      ? String((params.turn as JsonObject).id) : null;
    if (!turnId) return;
    this.completedTurns.add(turnId);
    this.startedTurns.delete(turnId);
    for (const waiter of this.startedWaiters.get(turnId) ?? []) waiter.reject(new Error('Codex turn 已结束，无法引导'));
    this.startedWaiters.delete(turnId);
    const index = this.waiters.findIndex((waiter) => waiter.turnId === turnId);
    if (index >= 0) this.waiters.splice(index, 1)[0]!.resolve(params);
    else this.notifications.set(turnId, params);
  }

  private rejectUnexpectedServerRequest(message: JsonObject): void {
    const method = String(message.method);
    const error = new Error(`后台 Codex Runtime 禁止交互请求：${method}`);
    try {
      this.send({
        id: message.id,
        error: { code: -32000, message: error.message },
      });
    } catch {
      // failAll below remains the authoritative local terminal state.
    }
    this.failAll(error);
    this.stopping = true;
    this.socket?.close();
    this.socket = null;
  }

  private failAll(error: Error): void {
    this.terminalError ??= error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters = [];
    for (const waiters of this.startedWaiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    this.startedWaiters.clear();
  }
}

function threadIdFrom(result: JsonObject): string | null {
  const thread = result.thread as JsonObject | undefined;
  return typeof thread?.id === 'string' ? thread.id : null;
}
