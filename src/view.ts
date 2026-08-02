import type { HostConfig } from './config.js';
import { validateConfig, writeConfig } from './config.js';
import type { Store } from './store.js';
import { CLI_NAME } from './product.js';
import { MAX_WORKER_WARM_SECONDS } from './types.js';
import { publishRecoveryContext } from './recovery-context.js';

type Json = Record<string, unknown>;

export interface ViewOptions {
  instance: string;
  intervalSeconds: number;
  once: boolean;
  showContent: boolean;
  attachedToExistingHost?: boolean;
  notices?: string[];
}

export interface ManagementViewState {
  tab: 'overview' | 'settings';
  selectedConversation: number;
  selectedSetting: number;
  detailConversationId: string | null;
  editing: { key: string; label: string; value: string } | null;
  notice: string | null;
}

export interface SettingEntry {
  key: string;
  label: string;
  value: string;
  hint: string;
  apply(value: string): Promise<void>;
}

export function createManagementViewState(): ManagementViewState {
  return {
    tab: 'overview',
    selectedConversation: 0,
    selectedSetting: 0,
    detailConversationId: null,
    editing: null,
    notice: null,
  };
}

export function assertInteractiveView(options: ViewOptions): void {
  if (!options.once && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('持续 view 需要交互式终端；在管道或脚本中请使用 --once');
  }
}

export function shouldStartHostForView(once: boolean, snapshot: Record<string, unknown>): boolean {
  return !once && snapshot.hostState !== 'running';
}

export async function runView(store: Store, config: HostConfig, options: ViewOptions): Promise<void> {
  assertInteractiveView(options);
  if (options.once) {
    process.stdout.write(`${renderStatusView(options.instance, store.status(options.showContent), process.stdout.columns ?? 120)}\n`);
    return;
  }

  const state = createManagementViewState();
  let rawMode = false;
  let timer: NodeJS.Timeout | null = null;
  let inputBusy = false;
  let resolveStop!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
  const render = () => {
    const snapshot = store.status(options.showContent);
    const conversations = array(snapshot.conversations);
    if (state.selectedConversation >= conversations.length) state.selectedConversation = Math.max(0, conversations.length - 1);
    const selected = conversations[state.selectedConversation];
    const selectedId = typeof selected?.id === 'string' ? selected.id : null;
    const detailId = state.detailConversationId ?? selectedId;
    const detail = detailId ? store.conversationDetail(detailId, options.showContent) : null;
    const settings = createSettingEntries(config, store, selectedId);
    if (state.selectedSetting >= settings.length) state.selectedSetting = Math.max(0, settings.length - 1);
    return renderManagementView(
      options.instance,
      snapshot,
      config,
      state,
      detail,
      settings,
      process.stdout.columns ?? 120,
      options.attachedToExistingHost ?? false,
      options.notices ?? [],
    );
  };
  const paint = () => process.stdout.write(`\u001b[2J\u001b[H${render()}\n`);
  const onData = (chunk: Buffer) => {
    if (inputBusy) return;
    inputBusy = true;
    void handleManagementViewInput(chunk.toString('utf8'), state, config, store, resolveStop)
      .catch((error) => { state.notice = (error as Error).message; })
      .finally(() => {
        inputBusy = false;
        paint();
      });
  };
  const onSignal = () => resolveStop();
  try {
    process.stdin.setRawMode?.(true);
    rawMode = true;
    process.stdin.resume();
    process.stdin.on('data', onData);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    paint();
    timer = setInterval(paint, options.intervalSeconds * 1_000);
    await stopped;
  } finally {
    if (timer) clearInterval(timer);
    process.stdin.removeListener('data', onData);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (rawMode) process.stdin.setRawMode?.(false);
    process.stdin.pause();
  }
}

