import type { ChannelSubscriptionMode, HostConfig } from './config.js';
import { CHANNEL_SUBSCRIPTION_MODES, configuredChannels, validateConfig, writeConfig } from './config.js';
import type { Store } from './store.js';
import type { Conversation } from './types.js';
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
  instanceFocus: 'channels' | 'conversations';
  selectedChannel: number;
  selectedConversation: number;
  selectedChannelItem: number;
  selectedSetting: number;
  detailInstanceName: string | null;
  detailChannel: ChannelTarget | null;
  detailConversationId: string | null;
  settingsInstanceName: string | null;
  editing: { key: string; label: string; value: string; cursor: number } | null;
  creatingInstance: InstanceCreationDraft | null;
  groupSearch: GroupSearchDraft | null;
  destructiveConfirmation: DestructiveConfirmation | null;
  exitConfirmation: boolean;
  notice: string | null;
}

export interface ChannelTarget {
  instanceName: string;
  channelId: string;
  profileId: string;
}

export interface ChannelGroupCandidate {
  title: string;
  externalId: string;
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
  searchGroups?(instance: ViewInstance, query: string): Promise<ChannelGroupCandidate[]>;
  deleteInstance?(instance: ViewInstance): Promise<void>;
  deleteConversation?(instance: ViewInstance, conversationId: string): Promise<void>;
}

interface DestructiveConfirmation {
  kind: 'instance' | 'conversation';
  instanceName: string;
  conversationId: string | null;
  label: string;
}

type InstanceCreationStep = 'instance' | 'cwd' | 'name' | 'role';

interface InstanceCreationDraft {
  step: InstanceCreationStep;
  values: Partial<NewInstanceInput>;
  value: string;
  cursor: number;
}

interface GroupSearchDraft {
  target: ChannelTarget;
  phase: 'query' | 'results';
  query: string;
  cursor: number;
  results: ChannelGroupCandidate[];
  selected: number;
}

export const VIEW_ALTERNATE_SCREEN_ENTER = '\u001b[?1049h\u001b[?25l';
export const VIEW_ALTERNATE_SCREEN_EXIT = '\u001b[?25h\u001b[?1049l';

