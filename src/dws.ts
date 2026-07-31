import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { HostConfig } from './config.js';
import type { ConversationKind, NormalizedEvent, OutboxRecord } from './types.js';
import { delay, stopChild, withTimeout } from './process-utils.js';
import { commandArgs, execResolved, resolveCommand, type ResolvedCommand } from './command.js';
export const GROUP_EVENT = 'user_im_message_receive_group_all';
export const DIRECT_EVENT = 'user_im_message_receive_o2o_all';

export interface DwsCommandResult {
  stdout: string;
  stderr: string;
}

export async function runDwsJson(config: HostConfig, args: string[], timeoutMs = 30_000): Promise<unknown> {
  const fullArgs = [...args, '--format', 'json', ...profileArgs(config)];
  const command = await resolveCommand(config.runtime.dwsCommand);
  const result = await execResolved(command, fullArgs, {
    cwd: config.runtime.cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`DWS ${args.join(' ')} 未返回合法 JSON：${(error as Error).message}`);
  }
}

export async function resolveExactGroup(config: HostConfig, title: string): Promise<{ title: string; openConversationId: string }> {
  const result = await runDwsJson(config, ['chat', 'search', '--query', title]) as Record<string, unknown>;
  const resultBody = result.result as Record<string, unknown> | undefined;
  const groups = Array.isArray(resultBody?.groups) ? resultBody.groups : [];
  const exact = groups.filter((item) => {
    const group = item as Record<string, unknown>;
    return group.title === title && typeof group.openConversationId === 'string';
  }) as Array<Record<string, unknown>>;
  if (exact.length !== 1) {
    throw new Error(`群名“${title}”精确匹配数量为 ${exact.length}，拒绝猜测 ID`);
  }
  return { title, openConversationId: String(exact[0]!.openConversationId) };
}