export async function handleManagementViewInput(
  key: string,
  state: ManagementViewState,
  config: HostConfig,
  store: Store,
  stop: () => void,
): Promise<void> {
  if (state.editing) {
    if (key === '\u001b') {
      state.editing = null;
      state.notice = '已取消修改';
      return;
    }
    if (key === '\r' || key === '\n') {
      const selectedId = selectedConversationId(store, state.selectedConversation);
      const entry = createSettingEntries(config, store, selectedId).find((item) => item.key === state.editing!.key);
      if (!entry) throw new Error('设置项已变化，请重新选择');
      await entry.apply(state.editing.value);
      state.notice = `${entry.label} 已保存`;
      state.editing = null;
      return;
    }
    if (key === '\u007f' || key === '\b') {
      state.editing.value = state.editing.value.slice(0, -1);
      return;
    }
    if (!key.startsWith('\u001b') && key !== '\u0003') state.editing.value += key.replace(/[\u0000-\u001f]/g, '');
    return;
  }

  if (key.toLowerCase() === 'q' || key === '\u0003') {
    stop();
    return;
  }
  if (key === '\t' || key === '\u001b[C' || key === '\u001b[D') {
    state.tab = state.tab === 'overview' ? 'settings' : 'overview';
    state.detailConversationId = null;
    state.notice = null;
    return;
  }
  if (key === '\u001b') {
    state.detailConversationId = null;
    state.notice = null;
    return;
  }
  const direction = key === '\u001b[A' || key.toLowerCase() === 'k' ? -1
    : key === '\u001b[B' || key.toLowerCase() === 'j' ? 1 : 0;
  if (direction !== 0) {
    if (state.tab === 'overview') {
      const total = store.listConversations().length;
      state.selectedConversation = clamp(state.selectedConversation + direction, 0, Math.max(0, total - 1));
    } else {
      const selectedId = selectedConversationId(store, state.selectedConversation);
      const total = createSettingEntries(config, store, selectedId).length;
      state.selectedSetting = clamp(state.selectedSetting + direction, 0, Math.max(0, total - 1));
    }
    return;
  }
  if (key === '\r' || key === '\n') {
    if (state.tab === 'overview') {
      state.detailConversationId = selectedConversationId(store, state.selectedConversation);
      return;
    }
    const selectedId = selectedConversationId(store, state.selectedConversation);
    const entry = createSettingEntries(config, store, selectedId)[state.selectedSetting];
    if (entry) state.editing = { key: entry.key, label: entry.label, value: entry.value };
  }
}

