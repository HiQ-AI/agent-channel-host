import type { HostConfig } from './config.js';
import { configuredChannels, validateConfig, writeConfig } from './config.js';
import type { Store } from './store.js';
import { CLI_NAME } from './product.js';
import { MAX_WORKER_WARM_SECONDS } from './types.js';
import { publishRecoveryContext } from './recovery-context.js';
import { safeName } from './paths.js';

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
  configFile?: string;
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
  settingsInstanceName: string | null;
  editing: { key: string; label: string; value: string } | null;
  creatingInstance: InstanceCreationDraft | null;
  notice: string | null;
}

export interface SettingEntry {
  key: string;
  section: 'instance' | 'channels' | 'conversation' | 'members';
  input: 'text' | 'toggle';
  label: string;
  value: string;
  hint: string;
  restartHost: boolean;
  apply(value: string): Promise<void>;
}

export interface NewInstanceInput {
  instance: string;
  cwd: string;
  name: string;
  role: string;
}

export interface ManagementViewActions {
  createInstance?(input: NewInstanceInput): Promise<ViewInstance>;
  startInstance?(instance: ViewInstance): Promise<void>;
  afterSettingApplied?(instance: ViewInstance, entry: SettingEntry): Promise<string | void>;
}

type InstanceCreationStep = 'instance' | 'cwd' | 'name' | 'role';

interface InstanceCreationDraft {
  step: InstanceCreationStep;
  values: Partial<NewInstanceInput>;
  value: string;
}

