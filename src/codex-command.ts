import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { HostConfig } from './config.js';
import { assertMinimumToolVersion } from './tool-version.js';
import type { AgentSession } from './contracts.js';
import { commandArgs, execResolved, resolveCommand, type ResolvedCommand } from './command.js';
import { withTimeout } from './process-utils.js';
import type { Store } from './store.js';
import type { Conversation, DeliveryRun, SessionRecord } from './types.js';
import { prependResponsibilityReminder } from './prompts.js';

type JsonObject = Record<string, unknown>;

export interface CodexCommandIdentity {
  version: string;
  fingerprint: string;
  command: ResolvedCommand;
}

export interface SessionStartup {
  mode: 'new' | 'resumed';
  providerSessionId: string | null;
}

const DRIVER_PROTOCOL = 'exec-jsonl-v4-one-way-delivery';
export const RESPONSIBILITY_REMINDER_INTERVAL_TURNS = 5;

export async function verifyCodexCommand(config: HostConfig): Promise<CodexCommandIdentity> {
  const command = await resolveCommand(config.runtime.command);
  const version = await execResolved(command, ['--version'], {
    cwd: config.runtime.cwd,
    encoding: 'utf8',
    timeout: config.runtime.startupTimeoutSeconds * 1_000,
    windowsHide: true,
  });
  const actualVersion = version.stdout.trim();
  assertMinimumToolVersion('Codex', config.runtime.version, actualVersion);
  const [execHelp, resumeHelp] = await Promise.all([
    execResolved(command, ['exec', '--help'], {
      cwd: config.runtime.cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    }),
    execResolved(command, ['exec', 'resume', '--help'], {
      cwd: config.runtime.cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    }),
  ]);
  for (const token of ['--json']) {
    if (!execHelp.stdout.includes(token)) throw new Error(`Codex exec 缺少能力：${token}`);
    if (!resumeHelp.stdout.includes(token)) throw new Error(`Codex exec resume 缺少能力：${token}`);
  }
  if (!resumeHelp.stdout.includes('[SESSION_ID]')) throw new Error('Codex exec resume 缺少显式 session ID');
  return {
    version: actualVersion,
    fingerprint: `${actualVersion}:${DRIVER_PROTOCOL}`,
    command,
  };
}

export function buildCodexExecArgs(
  config: HostConfig,
  prompt: string,
  providerSessionId: string | null,
): string[] {
  const common = [
    '--json',
    '--model', config.runtime.model,
    '--skip-git-repo-check',
    '-c', `model_reasoning_effort=${tomlString(config.runtime.effort)}`,
  ];
  if (providerSessionId) return ['exec', 'resume', ...common, providerSessionId, prompt];
  return ['exec', ...common, '-C', config.runtime.cwd, prompt];
}

export class CodexJsonlCollector {
  providerSessionId: string | null = null;
  turnCompleted = false;
  failure: Error | null = null;

  constructor(private readonly expectedSessionId: string | null) {}

  accept(line: string): void {
    let event: JsonObject;
    try {
      event = JSON.parse(line) as JsonObject;
    } catch (error) {
      throw new Error(`Codex exec 输出非法 JSONL：${(error as Error).message}`);
    }
    const type = String(event.type ?? '');
    if (type === 'thread.started') {
      const sessionId = typeof event.thread_id === 'string' ? event.thread_id : null;
      if (!sessionId) throw new Error('Codex exec thread.started 缺少 thread_id');
      if (this.providerSessionId) return;
      if (this.expectedSessionId && sessionId !== this.expectedSessionId) {
        throw new Error('Codex exec resume 未精确恢复原 session');
      }
      this.providerSessionId = sessionId;
      return;
    }
    if (type === 'turn.completed') {
      this.turnCompleted = true;
      return;
    }
    if (type === 'turn.failed' || type === 'error') {
      this.failure = new Error(`Codex exec ${type}：${eventMessage(event)}`);
      return;
    }
    // item.completed 及 Agent final text 均属于 runtime 内部结果，Host 不读取。
  }
}