export function createSettingEntries(
  config: HostConfig,
  store: Store,
  conversationId: string | null,
  configFile?: string,
): SettingEntry[] {
  const entries: SettingEntry[] = [
    configSetting('identity.name', 'Agent 名称', config.identity.name, '下一 turn', config, store, configFile, (next, value) => {
      if (!value.trim()) throw new Error('Agent 名称不能为空');
      next.identity.name = value.trim();
    }),
    configSetting('identity.role', 'Agent 默认角色', config.identity.role, '下一 turn', config, store, configFile, (next, value) => {
      if (!value.trim()) throw new Error('Agent 默认角色不能为空');
      next.identity.role = value.trim();
    }),
    configSetting('identity.signature', '回复签名', config.identity.signature, '下一 turn', config, store, configFile, (next, value) => {
      if (!value.trim()) throw new Error('回复签名不能为空');
      next.identity.signature = value.trim();
    }),
    configSetting('runtime.model', 'Runtime 模型', config.runtime.model, '下一 turn；attach 模式建议重启', config, store, configFile, (next, value) => {
      if (!value.trim()) throw new Error('Runtime 模型不能为空');
      next.runtime.model = value.trim();
    }),
    configSetting('runtime.effort', '推理强度', config.runtime.effort, 'low/medium/high/xhigh/max/ultra', config, store, configFile, (next, value) => {
      next.runtime.effort = value.trim() as HostConfig['runtime']['effort'];
    }),
    configSetting(
      'scheduling.quietWindowMilliseconds', '合批静默窗口(ms)', String(config.scheduling.quietWindowMilliseconds),
      '0-60000；下一 batch', config, store, configFile,
      (next, value) => { next.scheduling.quietWindowMilliseconds = integer(value, 0, 60_000, '静默窗口'); },
    ),
    configSetting(
      'scheduling.maxBatchMessages', '单批消息上限', String(config.scheduling.maxBatchMessages),
      '1-200；下一 batch', config, store, configFile,
      (next, value) => { next.scheduling.maxBatchMessages = integer(value, 1, 200, '单批消息上限'); },
    ),
  ];
  if (!conversationId) return entries;
  const conversation = store.getConversation(conversationId);
  if (!conversation) return entries;
  entries.push(
    storeSetting(`conversation:${conversationId}:responsibility`, `会话职责 · ${conversation.title}`, conversation.responsibility, '下一 turn', async (value) => {
      if (!store.setConversationResponsibility(conversationId, value)) throw new Error('conversation 不存在');
      await publishCurrentRecovery(config, store, conversationId);
    }),
    storeSetting(`conversation:${conversationId}:mode`, `会话模式 · ${conversation.title}`, conversation.mode, 'shadow/reply；发送前即时生效', async (value) => {
      if (value !== 'shadow' && value !== 'reply') throw new Error('会话模式必须是 shadow 或 reply');
      if (!store.setConversationMode(conversationId, value)) throw new Error('conversation 不存在');
      await publishCurrentRecovery(config, store, conversationId);
    }),
    storeSetting(
      `conversation:${conversationId}:warm`, `Worker 保温秒数 · ${conversation.title}`, String(conversation.workerWarmSeconds),
      `0-${MAX_WORKER_WARM_SECONDS}；下一次 idle`, async (value) => {
        if (!store.setWorkerWarmSeconds(conversationId, integer(value, 0, MAX_WORKER_WARM_SECONDS, 'Worker 保温秒数'))) {
          throw new Error('conversation 不存在');
        }
      },
    ),
  );
  for (const member of store.listConversationMembers(conversationId)) {
    const label = redact(member.displayName ?? member.externalUserId);
    entries.push(
      storeSetting(`member:${member.externalUserId}:organizationRole`, `成员 ${label} · 组织角色`, member.organizationRole, '按需注入', async (value) => {
        store.updateConversationMember(conversationId, member.externalUserId, { organizationRole: value });
      }),
      storeSetting(`member:${member.externalUserId}:conversationRole`, `成员 ${label} · 会话角色`, member.conversationRole, '按需注入', async (value) => {
        store.updateConversationMember(conversationId, member.externalUserId, { conversationRole: value });
      }),
      storeSetting(`member:${member.externalUserId}:boundary`, `成员 ${label} · 职责边界`, member.responsibilityBoundary, '按需注入', async (value) => {
        store.updateConversationMember(conversationId, member.externalUserId, { responsibilityBoundary: value });
      }),
    );
  }
  return entries;
}

function configSetting(
  key: string,
  label: string,
  value: string,
  hint: string,
  config: HostConfig,
  store: Store,
  configFile: string | undefined,
  mutate: (next: HostConfig, value: string) => void,
): SettingEntry {
  return storeSetting(key, label, value, hint, async (raw) => {
    const next = structuredClone(config);
    mutate(next, raw);
    const validated = validateConfig(next);
    await writeConfig(validated, configFile);
    replaceConfig(config, validated);
    if (store.path !== ':memory:') {
      await Promise.all(store.listConversations().map((conversation) => publishRecoveryContext(config, conversation, store)));
    }
  });
}

function storeSetting(
  key: string,
  label: string,
  value: string,
  hint: string,
  apply: (value: string) => Promise<void>,
): SettingEntry {
  return { key, label, value, hint, apply };
}

async function publishCurrentRecovery(config: HostConfig, store: Store, conversationId: string): Promise<void> {
  if (store.path === ':memory:') return;
  const current = store.getConversation(conversationId);
  if (current) await publishRecoveryContext(config, current, store);
}

function replaceConfig(target: HostConfig, source: HostConfig): void {
  Object.assign(target, source);
}