export function createManagementViewState(): ManagementViewState {
  return {
    tab: 'overview',
    selectedInstance: 0,
    selectedConversation: 0,
    selectedSetting: 0,
    detailInstanceName: null,
    detailConversationId: null,
    settingsInstanceName: null,
    editing: null,
    creatingInstance: null,
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

export function shouldUseColor(isTTY: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return isTTY && env.NO_COLOR === undefined && env.TERM !== 'dumb';
}

export async function runView(
  instances: ViewInstance[],
  options: ViewOptions,
  actions: ManagementViewActions = {},
): Promise<void> {
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
  const color = shouldUseColor(Boolean(process.stdout.isTTY));
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
    const settingsInstance = state.settingsInstanceName
      ? instances.find((instance) => instance.name === state.settingsInstanceName) ?? null
      : null;
    const settings = settingsInstance
      ? createSettingEntries(
        settingsInstance.config,
        settingsInstance.store,
        selectedIdForSettings(state, settingsInstance),
        settingsInstance.configFile,
      )
      : [];
    if (state.selectedSetting >= settings.length) state.selectedSetting = Math.max(0, settings.length - 1);
    return renderManagementView(
      instances,
      state,
      detail,
      settings,
      process.stdout.columns ?? 120,
      options.showContent,
      color,
    );
  };
  const paint = () => process.stdout.write(`\u001b[2J\u001b[H${render()}\n`);
  const onData = (chunk: Buffer) => {
    if (inputBusy) return;
    inputBusy = true;
    void handleManagementViewInput(chunk.toString('utf8'), state, instances, resolveStop, actions)
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
  actions: ManagementViewActions = {},
): Promise<void> {
  normalizeSelection(state, instances);
  if (state.creatingInstance) {
    await handleInstanceCreationInput(key, state, instances, stop, actions);
    return;
  }
  const overviewInstance = instances[state.selectedInstance] ?? null;
  const settingsInstance = state.settingsInstanceName
    ? instances.find((instance) => instance.name === state.settingsInstanceName) ?? null
    : null;
  if (state.editing) {
    if (key === '\u001b') {
      state.editing = null;
      state.notice = '已取消修改';
      return;
    }
    if (key === '\r' || key === '\n') {
      if (!settingsInstance) throw new Error('没有可配置的 instance');
      const selectedId = selectedIdForSettings(state, settingsInstance);
      const entry = createSettingEntries(
        settingsInstance.config,
        settingsInstance.store,
        selectedId,
        settingsInstance.configFile,
      )
        .find((item) => item.key === state.editing!.key);
      if (!entry) throw new Error('设置项已变化，请重新选择');
      await entry.apply(state.editing.value);
      const actionNotice = await actions.afterSettingApplied?.(settingsInstance, entry);
      state.notice = actionNotice ?? `${entry.label} 已保存`;
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
    state.settingsInstanceName = null;
    state.notice = null;
    return;
  }
  if (key === '\u001b') {
    if (state.tab === 'settings') {
      state.tab = 'overview';
    } else if (state.settingsInstanceName) {
      state.settingsInstanceName = null;
      state.selectedSetting = 0;
    } else if (state.detailConversationId) state.detailConversationId = null;
    else state.detailInstanceName = null;
    state.notice = null;
    return;
  }
  if (state.tab === 'overview' && !state.detailInstanceName && !state.settingsInstanceName && key.toLowerCase() === 'a') {
    startInstanceCreation(state, actions);
    return;
  }
  if (state.tab === 'overview' && state.detailInstanceName && key.toLowerCase() === 's') {
    state.settingsInstanceName = state.detailInstanceName;
    state.selectedSetting = 0;
    state.notice = null;
    return;
  }
  const direction = key === '\u001b[A' || key.toLowerCase() === 'k' ? -1
    : key === '\u001b[B' || key.toLowerCase() === 'j' ? 1 : 0;
  if (direction !== 0) {
    if (state.tab === 'overview') {
      if (state.settingsInstanceName) {
        const selectedId = settingsInstance ? selectedIdForSettings(state, settingsInstance) : null;
        const total = settingsInstance
          ? createSettingEntries(
            settingsInstance.config,
            settingsInstance.store,
            selectedId,
            settingsInstance.configFile,
          ).length
          : 0;
        state.selectedSetting = clamp(state.selectedSetting + direction, 0, Math.max(0, total - 1));
      } else if (!state.detailInstanceName) {
        state.selectedInstance = clamp(state.selectedInstance + direction, 0, instances.length);
        state.selectedConversation = 0;
      } else {
        const detailInstance = instances.find((instance) => instance.name === state.detailInstanceName);
        const total = detailInstance?.store.listConversations().length ?? 0;
        state.selectedConversation = clamp(state.selectedConversation + direction, 0, Math.max(0, total - 1));
      }
    }
    return;
  }
  if (key === '\r' || key === '\n') {
    if (state.tab === 'overview') {
      if (state.settingsInstanceName) {
        if (!settingsInstance) return;
        const selectedId = selectedIdForSettings(state, settingsInstance);
        const entry = createSettingEntries(
          settingsInstance.config,
          settingsInstance.store,
          selectedId,
          settingsInstance.configFile,
        )[state.selectedSetting];
        if (!entry) return;
        if (entry.input === 'toggle') {
          await entry.apply(entry.value === 'enabled' ? 'disabled' : 'enabled');
          const actionNotice = await actions.afterSettingApplied?.(settingsInstance, entry);
          state.notice = actionNotice ?? `${entry.label} 已切换为 ${entry.value === 'enabled' ? 'disabled' : 'enabled'}`;
          return;
        }
        state.editing = { key: entry.key, label: entry.label, value: entry.value };
        return;
      }
      if (!state.detailInstanceName) {
        if (state.selectedInstance >= instances.length) {
          startInstanceCreation(state, actions);
          return;
        }
        if (!overviewInstance) return;
        state.detailInstanceName = overviewInstance.name;
        state.selectedConversation = 0;
      } else {
        if (!overviewInstance) return;
        state.detailConversationId = selectedConversationId(overviewInstance.store, state.selectedConversation);
      }
      return;
    }
    return;
  }
}

async function handleInstanceCreationInput(
  key: string,
  state: ManagementViewState,
  instances: ViewInstance[],
  stop: () => void,
  actions: ManagementViewActions,
): Promise<void> {
  const draft = state.creatingInstance!;
  if (key === '\u0003') {
    stop();
    return;
  }
  if (key === '\u001b') {
    state.creatingInstance = null;
    state.notice = '已取消新增 Instance';
    return;
  }
  if (key === '\u007f' || key === '\b') {
    draft.value = draft.value.slice(0, -1);
    return;
  }
  if (key !== '\r' && key !== '\n') {
    if (!key.startsWith('\u001b')) draft.value += key.replace(/[\u0000-\u001f]/g, '');
    return;
  }

  const value = draft.value.trim();
  if (draft.step === 'instance') {
    safeName(value);
    if (instances.some((instance) => instance.name === value)) throw new Error(`instance 已存在：${value}`);
    draft.values.instance = value;
    draft.step = 'cwd';
    draft.value = process.cwd();
    return;
  }
  if (!value) throw new Error(`${creationStepLabel(draft.step)}不能为空`);
  if (draft.step === 'cwd') {
    draft.values.cwd = value;
    draft.step = 'name';
    draft.value = 'DingTalk Agent';
    return;
  }
  if (draft.step === 'name') {
    draft.values.name = value;
    draft.step = 'role';
    draft.value = '在授权会话内提供职责范围内的分析和答复';
    return;
  }

  if (!actions.createInstance) throw new Error('当前 View 入口未提供 instance 创建能力');
  const input = { ...draft.values, role: value } as NewInstanceInput;
  const created = await actions.createInstance(input);
  state.creatingInstance = null;
  instances.push(created);
  state.selectedInstance = instances.length - 1;
  state.detailInstanceName = created.name;
  state.settingsInstanceName = created.name;
  state.selectedSetting = 0;
  await actions.startInstance?.(created);
  state.notice = `Instance ${created.name} 已创建；Channel 默认 disabled，请确认配置后启用`;
}

function startInstanceCreation(state: ManagementViewState, actions: ManagementViewActions): void {
  if (!actions.createInstance) throw new Error('当前 View 入口未提供 instance 创建能力');
  state.creatingInstance = { step: 'instance', values: {}, value: '' };
  state.notice = null;
}

function creationStepLabel(step: InstanceCreationStep): string {
  return ({ instance: 'Instance 名称', cwd: 'Runtime cwd', name: 'Agent 名称', role: '默认角色' })[step];
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
  entries.push(...configuredChannels(config).map((channel) => {
    const entry = configSetting(
      `channel:${channel.id}:${channel.profileId}:enabled`,
      `${channel.id}/${channel.profileId}`,
      channel.enabled ? 'enabled' : 'disabled',
      'Enter 切换；View owner 即时重启，attach 需重启',
      config,
      store,
      configFile,
      (next, value) => {
        if (value !== 'enabled' && value !== 'disabled') throw new Error('Channel 状态必须是 enabled 或 disabled');
        next.channel.enabled = value === 'enabled';
      },
    );
    entry.section = 'channels';
    entry.input = 'toggle';
    entry.restartHost = true;
    return entry;
  }));
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
      }, 'members'),
      storeSetting(`member:${member.externalUserId}:conversationRole`, `成员 ${label} · 会话角色`, member.conversationRole, '按需注入', async (value) => {
        store.updateConversationMember(conversationId, member.externalUserId, { conversationRole: value });
      }, 'members'),
      storeSetting(`member:${member.externalUserId}:boundary`, `成员 ${label} · 职责边界`, member.responsibilityBoundary, '按需注入', async (value) => {
        store.updateConversationMember(conversationId, member.externalUserId, { responsibilityBoundary: value });
      }, 'members'),
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
  }, 'instance');
}