export function createManagementViewState(): ManagementViewState {
  return {
    tab: 'overview',
    selectedInstance: 0,
    instanceFocus: 'channels',
    selectedChannel: 0,
    selectedConversation: 0,
    selectedChannelItem: 0,
    selectedSetting: 0,
    detailInstanceName: null,
    detailChannel: null,
    detailConversationId: null,
    settingsInstanceName: null,
    editing: null,
    creatingInstance: null,
    groupSearch: null,
    destructiveConfirmation: null,
    exitConfirmation: false,
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
  let alternateScreen = false;
  let timer: NodeJS.Timeout | null = null;
  let inputBusy = false;
  let stopRequested = false;
  let renderFailure: Error | null = null;
  let resolveStop!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
  const requestStop = () => {
    if (stopRequested) return;
    stopRequested = true;
    resolveStop();
  };
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
  const paint = () => process.stdout.write(`\u001b[H\u001b[2J${render()}\n`);
  const repaint = () => {
    if (stopRequested || inputBusy) return;
    try {
      paint();
    } catch (error) {
      renderFailure = error as Error;
      requestStop();
    }
  };
  const onData = (chunk: Buffer) => {
    if (inputBusy) return;
    inputBusy = true;
    void handleManagementViewInput(chunk.toString('utf8'), state, instances, requestStop, actions)
      .catch((error) => { state.notice = (error as Error).message; })
      .finally(() => {
        inputBusy = false;
        repaint();
      });
  };
  const onSignal = () => requestStop();
  try {
    process.stdin.setRawMode?.(true);
    rawMode = true;
    process.stdin.resume();
    process.stdin.on('data', onData);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    process.stdout.write(VIEW_ALTERNATE_SCREEN_ENTER);
    alternateScreen = true;
    paint();
    timer = setInterval(repaint, options.intervalSeconds * 1_000);
    await stopped;
    if (renderFailure) throw renderFailure;
  } finally {
    if (timer) clearInterval(timer);
    process.stdin.removeListener('data', onData);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (rawMode) process.stdin.setRawMode?.(false);
    process.stdin.pause();
    if (alternateScreen) process.stdout.write(VIEW_ALTERNATE_SCREEN_EXIT);
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
  if (state.exitConfirmation) {
    if (key.toLowerCase() === 'q' || key === '\u0003' || key === '\r' || key === '\n') {
      stop();
      return;
    }
    if (key === '\u001b' || key === '\u001b[D') {
      state.exitConfirmation = false;
      state.notice = '已取消退出';
    }
    return;
  }
  if (state.destructiveConfirmation) {
    if (key === '\u0003') {
      state.destructiveConfirmation = null;
      state.exitConfirmation = true;
      return;
    }
    if (key === '\u001b' || key === '\u001b[D') {
      state.destructiveConfirmation = null;
      state.notice = '已取消删除';
      return;
    }
    if (key.toLowerCase() !== 'd' && key !== '\r' && key !== '\n') return;
    const confirmation = state.destructiveConfirmation;
    const target = instances.find((instance) => instance.name === confirmation.instanceName);
    if (!target) throw new Error('删除目标已不存在');
    if (confirmation.kind === 'instance') {
      if (!actions.deleteInstance) throw new Error('当前 View 入口未提供 Instance 删除能力');
      await actions.deleteInstance(target);
      const index = instances.indexOf(target);
      if (index >= 0) instances.splice(index, 1);
      state.detailInstanceName = null;
      state.detailChannel = null;
      state.detailConversationId = null;
      state.settingsInstanceName = null;
      state.selectedInstance = instances.length === 0 ? 0 : Math.min(index, instances.length - 1);
      state.notice = `Instance ${confirmation.label} 已删除`;
    } else {
      if (!confirmation.conversationId) throw new Error('删除目标缺少 conversation ID');
      if (!actions.deleteConversation) throw new Error('当前 View 入口未提供 Conversation 删除能力');
      await actions.deleteConversation(target, confirmation.conversationId);
      state.detailConversationId = null;
      state.settingsInstanceName = null;
      state.selectedConversation = clamp(state.selectedConversation, 0, Math.max(0, target.store.listConversations().length - 1));
      state.notice = `Conversation ${confirmation.label} 已删除`;
    }
    state.destructiveConfirmation = null;
    return;
  }
  if (key === '\u0003') {
    state.exitConfirmation = true;
    return;
  }
  if (state.creatingInstance) {
    await handleInstanceCreationInput(key, state, instances, actions);
    return;
  }
  if (state.groupSearch) {
    if (state.groupSearch.phase === 'results' && key.toLowerCase() === 'q') {
      state.exitConfirmation = true;
      return;
    }
    await handleGroupSearchInput(key, state, instances, actions);
    return;
  }
  const overviewInstance = instances[state.selectedInstance] ?? null;
  const detailInstance = state.detailInstanceName
    ? instances.find((instance) => instance.name === state.detailInstanceName) ?? null
    : null;
  const settingsInstance = state.settingsInstanceName
    ? instances.find((instance) => instance.name === state.settingsInstanceName) ?? null
    : null;
  const back = key === '\u001b' || key === '\u001b[D';
  const forward = key === '\r' || key === '\n' || key === '\u001b[C';
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
    editSingleLine(state.editing, key);
    return;
  }

  if (key.toLowerCase() === 'q') {
    state.exitConfirmation = true;
    return;
  }
  if (key === '\t' && !state.detailInstanceName && !state.settingsInstanceName) {
    state.tab = state.tab === 'overview' ? 'settings' : 'overview';
    state.notice = null;
    return;
  }
  if (back) {
    if (state.tab === 'settings') {
      state.tab = 'overview';
    } else if (state.settingsInstanceName) {
      state.settingsInstanceName = null;
      state.selectedSetting = 0;
    } else if (state.detailConversationId) state.detailConversationId = null;
    else if (state.detailChannel) {
      state.detailChannel = null;
      state.selectedChannelItem = 0;
    } else if (state.detailInstanceName) {
      state.detailInstanceName = null;
      state.instanceFocus = 'channels';
    }
    state.notice = null;
    return;
  }
  if (state.tab === 'overview' && !state.detailInstanceName && !state.settingsInstanceName && key.toLowerCase() === 'a') {
    startInstanceCreation(state, actions);
    return;
  }
  if (state.tab === 'overview' && state.detailInstanceName
    && (!state.detailChannel || state.detailConversationId) && key.toLowerCase() === 's') {
    state.settingsInstanceName = state.detailInstanceName;
    state.selectedSetting = 0;
    state.notice = null;
    return;
  }
  if (state.tab === 'overview' && state.detailConversationId && detailInstance && key.toLowerCase() === 'e') {
    state.settingsInstanceName = detailInstance.name;
    state.selectedSetting = 0;
    state.notice = null;
    return;
  }
  if (state.tab === 'overview' && key.toLowerCase() === 'd') {
    if (state.detailConversationId && detailInstance) {
      const conversation = detailInstance.store.getConversation(state.detailConversationId);
      if (!conversation) throw new Error('Conversation 已不存在');
      state.destructiveConfirmation = {
        kind: 'conversation', instanceName: detailInstance.name,
        conversationId: conversation.id, label: conversation.title,
      };
      return;
    }
    if (!state.detailChannel && !state.settingsInstanceName) {
      const target = detailInstance ?? overviewInstance;
      if (target && (state.detailInstanceName || state.selectedInstance < instances.length)) {
        state.destructiveConfirmation = {
          kind: 'instance', instanceName: target.name, conversationId: null, label: target.name,
        };
      }
      return;
    }
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
        state.instanceFocus = 'channels';
        state.selectedChannel = 0;
        state.selectedConversation = 0;
      } else if (state.detailChannel && detailInstance) {
        const total = channelManagementItems(detailInstance, state.detailChannel).length;
        state.selectedChannelItem = clamp(state.selectedChannelItem + direction, 0, Math.max(0, total - 1));
      } else {
        moveInstanceSelection(state, detailInstance, direction);
      }
    }
    return;
  }
  if (forward) {
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
        state.editing = { key: entry.key, label: entry.label, value: entry.value, cursor: textLength(entry.value) };
        return;
      }
      if (!state.detailInstanceName) {
        if (state.selectedInstance >= instances.length) {
          startInstanceCreation(state, actions);
          return;
        }
        if (!overviewInstance) return;
        state.detailInstanceName = overviewInstance.name;
        state.instanceFocus = 'channels';
        state.selectedChannel = 0;
        state.selectedConversation = 0;
      } else if (state.detailChannel) {
        if (!detailInstance) return;
        await activateChannelItem(state, detailInstance, actions);
      } else {
        if (!detailInstance) return;
        if (state.instanceFocus === 'channels') {
          const channel = configuredChannels(detailInstance.config)[state.selectedChannel];
          if (!channel) return;
          state.detailChannel = {
            instanceName: detailInstance.name,
            channelId: channel.id,
            profileId: channel.profileId,
          };
          state.selectedChannelItem = 0;
        } else {
          state.detailConversationId = selectedConversationId(detailInstance.store, state.selectedConversation);
        }
      }
      return;
    }
    return;
  }
}