export async function dwsDoctor(config: HostConfig): Promise<Record<string, unknown>> {
  const command = await resolveCommand(config.runtime.dwsCommand);
  const version = await execResolved(command, ['--version'], {
    cwd: config.runtime.cwd,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  const status = await runDwsJson(config, ['event', 'status'], 15_000);
  return { version: version.stdout.trim(), eventStatus: status };
}

export function normalizeDwsEvent(value: unknown): NormalizedEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const eventType = text(source.event_type) ?? text(source.type);
  const kind: ConversationKind | null = eventType?.includes('group')
    ? 'group'
    : eventType?.includes('o2o')
      ? 'direct'
      : null;
  if (!kind) return null;
  const externalId = kind === 'direct'
    ? text(source.sender_open_dingtalk_id) ?? text(source.conversation_id)
    : text(source.conversation_id) ?? text(source.open_conversation_id);
  if (!externalId) return null;
  const eventId = text(source.event_id);
  const messageId = text(source.message_id) ?? text(source.msg_id);
  if (!eventId && !messageId) return null;
  const fingerprintSource = [
    eventId, messageId, externalId, source.timestamp, source.create_time, source.content,
  ].map((part) => safeJson(part)).join('|');
  return {
    fingerprint: createHash('sha256').update(fingerprintSource).digest('hex'),
    eventId,
    messageId,
    conversationExternalId: externalId,
    kind,
    senderId: text(source.sender_open_dingtalk_id) ?? text(source.sender_id),
    senderName: text(source.sender) ?? text(source.sender_name),
    content: source.content ?? null,
    quotedMessage: source.quoted_message ?? null,
    forwardedMessages: source.forward_messages ?? null,
    occurredAt: text(source.event_time) ?? text(source.create_time) ?? text(source.timestamp),
    receivedAt: new Date().toISOString(),
    source,
  };
}

export function consumerArgs(eventKey: string, config: HostConfig): string[] {
  return [
    'event', 'consume', eventKey, '--ephemeral', '--flatten', '--format', 'ndjson',
    ...profileArgs(config),
  ];
}

export class DwsEventOwner {
  private bus: ChildProcessWithoutNullStreams | null = null;
  private consumers: ChildProcessWithoutNullStreams[] = [];
  private interfaces: Interface[] = [];
  private stopping = false;
  private command: ResolvedCommand | null = null;

  constructor(
    private readonly config: HostConfig,
    private readonly onEvent: (event: unknown) => void,
    private readonly onFatal: (error: Error) => void,
  ) {}

  async start(): Promise<void> {
    this.command = await resolveCommand(this.config.runtime.dwsCommand);
    const busArgs = [
      'event', 'consume', GROUP_EVENT, '--foreground', '--format', 'ndjson', ...profileArgs(this.config),
    ];
    this.bus = spawn(this.command.file, commandArgs(this.command, busArgs), {
      cwd: this.config.runtime.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.bus.once('error', this.onFatal);
    this.bus.once('exit', (code, signal) => {
      if (!this.stopping) this.onFatal(new Error(`DWS bus 意外退出：code=${code} signal=${signal}`));
    });
    const busStdout = createInterface({ input: this.bus.stdout });
    const busStderr = createInterface({ input: this.bus.stderr });
    busStdout.on('line', () => undefined);
    busStderr.on('line', () => undefined);
    this.interfaces.push(busStdout, busStderr);
    await this.waitForBus();
    await Promise.all([GROUP_EVENT, DIRECT_EVENT].map((eventKey) => this.startConsumer(eventKey)));
  }

  private async waitForBus(): Promise<void> {
    const deadline = Date.now() + this.config.runtime.startupTimeoutSeconds * 1_000;
    while (Date.now() < deadline) {
      if (this.bus?.exitCode !== null) throw new Error(`DWS bus ready 前退出：${this.bus?.exitCode}`);
      const status = await runDwsJson(this.config, ['event', 'status'], 15_000);
      const body = status as Record<string, unknown>;
      const bus = body.bus as Record<string, unknown> | undefined;
      const entry = bus?.entry as Record<string, unknown> | undefined;
      if (entry?.state === 'running') return;
      await delay(500);
    }
    throw new Error('DWS bus 未在启动期限内进入 running');
  }

  private async startConsumer(eventKey: string): Promise<void> {
    if (!this.command) throw new Error('DWS command 尚未解析');
    const child = spawn(this.command.file, commandArgs(this.command, consumerArgs(eventKey, this.config)), {
      cwd: this.config.runtime.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.consumers.push(child);
    const stdout = createInterface({ input: child.stdout });
    const stderr = createInterface({ input: child.stderr });
    this.interfaces.push(stdout, stderr);
    stdout.on('line', (line) => {
      try {
        this.onEvent(JSON.parse(line));
      } catch (error) {
        this.onFatal(new Error(`DWS ${eventKey} 输出非法 NDJSON：${(error as Error).message}`));
      }
    });
    let becameReady = false;
    const ready = new Promise<void>((resolve, reject) => {
      stderr.on('line', (line) => {
        if (/\[event\]\s+ready\b/.test(line)) {
          becameReady = true;
          resolve();
        }
      });
      child.once('error', (error) => {
        if (becameReady) this.onFatal(error);
        else reject(error);
      });
      child.once('exit', (code, signal) => {
        if (this.stopping) return;
        const error = new Error(`DWS ${eventKey} consumer 退出：code=${code} signal=${signal}`);
        if (becameReady) this.onFatal(error);
        else reject(error);
      });
    });
    await withTimeout(ready, this.config.runtime.startupTimeoutSeconds * 1_000, `DWS ${eventKey} ready`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.consumers.map((child) => stopChild(child)));
    await stopChild(this.bus);
    this.interfaces.forEach((item) => item.close());
    this.consumers = [];
    this.bus = null;
  }
}

export class DwsSender {
  constructor(private readonly config: HostConfig) {}

  async send(conversation: { kind: ConversationKind; externalId: string }, record: OutboxRecord): Promise<void> {
    const target = conversation.kind === 'group'
      ? ['--group', conversation.externalId]
      : ['--open-dingtalk-id', conversation.externalId];
    const result = await runDwsJson(this.config, [
      'chat', 'message', 'send', ...target,
      '--text', record.text, '--uuid', record.uuid, '--ai-tag=true', '--yes',
    ], 45_000) as Record<string, unknown>;
    if (result.success !== true) {
      throw new Error(`DWS 发送失败：${text(result.errorMsg) ?? text(result.errorCode) ?? 'unknown'}`);
    }
  }
}

function profileArgs(config: HostConfig): string[] {
  return config.runtime.dwsProfile ? ['--profile', config.runtime.dwsProfile] : [];
}

function text(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number') return String(value);
  return null;
}

function safeJson(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value.slice(0, 4_000);
  try {
    return JSON.stringify(value).slice(0, 4_000);
  } catch {
    return '[unserializable]';
  }
}
