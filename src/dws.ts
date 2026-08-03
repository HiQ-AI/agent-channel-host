import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { HostConfig } from './config.js';
import { ChannelDeliveryUnknownError, type ChannelAdapter, type ChannelHandlers } from './contracts.js';
import type { Conversation, ConversationKind, NormalizedEvent, OutboxRecord } from './types.js';
import { delay, stopChild, withTimeout } from './process-utils.js';
import { commandArgs, execResolved, resolveCommand, type ResolvedCommand } from './command.js';
export const GROUP_EVENT = 'user_im_message_receive_group_all';
export const DIRECT_EVENT = 'user_im_message_receive_o2o_all';

export interface DwsCommandResult {
  stdout: string;
  stderr: string;
}

export class DwsCommandError extends Error {
  constructor(
    readonly operation: string,
    readonly response: Record<string, unknown> | null,
    readonly exitCode: string | number | null,
    cause: unknown,
  ) {
    super(`DWS ${operation} 执行失败：${dwsFailureSummary(response, exitCode)}`, { cause });
    this.name = 'DwsCommandError';
  }
}

export interface RecentGroupHistory {
  count: number;
  messages: RecentMessage[];
}

export interface RecentMessage {
  sender: string;
  time: string;
  content: string;
}

export interface DwsGroupSearchResult {
  title: string;
  openConversationId: string;
}

export async function runDwsJson(config: HostConfig, args: string[], timeoutMs = 30_000): Promise<unknown> {
  const fullArgs = [...args, '--format', 'json', ...profileArgs(config)];
  const command = await resolveCommand(config.channel.command);
  let result: DwsCommandResult;
  try {
    result = await execResolved(command, fullArgs, {
      cwd: config.runtime.cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    throw parseDwsCommandFailure(error, args);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`DWS ${args.join(' ')} 未返回合法 JSON：${(error as Error).message}`);
  }
}

export async function searchDwsGroups(
  config: HostConfig,
  query: string,
  runner: typeof runDwsJson = runDwsJson,
): Promise<DwsGroupSearchResult[]> {
  const keyword = query.trim();
  if (!keyword) throw new Error('群搜索关键词不能为空');
  return parseDwsGroupSearch(await runner(config, ['chat', 'search', '--query', keyword]));
}

export function parseDwsGroupSearch(value: unknown): DwsGroupSearchResult[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DWS 群搜索返回结构无效');
  const body = value as Record<string, unknown>;
  if (body.success === false) {
    throw new Error(`DWS 群搜索失败：${text(body.errorMsg) ?? text(body.errorCode) ?? 'unknown'}`);
  }
  const result = body.result;
  const resultBody = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : null;
  const groups = Array.isArray(resultBody?.groups) ? resultBody.groups : [];
  const seen = new Set<string>();
  const projected: DwsGroupSearchResult[] = [];
  for (const item of groups) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const group = item as Record<string, unknown>;
    const title = text(group.title)?.trim();
    const openConversationId = text(group.openConversationId)?.trim();
    if (!title || !openConversationId || seen.has(openConversationId)) continue;
    seen.add(openConversationId);
    projected.push({ title, openConversationId });
  }
  return projected;
}

export async function resolveExactGroup(config: HostConfig, title: string): Promise<{ title: string; openConversationId: string }> {
  const exact = (await searchDwsGroups(config, title)).filter((group) => group.title === title);
  if (exact.length !== 1) {
    throw new Error(`群名“${title}”精确匹配数量为 ${exact.length}，拒绝猜测 ID`);
  }
  return exact[0]!;
}

export async function fetchRecentGroupHistory(
  config: HostConfig,
  conversation: Conversation,
  now = new Date(),
  runner: typeof runDwsJson = runDwsJson,
): Promise<RecentGroupHistory> {
  if (conversation.kind !== 'group') throw new Error('只有群 conversation 可以拉取群历史');
  const result = await runner(config, [
    'chat', 'message', 'list', '--group', conversation.externalId,
    '--time', formatDwsLocalTime(now), '--direction', 'older', '--limit', '50',
  ], 45_000);
  return parseRecentGroupHistory(result);
}