export function renderManagementView(
  instance: string,
  snapshot: Record<string, unknown>,
  config: HostConfig,
  state: ManagementViewState,
  detail: Record<string, unknown> | null,
  settings: SettingEntry[],
  width = 120,
  attached = false,
  notices: string[] = [],
): string {
  const host = object(snapshot.host);
  const tabs = state.tab === 'overview' ? '[ 总览 ]   设置' : '  总览   [ 设置 ]';
  const lines = [
    `${CLI_NAME}  instance=${instance}  host=${text(host.state) ?? 'unknown'}  pid=${text(host.pid) ?? '-'}  ${attached ? 'attached' : 'foreground'}`,
    tabs,
    '─'.repeat(Math.min(width, 120)),
  ];
  if (state.tab === 'settings') lines.push(...renderSettings(config, detail, settings, state, width, attached));
  else if (state.detailConversationId) lines.push(...renderConversationDetail(detail, width));
  else lines.push(...renderOverview(snapshot, state, width));
  const notice = state.notice ?? notices.at(-1) ?? null;
  if (notice) lines.push('', `提示：${notice}`);
  lines.push('', state.editing
    ? `编辑 ${state.editing.label}：${state.editing.value}█  Enter 保存 / Esc 取消`
    : 'Tab/←/→ 切换  ↑/↓ 选择  Enter 详情或编辑  Esc 返回  q 退出');
  return lines.join('\n');
}

function renderOverview(snapshot: Record<string, unknown>, state: ManagementViewState, width: number): string[] {
  const channels = array(snapshot.channels);
  const conversations = array(snapshot.conversations);
  const runtimeAdapters = array(snapshot.runtimeAdapters);
  const alerts = array(snapshot.alerts);
  const lines = ['CHANNELS'];
  lines.push(...table(
    ['CHANNEL', 'PROFILE', 'STATE', 'PID', 'LAST EVENT', 'ERROR'],
    channels.map((row) => [row.channelId, row.profileId, row.state, row.pid, age(row.lastEventAt), row.error ?? '-']),
    width,
  ));
  lines.push('',
    `MESSAGES received=${number(snapshot.received)} pending=${number(snapshot.pending_messages)}`
    + ` claimed=${number(snapshot.claimed_messages)} processed=${number(snapshot.processed)}`
    + ` failed=${number(snapshot.failed_messages)} outbox=${number(snapshot.pending_outbox)}/${number(snapshot.submitted)}`,
    '', 'CONVERSATIONS');
  lines.push(...table(
    ['', 'CHANNEL', 'TITLE', 'MODE', 'PENDING', 'WORKER', 'SESSION', 'CONTEXT', 'MEMBERS', 'RUNTIME'],
    conversations.map((row, index) => [
      index === state.selectedConversation ? '>' : ' ', row.channelId, row.title, row.mode, row.pending,
      row.workerState, row.sessionState, `v${row.contextVersion ?? 0}@${row.contextThroughSequence ?? 0}`,
      row.memberCount ?? 0, row.runtimeId,
    ]), width,
  ));
  lines.push('', 'RUNTIMES');
  lines.push(...table(
    ['RUNTIME', 'LABEL', 'STATE', 'MODEL', 'RECOVERY', 'ERROR'],
    runtimeAdapters.map((row) => [row.runtimeId, row.label, row.state, row.model ?? '-', row.contextRecovery ?? '-', row.error ?? '-']),
    width,
  ));
  if (alerts.length > 0) lines.push('', 'ALERTS', ...alerts.map((row) => `- ${text(row.scope)}/${text(row.target)}: ${text(row.error)} (${age(row.at)})`));
  return lines;
}

