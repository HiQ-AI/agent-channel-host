import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { MINIMUM_DWS_VERSION, type HostConfig } from './config.js';
import { assertMinimumToolVersion } from './tool-version.js';
import type { ChannelAdapter, ChannelHandlers } from './contracts.js';
import type { Conversation, ConversationKind, NormalizedEvent } from './types.js';
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
  senderId: string | null;
  time: string;
  content: string;
}

interface HistoryPage {
  messages: unknown[];
  hasMore: boolean;
}

export interface DwsGroupSearchResult {
  title: string;
  openConversationId: string;
}

const BOT_MESSAGE_REFRESH_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

export function isProvisionalBotMessage(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  const value = content.trim();
  if (!value || value.length > 120) return false;
  return /^(?:机器人)?(?:消息|回复)?\s*(?:正在)?(?:处理|进行|生成|思考)中(?:[，,。.!！…\s]*(?:请稍候|请稍后(?:查看|再试)?))?[。.！!…\s]*$/.test(value);
}

export function parseDwsMessageLookup(value: unknown, messageId: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const messages = (value as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return null;
  for (const item of messages) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const message = item as Record<string, unknown>;
    if (text(firstValue(message, ['messageId', 'openMessageId', 'message_id'])) !== messageId) continue;
    return text(firstValue(message, ['text', 'content', 'message']));
  }
  return null;
}

export async function stabilizeDwsBotMessage(
  config: HostConfig,
  event: NormalizedEvent,
  runner: typeof runDwsJson = runDwsJson,
  sleep: (milliseconds: number) => Promise<void> = delay,
  delays: readonly number[] = BOT_MESSAGE_REFRESH_DELAYS_MS,
  signal?: AbortSignal,
): Promise<NormalizedEvent> {
  if (!event.messageId || !isProvisionalBotMessage(event.content)) return event;
  let latest = typeof event.content === 'string' ? event.content : '';
  let previousFinal: string | null = null;
  for (const milliseconds of delays) {
    await sleep(milliseconds);
    if (signal?.aborted) return latest === event.content ? event : refreshedEvent(event, latest);
    try {
      const value = await runner(config, ['chat', '+messages-mget', '--msg-ids', event.messageId]);
      const refreshed = parseDwsMessageLookup(value, event.messageId);
      if (!refreshed) continue;
      latest = refreshed;
      if (isProvisionalBotMessage(refreshed)) {
        previousFinal = null;
        continue;
      }
      if (previousFinal === refreshed) return refreshedEvent(event, refreshed);
      previousFinal = refreshed;
    } catch {
      // 有界回查失败不影响原消息进入 durable inbox。
    }
  }
  return latest === event.content ? event : refreshedEvent(event, latest);
}