export function parseRecentGroupHistory(value: unknown): RecentGroupHistory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DWS 群历史返回结构无效');
  const body = value as Record<string, unknown>;
  if (body.success !== true) {
    throw new Error(`DWS 群历史读取失败：${text(body.errorMsg) ?? text(body.errorCode) ?? 'unknown'}`);
  }
  const result = body.result;
  const nested = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : null;
  const messages = Array.isArray(result)
    ? result
    : Array.isArray(nested?.messages)
      ? nested.messages
      : Array.isArray(nested?.data)
        ? nested.data
        : null;
  if (!messages) throw new Error('DWS 群历史返回缺少消息数组');

  const newestFirst = messages.slice(0, 50).map(projectHistoryMessage);
  const selected: RecentMessage[] = [];
  let size = 0;
  for (const message of newestFirst) {
    const serialized = JSON.stringify(message);
    if (size + serialized.length > 60_000) break;
    selected.push(message);
    size += serialized.length;
  }
  return {
    count: selected.length,
    messages: selected.reverse(),
  };
}

export function formatDwsLocalTime(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

export async function dwsDoctor(config: HostConfig): Promise<Record<string, unknown>> {
  const command = await resolveCommand(config.channel.command);
  const version = await execResolved(command, ['--version'], {
    cwd: config.runtime.cwd,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  const status = await runDwsJson(config, ['event', 'status'], 15_000);
  return { version: version.stdout.trim(), eventStatus: status };
}

export function normalizeDwsEvent(
  value: unknown,
  channelId = 'dingtalk',
  channelProfileId = 'default',
): NormalizedEvent | null {
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
    channelId, channelProfileId, eventId, messageId, externalId,
    source.timestamp, source.create_time, source.content,
  ].map((part) => safeJson(part)).join('|');
  return {
    channelId,
    channelProfileId,
    fingerprint: createHash('sha256').update(fingerprintSource).digest('hex'),
    eventId,
    messageId,
    conversationExternalId: externalId,
    conversationTitle: text(firstValue(source, [
      'conversation_title', 'conversationTitle', 'conversation_name', 'conversationName', 'group_name', 'groupName',
    ])),
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

export function subscribedEventKeys(config: HostConfig): string[] {
  const eventKeys: string[] = [];
  if (config.channel.subscriptions.groups !== 'none') eventKeys.push(GROUP_EVENT);
  if (config.channel.subscriptions.directs !== 'none') eventKeys.push(DIRECT_EVENT);
  return eventKeys;
}

export function inspectDwsBusStatus(value: unknown): { state: string | null; live: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: null, live: false };
  const bus = (value as Record<string, unknown>).bus;
  if (!bus || typeof bus !== 'object' || Array.isArray(bus)) return { state: null, live: false };
  const entry = (bus as Record<string, unknown>).entry;
  const live = (bus as Record<string, unknown>).live;
  return {
    state: entry && typeof entry === 'object' && !Array.isArray(entry)
      ? text((entry as Record<string, unknown>).state)
      : null,
    live: Boolean(live && typeof live === 'object' && !Array.isArray(live)),
  };
}

export function dwsProcessExitError(
  label: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrLines: string[],
): Error {
  return new Error(`${label}：code=${code} signal=${signal}${dwsStderrSuffix(stderrLines)}`);
}

export class DwsEventOwner {
  private bus: ChildProcessWithoutNullStreams | null = null;
  private consumers: ChildProcessWithoutNullStreams[] = [];
  private interfaces: Interface[] = [];
  private stopping = false;
  private command: ResolvedCommand | null = null;
  private busReady = false;
  private busSpawnError: Error | null = null;
  private busStderr: string[] = [];

  constructor(
    private readonly config: HostConfig,
    private readonly onEvent: (event: unknown) => void,
    private readonly onFatal: (error: Error) => void,
  ) {}

  async start(): Promise<void> {
    const eventKeys = subscribedEventKeys(this.config);
    if (eventKeys.length === 0) return;
    this.command = await resolveCommand(this.config.channel.command);
    const busArgs = [
      'event', 'consume', eventKeys[0]!, '--foreground', '--format', 'ndjson', ...profileArgs(this.config),
    ];
    this.bus = spawn(this.command.file, commandArgs(this.command, busArgs), {
      cwd: this.config.runtime.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.bus.once('error', (error) => {
      const wrapped = new Error(`DWS bus 启动失败：${error.message}`);
      this.busSpawnError = wrapped;
      if (this.busReady && !this.stopping) this.onFatal(wrapped);
    });
    this.bus.once('exit', (code, signal) => {
      if (this.busReady && !this.stopping) {
        this.onFatal(dwsProcessExitError('DWS bus 意外退出', code, signal, this.busStderr));
      }
    });
    const busStdout = createInterface({ input: this.bus.stdout });
    const busStderr = createInterface({ input: this.bus.stderr });
    busStdout.on('line', () => undefined);
    busStderr.on('line', (line) => appendDwsStderr(this.busStderr, line));
    this.interfaces.push(busStdout, busStderr);
    try {
      await this.waitForBus();
      await Promise.all(eventKeys.map((eventKey) => this.startConsumer(eventKey)));
      this.busReady = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private async waitForBus(): Promise<void> {
    const deadline = Date.now() + this.config.runtime.startupTimeoutSeconds * 1_000;
    let staleSince: number | null = null;
    while (Date.now() < deadline) {
      if (this.busSpawnError) throw this.busSpawnError;
      if (this.bus?.exitCode !== null || this.bus?.signalCode !== null) {
        throw dwsProcessExitError('DWS bus ready 前退出', this.bus?.exitCode ?? null, this.bus?.signalCode ?? null, this.busStderr);
      }
      const status = await runDwsJson(this.config, ['event', 'status'], 15_000);
      const probe = inspectDwsBusStatus(status);
      if (probe.state === 'running' && probe.live) return;
      if (probe.state === 'running') {
        staleSince ??= Date.now();
        if (Date.now() - staleSince >= 2_000) {
          throw new Error(
            `DWS bus 状态失真：bus.lock 显示 running，但 status RPC 连续不可用；疑似 stale bus 或 PID 复用${dwsStderrSuffix(this.busStderr)}`,
          );
        }
      } else {
        staleSince = null;
      }
      await delay(500);
    }
    throw new Error(`DWS bus 未在启动期限内进入可连接状态${dwsStderrSuffix(this.busStderr)}`);
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
    const stderrLines: string[] = [];
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
        appendDwsStderr(stderrLines, line);
        if (/\[event\]\s+ready\b/.test(line)) {
          becameReady = true;
          resolve();
        }
      });
      child.once('error', (error) => {
        const wrapped = new Error(`DWS ${eventKey} consumer 启动失败：${error.message}`);
        if (becameReady) this.onFatal(wrapped);
        else reject(wrapped);
      });
      child.once('exit', (code, signal) => {
        if (this.stopping) return;
        const error = dwsProcessExitError(`DWS ${eventKey} consumer 退出`, code, signal, stderrLines);
        if (becameReady) this.onFatal(error);
        else reject(error);
      });
    });
    try {
      await withTimeout(ready, this.config.runtime.startupTimeoutSeconds * 1_000, `DWS ${eventKey} ready`);
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes('stderr=')) throw error;
      throw new Error(`${message}${dwsStderrSuffix(stderrLines)}`);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.consumers.map((child) => stopChild(child)));
    await stopChild(this.bus);
    this.interfaces.forEach((item) => item.close());
    this.consumers = [];
    this.bus = null;
    this.busReady = false;
    this.busSpawnError = null;
    this.busStderr = [];
  }
}

export class DwsSender {
  constructor(
    private readonly config: HostConfig,
    private readonly runner: typeof runDwsJson = runDwsJson,
  ) {}

  async send(
    conversation: { kind: ConversationKind; externalId: string },
    record: Pick<OutboxRecord, 'text' | 'uuid'>,
  ): Promise<void> {
    const target = conversation.kind === 'group'
      ? ['--group', conversation.externalId]
      : ['--open-dingtalk-id', conversation.externalId];
    let result: Record<string, unknown>;
    try {
      result = await this.runner(this.config, [
        'chat', 'message', 'send', ...target,
        '--text', record.text, '--uuid', record.uuid, '--ai-tag=true', '--yes',
      ], 45_000) as Record<string, unknown>;
    } catch (error) {
      if (isDwsRepeatedUuidError(error)) throw new ChannelDeliveryUnknownError('duplicate_uuid');
      throw error;
    }
    if (isDwsRepeatedUuidResponse(result)) throw new ChannelDeliveryUnknownError('duplicate_uuid');
    if (result.success !== true) {
      throw new Error(`DWS 发送失败：${dwsFailureSummary(result, null)}`);
    }
  }
}

export class DwsChannelAdapter implements ChannelAdapter {
  readonly descriptor;
  private owner: DwsEventOwner | null = null;
  private readonly sender: DwsSender;

  constructor(private readonly config: HostConfig) {
    this.descriptor = {
      channelId: config.channel.id,
      profileId: config.channel.profileId,
      label: 'DingTalk DWS',
    };
    this.sender = new DwsSender(config);
  }

  async start(handlers: ChannelHandlers): Promise<void> {
    if (this.owner) throw new Error('DWS ChannelAdapter 已启动');
    this.owner = new DwsEventOwner(
      this.config,
      (raw) => {
        const event = normalizeDwsEvent(raw, this.descriptor.channelId, this.descriptor.profileId);
        if (!event) return;
        handlers.onEvent(event);
      },
      handlers.onFatal,
    );
    await this.owner.start();
  }

  async stop(): Promise<void> {
    await this.owner?.stop();
    this.owner = null;
  }

  send(conversation: Conversation, record: Pick<OutboxRecord, 'text' | 'uuid'>): Promise<void> {
    return this.sender.send(conversation, record);
  }
}

function profileArgs(config: HostConfig): string[] {
  return config.channel.profile ? ['--profile', config.channel.profile] : [];
}

export function parseDwsCommandFailure(error: unknown, args: string[]): DwsCommandError {
  const failure = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  const response = parseDwsErrorJson(failure?.stdout) ?? parseDwsErrorJson(failure?.stderr);
  const operation = args.slice(0, 3).filter((part) => !part.startsWith('--')).join(' ') || 'command';
  const exitCode = typeof failure?.code === 'string' || typeof failure?.code === 'number' ? failure.code : null;
  return new DwsCommandError(operation, response, exitCode, error);
}

export function isDwsRepeatedUuidError(error: unknown): boolean {
  return error instanceof DwsCommandError && isDwsRepeatedUuidResponse(error.response);
}

function isDwsRepeatedUuidResponse(value: unknown): boolean {
  const error = dwsErrorBody(value);
  const message = text(error?.message);
  return error?.reason === 'business_error'
    && String(error.server_error_code ?? '') === '1001'
    && Boolean(message && /Request is repeated with uuid\b/i.test(message));
}

function parseDwsErrorJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function dwsErrorBody(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const nested = (value as Record<string, unknown>).error;
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : value as Record<string, unknown>;
}

function dwsFailureSummary(response: Record<string, unknown> | null, exitCode: string | number | null): string {
  if (isDwsRepeatedUuidResponse(response)) return 'duplicate_uuid';
  const error = dwsErrorBody(response);
  const fields = [
    ['category', error?.category],
    ['reason', error?.reason],
    ['server_error_code', error?.server_error_code],
    ['operation', error?.operation],
  ].flatMap(([key, value]) => text(value) ? [`${key}=${text(value)}`] : []);
  if (fields.length > 0) return fields.join(' ');
  return exitCode === null ? 'unknown' : `exit_code=${exitCode}`;
}

function text(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number') return String(value);
  return null;
}

function safeJson(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.slice(0, 4_000);
  try {
    return JSON.stringify(value).slice(0, 4_000);
  } catch {
    return '[unserializable]';
  }
}

function appendDwsStderr(lines: string[], line: string): void {
  const compact = line.trim();
  if (!compact) return;
  lines.push(compact.slice(0, 1_000));
  if (lines.length > 8) lines.splice(0, lines.length - 8);
}

function dwsStderrSuffix(lines: string[]): string {
  if (lines.length === 0) return '';
  const detail = lines.join(' | ')
    .replace(/\b(access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)\b\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .slice(-2_000);
  return detail ? ` stderr=${detail}` : '';
}

function projectHistoryMessage(value: unknown): RecentMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { sender: '未知', time: '未知', content: safeJson(value) || '[空消息]' };
  }
  const source = value as Record<string, unknown>;
  const quoted = firstValue(source, ['quotedMessage', 'quoted_message']);
  const forwarded = firstValue(source, ['forwardMessages', 'forward_messages']);
  const content = safeJson(firstValue(source, ['content', 'msgContent', 'text', 'message'])) || '[空消息]';
  const parts = [content];
  const quotedText = historyNestedContent(quoted);
  const forwardedText = historyNestedContent(forwarded);
  if (quotedText) parts.push(`引用内容：${quotedText}`);
  if (forwardedText) parts.push(`合并转发内容：${forwardedText}`);
  return {
    sender: text(firstValue(source, ['senderName', 'sender_name', 'sender', 'nickName', 'nickname'])) ?? '未知',
    time: text(firstValue(source, ['createTime', 'create_time', 'sendTime', 'timestamp'])) ?? '未知',
    content: parts.join('\n'),
  };
}

function historyNestedContent(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return JSON.stringify(value.slice(0, 50).map(projectHistoryMessage));
  if (typeof value === 'object') return JSON.stringify(projectHistoryMessage(value));
  return safeJson(value);
}

function firstValue(source: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (source[name] !== undefined && source[name] !== null) return source[name];
  }
  return null;
}