function renderConversationDetail(detail: Record<string, unknown> | null, width: number): string[] {
  if (!detail) return ['会话不存在或已删除'];
  const conversation = object(detail.conversation);
  const session = object(detail.session);
  const worker = object(detail.worker);
  const context = object(detail.context);
  const members = array(detail.members);
  const messages = array(detail.messages);
  const lines = [
    `会话详情 / ${text(conversation.title) ?? '-'}`,
    `Channel ${text(conversation.channelId)}/${text(conversation.channelProfileId)}  kind=${text(conversation.kind)}  enabled=${text(conversation.enabled)}`,
    `mode=${text(conversation.mode)}  runtime=${text(conversation.runtimeId)}  policy=v${text(conversation.policyVersion)}  warm=${text(conversation.workerWarmSeconds)}s`,
    `职责：${text(conversation.responsibility) ?? '-'}`,
    `Session ${text(session.lifecycle) ?? 'unprovisioned'}  id=${text(session.providerSessionPrefix) ?? '-'}  generation=${text(session.generation) ?? '-'}`,
    `Worker ${text(worker.state) ?? 'stopped'}  pid=${text(worker.processId) ?? '-'}  error=${text(worker.error) ?? '-'}`,
    `Checkpoint v${text(context.version) ?? '0'} @ seq ${text(context.throughSequence) ?? '0'}  facts=${text(context.facts) ?? '0'} decisions=${text(context.decisions) ?? '0'} commitments=${text(context.commitments) ?? '0'} open=${text(context.openQuestions) ?? '0'}`,
    '', 'MEMBERS',
  ];
  lines.push(...table(
    ['NAME', 'ORG ROLE', 'CHANNEL ROLE', 'BOUNDARY', 'SOURCE', 'VER'],
    members.map((row) => [row.displayName, row.organizationRole || '-', row.conversationRole || '-', row.responsibilityBoundary || '-', row.source, row.version]),
    width,
  ));
  lines.push('', 'RECENT MESSAGES');
  const headers = ['SEQ', 'SENDER', 'STATE', 'AGE'];
  if (messages.some((row) => row.preview !== undefined)) headers.push('PREVIEW');
  lines.push(...table(headers, messages.map((row) => {
    const values: unknown[] = [row.sequence, row.sender, row.state, age(row.receivedAt)];
    if (headers.includes('PREVIEW')) values.push(row.preview ?? '-');
    return values;
  }), width));
  if (context.currentTopic !== undefined) {
    lines.push('', `当前主题：${text(context.currentTopic) || '无'}`);
    for (const [label, key] of [['事实', 'factItems'], ['决定', 'decisionItems'], ['承诺', 'commitmentItems'], ['未决', 'openQuestionItems']] as const) {
      const values = Array.isArray(context[key]) ? context[key] as unknown[] : [];
      if (values.length > 0) lines.push(`${label}：${values.map(String).join('；')}`);
    }
  }
  return lines;
}

function renderSettings(
  config: HostConfig,
  detail: Record<string, unknown> | null,
  settings: SettingEntry[],
  state: ManagementViewState,
  width: number,
  attached: boolean,
): string[] {
  const conversation = object(detail?.conversation);
  const lines = [
    `设置  Agent=${config.identity.name}  Runtime=${config.runtime.id}  Channel=${config.channel.id}/${config.channel.profileId}`,
    attached ? '当前连接到外部 Host；conversation/member 设置下一 turn 生效，config.yaml 设置建议重启 Host。' : '当前 Host 由 view 启动；配置在后续 turn/batch 生效。',
    `当前会话：${text(conversation.title) ?? '未选择'}`,
    '',
  ];
  lines.push(...table(
    ['', 'SETTING', 'VALUE', 'EFFECT'],
    settings.map((entry, index) => [index === state.selectedSetting ? '>' : ' ', entry.label, entry.value || '(空)', entry.hint]),
    width,
  ));
  return lines;
}