async function activateChannelItem(
  state: ManagementViewState,
  instance: ViewInstance,
  actions: ManagementViewActions,
): Promise<void> {
  const target = state.detailChannel!;
  const item = channelManagementItems(instance, target)[state.selectedChannelItem];
  if (!item) return;
  if (item.kind === 'enabled') {
    const entry = createChannelSettingEntry(instance.config, instance.store, target, instance.configFile);
    await entry.apply(entry.value === 'enabled' ? 'disabled' : 'enabled');
    const actionNotice = await actions.afterSettingApplied?.(instance, entry);
    state.notice = actionNotice ?? `${entry.label} 已切换为 ${entry.value === 'enabled' ? 'disabled' : 'enabled'}`;
    return;
  }
  if (item.kind === 'groups-subscription' || item.kind === 'directs-subscription') {
    const kind = item.kind === 'groups-subscription' ? 'groups' : 'directs';
    const entry = createChannelSubscriptionSettingEntry(instance.config, instance.store, target, kind, instance.configFile);
    const current = CHANNEL_SUBSCRIPTION_MODES.indexOf(entry.value as ChannelSubscriptionMode);
    const next = CHANNEL_SUBSCRIPTION_MODES[(current + 1) % CHANNEL_SUBSCRIPTION_MODES.length]!;
    await entry.apply(next);
    const actionNotice = await actions.afterSettingApplied?.(instance, entry);
    state.notice = actionNotice ?? `${entry.label} 已切换为 ${next}`;
    return;
  }
  if (item.kind === 'conversation') {
    state.detailConversationId = item.conversation.id;
    state.notice = null;
    return;
  }
  if (item.kind !== 'search-group') return;
  if (!actions.searchGroups) throw new Error('当前 View 入口未提供群搜索能力');
  state.groupSearch = { target, phase: 'query', query: '', cursor: 0, results: [], selected: 0 };
  state.notice = null;
}

async function handleGroupSearchInput(
  key: string,
  state: ManagementViewState,
  instances: ViewInstance[],
  actions: ManagementViewActions,
): Promise<void> {
  const draft = state.groupSearch!;
  const back = key === '\u001b' || (draft.phase === 'results' && key === '\u001b[D');
  const forward = key === '\r' || key === '\n' || key === '\u001b[C';
  if (back) {
    if (draft.phase === 'results') {
      draft.phase = 'query';
      draft.results = [];
      draft.selected = 0;
      draft.cursor = textLength(draft.query);
      state.notice = '可修改关键词后重新搜索';
    } else {
      state.groupSearch = null;
      state.notice = null;
    }
    return;
  }
  if (draft.phase === 'query') {
    if (key !== '\r' && key !== '\n') {
      const line = { value: draft.query, cursor: draft.cursor };
      editSingleLine(line, key);
      draft.query = line.value;
      draft.cursor = line.cursor;
      return;
    }
    const instance = instances.find((item) => item.name === draft.target.instanceName);
    if (!instance) throw new Error('目标 instance 已不存在');
    if (!actions.searchGroups) throw new Error('当前 View 入口未提供群搜索能力');
    const query = draft.query.trim();
    if (!query) throw new Error('群搜索关键词不能为空');
    const seen = new Set<string>();
    draft.results = (await actions.searchGroups(instance, query)).filter((candidate) => {
      if (!candidate.title.trim() || !candidate.externalId.trim() || seen.has(candidate.externalId)) return false;
      seen.add(candidate.externalId);
      return true;
    });
    draft.phase = 'results';
    draft.selected = 0;
    state.notice = draft.results.length > 0 ? `找到 ${draft.results.length} 个群组` : '没有匹配群组；← 返回修改关键词';
    return;
  }
  const direction = key === '\u001b[A' || key.toLowerCase() === 'k' ? -1
    : key === '\u001b[B' || key.toLowerCase() === 'j' ? 1 : 0;
  if (direction !== 0) {
    draft.selected = clamp(draft.selected + direction, 0, Math.max(0, draft.results.length - 1));
    return;
  }
  if (!forward || draft.results.length === 0) return;
  const instance = instances.find((item) => item.name === draft.target.instanceName);
  if (!instance) throw new Error('目标 instance 已不存在');
  const candidate = draft.results[draft.selected]!;
  let conversation = findChannelGroup(instance, draft.target, candidate.externalId);
  if (!conversation) {
    try {
      conversation = instance.store.addConversation({
        channelId: draft.target.channelId,
        channelProfileId: draft.target.profileId,
        kind: 'group',
        externalId: candidate.externalId,
        title: candidate.title,
        responsibility: instance.config.identity.role,
        mode: 'shadow',
        runtimeId: instance.config.runtime.id,
      });
      state.notice = `已绑定群组“${candidate.title}”；默认职责继承 Agent 角色，模式为 shadow`;
    } catch (error) {
      conversation = findChannelGroup(instance, draft.target, candidate.externalId);
      if (!conversation) throw error;
      state.notice = `群组“${candidate.title}”已由其他操作绑定`;
    }
  } else {
    state.notice = `群组“${candidate.title}”已绑定，已打开会话详情`;
  }
  state.groupSearch = null;
  state.detailConversationId = conversation.id;
  const index = instance.store.listConversations().findIndex((item) => item.id === conversation!.id);
  state.selectedConversation = Math.max(0, index);
}