function refreshedEvent(event: NormalizedEvent, content: string): NormalizedEvent {
  return { ...event, content, source: { ...event.source, stabilizedBy: 'messages-mget' } };
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
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

export async function fetchConversationBackfill(
  config: HostConfig,
  conversation: Conversation,
  start: Date,
  until: Date,
  runner: typeof runDwsJson = runDwsJson,
): Promise<NormalizedEvent[]> {
  let pageTime = start;
  const events: NormalizedEvent[] = [];
  while (true) {
    const target = conversation.kind === 'group'
      ? ['--group', conversation.externalId]
      : ['--open-dingtalk-id', conversation.externalId];
    const value = await runner(config, [
      'chat', 'message', 'list', ...target,
      '--time', formatDwsLocalTime(pageTime), '--direction', 'newer', '--limit', '50',
    ], 45_000);
    const page = parseHistoryPage(value);
    let boundary = pageTime.getTime();
    for (const raw of page.messages) {
      const event = normalizeDwsHistoryMessage(conversation, raw);
      const occurred = event.occurredAt ? Date.parse(event.occurredAt) : Number.NaN;
      if (!Number.isFinite(occurred)) throw new Error('DWS 历史消息缺少有效 createTime');
      boundary = Math.max(boundary, occurred);
      if (occurred <= until.getTime()) events.push(event);
    }
    if (!page.hasMore) break;
    if (boundary <= pageTime.getTime()) throw new Error(`DWS 历史分页边界未推进：${conversation.id}`);
    pageTime = new Date(boundary);
  }
  return events.sort((left, right) => Date.parse(left.occurredAt!) - Date.parse(right.occurredAt!));
}

export function parseHistoryPage(value: unknown): HistoryPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DWS 历史返回结构无效');
  const body = value as Record<string, unknown>;
  if (body.success !== true) {
    throw new Error(`DWS 历史读取失败：${text(body.errorMsg) ?? text(body.errorCode) ?? 'unknown'}`);
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
  if (!messages) throw new Error('DWS 历史返回缺少消息数组');
  return { messages, hasMore: body.hasMore === true || nested?.hasMore === true };
}

export function normalizeDwsHistoryMessage(conversation: Conversation, value: unknown): NormalizedEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DWS 历史消息结构无效');
  const source = value as Record<string, unknown>;
  const messageId = text(firstValue(source, ['openMessageId', 'messageId', 'message_id', 'msgId', 'msg_id']));
  const occurredAt = parseDwsMessageTime(firstValue(source, ['createTime', 'create_time', 'sendTime', 'timestamp']));
  if (!occurredAt) throw new Error('DWS 历史消息缺少有效 createTime');
  const fingerprintSource = [
    conversation.channelId, conversation.channelProfileId, messageId, conversation.externalId,
    occurredAt, firstValue(source, ['content', 'msgContent', 'text', 'message']),
  ].map((part) => safeJson(part)).join('|');
  return {
    channelId: conversation.channelId,
    channelProfileId: conversation.channelProfileId,
    fingerprint: createHash('sha256').update(fingerprintSource).digest('hex'),
    eventId: null,
    messageId,
    conversationExternalId: conversation.externalId,
    conversationTitle: conversation.title,
    kind: conversation.kind,
    senderId: text(firstValue(source, ['senderOpenDingTalkId', 'sender_open_dingtalk_id', 'senderId', 'sender_id'])),
    senderName: text(firstValue(source, ['senderName', 'sender_name', 'sender', 'nickName', 'nickname'])),
    content: firstValue(source, ['content', 'msgContent', 'text', 'message']),
    quotedMessage: firstValue(source, ['quotedMessage', 'quoted_message']),
    forwardedMessages: firstValue(source, ['forwardMessages', 'forward_messages']),
    occurredAt,
    receivedAt: new Date().toISOString(),
    source,
  };
}

export function currentProfileUserName(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DWS profile list 返回结构无效');
  const body = value as Record<string, unknown>;
  const currentProfile = text(body.currentProfile);
  const profiles = Array.isArray(body.profiles) ? body.profiles : [];
  const current = profiles.find((profile) => {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return false;
    const entry = profile as Record<string, unknown>;
    return entry.isCurrent === true || (currentProfile && text(entry.profile) === currentProfile);
  }) as Record<string, unknown> | undefined;
  const userName = text(current?.userName);
  if (!userName) throw new Error('DWS 当前 profile 缺少 userName，无法识别本人消息');
  return userName;
}

export function isCurrentUserHistoryMessage(event: NormalizedEvent, currentUserName: string): boolean {
  return event.senderName === currentUserName;
}

export function isCurrentUserHumanMessage(event: NormalizedEvent, currentUserName: string): boolean {
  if (!isCurrentUserHistoryMessage(event, currentUserName)) return false;
  const aiTag = firstValue(event.source, ['aiTag', 'ai_tag', 'isAi', 'is_ai']);
  return aiTag !== true && aiTag !== 'true';
}

export function applyWakeWordSubscription(
  config: HostConfig,
  event: NormalizedEvent,
  currentUserName: string,
): NormalizedEvent | null {
  const subscription = event.kind === 'group'
    ? config.channel.subscriptions.groups
    : config.channel.subscriptions.directs;
  if (subscription !== 'wake-word') return event;
  if (!isCurrentUserHumanMessage(event, currentUserName)) return null;
  const content = wakeWordContent(event.content);
  if (content === null || !content.startsWith(config.channel.wakeWord)) return null;
  const instruction = content.slice(config.channel.wakeWord.length).replace(/^[\s:：,，、]+/u, '');
  if (!instruction) return null;
  return { ...event, content: instruction };
}

function wakeWordContent(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return text(firstValue(value as Record<string, unknown>, ['text', 'content']));
}