function storeSetting(
  key: string,
  label: string,
  value: string,
  hint: string,
  apply: (value: string) => Promise<void>,
  section: SettingEntry['section'] = 'conversation',
): SettingEntry {
  return { key, section, input: 'text', label, value, hint, restartHost: false, apply };
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
  color = false,
): string {
  normalizeSelection(state, instances);
  const selectedInstance = instances[state.selectedInstance] ?? null;
  const settingsInstance = state.settingsInstanceName
    ? instances.find((instance) => instance.name === state.settingsInstanceName) ?? null
    : null;
  const detailInstance = state.detailInstanceName
    ? instances.find((instance) => instance.name === state.detailInstanceName) ?? null
    : null;
  const snapshots = instances.map((instance) => ({ instance, snapshot: instance.store.status(showContent) }));
  const running = snapshots.filter(({ snapshot }) => text(object(snapshot.host).state) === 'running').length;
  const tabs = (['overview', 'settings'] as const)
    .map((tab) => {
      const label = ({ overview: '总览', settings: '全局设置' })[tab];
      return state.tab === tab ? ansi(`[ ${label} ]`, 'cyan-bold', color) : ansi(label, 'dim', color);
    })
    .join('   ');
  const lines = [
    `${ansi(CLI_NAME, 'cyan-bold', color)}  instances=${instances.length}  running=${ansi(String(running), running > 0 ? 'green-bold' : 'dim', color)}  ${ansi(`refreshed=${new Date().toISOString()}`, 'dim', color)}`,
    tabs,
    ansi('─'.repeat(Math.min(width, 120)), 'dim', color),
  ];
  if (state.tab === 'settings') lines.push(...renderGlobalSettings(instances, width, color));
  else if (settingsInstance) lines.push(...renderInstanceSettings(settingsInstance, detail, settings, state, width, color));
  else if (state.detailConversationId) lines.push(...renderConversationDetail(detail, width, color));
  else if (detailInstance) lines.push(...renderInstanceOverview(detailInstance, detailInstance.store.status(showContent), state, width, color));
  else lines.push(...renderGlobalOverview(snapshots, state, width, color));
  const notice = state.notice ?? (settingsInstance ?? selectedInstance)?.notices.at(-1) ?? null;
  if (notice) lines.push('', ansi(`提示：${notice}`, 'yellow-bold', color));
  lines.push('', state.creatingInstance
    ? ansi(`新增 Instance · ${creationStepLabel(state.creatingInstance.step)}：${state.creatingInstance.value}█  Enter 下一步 / Esc 取消`, 'cyan-bold', color)
    : state.editing
      ? ansi(`编辑 ${state.editing.label}：${state.editing.value}█  Enter 保存 / Esc 取消`, 'cyan-bold', color)
      : state.tab === 'settings'
        ? ansi('Tab/←/→ 切换  全局设置不包含 Instance 配置  Esc 返回总览  q 退出', 'dim', color)
        : state.settingsInstanceName
          ? ansi('↑/↓ 选择  Enter 编辑/切换  Esc 返回 Instance 详情  q 退出', 'dim', color)
          : state.detailInstanceName
            ? ansi('↑/↓ 选择  Enter 下钻会话  s Instance 设置  Esc 返回  q 退出', 'dim', color)
            : ansi('Tab/←/→ 切换  ↑/↓ 选择  Enter 下钻  a 新增 Instance  q 退出', 'dim', color));
  return lines.join('\n');
}