async function handleInstanceCreationInput(
  key: string,
  state: ManagementViewState,
  instances: ViewInstance[],
  actions: ManagementViewActions,
): Promise<void> {
  const draft = state.creatingInstance!;
  if (key === '\u001b') {
    state.creatingInstance = null;
    state.notice = '已取消新增 Instance';
    return;
  }
  if (key !== '\r' && key !== '\n') {
    editSingleLine(draft, key);
    return;
  }

  const value = draft.value.trim();
  if (draft.step === 'instance') {
    safeName(value);
    if (instances.some((instance) => instance.name === value)) throw new Error(`instance 已存在：${value}`);
    draft.values.instance = value;
    draft.step = 'cwd';
    draft.value = process.cwd();
    draft.cursor = textLength(draft.value);
    return;
  }
  if (!value) throw new Error(`${creationStepLabel(draft.step)}不能为空`);
  if (draft.step === 'cwd') {
    draft.values.cwd = value;
    draft.step = 'name';
    draft.value = 'DingTalk Agent';
    draft.cursor = textLength(draft.value);
    return;
  }
  if (draft.step === 'name') {
    draft.values.name = value;
    draft.step = 'role';
    draft.value = '在授权会话内提供职责范围内的分析和答复';
    draft.cursor = textLength(draft.value);
    return;
  }

  if (!actions.createInstance) throw new Error('当前 View 入口未提供 instance 创建能力');
  const input = { ...draft.values, role: value } as NewInstanceInput;
  const created = await actions.createInstance(input);
  state.creatingInstance = null;
  instances.push(created);
  state.selectedInstance = instances.length - 1;
  state.detailInstanceName = created.name;
  const channel = configuredChannels(created.config)[0];
  state.detailChannel = channel
    ? { instanceName: created.name, channelId: channel.id, profileId: channel.profileId }
    : null;
  state.instanceFocus = 'channels';
  state.selectedChannel = 0;
  state.selectedChannelItem = 0;
  await actions.startInstance?.(created);
  state.notice = `Instance ${created.name} 已创建；Channel 默认 disabled，可在当前页确认后启用`;
}

