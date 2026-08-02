import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createInterface, type Interface } from 'node:readline';
import type { HostConfig } from './config.js';
import type { AgentSession } from './contracts.js';
import { commandArgs, execResolved, resolveCommand, type ResolvedCommand } from './command.js';
import { emptyTurnEvidence, validateDecision, type TurnEvidence } from './decision.js';
import { developerInstructions, recoveryContext } from './prompts.js';
import { publishRecoveryContext } from './recovery-context.js';
import { withTimeout } from './process-utils.js';
import type { Store } from './store.js';
import type { Conversation, ConversationContext, Decision, DecisionRun, SessionRecord } from './types.js';

type JsonObject = Record<string, unknown>;

export interface CodexCommandIdentity {
  version: string;
  fingerprint: string;
  command: ResolvedCommand;
  decisionSchemaPath: string;
}

export interface SessionStartup {
  mode: 'new' | 'resumed';
  providerSessionId: string | null;
}

const DRIVER_PROTOCOL = 'exec-jsonl-v2-compaction-recovery';
const DECISION_SCHEMA_PATH = fileURLToPath(new URL('../../schemas/decision-output.schema.json', import.meta.url));
const COMPACTION_HOOK_PATH = fileURLToPath(new URL('./codex-compaction-hook.js', import.meta.url));

export async function verifyCodexCommand(config: HostConfig): Promise<CodexCommandIdentity> {
  const command = await resolveCommand(config.runtime.command);
  const version = await execResolved(command, ['--version'], {
    cwd: config.runtime.cwd,
    encoding: 'utf8',
    timeout: config.runtime.startupTimeoutSeconds * 1_000,
    windowsHide: true,
  });
  const actualVersion = version.stdout.trim();
  if (actualVersion !== config.runtime.version) {
    throw new Error(`Codex 版本不匹配：要求 ${config.runtime.version}，实际 ${actualVersion}`);
  }
  const [execHelp, resumeHelp, schema] = await Promise.all([
    execResolved(command, ['exec', '--help'], {
      cwd: config.runtime.cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    }),
    execResolved(command, ['exec', 'resume', '--help'], {
      cwd: config.runtime.cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    }),
    readFile(DECISION_SCHEMA_PATH),
  ]);
  for (const token of ['--json', '--output-schema', '--dangerously-bypass-hook-trust']) {
    if (!execHelp.stdout.includes(token)) throw new Error(`Codex exec 缺少能力：${token}`);
    if (!resumeHelp.stdout.includes(token)) throw new Error(`Codex exec resume 缺少能力：${token}`);
  }
  if (!resumeHelp.stdout.includes('[SESSION_ID]')) throw new Error('Codex exec resume 缺少显式 session ID');
  const schemaHash = createHash('sha256').update(schema).digest('hex');
  return {
    version: actualVersion,
    fingerprint: `${actualVersion}:${DRIVER_PROTOCOL}:${schemaHash}`,
    command,
    decisionSchemaPath: DECISION_SCHEMA_PATH,
  };
}

export function buildCodexExecArgs(
  config: HostConfig,
  conversation: Conversation,
  schemaPath: string,
  prompt: string,
  providerSessionId: string | null,
): string[] {
  const hook = `[{ matcher = "^compact$", hooks = [{ type = "command", command = ${tomlString(commandLine([
    process.execPath, COMPACTION_HOOK_PATH,
  ]))}, additionalContextLimit = 2500 }] }]`;
  const common = [
    '--dangerously-bypass-hook-trust',
    '--json',
    '--output-schema', schemaPath,
    '--model', config.runtime.model,
    '--skip-git-repo-check',
    '-c', `model_reasoning_effort=${tomlString(config.runtime.effort)}`,
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_mode="workspace-write"',
    '-c', 'sandbox_workspace_write.network_access=false',
    '-c', 'sandbox_workspace_write.writable_roots=[]',
    '-c', `hooks.SessionStart=${hook}`,
    '-c', `developer_instructions=${tomlString(developerInstructions(config, conversation))}`,
  ];
  if (providerSessionId) return ['exec', 'resume', ...common, providerSessionId, prompt];
  return ['exec', ...common, '--sandbox', 'workspace-write', '-C', config.runtime.cwd, prompt];
}

export function promptForSession(
  config: HostConfig,
  conversation: Conversation,
  context: ConversationContext | null,
  prompt: string,
  providerSessionId: string | null,
): string {
  return providerSessionId || !context ? prompt : `${recoveryContext(config, conversation, context)}\n\n${prompt}`;
}