export function renderStatusView(instance: string, snapshot: Record<string, unknown>, width = 120): string {
  const host = object(snapshot.host);
  const channels = array(snapshot.channels);
  const conversations = array(snapshot.conversations);
  const messages = array(snapshot.messages);
  const runtimeAdapters = array(snapshot.runtimeAdapters);
  const runtimes = array(snapshot.runtimes);
  const alerts = array(snapshot.alerts);
  const lines: string[] = [];
  lines.push(`${CLI_NAME} view  instance=${instance}  refreshed=${text(snapshot.generatedAt) ?? '-'}`);
  lines.push(`Host ${text(host.state) ?? 'unknown'}  pid=${text(host.pid) ?? '-'}  heartbeat=${age(host.heartbeatAt)}`);
  lines.push('');
  lines.push('CHANNELS');
  lines.push(...table(
    ['CHANNEL', 'PROFILE', 'STATE', 'PID', 'LAST EVENT', 'ERROR'],
    channels.map((row) => [row.channelId, row.profileId, row.state, row.pid, age(row.lastEventAt), row.error ?? '-']),
    width,
  ));
  lines.push('');
  lines.push(
    `MESSAGES received=${number(snapshot.received)} pending=${number(snapshot.pending_messages)}`
    + ` claimed=${number(snapshot.claimed_messages)} processed=${number(snapshot.processed)}`
    + ` failed=${number(snapshot.failed_messages)} outbox=${number(snapshot.pending_outbox)}/${number(snapshot.submitted)}`,
  );
  const messageHeaders = ['CHANNEL', 'CONVERSATION', 'SEQ', 'SENDER', 'STATE', 'ACTION', 'AGE'];
  if (messages.some((row) => row.preview !== undefined)) messageHeaders.push('PREVIEW');
  lines.push(...table(
    messageHeaders,
    messages.map((row) => {
      const values: unknown[] = [row.channelId, row.title, row.sequence, row.sender ?? '-', row.state, row.action ?? '-', age(row.receivedAt)];
      if (messageHeaders.includes('PREVIEW')) values.push(row.preview ?? '-');
      return values;
    }),
    width,
  ));
  lines.push('', 'CONVERSATIONS');
  lines.push(...table(
    ['CHANNEL', 'TITLE', 'KIND', 'MODE', 'PENDING', 'WORKER', 'CONTEXT', 'RUNTIME'],
    conversations.map((row) => [
      row.channelId, row.title, row.kind, row.mode, row.pending, row.workerState,
      `v${row.contextVersion ?? 0}@${row.contextThroughSequence ?? 0}`, row.runtimeId,
    ]),
    width,
  ));
  lines.push('', 'RUNTIMES');
  lines.push(...table(
    ['RUNTIME', 'LABEL', 'STATE', 'MODEL', 'RECOVERY', 'ERROR'],
    runtimeAdapters.map((row) => [
      row.runtimeId, row.label, row.state, row.model ?? '-', row.contextRecovery ?? '-', row.error ?? '-',
    ]),
    width,
  ));
  lines.push('', 'SESSIONS / WORKERS');
  lines.push(...table(
    ['RUNTIME', 'CONVERSATION', 'WORKER', 'PID', 'SESSION', 'SESSION ID', 'GEN'],
    runtimes.map((row) => [
      row.runtimeId, row.conversation, row.workerState, row.processId ?? '-', row.sessionState,
      row.providerSessionPrefix ?? '-', row.generation ?? '-',
    ]),
    width,
  ));
  if (alerts.length > 0) lines.push('', 'ALERTS', ...alerts.map((row) => `- ${text(row.scope)}/${text(row.target)}: ${text(row.error)} (${age(row.at)})`));
  lines.push('', '只读快照；交互模式默认启动或 attach Host，并提供总览、详情和设置 tab');
  return lines.join('\n');
}

function selectedConversationId(store: Store, index: number): string | null {
  return store.listConversations()[index]?.id ?? null;
}

function table(headers: string[], rows: unknown[][], width: number): string[] {
  if (rows.length === 0) return ['  (none)'];
  const usable = Math.max(60, width - 2);
  const natural = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => cell(row[index]).length)));
  const separatorWidth = (headers.length - 1) * 2;
  let total = natural.reduce((sum, value) => sum + value, 0) + separatorWidth;
  const widths = [...natural];
  while (total > usable) {
    const index = widths.reduce((best, value, current) => value > widths[best]! ? current : best, 0);
    if (widths[index]! <= 6) break;
    widths[index]!--;
    total--;
  }
  const render = (row: unknown[]) => row.map((value, index) => pad(truncate(cell(value), widths[index]!), widths[index]!)).join('  ').trimEnd();
  return [render(headers), render(widths.map((value) => '-'.repeat(value))), ...rows.map(render)];
}

function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}

function array(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((item): item is Json => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cell(value: unknown): string {
  return text(value) ?? '-';
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return '…';
  return `${value.slice(0, width - 1)}…`;
}

function pad(value: string, width: number): string {
  return value.padEnd(width, ' ');
}

function age(value: unknown): string {
  if (!value) return '-';
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return String(value);
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function integer(value: string, min: number, max: number, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${label} 必须是 ${min}-${max} 的整数`);
  return parsed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function redact(value: string): string {
  return value.length <= 1 ? `${value}*` : `${value.slice(0, 1)}***${value.slice(-1)}`;
}