function startInstanceCreation(state: ManagementViewState, actions: ManagementViewActions): void {
  if (!actions.createInstance) throw new Error('当前 View 入口未提供 instance 创建能力');
  state.creatingInstance = { step: 'instance', values: {}, value: '', cursor: 0 };
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
  if (!conversationId) return entries;
  const conversation = store.getConversation(conversationId);
  if (!conversation) return entries;
  const enabledEntry = storeSetting(
    `conversation:${conversationId}:enabled`, `会话启用 · ${conversation.title}`,
    conversation.enabled ? 'enabled' : 'disabled', '即时准入策略', async (value) => {
      if (value !== 'enabled' && value !== 'disabled') throw new Error('会话状态必须是 enabled 或 disabled');
      if (!store.setConversationEnabled(conversationId, value === 'enabled')) throw new Error('conversation 不存在');
      await publishCurrentRecovery(config, store, conversationId);
    },
  );
  enabledEntry.input = 'toggle';
  entries.push(
    storeSetting(`conversation:${conversationId}:title`, `会话名称 · ${conversation.title}`, conversation.title, '仅修改本地显示名称', async (value) => {
      if (!store.setConversationTitle(conversationId, value)) throw new Error('conversation 不存在');
      await publishCurrentRecovery(config, store, conversationId);
    }),
    enabledEntry,
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

export function createChannelSettingEntry(
  config: HostConfig,
  store: Store,
  target: Pick<ChannelTarget, 'channelId' | 'profileId'>,
  configFile?: string,
): SettingEntry {
  const channel = configuredChannels(config)
    .find((item) => item.id === target.channelId && item.profileId === target.profileId);
  if (!channel) throw new Error(`Channel 不存在：${target.channelId}/${target.profileId}`);
  const entry = configSetting(
    `channel:${channel.id}:${channel.profileId}:enabled`,
    `${channel.id}/${channel.profileId}`,
    channel.enabled ? 'enabled' : 'disabled',
    '切换后 View owner 即时重启；attach Host 需手动重启',
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
}

export function createChannelSubscriptionSettingEntry(
  config: HostConfig,
  store: Store,
  target: Pick<ChannelTarget, 'channelId' | 'profileId'>,
  kind: 'groups' | 'directs',
  configFile?: string,
): SettingEntry {
  const channel = configuredChannels(config)
    .find((item) => item.id === target.channelId && item.profileId === target.profileId);
  if (!channel) throw new Error(`Channel 不存在：${target.channelId}/${target.profileId}`);
  const label = kind === 'groups' ? '群聊订阅' : '私聊订阅';
  const entry = configSetting(
    `channel:${channel.id}:${channel.profileId}:subscriptions:${kind}`,
    label,
    channel.subscriptions[kind],
    'none/selected/all；View owner 即时重启',
    config,
    store,
    configFile,
    (next, value) => {
      if (!CHANNEL_SUBSCRIPTION_MODES.includes(value as ChannelSubscriptionMode)) {
        throw new Error('订阅模式必须是 none、selected 或 all');
      }
      next.channel.subscriptions[kind] = value as ChannelSubscriptionMode;
    },
  );
  entry.section = 'channels';
  entry.restartHost = true;
  return entry;
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
  else if (state.groupSearch && detailInstance) lines.push(...renderGroupSearch(detailInstance, state.groupSearch, width, color));
  else if (settingsInstance) lines.push(...renderInstanceSettings(settingsInstance, detail, settings, state, width, color));
  else if (state.detailConversationId) lines.push(...renderConversationDetail(detail, width, color));
  else if (state.detailChannel && detailInstance) lines.push(...renderChannelManagement(detailInstance, state.detailChannel, state, width, color));
  else if (detailInstance) lines.push(...renderInstanceOverview(detailInstance, detailInstance.store.status(showContent), state, width, color));
  else lines.push(...renderGlobalOverview(snapshots, state, width, color));
  const notice = state.notice ?? (settingsInstance ?? selectedInstance)?.notices.at(-1) ?? null;
  if (notice) lines.push('', ansi(`提示：${notice}`, 'yellow-bold', color));
  if (state.exitConfirmation) {
    const owned = instances.filter((instance) => instance.hostOwnership === 'view').length;
    lines.push(
      '',
      heading('退出确认', color),
      `退出 View 将停止 ${ansi(String(owned), owned > 0 ? 'yellow-bold' : 'dim', color)} 个由当前 View 启动的 Host；attached/readonly Host 保持运行。`,
    );
  }
  if (state.destructiveConfirmation) {
    const confirmation = state.destructiveConfirmation;
    const target = instances.find((instance) => instance.name === confirmation.instanceName);
    lines.push('', heading('删除确认', color));
    if (confirmation.kind === 'instance') {
      lines.push(
        ansi(`将删除 Instance ${confirmation.label} 的配置、SQLite/WAL、recovery、日志和本地 session 映射。`, 'red-bold', color),
        `Host owner=${statusText(target?.hostOwnership ?? 'unknown', color)}；attached Host 存活时会拒绝删除。`,
      );
    } else {
      lines.push(
        ansi(`将删除 Conversation ${confirmation.label} 及其消息、session、outbox、worker、context、成员和 recovery。`, 'red-bold', color),
        `Instance=${confirmation.instanceName}；删除后不能用原 provider session 恢复。`,
      );
    }
  }
  lines.push('', state.destructiveConfirmation
    ? ansi('Enter/d 确认删除  Esc/← 取消', 'red-bold', color)
    : state.exitConfirmation
    ? ansi('Enter/q/Ctrl+C 确认退出  Esc/← 取消', 'yellow-bold', color)
    : state.creatingInstance
    ? ansi(`新增 Instance · ${creationStepLabel(state.creatingInstance.step)}：${renderTextCursor(state.creatingInstance.value, state.creatingInstance.cursor)}  ←/→ 移动  Enter 下一步  Esc 取消`, 'cyan-bold', color)
    : state.groupSearch?.phase === 'query'
      ? ansi(`群组搜索：${renderTextCursor(state.groupSearch.query, state.groupSearch.cursor)}  ←/→ 移动  Enter 搜索  Esc 返回 Channel`, 'cyan-bold', color)
      : state.groupSearch?.phase === 'results'
        ? ansi('↑/↓ 选择  →/Enter 绑定或打开  ←/Esc 修改关键词  q 退出', 'dim', color)
    : state.editing
      ? ansi(`编辑 ${state.editing.label}：${renderTextCursor(state.editing.value, state.editing.cursor)}  ←/→ 移动  Enter 保存  Esc 取消`, 'cyan-bold', color)
      : state.tab === 'settings'
        ? ansi('Tab 切换总览  ←/Esc 返回总览  q 退出', 'dim', color)
        : state.settingsInstanceName
          ? ansi('↑/↓ 选择  →/Enter 编辑  ←/Esc 返回  q 退出', 'dim', color)
          : state.detailConversationId
            ? ansi('e/s 修改  d 删除  ←/Esc 返回  q 退出', 'dim', color)
            : state.detailChannel
              ? ansi('↑/↓ 选择  →/Enter 操作或下钻  ←/Esc 返回 Instance  q 退出', 'dim', color)
          : state.detailInstanceName
            ? ansi('↑/↓ 选择  →/Enter 下钻  s Instance 设置  d 删除 Instance  ←/Esc 返回  q 退出', 'dim', color)
            : ansi('↑/↓ 选择  →/Enter 下钻  a 新增  d 删除 Instance  Tab 全局设置  q 退出', 'dim', color));
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
    ['', 'INSTANCE', 'AGENT', 'HOST', 'OWNER', 'CHANNELS', 'CONVERSATIONS', 'PENDING', 'ALERTS'],
    [...snapshots.map(({ instance, snapshot }, index) => {
      const host = object(snapshot.host);
      return [
        index === state.selectedInstance ? '>' : ' ', instance.name, instance.config.identity.name,
        host.state ?? 'unknown', instance.hostOwnership, array(snapshot.channels).length, array(snapshot.conversations).length,
        number(snapshot.pending_messages), array(snapshot.alerts).length,
      ];
    }), [
      state.selectedInstance >= snapshots.length ? '>' : ' ', '+ 新增 Instance', '-', '-', '-', '-', '-', '-', '-',
    ]],
    width,
    semanticTable(color, state.selectedInstance, 2),
  ));
  if (snapshots.length === 0) {
    lines.push('', ansi('尚未初始化 instance。交互模式可按 a 创建；也可运行 agent-channel init --instance <name> --cwd <path>。', 'yellow-bold', color));
  }

  const totals = snapshots.reduce((result, { snapshot }) => ({
    received: result.received + number(snapshot.received),
    pending: result.pending + number(snapshot.pending_messages),
    claimed: result.claimed + number(snapshot.claimed_messages),
    processed: result.processed + number(snapshot.processed),
    failed: result.failed + number(snapshot.failed_messages),
    outbox: result.outbox + number(snapshot.pending_outbox),
    submitted: result.submitted + number(snapshot.submitted),
  }), { received: 0, pending: 0, claimed: 0, processed: 0, failed: 0, outbox: 0, submitted: 0 });
  lines.push('', messageSummary(totals, color));
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
  const connectionRows = array(snapshot.channels);
  const channels = configuredChannels(instance.config).map((channel) => {
    const connection = connectionRows.find((row) => row.channelId === channel.id && row.profileId === channel.profileId) ?? {};
    return {
      channelId: channel.id,
      profileId: channel.profileId,
      state: connection.state ?? (channel.enabled ? 'stopped' : 'disabled'),
      pid: connection.pid ?? '-',
      lastEventAt: connection.lastEventAt,
      error: connection.error,
    };
  });
  const conversations = array(snapshot.conversations);
  const runtimeAdapters = array(snapshot.runtimeAdapters);
  const messages = array(snapshot.messages);
  const alerts = array(snapshot.alerts);
  const host = object(snapshot.host);
  const lines = [
    `${heading(`实例详情 / ${instance.name}`, color)}  Agent=${instance.config.identity.name}  host=${statusText(text(host.state) ?? 'unknown', color)}  pid=${text(host.pid) ?? '-'}  ${statusText(instance.hostOwnership, color)}`,
    '', heading('CHANNELS', color),
  ];
  lines.push(...table(
    ['', 'CHANNEL', 'PROFILE', 'STATE', 'PID', 'LAST EVENT', 'ERROR'],
    channels.map((row, index) => [
      state.instanceFocus === 'channels' && index === state.selectedChannel ? '>' : ' ',
      row.channelId, row.profileId, row.state, row.pid, age(row.lastEventAt), row.error ?? '-',
    ]),
    width,
    semanticTable(color, state.instanceFocus === 'channels' ? state.selectedChannel : -1, 2),
  ));
  lines.push('', messageSummary({
    received: number(snapshot.received),
    pending: number(snapshot.pending_messages),
    claimed: number(snapshot.claimed_messages),
    processed: number(snapshot.processed),
    failed: number(snapshot.failed_messages),
    outbox: number(snapshot.pending_outbox),
    submitted: number(snapshot.submitted),
  }, color), '', heading('RECENT MESSAGES', color));
  const messageHeaders = ['CHANNEL', 'CONVERSATION', 'SEQ', 'SENDER', 'STATE', 'ACTION', 'AGE'];
  if (messages.some((row) => row.preview !== undefined)) messageHeaders.push('PREVIEW');
  lines.push(...table(messageHeaders, messages.map((row) => {
    const values: unknown[] = [row.channelId, row.title, row.sequence, row.sender ?? '-', row.state, row.action ?? '-', age(row.receivedAt)];
    if (messageHeaders.includes('PREVIEW')) values.push(row.preview ?? '-');
    return values;
  }), width, semanticTable(color)));
  lines.push('', heading('CONVERSATIONS', color));
  lines.push(...table(
    ['', 'CHANNEL', 'TITLE', 'MODE', 'PENDING', 'WORKER', 'SESSION', 'CONTEXT', 'MEMBERS', 'RUNTIME'],
    conversations.map((row, index) => [
      state.instanceFocus === 'conversations' && index === state.selectedConversation ? '>' : ' ', row.channelId, row.title, row.mode, row.pending,
      row.workerState, row.sessionState, `v${row.contextVersion ?? 0}@${row.contextThroughSequence ?? 0}`,
      row.memberCount ?? 0, row.runtimeId,
    ]), width, semanticTable(color, state.instanceFocus === 'conversations' ? state.selectedConversation : -1, 2),
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

function renderChannelManagement(
  instance: ViewInstance,
  target: ChannelTarget,
  state: ManagementViewState,
  width: number,
  color: boolean,
): string[] {
  const channel = configuredChannels(instance.config)
    .find((item) => item.id === target.channelId && item.profileId === target.profileId);
  if (!channel) return [ansi(`Channel 不存在：${target.channelId}/${target.profileId}`, 'red-bold', color)];
  const snapshot = instance.store.status();
  const connection = array(snapshot.channels)
    .find((row) => row.channelId === target.channelId && row.profileId === target.profileId) ?? {};
  const groups = channelGroups(instance, target);
  const directs = channelDirects(instance, target);
  const items = channelManagementItems(instance, target);
  const selected = items[state.selectedChannelItem];
  const lines = [
    `${heading(`Channel 设置 / ${instance.name} / ${channel.id}/${channel.profileId}`, color)}  Agent=${instance.config.identity.name}`,
    `配置=${statusText(channel.enabled ? 'enabled' : 'disabled', color)}  连接=${statusText(text(connection.state) ?? (channel.enabled ? 'stopped' : 'disabled'), color)}  owner=${text(connection.pid) ?? '-'}`,
    ansi(channel.enabled
      ? 'Channel 已启用；由当前 View 启动的 Host 会持有唯一 owner。'
      : 'Channel 已停用；群组绑定会保留，但不会启动接收 owner。', channel.enabled ? 'green' : 'yellow', color),
    '', heading('CHANNEL', color),
    ...table(
      ['', 'ACTION', 'VALUE', 'EFFECT'],
      [
        [selected?.kind === 'enabled' ? '>' : ' ', '启用 / 停用', channel.enabled ? 'enabled' : 'disabled', '切换目标 Instance 的 Channel owner'],
        [selected?.kind === 'groups-subscription' ? '>' : ' ', '群聊订阅', channel.subscriptions.groups, subscriptionEffect(channel.subscriptions.groups)],
        [selected?.kind === 'directs-subscription' ? '>' : ' ', '私聊订阅', channel.subscriptions.directs, subscriptionEffect(channel.subscriptions.directs)],
      ],
      width,
      {
        separator: ' │ ', dividerSeparator: '─┼─', dividerFill: '─',
        decorate: tableDecorator(color, ['enabled', 'groups-subscription', 'directs-subscription'].indexOf(selected?.kind ?? ''), 2),
      },
    ),
    '', heading('GROUPS', color),
    ...table(
      ['', 'GROUP', 'STATE', 'MODE', 'RESPONSIBILITY', 'RUNTIME'],
      [
        ...groups.map((group) => [
          selected?.kind === 'conversation' && selected.conversation.id === group.id ? '>' : ' ', group.title,
          group.enabled ? 'enabled' : 'disabled', group.mode, group.responsibility, group.runtimeId,
        ]),
        [selected?.kind === 'search-group' ? '>' : ' ', '+ 搜索并绑定指定群聊', '-', 'shadow', '默认继承 Agent 角色', instance.config.runtime.id],
      ],
      width,
      semanticTable(color, selected?.kind === 'conversation'
        ? groups.findIndex((group) => group.id === selected.conversation.id)
        : selected?.kind === 'search-group' ? groups.length : -1, 2),
    ),
    '', heading('DIRECTS', color),
    ...table(
      ['', 'DIRECT', 'STATE', 'MODE', 'RESPONSIBILITY', 'RUNTIME'],
      directs.map((direct) => [
        selected?.kind === 'conversation' && selected.conversation.id === direct.id ? '>' : ' ', direct.title,
        direct.enabled ? 'enabled' : 'disabled', direct.mode, direct.responsibility, direct.runtimeId,
      ]),
      width,
      semanticTable(color, selected?.kind === 'conversation'
        ? directs.findIndex((direct) => direct.id === selected.conversation.id)
        : -1, 2),
    ),
    ansi('指定私聊使用稳定 openDingTalkId 登记；当前不按姓名猜测 ID。可用 conversation add 添加后在此管理。', 'dim', color),
  ];
  return lines;
}

function renderGroupSearch(
  instance: ViewInstance,
  draft: GroupSearchDraft,
  width: number,
  color: boolean,
): string[] {
  const lines = [
    heading(`群组搜索 / ${instance.name} / ${draft.target.channelId}/${draft.target.profileId}`, color),
    ansi('搜索是只读 Channel 操作；选择后写入当前 Instance 的 conversation allowlist，不会发送消息。', 'dim', color),
    '', `关键词：${draft.query || '(尚未输入)'}`,
  ];
  if (draft.phase === 'query') {
    lines.push('', ansi('输入群名关键词后按 Enter。外部 conversation ID 不会显示在 View 中。', 'yellow', color));
    return lines;
  }
  lines.push('', heading('SEARCH RESULTS', color));
  lines.push(...table(
    ['', 'GROUP', 'BINDING'],
    draft.results.map((candidate, index) => [
      index === draft.selected ? '>' : ' ',
      candidate.title,
      findChannelGroup(instance, draft.target, candidate.externalId) ? '已绑定' : '可绑定',
    ]),
    width,
    semanticTable(color, draft.selected, 2),
  ));
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

function channelGroups(instance: ViewInstance, target: Pick<ChannelTarget, 'channelId' | 'profileId'>): Conversation[] {
  return channelConversations(instance, target).filter((conversation) => conversation.kind === 'group');
}

function channelDirects(instance: ViewInstance, target: Pick<ChannelTarget, 'channelId' | 'profileId'>): Conversation[] {
  return channelConversations(instance, target).filter((conversation) => conversation.kind === 'direct');
}

function channelConversations(instance: ViewInstance, target: Pick<ChannelTarget, 'channelId' | 'profileId'>): Conversation[] {
  return instance.store.listConversations().filter((conversation) => (
    conversation.channelId === target.channelId
    && conversation.channelProfileId === target.profileId
  ));
}

type ChannelManagementItem =
  | { kind: 'enabled' | 'groups-subscription' | 'directs-subscription' | 'search-group' }
  | { kind: 'conversation'; conversation: Conversation };

function channelManagementItems(
  instance: ViewInstance,
  target: Pick<ChannelTarget, 'channelId' | 'profileId'>,
): ChannelManagementItem[] {
  return [
    { kind: 'enabled' },
    { kind: 'groups-subscription' },
    { kind: 'directs-subscription' },
    ...channelGroups(instance, target).map((conversation) => ({ kind: 'conversation' as const, conversation })),
    { kind: 'search-group' },
    ...channelDirects(instance, target).map((conversation) => ({ kind: 'conversation' as const, conversation })),
  ];
}

function subscriptionEffect(mode: ChannelSubscriptionMode): string {
  if (mode === 'none') return '拒绝该类全部消息';
  if (mode === 'all') return '未知会话自动以 shadow 建档';
  return '仅准入已启用的指定会话';
}

function findChannelGroup(
  instance: ViewInstance,
  target: Pick<ChannelTarget, 'channelId' | 'profileId'>,
  externalId: string,
): Conversation | null {
  return channelGroups(instance, target).find((conversation) => conversation.externalId === externalId) ?? null;
}

function moveInstanceSelection(state: ManagementViewState, instance: ViewInstance | null, direction: number): void {
  if (!instance) return;
  const channelCount = configuredChannels(instance.config).length;
  const conversationCount = instance.store.listConversations().length;
  const total = channelCount + conversationCount;
  if (total === 0) return;
  const current = state.instanceFocus === 'channels'
    ? state.selectedChannel
    : channelCount + state.selectedConversation;
  const next = clamp(current + direction, 0, total - 1);
  if (next < channelCount) {
    state.instanceFocus = 'channels';
    state.selectedChannel = next;
  } else {
    state.instanceFocus = 'conversations';
    state.selectedConversation = next - channelCount;
  }
}

function selectedIdForSettings(state: ManagementViewState, instance: ViewInstance): string | null {
  if (state.detailInstanceName !== instance.name) return null;
  return state.detailConversationId;
}

function normalizeSelection(state: ManagementViewState, instances: ViewInstance[]): void {
  state.selectedInstance = clamp(state.selectedInstance, 0, instances.length);
  if (state.detailInstanceName && !instances.some((instance) => instance.name === state.detailInstanceName)) {
    state.detailInstanceName = null;
    state.detailChannel = null;
    state.detailConversationId = null;
    state.groupSearch = null;
  }
  const detailInstance = state.detailInstanceName
    ? instances.find((instance) => instance.name === state.detailInstanceName) ?? null
    : null;
  if (detailInstance) {
    state.selectedChannel = clamp(state.selectedChannel, 0, Math.max(0, configuredChannels(detailInstance.config).length - 1));
    state.selectedConversation = clamp(state.selectedConversation, 0, Math.max(0, detailInstance.store.listConversations().length - 1));
  }
  if (state.detailChannel && (
    !detailInstance
    || state.detailChannel.instanceName !== detailInstance.name
    || !configuredChannels(detailInstance.config).some((channel) => (
      channel.id === state.detailChannel!.channelId && channel.profileId === state.detailChannel!.profileId
    ))
  )) {
    state.detailChannel = null;
    state.groupSearch = null;
    state.selectedChannelItem = 0;
  }
  if (state.settingsInstanceName && !instances.some((instance) => instance.name === state.settingsInstanceName)) {
    state.settingsInstanceName = null;
    state.selectedSetting = 0;
  }
  if (state.destructiveConfirmation
    && !instances.some((instance) => instance.name === state.destructiveConfirmation!.instanceName)) {
    state.destructiveConfirmation = null;
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
  const natural = headers.map((header, index) => Math.max(
    terminalDisplayWidth(header),
    ...rows.map((row) => terminalDisplayWidth(cell(row[index]))),
  ));
  const separatorWidth = (headers.length - 1) * terminalDisplayWidth(separator);
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
  if (terminalDisplayWidth(value) <= width) return value;
  if (width <= 0) return '';
  if (width === 1) return '…';
  const limit = width - 1;
  let result = '';
  let used = 0;
  for (const segment of graphemeSegments(value)) {
    const segmentWidth = graphemeDisplayWidth(segment);
    if (used + segmentWidth > limit) break;
    result += segment;
    used += segmentWidth;
  }
  return `${result}…`;
}

function pad(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - terminalDisplayWidth(value)))}`;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const MARK = /\p{Mark}/u;
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

export function terminalDisplayWidth(value: string): number {
  return graphemeSegments(value).reduce((total, segment) => total + graphemeDisplayWidth(segment), 0);
}

function graphemeSegments(value: string): string[] {
  return [...graphemeSegmenter.segment(value)].map(({ segment }) => segment);
}

function graphemeDisplayWidth(segment: string): number {
  if (EXTENDED_PICTOGRAPHIC.test(segment) || /[\uFE0F\u20E3]/u.test(segment)) return 2;
  let width = 0;
  for (const character of segment) {
    const codePoint = character.codePointAt(0)!;
    if (isZeroWidth(codePoint, character)) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function isZeroWidth(codePoint: number, character: string): boolean {
  return codePoint === 0x200d
    || codePoint <= 0x1f
    || (codePoint >= 0x7f && codePoint <= 0x9f)
    || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
    || MARK.test(character);
}

function isWideCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1b000 && codePoint <= 0x1b2ff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
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

function editSingleLine(line: { value: string; cursor: number }, key: string): void {
  const characters = Array.from(line.value);
  line.cursor = clamp(line.cursor, 0, characters.length);
  if (key === '\u001b[D') {
    line.cursor = Math.max(0, line.cursor - 1);
    return;
  }
  if (key === '\u001b[C') {
    line.cursor = Math.min(characters.length, line.cursor + 1);
    return;
  }
  if (key === '\u001b[H' || key === '\u001b[1~') {
    line.cursor = 0;
    return;
  }
  if (key === '\u001b[F' || key === '\u001b[4~') {
    line.cursor = characters.length;
    return;
  }
  if (key === '\u007f' || key === '\b') {
    if (line.cursor > 0) {
      characters.splice(line.cursor - 1, 1);
      line.cursor--;
      line.value = characters.join('');
    }
    return;
  }
  if (key === '\u001b[3~') {
    if (line.cursor < characters.length) {
      characters.splice(line.cursor, 1);
      line.value = characters.join('');
    }
    return;
  }
  if (key.startsWith('\u001b') || key === '\u0003') return;
  const inserted = Array.from(key.replace(/[\u0000-\u001f]/g, ''));
  if (inserted.length === 0) return;
  characters.splice(line.cursor, 0, ...inserted);
  line.cursor += inserted.length;
  line.value = characters.join('');
}

function renderTextCursor(value: string, cursor: number): string {
  const characters = Array.from(value);
  const index = clamp(cursor, 0, characters.length);
  return `${characters.slice(0, index).join('')}█${characters.slice(index).join('')}`;
}

function textLength(value: string): number {
  return Array.from(value).length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function redact(value: string): string {
  return value.length <= 1 ? `${value}*` : `${value.slice(0, 1)}***${value.slice(-1)}`;
}