export class CodexJsonlCollector {
  readonly evidence: TurnEvidence = emptyTurnEvidence();
  providerSessionId: string | null = null;
  agentMessage = '';
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
    if (type !== 'item.started' && type !== 'item.completed') return;
    const item = event.item && typeof event.item === 'object' ? event.item as JsonObject : null;
    if (!item) return;
    const itemType = normalizeToken(item.type);
    if (type === 'item.completed' && itemType === 'agentmessage' && typeof item.text === 'string') {
      this.agentMessage = item.text;
    }
    if (itemType === 'commandexecution' || itemType === 'filechange') {
      if (!this.evidence.mainWorkItems.includes(itemType)) this.evidence.mainWorkItems.push(itemType);
    }
    const tool = normalizeToken(item.tool ?? item.name ?? item.tool_name);
    if (tool.includes('waitagent')) this.evidence.waitedForSubagent = true;
    if (tool.includes('spawnagent') || (itemType === 'subagentactivity' && normalizeToken(item.kind) === 'started')) {
      for (const id of subagentIds(item)) {
        if (!this.evidence.spawnedSubagentThreadIds.includes(id)) this.evidence.spawnedSubagentThreadIds.push(id);
      }
    }
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
    const existing = this.store.getSession(this.conversation.id);
    if (existing) {
      if (existing.lifecycle === 'failed'
        || existing.runtimeId !== this.config.runtime.id
        || existing.protocolFingerprint !== this.identity.fingerprint
        || existing.runtimeCwd !== this.config.runtime.cwd) {
        throw new Error('已持久化 session 与当前 runtime command/version/cwd 不兼容，拒绝静默创建新 session');
      }
      this.providerSessionId = existing.providerSessionId;
    }
    this.started = true;
    return { mode: existing ? 'resumed' : 'new', providerSessionId: this.providerSessionId };
  }

  async runDecision(prompt: string, shouldInterrupt?: () => boolean): Promise<DecisionRun> {
    if (!this.started) throw new Error('Codex command session 尚未 start');
    if (this.child) throw new Error('同一 conversation 已有活动 Codex command');
    const expectedSessionId = this.providerSessionId;
    const conversation = this.store.getConversation(this.conversation.id);
    if (!conversation) throw new Error(`conversation 不存在：${this.conversation.id}`);
    const recoveryPath = await publishRecoveryContext(this.config, conversation, this.store);
    const existingContext = this.store.getConversationContext(conversation.id);
    const effectivePrompt = promptForSession(this.config, conversation, existingContext, prompt, expectedSessionId);
    const expectedSignature = this.config.identity.signature;
    const collector = new CodexJsonlCollector(expectedSessionId);
    const turnId = randomUUID();
    const args = buildCodexExecArgs(
      this.config,
      conversation,
      this.identity.decisionSchemaPath,
      effectivePrompt,
      expectedSessionId,
    );
    const child = spawn(this.identity.command.file, commandArgs(this.identity.command, args), {
      cwd: this.config.runtime.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, AGENT_CHANNEL_RECOVERY_CONTEXT: recoveryPath },
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
    if (shouldInterrupt?.()) await this.interruptActive();
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      exit = await withTimeout(exited, this.config.runtime.turnTimeoutSeconds * 1_000, `Codex exec ${turnId.slice(0, 12)}`);
    } catch (error) {
      child.kill();
      await exited.catch(() => undefined);
      throw error;
    } finally {
      this.stdout?.close();
      this.stderr?.close();
      this.stdout = null;
      this.stderr = null;
      if (this.child === child) this.child = null;
      this.activeExit = null;
    }
    if (this.interruptRequested) {
      return { turnId, status: 'interrupted', decision: null, subagentThreadId: null };
    }
    if (streamError) throw streamError;
    if (collector.failure) throw collector.failure;
    if (exit.code !== 0) {
      const tail = this.stderrTail.length ? `；stderr tail: ${this.stderrTail.join(' | ')}` : '';
      throw new Error(`Codex exec 退出异常：code=${exit.code} signal=${exit.signal}${tail}`);
    }
    if (!collector.providerSessionId) throw new Error('Codex exec 未返回 provider session ID');
    if (!collector.turnCompleted) throw new Error('Codex exec 未返回 turn.completed');
    let decision: Decision;
    try {
      decision = JSON.parse(collector.agentMessage) as Decision;
    } catch (error) {
      throw new Error(`Codex 决策不是合法 JSON：${(error as Error).message}`);
    }
    validateDecision(decision, expectedSignature, collector.evidence);
    this.persistReady(collector.providerSessionId, turnId);
    return {
      turnId,
      status: 'completed',
      decision,
      subagentThreadId: collector.evidence.spawnedSubagentThreadIds[0] ?? null,
    };
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
      generation: existing?.generation ?? 1,
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

function commandLine(args: string[]): string {
  return args.map((value) => `"${value.replaceAll('"', '\\"')}"`).join(' ');
}

function normalizeToken(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[_\-/]/g, '').toLowerCase() : '';
}

function subagentIds(item: JsonObject): string[] {
  const values = [
    item.agent_thread_id, item.agentThreadId, item.new_thread_id, item.newThreadId,
    item.receiver_thread_id, item.receiverThreadId,
    ...(Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids : []),
    ...(Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []),
  ];
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function eventMessage(event: JsonObject): string {
  if (typeof event.message === 'string') return event.message;
  if (event.error && typeof event.error === 'object') {
    const error = event.error as JsonObject;
    if (typeof error.message === 'string') return error.message;
  }
  return JSON.stringify(event).slice(0, 500);
}