function renderGlobalOverview(
  snapshots: Array<{ instance: ViewInstance; snapshot: Record<string, unknown> }>,
  state: ManagementViewState,
  width: number,
  color: boolean,
): string[] {
  const lines = [heading('INSTANCES', color)];
  lines.push(...table(
    ['', 'INSTANCE', 'AGENT', 'HOST', 'PID', 'CHANNELS', 'CONVERSATIONS', 'PENDING', 'RUNTIMES', 'OWNER'],
    [...snapshots.map(({ instance, snapshot }, index) => {
      const host = object(snapshot.host);
      return [
        index === state.selectedInstance ? '>' : ' ', instance.name, instance.config.identity.name,
        host.state ?? 'unknown', host.pid ?? '-', array(snapshot.channels).length, array(snapshot.conversations).length,
        number(snapshot.pending_messages), array(snapshot.runtimeAdapters).length,
        instance.hostOwnership,
      ];
    }), [
      state.selectedInstance >= snapshots.length ? '>' : ' ', '+ 新增 Instance', '-', '-', '-', '-', '-', '-', '-', '-',
    ]],
    width,
    semanticTable(color, state.selectedInstance, 2),
  ));
  if (snapshots.length === 0) {
    lines.push('', ansi('尚未初始化 instance。交互模式可按 a 创建；也可运行 agent-channel init --instance <name> --cwd <path>。', 'yellow-bold', color));
  }

  const channels = snapshots.flatMap(({ instance, snapshot }) => tagRows(instance.name, snapshot.channels));
  lines.push('', heading('CHANNELS', color));
  lines.push(...table(
    ['INSTANCE', 'CHANNEL', 'PROFILE', 'STATE', 'PID', 'LAST EVENT', 'ERROR'],
    channels.map((row) => [row.instance, row.channelId, row.profileId, row.state, row.pid, age(row.lastEventAt), row.error ?? '-']),
    width,
    semanticTable(color),
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
  lines.push('', messageSummary(totals, color));
  const messageHeaders = ['INSTANCE', 'CHANNEL', 'CONVERSATION', 'SEQ', 'SENDER', 'STATE', 'ACTION', 'AGE'];
  if (messages.some((row) => row.preview !== undefined)) messageHeaders.push('PREVIEW');
  lines.push(...table(messageHeaders, messages.map((row) => {
    const values: unknown[] = [row.instance, row.channelId, row.title, row.sequence, row.sender ?? '-', row.state, row.action ?? '-', age(row.receivedAt)];
    if (messageHeaders.includes('PREVIEW')) values.push(row.preview ?? '-');
    return values;
  }), width, semanticTable(color)));

  const conversations = snapshots.flatMap(({ instance, snapshot }) => tagRows(instance.name, snapshot.conversations));
  lines.push('', heading('CONVERSATIONS', color));
  lines.push(...table(
    ['INSTANCE', 'CHANNEL', 'TITLE', 'MODE', 'PENDING', 'WORKER', 'SESSION', 'CONTEXT', 'RUNTIME'],
    conversations.map((row) => [
      row.instance, row.channelId, row.title, row.mode, row.pending, row.workerState,
      row.sessionState, `v${row.contextVersion ?? 0}@${row.contextThroughSequence ?? 0}`, row.runtimeId,
    ]),
    width,
    semanticTable(color),
  ));

  const runtimes = snapshots.flatMap(({ instance, snapshot }) => tagRows(instance.name, snapshot.runtimeAdapters));
  lines.push('', heading('RUNTIMES', color));
  lines.push(...table(
    ['INSTANCE', 'RUNTIME', 'LABEL', 'STATE', 'MODEL', 'RECOVERY', 'ERROR'],
    runtimes.map((row) => [row.instance, row.runtimeId, row.label, row.state, row.model ?? '-', row.contextRecovery ?? '-', row.error ?? '-']),
    width,
    semanticTable(color),
  ));
  const alerts = snapshots.flatMap(({ instance, snapshot }) => tagRows(instance.name, snapshot.alerts));
  if (alerts.length > 0) {
    lines.push('', heading('ALERTS', color), ...alerts.map((row) => ansi(`- ${row.instance}/${text(row.scope)}/${text(row.target)}: ${text(row.error)} (${age(row.at)})`, 'red-bold', color)));
  }
  return lines;
}

function renderInstanceOverview(
  instance: ViewInstance,
  snapshot: Record<string, unknown>,
  state: ManagementViewState,
  width: number,
  color: boolean,
): string[] {
  const channels = array(snapshot.channels);
  const conversations = array(snapshot.conversations);
  const runtimeAdapters = array(snapshot.runtimeAdapters);
  const alerts = array(snapshot.alerts);
  const host = object(snapshot.host);
  const lines = [
    `${heading(`实例详情 / ${instance.name}`, color)}  Agent=${instance.config.identity.name}  host=${statusText(text(host.state) ?? 'unknown', color)}  pid=${text(host.pid) ?? '-'}  ${statusText(instance.hostOwnership, color)}`,
    '', heading('CHANNELS', color),
  ];
  lines.push(...table(
    ['CHANNEL', 'PROFILE', 'STATE', 'PID', 'LAST EVENT', 'ERROR'],
    channels.map((row) => [row.channelId, row.profileId, row.state, row.pid, age(row.lastEventAt), row.error ?? '-']),
    width,
    semanticTable(color),
  ));
  lines.push('', messageSummary({
    received: number(snapshot.received),
    pending: number(snapshot.pending_messages),
    claimed: number(snapshot.claimed_messages),
    processed: number(snapshot.processed),
    failed: number(snapshot.failed_messages),
    outbox: number(snapshot.pending_outbox),
    submitted: number(snapshot.submitted),
  }, color), '', heading('CONVERSATIONS', color));
  lines.push(...table(
    ['', 'CHANNEL', 'TITLE', 'MODE', 'PENDING', 'WORKER', 'SESSION', 'CONTEXT', 'MEMBERS', 'RUNTIME'],
    conversations.map((row, index) => [
      index === state.selectedConversation ? '>' : ' ', row.channelId, row.title, row.mode, row.pending,
      row.workerState, row.sessionState, `v${row.contextVersion ?? 0}@${row.contextThroughSequence ?? 0}`,
      row.memberCount ?? 0, row.runtimeId,
    ]), width, semanticTable(color, state.selectedConversation, 2),
  ));
  lines.push('', heading('RUNTIMES', color));
  lines.push(...table(
    ['RUNTIME', 'LABEL', 'STATE', 'MODEL', 'RECOVERY', 'ERROR'],
    runtimeAdapters.map((row) => [row.runtimeId, row.label, row.state, row.model ?? '-', row.contextRecovery ?? '-', row.error ?? '-']),
    width,
    semanticTable(color),
  ));
  if (alerts.length > 0) {
    lines.push('', heading('ALERTS', color), ...alerts.map((row) => ansi(`- ${text(row.scope)}/${text(row.target)}: ${text(row.error)} (${age(row.at)})`, 'red-bold', color)));
  }
  return lines;
}

function renderConversationDetail(detail: Record<string, unknown> | null, width: number, color: boolean): string[] {
  if (!detail) return [ansi('会话不存在或已删除', 'red-bold', color)];
  const conversation = object(detail.conversation);
  const session = object(detail.session);
  const worker = object(detail.worker);
  const context = object(detail.context);
  const members = array(detail.members);
  const messages = array(detail.messages);
  const lines = [
    heading(`会话详情 / ${text(conversation.title) ?? '-'}`, color),
    `Channel ${text(conversation.channelId)}/${text(conversation.channelProfileId)}  kind=${text(conversation.kind)}  enabled=${statusText(text(conversation.enabled) ?? 'false', color)}`,
    `mode=${statusText(text(conversation.mode) ?? 'unknown', color)}  runtime=${text(conversation.runtimeId)}  policy=v${text(conversation.policyVersion)}  warm=${text(conversation.workerWarmSeconds)}s`,
    `职责：${text(conversation.responsibility) ?? '-'}`,
    `Session ${statusText(text(session.lifecycle) ?? 'unprovisioned', color)}  id=${text(session.providerSessionPrefix) ?? '-'}  generation=${text(session.generation) ?? '-'}`,
    `Worker ${statusText(text(worker.state) ?? 'stopped', color)}  pid=${text(worker.processId) ?? '-'}  error=${errorText(text(worker.error) ?? '-', color)}`,
    ansi(`Checkpoint v${text(context.version) ?? '0'} @ seq ${text(context.throughSequence) ?? '0'}  facts=${text(context.facts) ?? '0'} decisions=${text(context.decisions) ?? '0'} commitments=${text(context.commitments) ?? '0'} open=${text(context.openQuestions) ?? '0'}`, 'cyan', color),
    '', heading('MEMBERS', color),
  ];
  lines.push(...table(
    ['NAME', 'ORG ROLE', 'CHANNEL ROLE', 'BOUNDARY', 'SOURCE', 'VER'],
    members.map((row) => [row.displayName, row.organizationRole || '-', row.conversationRole || '-', row.responsibilityBoundary || '-', row.source, row.version]),
    width,
    semanticTable(color),
  ));
  lines.push('', heading('RECENT MESSAGES', color));
  const headers = ['SEQ', 'SENDER', 'STATE', 'AGE'];
  if (messages.some((row) => row.preview !== undefined)) headers.push('PREVIEW');
  lines.push(...table(headers, messages.map((row) => {
    const values: unknown[] = [row.sequence, row.sender, row.state, age(row.receivedAt)];
    if (headers.includes('PREVIEW')) values.push(row.preview ?? '-');
    return values;
  }), width, semanticTable(color)));
  if (context.currentTopic !== undefined) {
    lines.push('', ansi(`当前主题：${text(context.currentTopic) || '无'}`, 'cyan-bold', color));
    for (const [label, key] of [['事实', 'factItems'], ['决定', 'decisionItems'], ['承诺', 'commitmentItems'], ['未决', 'openQuestionItems']] as const) {
      const values = Array.isArray(context[key]) ? context[key] as unknown[] : [];
      if (values.length > 0) lines.push(`${label}：${values.map(String).join('；')}`);
    }
  }
  return lines;
}

function renderGlobalSettings(instances: ViewInstance[], width: number, color: boolean): string[] {
  const owned = instances.filter((instance) => instance.hostOwnership === 'view').length;
  const attached = instances.filter((instance) => instance.hostOwnership === 'attached').length;
  return [
    heading('全局设置', color),
    ansi('作用域：当前 agent-channel-host View 及其管理的全部 Instances。', 'dim', color),
    '',
    ...table(
      ['SETTING', 'VALUE', 'SCOPE'],
      [
        ['Instances', instances.length, '全局只读状态'],
        ['View-owned Hosts', owned, '由当前 View 管理'],
        ['Attached Hosts', attached, '外部进程，仅观察'],
      ],
      width,
      {
        separator: ' │ ',
        dividerSeparator: '─┼─',
        dividerFill: '─',
        decorate: tableDecorator(color),
      },
    ),
    '',
    ansi('当前版本暂无可修改的全局配置；Agent、Runtime、Channels 与会话边界请在 INSTANCES 中设置。', 'yellow', color),
  ];
}

function renderInstanceSettings(
  instance: ViewInstance,
  detail: Record<string, unknown> | null,
  settings: SettingEntry[],
  state: ManagementViewState,
  width: number,
  color: boolean,
): string[] {
  const conversation = object(detail?.conversation);
  const channels = configuredChannels(instance.config);
  const lines = [
    `${heading(`Instance 设置 / ${instance.name}`, color)}  Agent=${instance.config.identity.name}`,
    `Runtime=${instance.config.runtime.id}  Channels=${channels.filter((channel) => channel.enabled).length}/${channels.length}`,
    ansi(instance.hostOwnership === 'attached'
      ? '当前连接到外部 Host；conversation/member 设置下一 turn 生效，config.yaml 设置建议重启 Host。'
      : instance.hostOwnership === 'view'
        ? '当前 Host 由 view 启动；配置在后续 turn/batch 生效。'
        : '当前为只读快照；未启动或 attach Host。', instance.hostOwnership === 'view' ? 'yellow' : 'dim', color),
    `当前会话：${text(conversation.title) ?? '无（当前仅编辑 instance 配置）'}`,
  ];
  for (const section of ['instance', 'channels', 'conversation', 'members'] as const) {
    const sectionEntries = settings
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.section === section);
    if (sectionEntries.length === 0) continue;
    const selectedRow = sectionEntries.findIndex(({ index }) => index === state.selectedSetting);
    lines.push('', heading(section.toUpperCase(), color));
    lines.push(...table(
      ['', section === 'channels' ? 'CHANNEL' : 'SETTING', 'VALUE', 'EFFECT'],
      sectionEntries.map(({ entry, index }) => [
        index === state.selectedSetting ? '>' : ' ', entry.label, entry.value || '(空)', entry.hint,
      ]),
      width,
      {
        separator: ' │ ',
        dividerSeparator: '─┼─',
        dividerFill: '─',
        decorate: tableDecorator(color, selectedRow, 1),
      },
    ));
  }
  return lines;
}

export function renderStatusView(instances: ViewInstance[], showContent = false, width = 120): string {
  const state = createManagementViewState();
  const snapshots = instances.map((instance) => ({ instance, snapshot: instance.store.status(showContent) }));
  const lines = [
    `${CLI_NAME} view  instances=${instances.length}  refreshed=${new Date().toISOString()}`,
    ...renderGlobalOverview(snapshots, state, width, false),
    '',
    '只读聚合快照；交互模式会逐 instance 启动或 attach Host，并从总览下钻详情与 Instance 设置',
  ];
  return lines.join('\n');
}

function selectedConversationId(store: Store, index: number): string | null {
  return store.listConversations()[index]?.id ?? null;
}

function selectedIdForSettings(state: ManagementViewState, instance: ViewInstance): string | null {
  if (state.detailInstanceName !== instance.name) return null;
  return state.detailConversationId;
}

function normalizeSelection(state: ManagementViewState, instances: ViewInstance[]): void {
  state.selectedInstance = clamp(state.selectedInstance, 0, instances.length);
  if (state.detailInstanceName && !instances.some((instance) => instance.name === state.detailInstanceName)) {
    state.detailInstanceName = null;
    state.detailConversationId = null;
  }
  if (state.settingsInstanceName && !instances.some((instance) => instance.name === state.settingsInstanceName)) {
    state.settingsInstanceName = null;
    state.selectedSetting = 0;
  }
}

type AnsiStyle = 'cyan' | 'cyan-bold' | 'green' | 'green-bold' | 'yellow' | 'yellow-bold' | 'red-bold' | 'dim' | 'bold';

interface TableOptions {
  separator?: string;
  dividerSeparator?: string;
  dividerFill?: string;
  decorate?: (value: string, rowIndex: number, columnIndex: number, header: boolean) => string;
}

function table(headers: string[], rows: unknown[][], width: number, options: TableOptions = {}): string[] {
  if (rows.length === 0) return ['  (none)'];
  const separator = options.separator ?? '  ';
  const usable = Math.max(60, width - 2);
  const natural = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => cell(row[index]).length)));
  const separatorWidth = (headers.length - 1) * separator.length;
  let total = natural.reduce((sum, value) => sum + value, 0) + separatorWidth;
  const widths = [...natural];
  while (total > usable) {
    const index = widths.reduce((best, value, current) => value > widths[best]! ? current : best, 0);
    if (widths[index]! <= 6) break;
    widths[index]!--;
    total--;
  }
  const render = (row: unknown[], rowIndex: number, header = false) => {
    const values = row.map((value, index) => pad(truncate(cell(value), widths[index]!), widths[index]!));
    if (values.length > 0) values[values.length - 1] = values.at(-1)!.trimEnd();
    return values.map((value, columnIndex) => options.decorate?.(value, rowIndex, columnIndex, header) ?? value).join(separator);
  };
  const divider = widths
    .map((value) => (options.dividerFill ?? '-').repeat(value))
    .join(options.dividerSeparator ?? separator);
  return [render(headers, -1, true), divider, ...rows.map((row, index) => render(row, index))];
}

