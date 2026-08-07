import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { HostConfig } from './config.js';
import { assertMinimumToolVersion } from './tool-version.js';
import type { AgentActivityEntry, AgentActivitySnapshot, AgentSession } from './contracts.js';
import { commandArgs, execResolved, resolveCommand, type ResolvedCommand } from './command.js';
import { stopChild, withTimeout } from './process-utils.js';
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

const DRIVER_PROTOCOL = 'app-server-v1-turn-steer';
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
  if (!help.stdout.includes('--listen') && !help.stdout.includes('stdio')) {
    throw new Error('Codex App Server 缺少 stdio 控制面');
  }
  return { version: actualVersion, fingerprint: `${actualVersion}:${DRIVER_PROTOCOL}`, command };
}

export class CodexAppServerSession implements AgentSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdout: Interface | null = null;
  private stderr: Interface | null = null;
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
  private stderrTail: string[] = [];
  private completedTurnsSinceResponsibilityReminder = 0;
  private lastCompletedResponsibility: string | null = null;
  private activity: AgentActivityEntry[] = [];
  private activityRevision = 0;

  constructor(
    private readonly config: HostConfig,
    private readonly conversation: Conversation,
    private readonly identity: CodexAppServerIdentity,
    private readonly store: Store,
  ) {}

  get currentSessionId(): string | null { return this.providerSessionId; }
  get processId(): number | null { return this.child?.pid ?? null; }
  hasBackgroundWork(): boolean { return this.activeTurnId !== null; }
  readActivity(): AgentActivitySnapshot {
    return { state: 'ready', revision: this.activityRevision, message: null, entries: [...this.activity] };
  }

  async start(): Promise<void> {
    if (this.child) throw new Error('Codex App Server session 已启动');
    this.terminalError = null;
    this.child = spawn(this.identity.command.file, commandArgs(this.identity.command, ['app-server', '--listen', 'stdio://']), {
      cwd: this.config.runtime.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: process.env,
    });
    this.stdout = createInterface({ input: this.child.stdout });
    this.stderr = createInterface({ input: this.child.stderr });
    this.stdout.on('line', (line) => this.onLine(line));
    this.stderr.on('line', (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 30) this.stderrTail.shift();
    });
    this.child.once('error', (error) => this.failAll(error));
    this.child.once('exit', (code, signal) => {
      if (!this.stopping) this.failAll(new Error(`Codex App Server 意外退出：code=${code} signal=${signal}`));
    });
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
    }) as JsonObject;
    const turn = result.turn as JsonObject | undefined;
    const turnId = typeof turn?.id === 'string' ? turn.id : null;
    if (!turnId) throw new Error('turn/start 未返回 turn id');
    this.activeTurnId = turnId;
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
        this.completedTurnsSinceResponsibilityReminder, inject, reminderInterval,
      );
      return { turnId, status: 'completed' };
    } finally {
      this.activeTurnId = null;
    }
  }

  async steer(prompt: string): Promise<{ turnId: string }> {
    if (!this.providerSessionId || !this.activeTurnId) throw new Error('Codex 当前没有可引导的活动 turn');
    await this.waitForTurnStarted(this.activeTurnId);
    const result = await this.request('turn/steer', {
      threadId: this.providerSessionId,
      expectedTurnId: this.activeTurnId,
      input: [{ type: 'text', text: prompt }],
    }) as JsonObject;
    const acceptedTurnId = typeof result.turnId === 'string' ? result.turnId : null;
    if (acceptedTurnId !== this.activeTurnId) throw new Error('turn/steer 未确认当前活动 turn');
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
    await stopChild(this.child);
    this.stdout?.close();
    this.stderr?.close();
    this.child = null;
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
        const tail = this.stderrTail.length > 0 ? `；stderr tail: ${this.stderrTail.join(' | ')}` : '';
        throw new Error(`${(error as Error).message}${tail}`);
      });
  }

  private notify(method: string, params: JsonObject): void { this.send({ method, params }); }
  private send(message: JsonObject): void {
    if (!this.child || this.child.exitCode !== null) throw new Error('Codex App Server 未运行');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
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
    if (message.method === 'item/completed') {
      this.recordCompletedItem(message.params as JsonObject);
      return;
    }
    if (message.method === 'turn/started') {
      const params = message.params as JsonObject;
      const turnId = typeof (params.turn as JsonObject | undefined)?.id === 'string'
        ? String((params.turn as JsonObject).id) : null;
      if (!turnId) return;
      this.startedTurns.add(turnId);
      this.appendActivity({ id: `turn:${turnId}:started`, kind: 'status', at: new Date().toISOString(), label: '状态', content: 'Agent 开始处理' });
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
    const status = String((params.turn as JsonObject).status ?? 'completed');
    this.appendActivity({ id: `turn:${turnId}:completed`, kind: 'status', at: new Date().toISOString(), label: '状态', content: status === 'completed' ? 'Agent 处理完成' : `Agent ${status}` });
    this.startedTurns.delete(turnId);
    for (const waiter of this.startedWaiters.get(turnId) ?? []) waiter.reject(new Error('Codex turn 已结束，无法引导'));
    this.startedWaiters.delete(turnId);
    const index = this.waiters.findIndex((waiter) => waiter.turnId === turnId);
    if (index >= 0) this.waiters.splice(index, 1)[0]!.resolve(params);
    else this.notifications.set(turnId, params);
  }

  private recordCompletedItem(params: JsonObject): void {
    const item = params.item as JsonObject | undefined;
    if (!item || typeof item.type !== 'string') return;
    const id = typeof item.id === 'string' ? item.id : `${item.type}:${this.activityRevision + 1}`;
    const atMs = typeof params.completedAtMs === 'number' ? params.completedAtMs : Date.now();
    const at = new Date(atMs).toISOString();
    const text = (value: unknown): string => typeof value === 'string' ? value : '';
    let entry: AgentActivityEntry | null = null;
    switch (item.type) {
      case 'agentMessage':
        entry = { id, kind: 'assistant', at, label: 'Agent', content: text(item.text) };
        break;
      case 'reasoning': {
        const summary = Array.isArray(item.summary) ? item.summary.filter((value): value is string => typeof value === 'string').join('\n') : '';
        if (summary) entry = { id, kind: 'reasoning', at, label: '思考摘要', content: summary };
        break;
      }
      case 'commandExecution':
        entry = { id, kind: 'tool', at, label: '命令', content: text(item.command), result: text(item.aggregatedOutput), error: item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0) };
        break;
      case 'fileChange':
        entry = { id, kind: 'tool', at, label: '文件修改', content: summarizeValue(item.changes), result: text(item.status), error: item.status === 'failed' };
        break;
      case 'mcpToolCall':
      case 'dynamicToolCall':
        entry = { id, kind: 'tool', at, label: item.type === 'mcpToolCall' ? `${text(item.server)}/${text(item.tool)}` : text(item.tool), content: summarizeValue(item.arguments), result: summarizeValue(item.result ?? item.error), error: Boolean(item.error) || item.status === 'failed' };
        break;
      case 'webSearch':
        entry = { id, kind: 'tool', at, label: '网页搜索', content: text(item.query), result: text(item.action) };
        break;
      case 'plan':
        entry = { id, kind: 'reasoning', at, label: '计划', content: text(item.text) };
        break;
    }
    if (entry && (entry.content || entry.result)) this.appendActivity(entry);
  }

  private appendActivity(entry: AgentActivityEntry): void {
    this.activity.push(entry);
    if (this.activity.length > 200) this.activity.splice(0, this.activity.length - 200);
    this.activityRevision += 1;
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
    const child = this.child;
    void stopChild(child).finally(() => {
      if (this.child === child) this.child = null;
    });
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

function summarizeValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function threadIdFrom(result: JsonObject): string | null {
  const thread = result.thread as JsonObject | undefined;
  return typeof thread?.id === 'string' ? thread.id : null;
}