export class CodexCommandSession implements AgentSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdout: Interface | null = null;
  private stderr: Interface | null = null;
  private activeExit: Promise<void> | null = null;
  private providerSessionId: string | null = null;
  private started = false;
  private interruptRequested = false;
  private stderrTail: string[] = [];
  private completedTurnsSinceResponsibilityReminder = RESPONSIBILITY_REMINDER_INTERVAL_TURNS;
  private lastCompletedResponsibility: string | null = null;

  constructor(
    private readonly config: HostConfig,
    private readonly conversation: Conversation,
    private readonly identity: CodexCommandIdentity,
    private readonly store: Store,
  ) {}

  get currentSessionId(): string | null {
    return this.providerSessionId;
  }

  get processId(): number | null {
    return this.child?.pid ?? null;
  }

  hasBackgroundWork(): boolean {
    return false;
  }

  async start(): Promise<SessionStartup> {
    if (this.started) throw new Error('Codex command session 已启动');
    let existing = this.store.getSession(this.conversation.id);
    if (existing) {
      if (existing.lifecycle !== 'ready'
        || existing.runtimeId !== this.config.runtime.id
        || existing.protocolFingerprint !== this.identity.fingerprint
        || existing.runtimeCwd !== this.config.runtime.cwd) {
        this.store.rotateConversationSession(this.conversation.id, 'runtime-incompatible');
        existing = null;
      }
    }
    if (existing) {
      this.providerSessionId = existing.providerSessionId;
    }
    this.started = true;
    return { mode: existing ? 'resumed' : 'new', providerSessionId: this.providerSessionId };
  }

  async deliver(prompt: string): Promise<DeliveryRun> {
    if (!this.started) throw new Error('Codex command session 尚未 start');
    if (this.child) throw new Error('同一 conversation 已有活动 Codex command');
    const expectedSessionId = this.providerSessionId;
    const conversation = this.store.getConversation(this.conversation.id);
    if (!conversation) throw new Error(`conversation 不存在：${this.conversation.id}`);
    const responsibility = conversation.responsibility.trim();
    const injectResponsibility = responsibility.length > 0 && (
      responsibility !== this.lastCompletedResponsibility
      || this.completedTurnsSinceResponsibilityReminder >= RESPONSIBILITY_REMINDER_INTERVAL_TURNS
    );
    const effectivePrompt = injectResponsibility
      ? prependResponsibilityReminder(prompt, responsibility)
      : prompt;
    const collector = new CodexJsonlCollector(expectedSessionId);
    const turnId = randomUUID();
    const args = buildCodexExecArgs(
      this.config,
      effectivePrompt,
      expectedSessionId,
    );
    const child = spawn(this.identity.command.file, commandArgs(this.identity.command, args), {
      cwd: this.config.runtime.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    });
    this.child = child;
    this.interruptRequested = false;
    this.stderrTail = [];
    let streamError: Error | null = null;
    this.stdout = createInterface({ input: child.stdout });
    this.stderr = createInterface({ input: child.stderr });
    this.stdout.on('line', (line) => {
      try {
        const before = collector.providerSessionId;
        collector.accept(line);
        if (!before && collector.providerSessionId) this.persistProvisioning(collector.providerSessionId);
      } catch (error) {
        streamError = error as Error;
        child.kill();
      }
    });
    this.stderr.on('line', (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 30) this.stderrTail.shift();
    });
    child.stdin.end();
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    this.activeExit = exited.then(() => undefined, () => undefined);
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      exit = await exited;
    } finally {
      this.stdout?.close();
      this.stderr?.close();
      this.stdout = null;
      this.stderr = null;
      if (this.child === child) this.child = null;
      this.activeExit = null;
    }
    if (this.interruptRequested) {
      return { turnId, status: 'interrupted' };
    }
    if (streamError) throw streamError;
    if (collector.failure) throw collector.failure;
    if (exit.code !== 0) {
      const tail = this.stderrTail.length ? `；stderr tail: ${this.stderrTail.join(' | ')}` : '';
      throw new Error(`Codex exec 退出异常：code=${exit.code} signal=${exit.signal}${tail}`);
    }
    if (!collector.providerSessionId) throw new Error('Codex exec 未返回 provider session ID');
    if (!collector.turnCompleted) throw new Error('Codex exec 未返回 turn.completed');
    this.persistReady(collector.providerSessionId, turnId);
    this.lastCompletedResponsibility = responsibility;
    this.completedTurnsSinceResponsibilityReminder = injectResponsibility
      ? 1
      : this.completedTurnsSinceResponsibilityReminder + 1;
    return {
      turnId,
      status: 'completed',
    };
  }

  async steer(_prompt: string): Promise<{ turnId: string }> {
    throw new Error('Codex command runtime 不支持活动 turn 引导');
  }

  async interruptActive(): Promise<boolean> {
    if (!this.child || this.child.exitCode !== null || this.interruptRequested) return false;
    this.interruptRequested = true;
    this.child.kill();
    return true;
  }

  async stop(): Promise<void> {
    const activeExit = this.activeExit;
    await this.interruptActive();
    if (activeExit) await withTimeout(activeExit, 5_000, 'Codex command 终止');
  }

  private persistProvisioning(sessionId: string): void {
    if (this.providerSessionId && this.providerSessionId !== sessionId) {
      throw new Error('Codex command 返回了第二个 provider session ID');
    }
    this.providerSessionId = sessionId;
    const existing = this.store.getSession(this.conversation.id);
    const now = new Date().toISOString();
    this.store.saveSession({
      conversationId: this.conversation.id,
      runtimeId: this.config.runtime.id,
      providerSessionId: sessionId,
      generation: existing?.generation ?? this.store.getConversation(this.conversation.id)?.sessionGeneration ?? 1,
      lifecycle: existing?.lifecycle === 'ready' ? 'ready' : 'provisioning',
      protocolFingerprint: this.identity.fingerprint,
      runtimeCwd: this.config.runtime.cwd,
      bootstrapTurnId: existing?.bootstrapTurnId ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  private persistReady(sessionId: string, firstRunId: string): void {
    const existing = this.store.getSession(this.conversation.id);
    if (!existing || existing.providerSessionId !== sessionId) throw new Error('Codex session provisioning 状态丢失');
    this.store.saveSession({
      ...existing,
      lifecycle: 'ready',
      bootstrapTurnId: existing.bootstrapTurnId ?? firstRunId,
      updatedAt: new Date().toISOString(),
    });
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function eventMessage(event: JsonObject): string {
  if (typeof event.message === 'string') return event.message;
  if (event.error && typeof event.error === 'object') {
    const error = event.error as JsonObject;
    if (typeof error.message === 'string') return error.message;
  }
  return JSON.stringify(event).slice(0, 500);
}