function semanticTable(color: boolean, selectedRow = -1, selectedThroughColumn = -1): TableOptions {
  return { decorate: tableDecorator(color, selectedRow, selectedThroughColumn) };
}

function tableDecorator(color: boolean, selectedRow = -1, selectedThroughColumn = -1): TableOptions['decorate'] {
  return (value, rowIndex, columnIndex, header) => {
    if (header) return ansi(value, 'bold', color);
    if (rowIndex === selectedRow && columnIndex <= selectedThroughColumn) return ansi(value, 'cyan-bold', color);
    return statusText(value, color);
  };
}

function heading(value: string, color: boolean): string {
  return ansi(value, 'cyan-bold', color);
}

function messageSummary(
  values: { received: number; pending: number; claimed: number; processed: number; failed: number; outbox: number; submitted: number },
  color: boolean,
): string {
  return `${heading('MESSAGES', color)} received=${values.received}`
    + ` pending=${ansi(String(values.pending), values.pending > 0 ? 'yellow-bold' : 'dim', color)}`
    + ` claimed=${ansi(String(values.claimed), values.claimed > 0 ? 'yellow' : 'dim', color)}`
    + ` processed=${ansi(String(values.processed), values.processed > 0 ? 'green' : 'dim', color)}`
    + ` failed=${ansi(String(values.failed), values.failed > 0 ? 'red-bold' : 'dim', color)}`
    + ` outbox=${ansi(`${values.outbox}/${values.submitted}`, values.outbox > 0 ? 'yellow-bold' : 'dim', color)}`;
}

