import type { HostConfig } from './config.js';
import { validateConfig, writeConfig } from './config.js';
import type { Store } from './store.js';
import { CLI_NAME } from './product.js';
import { MAX_WORKER_WARM_SECONDS } from './types.js';
import { publishRecoveryContext } from './recovery-context.js';

type Json = Record<string, unknown>;
type TaggedJson = Json & { instance: string };

export interface ViewOptions {
  intervalSeconds: number;
  once: boolean;
  showContent: boolean;
}

export interface ViewInstance {
  name: string;
  config: HostConfig;
  store: Store;
  hostOwnership: 'attached' | 'view' | 'readonly';
  notices: string[];
}

export interface ManagementViewState {
  tab: 'overview' | 'settings';
  selectedInstance: number;
  selectedConversation: number;
  selectedSetting: number;
  detailInstanceName: string | null;
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
    selectedInstance: 0,
    selectedConversation: 0,
    selectedSetting: 0,
    detailInstanceName: null,
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

export async function runView(instances: ViewInstance[], options: ViewOptions): Promise<void> {
  assertInteractiveView(options);
  if (options.once) {
    process.stdout.write(`${renderStatusView(instances, options.showContent, process.stdout.columns ?? 120)}\n`);
    return;
  }

  const state = createManagementViewState();
  let rawMode = false;
  let timer: NodeJS.Timeout | null = null;
  let inputBusy = false;
  let resolveStop!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
  const render = () => {
    normalizeSelection(state, instances);
    const selectedInstance = instances[state.selectedInstance] ?? null;
    const detailInstance = state.detailInstanceName
      ? instances.find((instance) => instance.name === state.detailInstanceName) ?? null
      : selectedInstance;
    const conversations = detailInstance?.store.listConversations() ?? [];
    if (state.selectedConversation >= conversations.length) state.selectedConversation = Math.max(0, conversations.length - 1);
    const selectedId = conversations[state.selectedConversation]?.id ?? null;
    const detailId = state.detailConversationId ?? selectedId;
    const detail = detailInstance && detailId ? detailInstance.store.conversationDetail(detailId, options.showContent) : null;
    const settings = selectedInstance
      ? createSettingEntries(selectedInstance.config, selectedInstance.store, selectedIdForSettings(state, selectedInstance))
      : [];
    if (state.selectedSetting >= settings.length) state.selectedSetting = Math.max(0, settings.length - 1);
    return renderManagementView(
      instances,
      state,
      detail,
      settings,
      process.stdout.columns ?? 120,
      options.showContent,
    );
  };
  const paint = () => process.stdout.write(`\u001b[2J\u001b[H${render()}\n`);
  const onData = (chunk: Buffer) => {
    if (inputBusy) return;
    inputBusy = true;
    void handleManagementViewInput(chunk.toString('utf8'), state, instances, resolveStop)
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
  instances: ViewInstance[],
  stop: () => void,
): Promise<void> {
  normalizeSelection(state, instances);
  const selectedInstance = instances[state.selectedInstance] ?? null;
  if (state.editing) {
    if (key === '\u001b') {
      state.editing = null;
      state.notice = '已取消修改';
      return;
    }
    if (key === '\r' || key === '\n') {
      if (!selectedInstance) throw new Error('没有可配置的 instance');
      const selectedId = selectedIdForSettings(state, selectedInstance);
      const entry = createSettingEntries(selectedInstance.config, selectedInstance.store, selectedId)
        .find((item) => item.key === state.editing!.key);
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
    state.detailInstanceName = null;
    state.detailConversationId = null;
    state.notice = null;
    return;
  }
  if (key === '\u001b') {
    if (state.detailConversationId) state.detailConversationId = null;
    else state.detailInstanceName = null;
    state.notice = null;
    return;
  }
  if (state.tab === 'settings' && (key === '[' || key === ']')) {
    const direction = key === '[' ? -1 : 1;
    state.selectedInstance = clamp(state.selectedInstance + direction, 0, Math.max(0, instances.length - 1));
    state.selectedConversation = 0;
    state.selectedSetting = 0;
    state.notice = null;
    return;
  }
  const direction = key === '\u001b[A' || key.toLowerCase() === 'k' ? -1
    : key === '\u001b[B' || key.toLowerCase() === 'j' ? 1 : 0;
  if (direction !== 0) {
    if (state.tab === 'overview') {
      if (!state.detailInstanceName) {
        state.selectedInstance = clamp(state.selectedInstance + direction, 0, Math.max(0, instances.length - 1));
        state.selectedConversation = 0;
      } else {
        const detailInstance = instances.find((instance) => instance.name === state.detailInstanceName);
        const total = detailInstance?.store.listConversations().length ?? 0;
        state.selectedConversation = clamp(state.selectedConversation + direction, 0, Math.max(0, total - 1));
      }
    } else {
      const selectedId = selectedInstance ? selectedIdForSettings(state, selectedInstance) : null;
      const total = selectedInstance
        ? createSettingEntries(selectedInstance.config, selectedInstance.store, selectedId).length
        : 0;
      state.selectedSetting = clamp(state.selectedSetting + direction, 0, Math.max(0, total - 1));
    }
    return;
  }
  if (key === '\r' || key === '\n') {
    if (state.tab === 'overview') {
      if (!selectedInstance) return;
      if (!state.detailInstanceName) {
        state.detailInstanceName = selectedInstance.name;
        state.selectedConversation = 0;
      } else {
        state.detailConversationId = selectedConversationId(selectedInstance.store, state.selectedConversation);
      }
      return;
    }
    if (!selectedInstance) return;
    const selectedId = selectedIdForSettings(state, selectedInstance);
    const entry = createSettingEntries(selectedInstance.config, selectedInstance.store, selectedId)[state.selectedSetting];
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
  instances: ViewInstance[],
  state: ManagementViewState,
  detail: Record<string, unknown> | null,
  settings: SettingEntry[],
  width = 120,
  showContent = false,
): string {
  normalizeSelection(state, instances);
  const selectedInstance = instances[state.selectedInstance] ?? null;
  const detailInstance = state.detailInstanceName
    ? instances.find((instance) => instance.name === state.detailInstanceName) ?? null
    : null;
  const snapshots = instances.map((instance) => ({ instance, snapshot: instance.store.status(showContent) }));
  const running = snapshots.filter(({ snapshot }) => text(object(snapshot.host).state) === 'running').length;
  const tabs = state.tab === 'overview' ? '[ 总览 ]   设置' : '  总览   [ 设置 ]';
  const lines = [
    `${CLI_NAME}  instances=${instances.length}  running=${running}  refreshed=${new Date().toISOString()}`,
    tabs,
    '─'.repeat(Math.min(width, 120)),
  ];
  if (state.tab === 'settings') lines.push(...renderSettings(selectedInstance, detail, settings, state, width, instances.length));
  else if (state.detailConversationId) lines.push(...renderConversationDetail(detail, width));
  else if (detailInstance) lines.push(...renderInstanceOverview(detailInstance, detailInstance.store.status(showContent), state, width));
  else lines.push(...renderGlobalOverview(snapshots, state, width));
  const notice = state.notice ?? selectedInstance?.notices.at(-1) ?? null;
  if (notice) lines.push('', `提示：${notice}`);
  lines.push('', state.editing
    ? `编辑 ${state.editing.label}：${state.editing.value}█  Enter 保存 / Esc 取消`
    : state.tab === 'settings'
      ? 'Tab/←/→ 切换  [/ ] 选择 instance  ↑/↓ 选择  Enter 编辑  Esc 返回  q 退出'
      : 'Tab/←/→ 切换  ↑/↓ 选择  Enter 下钻  Esc 返回  q 退出');
  return lines.join('\n');
}

function renderGlobalOverview(
  snapshots: Array<{ instance: ViewInstance; snapshot: Record<string, unknown> }>,
  state: ManagementViewState,
  width: number,
): string[] {
  if (snapshots.length === 0) {
    return [
      'INSTANCES',
      '  (none)',
      '',
      '尚未初始化 instance。请先运行：',
      'agent-channel init --instance <name> --cwd <path>',
    ];
  }
  const lines = ['INSTANCES'];
  lines.push(...table(
    ['', 'INSTANCE', 'AGENT', 'HOST', 'PID', 'CHANNELS', 'CONVERSATIONS', 'PENDING', 'RUNTIMES', 'OWNER'],
    snapshots.map(({ instance, snapshot }, index) => {
      const host = object(snapshot.host);
      return [
        index === state.selectedInstance ? '>' : ' ', instance.name, instance.config.identity.name,
        host.state ?? 'unknown', host.pid ?? '-', array(snapshot.channels).length, array(snapshot.conversations).length,
        number(snapshot.pending_messages), array(snapshot.runtimeAdapters).length,
        instance.hostOwnership,
      ];
    }),
    width,
  ));

  const channels = snapshots.flatMap(({ instance, snapshot }) => tagRows(instance.name, snapshot.channels));
  lines.push('', 'CHANNELS');
  lines.push(...table(
    ['INSTANCE', 'CHANNEL', 'PROFILE', 'STATE', 'PID', 'LAST EVENT', 'ERROR'],
    channels.map((row) => [row.instance, row.channelId, row.profileId, row.state, row.pid, age(row.lastEventAt), row.error ?? '-']),
    width,
  ));

  const totals = snapshots.reduce((result, { snapshot }) => ({
    received: result.received + number(snapshot.received),
    pending: result.pending + number(snapshot.pending_messages),
    claimed: result.claimed + number(snapshot.claimed_messages),
    processed: result.processed + number(snapshot.processed),
    failed: result.failed + number(snapshot.failed_messages),
    outbox: result.outbox + number(snapshot.pending_outbox),
    submitted: result.submitted + number(snapshot.submitted),
  }), { received: 0, pending: 0, claimed: 0, processed: 0, failed: 0, outbox: 0, submitted: 0 });
  const messages = snapshots.flatMap(({ instance, snapshot }) => tagRows(instance.name, snapshot.messages));
  lines.push('',
    `MESSAGES received=${totals.received} pending=${totals.pending} claimed=${totals.claimed}`
    + ` processed=${totals.processed} failed=${totals.failed} outbox=${totals.outbox}/${totals.submitted}`,
  );
  const messageHeaders = ['INSTANCE', 'CHANNEL', 'CONVERSATION', 'SEQ', 'SENDER', 'STATE', 'ACTION', 'AGE'];
  if (messages.some((row) => row.preview !== undefined)) messageHeaders.push('PREVIEW');
  lines.push(...table(messageHeaders, messages.map((row) => {
    const values: unknown[] = [row.instance, row.channelId, row.title, row.sequence, row.sender ?? '-', row.state, row.action ?? '-', age(row.receivedAt)];
    if (messageHeaders.includes('PREVIEW')) values.push(row.preview ?? '-');
    return values;
  }), width));

  const conversations = snapshots.flatMap(({ instance, snapshot }) => tagRows(instance.name, snapshot.conversations));
  lines.push('', 'CONVERSATIONS');
  lines.push(...table(
    ['INSTANCE', 'CHANNEL', 'TITLE', 'MODE', 'PENDING', 'WORKER', 'SESSION', 'CONTEXT', 'RUNTIME'],
    conversations.map((row) => [
      row.instance, row.channelId, row.title, row.mode, row.pending, row.workerState,
      row.sessionState, `v${row.contextVersion ?? 0}@${row.contextThroughSequence ?? 0}`, row.runtimeId,
    ]),
    width,
  ));

  const runtimes = snapshots.flatMap(({ instance, snapshot }) => tagRows(instance.name, snapshot.runtimeAdapters));
  lines.push('', 'RUNTIMES');
  lines.push(...table(
    ['INSTANCE', 'RUNTIME', 'LABEL', 'STATE', 'MODEL', 'RECOVERY', 'ERROR'],
    runtimes.map((row) => [row.instance, row.runtimeId, row.label, row.state, row.model ?? '-', row.contextRecovery ?? '-', row.error ?? '-']),
    width,
  ));
  const alerts = snapshots.flatMap(({ instance, snapshot }) => tagRows(instance.name, snapshot.alerts));
  if (alerts.length > 0) {
    lines.push('', 'ALERTS', ...alerts.map((row) => `- ${row.instance}/${text(row.scope)}/${text(row.target)}: ${text(row.error)} (${age(row.at)})`));
  }
  return lines;
}

function renderInstanceOverview(instance: ViewInstance, snapshot: Record<string, unknown>, state: ManagementViewState, width: number): string[] {
  const channels = array(snapshot.channels);
  const conversations = array(snapshot.conversations);
  const runtimeAdapters = array(snapshot.runtimeAdapters);
  const alerts = array(snapshot.alerts);
  const host = object(snapshot.host);
  const lines = [
    `实例详情 / ${instance.name}  Agent=${instance.config.identity.name}  host=${text(host.state) ?? 'unknown'}  pid=${text(host.pid) ?? '-'}  ${instance.hostOwnership}`,
    '', 'CHANNELS',
  ];
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
  instance: ViewInstance | null,
  detail: Record<string, unknown> | null,
  settings: SettingEntry[],
  state: ManagementViewState,
  width: number,
  instanceCount: number,
): string[] {
  if (!instance) {
    return [
      '设置',
      '',
      '尚未初始化 instance，当前没有可修改的配置。',
      '请先运行 agent-channel init --instance <name> --cwd <path>。',
    ];
  }
  const conversation = object(detail?.conversation);
  const lines = [
    `设置  instance=${instance.name} (${state.selectedInstance + 1}/${instanceCount})  Agent=${instance.config.identity.name}`,
    `Runtime=${instance.config.runtime.id}  Channel=${instance.config.channel.id}/${instance.config.channel.profileId}`,
    instance.hostOwnership === 'attached'
      ? '当前连接到外部 Host；conversation/member 设置下一 turn 生效，config.yaml 设置建议重启 Host。'
      : instance.hostOwnership === 'view'
        ? '当前 Host 由 view 启动；配置在后续 turn/batch 生效。'
        : '当前为只读快照；未启动或 attach Host。',
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

export function renderStatusView(instances: ViewInstance[], showContent = false, width = 120): string {
  const state = createManagementViewState();
  const snapshots = instances.map((instance) => ({ instance, snapshot: instance.store.status(showContent) }));
  const lines = [
    `${CLI_NAME} view  instances=${instances.length}  refreshed=${new Date().toISOString()}`,
    ...renderGlobalOverview(snapshots, state, width),
    '',
    '只读聚合快照；交互模式会逐 instance 启动或 attach Host，并提供下钻详情和设置 tab',
  ];
  return lines.join('\n');
}

function selectedConversationId(store: Store, index: number): string | null {
  return store.listConversations()[index]?.id ?? null;
}

function selectedIdForSettings(state: ManagementViewState, instance: ViewInstance): string | null {
  if (state.detailInstanceName && state.detailInstanceName !== instance.name) return null;
  return selectedConversationId(instance.store, state.selectedConversation);
}

function normalizeSelection(state: ManagementViewState, instances: ViewInstance[]): void {
  state.selectedInstance = clamp(state.selectedInstance, 0, Math.max(0, instances.length - 1));
  if (state.detailInstanceName && !instances.some((instance) => instance.name === state.detailInstanceName)) {
    state.detailInstanceName = null;
    state.detailConversationId = null;
  }
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

function tagRows(instance: string, value: unknown): TaggedJson[] {
  return array(value).map((row) => Object.assign({ instance }, row));
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