export async function dwsDoctor(config: HostConfig): Promise<Record<string, unknown>> {
  const command = await resolveCommand(config.channel.command);
  const version = await execResolved(command, ['--version'], {
    cwd: config.runtime.cwd,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  const actualVersion = version.stdout.trim();
  assertMinimumToolVersion('DWS', MINIMUM_DWS_VERSION, actualVersion);
  const status = await runDwsJson(config, ['event', 'status'], 15_000);
  return { version: actualVersion, eventStatus: status };
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

export class DwsChannelAdapter implements ChannelAdapter {
  readonly descriptor;
  private owner: DwsEventOwner | null = null;
  private readonly eventQueues = new Map<string, Promise<void>>();
  private stabilizationAbort = new AbortController();
  private selfUserName: string | null = null;

  constructor(private readonly config: HostConfig) {
    this.descriptor = {
      channelId: config.channel.id,
      profileId: config.channel.profileId,
      label: 'DingTalk DWS',
    };
  }

  async start(handlers: ChannelHandlers): Promise<void> {
    if (this.owner) throw new Error('DWS ChannelAdapter 已启动');
    this.stabilizationAbort = new AbortController();
    const command = await resolveCommand(this.config.channel.command);
    const version = await execResolved(command, ['--version'], {
      cwd: this.config.runtime.cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    assertMinimumToolVersion('DWS', MINIMUM_DWS_VERSION, version.stdout.trim());
    this.selfUserName = currentProfileUserName(await runDwsJson(this.config, ['profile', 'list'], 15_000));
    this.owner = new DwsEventOwner(
      this.config,
      (raw) => {
        const event = normalizeDwsEvent(raw, this.descriptor.channelId, this.descriptor.profileId);
        if (!event) return;
        const key = `${event.kind}:${event.conversationExternalId}`;
        const previous = this.eventQueues.get(key) ?? Promise.resolve();
        const current = previous
          .then(async () => {
            const stabilized = await stabilizeDwsBotMessage(
              this.config,
              event,
              runDwsJson,
              (milliseconds) => delayUntilAbort(milliseconds, this.stabilizationAbort.signal),
              BOT_MESSAGE_REFRESH_DELAYS_MS,
              this.stabilizationAbort.signal,
            );
            const accepted = applyWakeWordSubscription(this.config, stabilized, this.selfUserName!);
            if (accepted) handlers.onEvent(accepted);
          })
          .catch(handlers.onFatal)
          .finally(() => {
            if (this.eventQueues.get(key) === current) this.eventQueues.delete(key);
          });
        this.eventQueues.set(key, current);
      },
      handlers.onFatal,
    );
    await this.owner.start();
  }

  async stop(): Promise<void> {
    this.stabilizationAbort.abort();
    await this.owner?.stop();
    await Promise.allSettled(this.eventQueues.values());
    this.eventQueues.clear();
    this.owner = null;
  }

  async backfill(
    targets: Array<{ conversation: Conversation; start: Date }>,
    until: Date,
    onEvent: (event: NormalizedEvent) => void,
  ): Promise<number> {
    let count = 0;
    for (const { conversation, start } of targets) {
      const events = await fetchConversationBackfill(
        this.config,
        conversation,
        start,
        until,
      );
      for (const event of events) {
        const accepted = applyWakeWordSubscription(this.config, event, this.selfUserName!);
        if (!accepted) continue;
        onEvent(accepted);
        count++;
      }
    }
    return count;
  }

  async pollSelfMessages(
    targets: Array<{ conversation: Conversation; start: Date }>,
    until: Date,
    onEvent: (event: NormalizedEvent) => void,
  ): Promise<number> {
    if (!this.selfUserName) throw new Error('DWS 当前用户尚未解析');
    let count = 0;
    for (const { conversation, start } of targets) {
      const events = await fetchConversationBackfill(this.config, conversation, start, until);
      for (const event of events) {
        if (!isCurrentUserHistoryMessage(event, this.selfUserName)) continue;
        const accepted = applyWakeWordSubscription(this.config, event, this.selfUserName);
        if (!accepted) continue;
        onEvent(accepted);
        count++;
      }
    }
    return count;
  }

}

function delayUntilAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
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
    return { sender: '未知', senderId: null, time: '未知', content: safeJson(value) || '[空消息]' };
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
    senderId: text(firstValue(source, ['senderOpenDingTalkId', 'sender_open_dingtalk_id', 'senderId', 'sender_id'])),
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

function parseDwsMessageTime(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const numeric = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  const parsed = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
    : new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)
      ? raw
      : `${raw.replace(' ', 'T')}+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