function statusText(value: string, color: boolean): string {
  const token = value.trim().toLowerCase();
  if (/^(error|failed|fatal|unknown)$/.test(token)) return ansi(value, 'red-bold', color);
  if (/^(running|ready|completed|success|reply|enabled|true)$/.test(token)) return ansi(value, 'green-bold', color);
  if (/^(starting|pending|claimed|processing|warm|view|shadow|provisioning|held|interrupted)$/.test(token)) {
    return ansi(value, 'yellow', color);
  }
  if (/^(stopped|idle|silent|readonly|attached|unprovisioned|disabled|false|-)$/.test(token)) return ansi(value, 'dim', color);
  return value;
}

function errorText(value: string, color: boolean): string {
  return value === '-' ? ansi(value, 'dim', color) : ansi(value, 'red-bold', color);
}

function ansi(value: string, style: AnsiStyle, enabled: boolean): string {
  if (!enabled) return value;
  const code: Record<AnsiStyle, string> = {
    cyan: '36',
    'cyan-bold': '1;36',
    green: '32',
    'green-bold': '1;32',
    yellow: '33',
    'yellow-bold': '1;33',
    'red-bold': '1;31',
    dim: '2',
    bold: '1',
  };
  return `\u001b[${code[style]}m${value}\u001b[0m`;
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
