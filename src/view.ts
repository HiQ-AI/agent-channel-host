import type { ChannelSubscriptionMode, HostConfig } from './config.js';
import { CHANNEL_SUBSCRIPTION_MODES, configuredChannels, validateConfig, writeConfig } from './config.js';
import { resolve } from 'node:path';
import type { Store } from './store.js';
import type { Conversation, ConversationMode } from './types.js';
import { CLI_NAME, PRODUCT_VERSION } from './product.js';
import { CONVERSATION_MODES, MAX_RESPONSIBILITY_REMINDER_INTERVAL, MAX_WORKER_WARM_SECONDS } from './types.js';
import { safeName } from './paths.js';
import { displayConversationTitle } from './conversation-title.js';
import { execResolved, resolveCommand } from './command.js';
import type { AgentTranscript, AgentTranscriptEntry } from './codex-transcript.js';

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

export interface RequiredToolStatus {
  tool: 'Node.js' | 'DWS' | 'Codex CLI';
  state: 'ready' | 'error';
  version: string;
  command: string;
  error: string | null;
}

export interface ManagementViewState {
  tab: 'overview' | 'settings';
  selectedInstance: number;
  instanceFocus: 'settings' | 'channels' | 'conversations';
  selectedChannel: number;
  selectedConversation: number;
  selectedConversationId: string | null;
  selectedChannelItem: number;
  selectedSetting: number;
  detailInstanceName: string | null;
  detailChannel: ChannelTarget | null;
  detailConversationId: string | null;
  conversationDetailFocus: 'settings' | 'members' | 'messages';
  selectedMember: number;
  selectedMessage: number;
  selectedMessageSequence: number | null;
  settingsInstanceName: string | null;
  editing: {
    key: string;
    label: string;
    value: string;
    cursor: number;
    multiline?: boolean;
    wrapWidth?: number;
    preferredColumn?: number | null;
    purpose?: 'setting' | 'agent-input';
    conversationId?: string;
    timelineScroll?: number;
  } | null;
  creatingInstance: InstanceCreationDraft | null;
  groupSearch: GroupSearchDraft | null;
  destructiveConfirmation: DestructiveConfirmation | null;
  exitConfirmation: boolean;
  paused: boolean;
  pendingOperation: { label: string; startedAt: number } | null;
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
  section: 'instance' | 'channels' | 'conversation';
  input: 'text' | 'toggle' | 'select';
  multiline?: boolean;
  options?: readonly string[];
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
}

export interface ManagementViewActions {
  createInstance?(input: NewInstanceInput): Promise<ViewInstance>;
  startInstance?(instance: ViewInstance): Promise<void>;
  afterSettingApplied?(instance: ViewInstance, entry: SettingEntry): Promise<string | void>;
  afterConversationAdded?(instance: ViewInstance, conversation: Conversation): Promise<string | void>;
  searchGroups?(instance: ViewInstance, query: string): Promise<ChannelGroupCandidate[]>;
  deleteInstance?(instance: ViewInstance): Promise<void>;
  deleteConversation?(instance: ViewInstance, conversationId: string): Promise<void>;
  sendToAgent?(instance: ViewInstance, conversationId: string, text: string): Promise<void>;
  readAgentTranscript?(instance: ViewInstance, conversationId: string): AgentTranscript;
}

interface DestructiveConfirmation {
  kind: 'instance' | 'conversation';
  instanceName: string;
  conversationId: string | null;
  label: string;
}

type InstanceCreationStep = 'instance' | 'cwd' | 'name';

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

const BRACKETED_PASTE_START = '\u001b[200~';
const BRACKETED_PASTE_END = '\u001b[201~';
const CTRL_C = '\u0003';
const CTRL_V_KEY = '\u0016';
const EDITING_COPY_NOTICE = '已复制输入内容到剪贴板，可用 Ctrl+V 粘贴';
let editingClipboard = '';

function formatViewTime(date: Date = new Date()): string {
  const m = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${m(date.getMonth() + 1)}-${m(date.getDate())} ${m(date.getHours())}:${m(date.getMinutes())}:${m(date.getSeconds())}`;
}

export function renderFrameDiff(previous: string, next: string, forceFull = false): string {
  if (forceFull || previous === '') return `\u001b[H\u001b[2J${next}`;
  if (previous === next) return '';
  const previousLines = previous.split('\n');
  const nextLines = next.split('\n');
  const rowCount = Math.max(previousLines.length, nextLines.length);
  let output = '';
  for (let index = 0; index < rowCount; index += 1) {
    const previousLine = previousLines[index] ?? '';
    const nextLine = nextLines[index] ?? '';
    if (previousLine === nextLine) continue;
    output += `\u001b[${index + 1};1H\u001b[2K${nextLine}`;
  }
  return output;
}

export function createManagementViewState(): ManagementViewState {
  return {
    tab: 'overview',
    selectedInstance: 0,
    instanceFocus: 'settings',
    selectedChannel: 0,
    selectedConversation: 0,
    selectedConversationId: null,
    selectedChannelItem: 0,
    selectedSetting: 0,
    detailInstanceName: null,
    detailChannel: null,
    detailConversationId: null,
    conversationDetailFocus: 'settings',
    selectedMember: 0,
    selectedMessage: 0,
    selectedMessageSequence: null,
    settingsInstanceName: null,
    editing: null,
    creatingInstance: null,
    groupSearch: null,
    destructiveConfirmation: null,
    exitConfirmation: false,
    paused: false,
    pendingOperation: null,
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

export async function bindHostToInteractiveView(
  once: boolean,
  instance: ViewInstance,
  stopExternal: (instance: ViewInstance) => Promise<unknown>,
  startManaged: (instance: ViewInstance) => void,
): Promise<void> {
  if (once) {
    instance.hostOwnership = 'readonly';
    return;
  }
  if (!shouldStartHostForView(false, instance.store.status())) {
    instance.hostOwnership = 'attached';
    await stopExternal(instance);
  }
  instance.hostOwnership = 'readonly';
  startManaged(instance);
}

export function shouldUseColor(isTTY: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return isTTY && env.NO_COLOR === undefined && env.TERM !== 'dumb';
}

export function renderPendingOperation(
  lastStableFrame: string,
  operation: { label: string; startedAt: number },
  width: number,
  height: number,
  frame: number,
  color = false,
  now = Date.now(),
): string {
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][frame % 10]!;
  const elapsedSeconds = Math.max(0, (now - operation.startedAt) / 1_000).toFixed(1);
  const safeWidth = Math.max(1, width);
  const baseLines = lastStableFrame.split('\n').slice(0, Math.max(1, height - 3));
  const status = truncate(`${spinner} 处理中：${operation.label}  已用时 ${elapsedSeconds}s`, safeWidth);
  const hint = truncate('操作在后台串行执行；为避免重复提交，输入已暂时锁定，完成后自动刷新。', safeWidth);
  return [
    ...baseLines,
    ansi('─'.repeat(Math.min(safeWidth, 120)), 'cyan', color),
    ansi(status, 'yellow-bold', color),
    ansi(hint, 'dim', color),
  ].join('\n');
}

export async function runView(
  instances: ViewInstance[],
  options: ViewOptions,
  actions: ManagementViewActions = {},
): Promise<void> {
  assertInteractiveView(options);
  const requiredTools = await inspectRequiredTools(instances);
  if (options.once) {
    process.stdout.write(`${renderStatusView(instances, options.showContent, process.stdout.columns ?? 120, requiredTools)}\n`);
    return;
  }

  const state = createManagementViewState();
  let rawMode = false;
  let alternateScreen = false;
  let timer: NodeJS.Timeout | null = null;
  let progressTimer: NodeJS.Timeout | null = null;
  let inputBusy = false;
  let progressFrame = 0;
  let lastStableFrame = '';
  let displayedFrame = '';
  let terminalSize = `${process.stdout.columns ?? 120}x${process.stdout.rows ?? 30}`;
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
    const selectedId = state.selectedConversationId;
    const detailId = state.detailConversationId ?? selectedId;
    const detail = detailInstance && detailId ? detailInstance.store.conversationDetail(detailId, options.showContent) : null;
    const settingsInstance = state.settingsInstanceName
      ? instances.find((instance) => instance.name === state.settingsInstanceName) ?? null
      : null;
    const settings = settingsInstance
      ? createSettingEntries(
        settingsInstance.config,
        settingsInstance.store,
        null,
        settingsInstance.configFile,
      )
      : [];
    const agentTranscript = state.editing?.purpose === 'agent-input' && detailInstance && state.editing.conversationId
      ? actions.readAgentTranscript?.(detailInstance, state.editing.conversationId) ?? null
      : null;
    return renderManagementView(
      instances,
      state,
      detail,
      settings,
      process.stdout.columns ?? 120,
      options.showContent,
      color,
      process.stdout.rows ?? 30,
      requiredTools,
      agentTranscript,
    );
  };
  const writeFrame = (frame: string) => {
    const nextTerminalSize = `${process.stdout.columns ?? 120}x${process.stdout.rows ?? 30}`;
    const output = renderFrameDiff(displayedFrame, frame, nextTerminalSize !== terminalSize);
    terminalSize = nextTerminalSize;
    displayedFrame = frame;
    if (output) process.stdout.write(output);
  };
  const paint = () => {
    lastStableFrame = render();
    writeFrame(lastStableFrame);
  };
  const paintProgress = () => {
    if (!state.pendingOperation) return;
    writeFrame(renderPendingOperation(
      lastStableFrame,
      state.pendingOperation,
      process.stdout.columns ?? 120,
      process.stdout.rows ?? 30,
      progressFrame,
      color,
    ));
    progressFrame += 1;
  };
  const repaint = (fromInput = false) => {
    if (stopRequested || inputBusy || (state.paused && !fromInput)) return;
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
    const handling = handleManagementViewInput(chunk.toString('utf8'), state, instances, requestStop, actions);
    if (state.pendingOperation) {
      progressFrame = 0;
      paintProgress();
    }
    void handling
      .catch((error) => { state.notice = (error as Error).message; })
      .finally(() => {
        inputBusy = false;
        repaint(true);
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
    progressTimer = setInterval(() => {
      if (inputBusy && state.pendingOperation) paintProgress();
    }, 120);
    await stopped;
    if (renderFailure) throw renderFailure;
  } finally {
    if (timer) clearInterval(timer);
    if (progressTimer) clearInterval(progressTimer);
    process.stdin.removeListener('data', onData);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (rawMode) process.stdin.setRawMode?.(false);
    process.stdin.pause();
    if (alternateScreen) process.stdout.write(VIEW_ALTERNATE_SCREEN_EXIT);
  }
}

export async function inspectRequiredTools(instances: ViewInstance[]): Promise<RequiredToolStatus[]> {
  const dwsCommands = uniqueCommands(instances.map((instance) => instance.config.channel.command), 'dws');
  const codexCommands = uniqueCommands(instances.map((instance) => instance.config.runtime.command), 'codex');
  const [dws, codex] = await Promise.all([
    inspectExternalTool('DWS', dwsCommands),
    inspectExternalTool('Codex CLI', codexCommands),
  ]);
  return [
    { tool: 'Node.js', state: 'ready', version: process.version, command: process.execPath, error: null },
    dws,
    codex,
  ];
}

function uniqueCommands(commands: string[], fallback: string): string[] {
  return [...new Set(commands.length > 0 ? commands : [fallback])];
}

async function inspectExternalTool(
  tool: 'DWS' | 'Codex CLI',
  commands: string[],
): Promise<RequiredToolStatus> {
  try {
    const versions = await Promise.all(commands.map(async (command) => {
      const resolved = await resolveCommand(command);
      const result = await execResolved(resolved, ['--version'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 5_000, windowsHide: true,
      });
      return result.stdout.trim().split(/\r?\n/, 1)[0] || 'unknown';
    }));
    return { tool, state: 'ready', version: [...new Set(versions)].join(' / '), command: commands.join(' / '), error: null };
  } catch (error) {
    return {
      tool, state: 'error', version: '-', command: commands.join(' / '),
      error: truncate(error instanceof Error ? error.message.replace(/\s+/g, ' ') : String(error), 100),
    };
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
      await withPendingOperation(state, `删除 Instance ${confirmation.label}`, () => actions.deleteInstance!(target));
      const index = instances.indexOf(target);
      if (index >= 0) instances.splice(index, 1);
      state.detailInstanceName = null;
      state.detailChannel = null;
      state.detailConversationId = null;
      state.selectedConversationId = null;
      state.settingsInstanceName = null;
      state.selectedInstance = instances.length === 0 ? 0 : Math.min(index, instances.length - 1);
      state.notice = `Instance ${confirmation.label} 已删除`;
    } else {
      if (!confirmation.conversationId) throw new Error('删除目标缺少 conversation ID');
      if (!actions.deleteConversation) throw new Error('当前 View 入口未提供 Conversation 删除能力');
      await withPendingOperation(
        state,
        `删除 Conversation ${confirmation.label}`,
        () => actions.deleteConversation!(target, confirmation.conversationId!),
      );
      state.detailConversationId = null;
      state.settingsInstanceName = null;
      const remaining = target.store.listConversations();
      state.selectedConversation = clamp(state.selectedConversation, 0, Math.max(0, remaining.length - 1));
      state.selectedConversationId = remaining[state.selectedConversation]?.id ?? null;
      if (state.detailChannel) {
        state.selectedChannelItem = clamp(
          state.selectedChannelItem,
          0,
          Math.max(0, channelManagementItems(target, state.detailChannel).length - 1),
        );
      }
      state.notice = `Conversation ${confirmation.label} 已删除`;
    }
    state.destructiveConfirmation = null;
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
    const isMultiline = Boolean(state.editing.multiline);
    if (key === '\u001b') {
      const wasAgentInput = state.editing.purpose === 'agent-input';
      state.editing = null;
      state.notice = wasAgentInput ? '已关闭真人介入页面' : '已取消修改';
      return;
    }
    if (state.editing.purpose === 'agent-input' && (key === '\u001b[5~' || key === '\u001b[6~')) {
      const direction = key === '\u001b[5~' ? 6 : -6;
      state.editing.timelineScroll = Math.max(0, (state.editing.timelineScroll ?? 0) + direction);
      return;
    }
    if (isSaveKey(key, isMultiline)) {
      const editingInstance = settingsInstance ?? detailInstance;
      if (!editingInstance) throw new Error('没有可配置的 instance');
      if (state.editing.purpose === 'agent-input') {
        if (!actions.sendToAgent || !state.editing.conversationId) {
          throw new Error('当前 View 入口未提供发送给 Agent 的能力');
        }
        const text = state.editing.value;
        await withPendingOperation(
          state,
          `发送消息给 ${state.editing.label}`,
          () => actions.sendToAgent!(editingInstance, state.editing!.conversationId!, text),
        );
        state.editing.value = '';
        state.editing.cursor = 0;
        state.editing.timelineScroll = 0;
        state.notice = '消息已进入当前会话的 Agent inbox';
        return;
      }
      const selectedId = state.detailConversationId;
      const entry = createSettingEntries(
        editingInstance.config,
        editingInstance.store,
        selectedId,
        editingInstance.configFile,
      )
        .find((item) => item.key === state.editing!.key);
      if (!entry) throw new Error('设置项已变化，请重新选择');
      const editingValue = state.editing.value;
      const actionNotice = await applySettingWithProgress(
        state, editingInstance, entry, editingValue, actions,
      );
      state.notice = actionNotice ?? `${entry.label} 已保存`;
      state.editing = null;
      return;
    }
    if (key === CTRL_C) {
      if (isMultiline) {
        state.notice = copyEditingValue(state.editing.value);
      } else {
        state.exitConfirmation = true;
      }
      return;
    }
    if (isMultiline && key === CTRL_V_KEY) {
      if (editingClipboard === '') {
        state.notice = '剪贴板为空，无法粘贴';
        return;
      }
      editSingleLine(state.editing, editingClipboard, { multiline: true });
      state.notice = '已粘贴';
      return;
    }
    const insertedText = extractInsertedText(key);
    if (insertedText !== null) {
      editSingleLine(state.editing, insertedText, { multiline: isMultiline });
      return;
    }
    editSingleLine(state.editing, key, { multiline: isMultiline });
    return;
  }
  if (key === CTRL_C) {
    state.exitConfirmation = true;
    return;
  }

  if (state.paused) {
    if (key.toLowerCase() === 'p') {
      state.paused = false;
      state.notice = '已恢复实时刷新';
    } else if (key.toLowerCase() === 'q') {
      state.exitConfirmation = true;
    }
    return;
  }
  if (key.toLowerCase() === 'p') {
    state.paused = true;
    state.notice = null;
    return;
  }

  if (key.toLowerCase() === 'q') {
    state.exitConfirmation = true;
    return;
  }
  if (state.detailConversationId && detailInstance && !state.settingsInstanceName) {
    if (key === '\t') {
      state.conversationDetailFocus = state.conversationDetailFocus === 'settings'
        ? 'messages'
        : state.conversationDetailFocus === 'messages' ? 'members' : 'settings';
      return;
    }
    const detailSnapshot = detailInstance.store.conversationDetail(state.detailConversationId);
    if (detailSnapshot && moveConversationDetailSelection(state, detailInstance, detailSnapshot, key)) return;
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
      state.instanceFocus = 'settings';
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
    if (state.detailConversationId) {
      state.conversationDetailFocus = 'settings';
      state.selectedSetting = 0;
      state.notice = null;
      return;
    }
    state.instanceFocus = 'settings';
    state.selectedSetting = 0;
    state.notice = null;
    return;
  }
  if (state.tab === 'overview' && state.detailConversationId && detailInstance && key.toLowerCase() === 'e') {
    state.conversationDetailFocus = 'settings';
    state.selectedSetting = 0;
    state.notice = null;
    return;
  }
  if (state.tab === 'overview' && state.detailConversationId && detailInstance && key.toLowerCase() === 'i') {
    const conversation = detailInstance.store.getConversation(state.detailConversationId);
    if (!conversation) throw new Error('Conversation 已不存在');
    state.editing = {
      key: `agent-input:${conversation.id}`,
      label: `发送给 Agent · ${conversation.title}`,
      value: '',
      cursor: 0,
      multiline: true,
      purpose: 'agent-input',
      conversationId: conversation.id,
      timelineScroll: 0,
    };
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
    if (state.detailChannel && detailInstance) {
      const item = channelManagementItems(detailInstance, state.detailChannel)[state.selectedChannelItem];
      if (item?.kind === 'conversation') {
        state.destructiveConfirmation = {
          kind: 'conversation', instanceName: detailInstance.name,
          conversationId: item.conversation.id, label: item.conversation.title,
        };
      }
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
  if (detailInstance && !state.detailChannel && !state.settingsInstanceName
    && (key === '\u001b[H' || key === '\u001b[F')) {
    if (state.instanceFocus === 'settings') {
      state.selectedSetting = key === '\u001b[H' ? 0 : Math.max(0, instanceSettingEntries(detailInstance).length - 1);
    } else if (state.instanceFocus === 'channels') {
      state.selectedChannel = key === '\u001b[H' ? 0 : Math.max(0, configuredChannels(detailInstance.config).length - 1);
    } else {
      const conversations = detailInstance.store.listConversations();
      state.selectedConversation = key === '\u001b[H' ? 0 : Math.max(0, conversations.length - 1);
      state.selectedConversationId = conversations[state.selectedConversation]?.id ?? null;
    }
    return;
  }
  const direction = key === '\u001b[A' || key.toLowerCase() === 'k' ? -1
    : key === '\u001b[B' || key.toLowerCase() === 'j' ? 1
      : key === '\u001b[5~' ? -6
        : key === '\u001b[6~' ? 6 : 0;
  if (direction !== 0) {
    if (state.tab === 'overview') {
      if (state.settingsInstanceName) {
        const total = settingsInstance
          ? createSettingEntries(
            settingsInstance.config,
            settingsInstance.store,
            null,
            settingsInstance.configFile,
          ).length
          : 0;
        state.selectedSetting = clamp(state.selectedSetting + direction, 0, Math.max(0, total - 1));
      } else if (!state.detailInstanceName) {
        state.selectedInstance = clamp(state.selectedInstance + direction, 0, instances.length);
        state.instanceFocus = 'settings';
        state.selectedChannel = 0;
        state.selectedConversation = 0;
        state.selectedConversationId = null;
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
      if (state.detailConversationId && detailInstance && state.conversationDetailFocus === 'settings') {
        const entries = conversationSettingEntries(detailInstance, state.detailConversationId);
        const entry = entries[state.selectedSetting];
        if (!entry) return;
        if (entry.input === 'toggle') {
          const next = entry.value === 'enabled' ? 'disabled' : 'enabled';
          const actionNotice = await applySettingWithProgress(state, detailInstance, entry, next, actions);
          state.notice = actionNotice ?? `${entry.label} 已切换为 ${next}`;
          return;
        }
        if (entry.input === 'select') {
          const next = nextOption(entry);
          const actionNotice = await applySettingWithProgress(state, detailInstance, entry, next, actions);
          state.notice = actionNotice ?? `${entry.label} 已选择 ${next}`;
          return;
        }
      state.editing = {
        key: entry.key,
        label: entry.label,
        value: entry.value,
        cursor: textLength(entry.value),
        multiline: entry.multiline,
      };
        return;
      }
      if (detailInstance && !state.detailChannel && !state.detailConversationId && state.instanceFocus === 'settings') {
        const entry = instanceSettingEntries(detailInstance)[state.selectedSetting];
        if (!entry) return;
        await activateSettingEntry(state, detailInstance, entry, actions);
        return;
      }
      if (state.settingsInstanceName) {
        if (!settingsInstance) return;
        const entry = createSettingEntries(
          settingsInstance.config,
          settingsInstance.store,
          null,
          settingsInstance.configFile,
        )[state.selectedSetting];
        if (!entry) return;
        if (entry.input === 'toggle') {
          const next = entry.value === 'enabled' ? 'disabled' : 'enabled';
          const actionNotice = await applySettingWithProgress(state, settingsInstance, entry, next, actions);
          state.notice = actionNotice ?? `${entry.label} 已切换为 ${next}`;
          return;
        }
        if (entry.input === 'select') {
          const next = nextOption(entry);
          const actionNotice = await applySettingWithProgress(state, settingsInstance, entry, next, actions);
          state.notice = actionNotice ?? `${entry.label} 已选择 ${next}`;
          return;
        }
        state.editing = {
          key: entry.key,
          label: entry.label,
          value: entry.value,
          cursor: textLength(entry.value),
          multiline: entry.multiline,
        };
        return;
      }
      if (!state.detailInstanceName) {
        if (state.selectedInstance >= instances.length) {
          startInstanceCreation(state, actions);
          return;
        }
        if (!overviewInstance) return;
        state.detailInstanceName = overviewInstance.name;
        state.instanceFocus = 'settings';
        state.selectedChannel = 0;
        state.selectedConversation = 0;
        state.selectedConversationId = null;
      } else if (state.detailChannel) {
        if (!detailInstance) return;
        await activateChannelItem(state, detailInstance, actions);
      } else {
        if (!detailInstance) return;
        if (state.instanceFocus === 'settings') {
          return;
        } else if (state.instanceFocus === 'channels') {
          const channel = configuredChannels(detailInstance.config)[state.selectedChannel];
          if (!channel) return;
          state.detailChannel = {
            instanceName: detailInstance.name,
            channelId: channel.id,
            profileId: channel.profileId,
          };
          state.selectedChannelItem = 0;
        } else {
          state.detailConversationId = state.selectedConversationId;
          state.conversationDetailFocus = 'settings';
          state.selectedMember = 0;
          state.selectedMessage = 0;
          state.selectedMessageSequence = null;
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
    const next = entry.value === 'enabled' ? 'disabled' : 'enabled';
    const actionNotice = await applySettingWithProgress(state, instance, entry, next, actions);
    state.notice = actionNotice ?? `${entry.label} 已切换为 ${next}`;
    return;
  }
  if (item.kind === 'groups-subscription' || item.kind === 'directs-subscription') {
    const kind = item.kind === 'groups-subscription' ? 'groups' : 'directs';
    const entry = createChannelSubscriptionSettingEntry(instance.config, instance.store, target, kind, instance.configFile);
    const current = CHANNEL_SUBSCRIPTION_MODES.indexOf(entry.value as ChannelSubscriptionMode);
    const next = CHANNEL_SUBSCRIPTION_MODES[(current + 1) % CHANNEL_SUBSCRIPTION_MODES.length]!;
    const actionNotice = await applySettingWithProgress(state, instance, entry, next, actions);
    state.notice = actionNotice ?? `${entry.label} 已切换为 ${next}`;
    return;
  }
  if (item.kind === 'groups-default-mode' || item.kind === 'directs-default-mode') {
    const kind = item.kind === 'groups-default-mode' ? 'groups' : 'directs';
    const entry = createChannelDefaultModeSettingEntry(instance.config, instance.store, target, kind, instance.configFile);
    const next = nextOption(entry);
    const actionNotice = await applySettingWithProgress(state, instance, entry, next, actions);
    state.notice = actionNotice ?? `${entry.label} 已选择 ${next}`;
    return;
  }
  if (item.kind === 'conversation') {
    state.detailConversationId = item.conversation.id;
    state.selectedConversationId = item.conversation.id;
    state.conversationDetailFocus = 'settings';
    state.selectedMember = 0;
    state.selectedMessage = 0;
    state.selectedMessageSequence = null;
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
    const candidates = await withPendingOperation(
      state,
      `搜索群组“${query}”`,
      () => actions.searchGroups!(instance, query),
    );
    draft.results = candidates.filter((candidate) => {
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
  let added = false;
  if (!conversation) {
    try {
      conversation = instance.store.addConversation({
        channelId: draft.target.channelId,
        channelProfileId: draft.target.profileId,
        kind: 'group',
        externalId: candidate.externalId,
        title: candidate.title,
        responsibility: '',
        mode: instance.config.channel.defaultModes.groups,
        runtimeId: instance.config.runtime.id,
      });
      added = true;
      state.notice = `已绑定群组“${candidate.title}”；会话职责未配置，模式为 ${instance.config.channel.defaultModes.groups}`;
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
  state.selectedConversationId = conversation.id;
  state.conversationDetailFocus = 'settings';
  state.selectedMember = 0;
  state.selectedMessage = 0;
  state.selectedMessageSequence = null;
  const index = instance.store.listConversations().findIndex((item) => item.id === conversation!.id);
  state.selectedConversation = Math.max(0, index);
  if (added) {
    const notice = await withPendingOperation(state, `加载群聊“${conversation.title}”的最近消息`, () => (
      actions.afterConversationAdded?.(instance, conversation!) ?? Promise.resolve()
    ));
    if (notice) state.notice = notice;
  }
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
  }

  if (!actions.createInstance) throw new Error('当前 View 入口未提供 instance 创建能力');
  const input = draft.values as NewInstanceInput;
  const created = await withPendingOperation(state, `创建 Instance ${input.instance}`, async () => {
    const next = await actions.createInstance!(input);
    await actions.startInstance?.(next);
    return next;
  });
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
  state.notice = `Instance ${created.name} 已创建；Channel 默认 disabled，可在当前页确认后启用`;
}

function startInstanceCreation(state: ManagementViewState, actions: ManagementViewActions): void {
  if (!actions.createInstance) throw new Error('当前 View 入口未提供 instance 创建能力');
  state.creatingInstance = { step: 'instance', values: {}, value: '', cursor: 0 };
  state.notice = null;
}

function creationStepLabel(step: InstanceCreationStep): string {
  return ({ instance: 'Instance 名称', cwd: 'Runtime cwd', name: 'Agent 名称' })[step];
}

export function createSettingEntries(
  config: HostConfig,
  store: Store,
  conversationId: string | null,
  configFile?: string,
): SettingEntry[] {
  const entries: SettingEntry[] = [
    configSetting('identity.name', 'Agent 名称', config.identity.name, '仅用于本地展示', config, store, configFile, (next, value) => {
      if (!value.trim()) throw new Error('Agent 名称不能为空');
      next.identity.name = value.trim();
    }),
    restartSetting(configSetting('runtime.cwd', 'Runtime cwd', config.runtime.cwd, 'Runtime 工作目录；已有 session cwd 不兼容时拒绝恢复', config, store, configFile, (next, value) => {
      if (!value.trim()) throw new Error('Runtime cwd 不能为空');
      next.runtime.cwd = resolve(value.trim());
    })),
    configSetting('runtime.model', 'Runtime 模型', config.runtime.model, '下一 turn；attach 模式建议重启', config, store, configFile, (next, value) => {
      if (!value.trim()) throw new Error('Runtime 模型不能为空');
      next.runtime.model = value.trim();
    }),
    selectSetting(configSetting('runtime.effort', '推理强度', config.runtime.effort, '从固定候选值选择', config, store, configFile, (next, value) => {
      next.runtime.effort = value.trim() as HostConfig['runtime']['effort'];
    }), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
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
    },
  );
  enabledEntry.input = 'toggle';
  enabledEntry.restartHost = conversation.kind === 'group' && !conversation.enabled;
  entries.push(
    storeSetting(`conversation:${conversationId}:title`, `会话名称 · ${conversation.title}`, conversation.title, '仅修改本地显示名称', async (value) => {
      if (!store.setConversationTitle(conversationId, value)) throw new Error('conversation 不存在');
    }),
    enabledEntry,
    storeSetting(
      `conversation:${conversationId}:responsibility`,
      `会话职责 · ${conversation.title}`,
      conversation.responsibility,
      '首轮、变更后首轮及按会话间隔提醒；留空沿用 Agent 自身职责',
      async (value) => {
        if (typeof value !== 'string') throw new Error('conversation responsibilities must be text');
        if (!store.setConversationResponsibility(conversationId, value)) throw new Error('conversation 不存在');
      },
      'conversation',
      true,
    ),
    storeSetting(
      `conversation:${conversationId}:responsibilityReminderInterval`,
      `职责周期提醒(turn) · ${conversation.title}`,
      String(conversation.responsibilityReminderInterval),
      '0 关闭周期提醒；1-99 表示每 N 个已完成 turn',
      async (value) => {
        if (!store.setResponsibilityReminderInterval(
          conversationId,
          integer(value, 0, MAX_RESPONSIBILITY_REMINDER_INTERVAL, '职责周期提醒间隔'),
        )) throw new Error('conversation 不存在');
      },
    ),
    selectSetting(storeSetting(`conversation:${conversationId}:mode`, `会话模式 · ${conversation.title}`, conversation.mode, '从 shadow/reply 选择；发送前即时生效', async (value) => {
      if (value !== 'shadow' && value !== 'reply') throw new Error('会话模式必须是 shadow 或 reply');
      if (!store.setConversationMode(conversationId, value)) throw new Error('conversation 不存在');
    }), CONVERSATION_MODES),
    storeSetting(
      `conversation:${conversationId}:warm`, `Worker 保温秒数 · ${conversation.title}`, String(conversation.workerWarmSeconds),
      `0-${MAX_WORKER_WARM_SECONDS}；下一次 idle`, async (value) => {
        if (!store.setWorkerWarmSeconds(conversationId, integer(value, 0, MAX_WORKER_WARM_SECONDS, 'Worker 保温秒数'))) {
          throw new Error('conversation 不存在');
        }
      },
    ),
  );
  return entries;
}

function conversationSettingEntries(instance: ViewInstance, conversationId: string): SettingEntry[] {
  return createSettingEntries(instance.config, instance.store, conversationId, instance.configFile)
    .filter((entry) => entry.section === 'conversation');
}

function instanceSettingEntries(instance: ViewInstance): SettingEntry[] {
  return createSettingEntries(instance.config, instance.store, null, instance.configFile)
    .filter((entry) => entry.section === 'instance');
}

async function activateSettingEntry(
  state: ManagementViewState,
  instance: ViewInstance,
  entry: SettingEntry,
  actions: ManagementViewActions,
): Promise<void> {
  if (entry.input === 'toggle') {
    const next = entry.value === 'enabled' ? 'disabled' : 'enabled';
    const actionNotice = await applySettingWithProgress(state, instance, entry, next, actions);
    state.notice = actionNotice ?? `${entry.label} 已切换为 ${next}`;
    return;
  }
  if (entry.input === 'select') {
    const next = nextOption(entry);
    const actionNotice = await applySettingWithProgress(state, instance, entry, next, actions);
    state.notice = actionNotice ?? `${entry.label} 已选择 ${next}`;
    return;
  }
  state.editing = {
    key: entry.key,
    label: entry.label,
    value: entry.value,
    cursor: textLength(entry.value),
    multiline: entry.multiline,
  };
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

export function createChannelDefaultModeSettingEntry(
  config: HostConfig,
  store: Store,
  target: Pick<ChannelTarget, 'channelId' | 'profileId'>,
  kind: 'groups' | 'directs',
  configFile?: string,
): SettingEntry {
  const channel = configuredChannels(config)
    .find((item) => item.id === target.channelId && item.profileId === target.profileId);
  if (!channel) throw new Error(`Channel 不存在：${target.channelId}/${target.profileId}`);
  const label = kind === 'groups' ? '群聊默认模式' : '私聊默认模式';
  const entry = selectSetting(configSetting(
    `channel:${channel.id}:${channel.profileId}:defaultModes:${kind}`,
    label,
    channel.defaultModes[kind],
    '只影响之后新建且未显式指定模式的 Conversation',
    config,
    store,
    configFile,
    (next, value) => {
      if (!CONVERSATION_MODES.includes(value as ConversationMode)) {
        throw new Error('默认模式必须是 shadow 或 reply');
      }
      next.channel.defaultModes[kind] = value as ConversationMode;
    },
  ), CONVERSATION_MODES);
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
  }, 'instance');
}

function storeSetting(
  key: string,
  label: string,
  value: string,
  hint: string,
  apply: (value: string) => Promise<void>,
  section: SettingEntry['section'] = 'conversation',
  multiline = false,
): SettingEntry {
  return {
    key,
    section,
    input: 'text',
    label,
    value,
    hint,
    restartHost: false,
    apply,
    multiline,
  };
}

function selectSetting(entry: SettingEntry, options: readonly string[]): SettingEntry {
  return { ...entry, input: 'select', options };
}

function restartSetting(entry: SettingEntry): SettingEntry {
  return { ...entry, restartHost: true };
}

async function withPendingOperation<T>(
  state: ManagementViewState,
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (state.pendingOperation) throw new Error(`已有操作正在处理：${state.pendingOperation.label}`);
  state.pendingOperation = { label, startedAt: Date.now() };
  try {
    return await operation();
  } finally {
    state.pendingOperation = null;
  }
}

function applySettingWithProgress(
  state: ManagementViewState,
  instance: ViewInstance,
  entry: SettingEntry,
  value: string,
  actions: ManagementViewActions,
): Promise<string | void> {
  return withPendingOperation(state, `应用 ${entry.label}`, async () => {
    await entry.apply(value);
    return actions.afterSettingApplied?.(instance, entry);
  });
}

function nextOption(entry: SettingEntry): string {
  if (!entry.options || entry.options.length === 0) throw new Error(`${entry.label} 缺少候选值`);
  const current = entry.options.indexOf(entry.value);
  return entry.options[(current + 1) % entry.options.length]!;
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
  height = 30,
  requiredTools: RequiredToolStatus[] = [],
  agentTranscript: AgentTranscript | null = null,
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
    `${ansi(CLI_NAME, 'cyan-bold', color)} v${PRODUCT_VERSION}  instances=${instances.length}  running=${ansi(String(running), running > 0 ? 'green-bold' : 'dim', color)}  ${state.paused ? ansi('PAUSED', 'yellow-bold', color) : ansi(`refreshed=${formatViewTime()}`, 'dim', color)}`,
    tabs,
    ansi('─'.repeat(Math.min(width, 120)), 'dim', color),
  ];
  if (state.editing?.purpose === 'agent-input') {
    lines.push(...renderAgentInputPanel(state.editing, agentTranscript, width, Math.max(10, height - 6), color));
  }
  else if (state.editing) lines.push(...renderEditingPanel(state.editing, width, color));
  else if (state.tab === 'settings') lines.push(...renderGlobalSettings(instances, width, color));
  else if (state.groupSearch && detailInstance) lines.push(...renderGroupSearch(detailInstance, state.groupSearch, width, color));
  else if (settingsInstance) {
    state.selectedSetting = clamp(state.selectedSetting, 0, Math.max(0, settings.length - 1));
    lines.push(...renderInstanceSettings(settingsInstance, detail, settings, state, width, color));
  }
  else if (state.detailConversationId) lines.push(...renderConversationDetail(detailInstance, detail, state, width, height, color));
  else if (state.detailChannel && detailInstance) lines.push(...renderChannelManagement(detailInstance, state.detailChannel, state, width, color));
  else if (detailInstance) lines.push(...renderInstanceOverview(detailInstance, detailInstance.store.status(showContent), state, width, height, color));
  else lines.push(...renderGlobalOverview(snapshots, state, width, color, requiredTools));
  const notice = state.notice ?? (settingsInstance ?? selectedInstance)?.notices.at(-1) ?? null;
  if (notice) lines.push('', ansi(`提示：${notice}`, 'yellow-bold', color));
  if (state.exitConfirmation) {
    const owned = instances.filter((instance) => instance.hostOwnership === 'view').length;
    lines.push(
      '',
      heading('退出确认', color),
      `退出 View 将停止全部 ${ansi(String(owned), owned > 0 ? 'yellow-bold' : 'dim', color)} 个由当前 View 管理的 Host。`,
    );
  }
  if (state.destructiveConfirmation) {
    const confirmation = state.destructiveConfirmation;
    const target = instances.find((instance) => instance.name === confirmation.instanceName);
    lines.push('', heading('删除确认', color));
    if (confirmation.kind === 'instance') {
      lines.push(
        ansi(`将删除 Instance ${confirmation.label} 的配置、SQLite/WAL、recovery、日志和本地 session 映射。`, 'red-bold', color),
        `Host owner=${statusText(target?.hostOwnership ?? 'unknown', color)}；删除前会停止当前 View 管理的 Host。`,
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
    : state.paused
    ? ansi('显示已暂停，Host 仍在后台运行；可选中文字复制。p 恢复刷新  q 退出', 'yellow-bold', color)
    : state.creatingInstance
    ? ansi(`新增 Instance · ${creationStepLabel(state.creatingInstance.step)}：${renderTextCursor(state.creatingInstance.value, state.creatingInstance.cursor)}  ←/→ 移动  Enter 下一步  Esc 取消`, 'cyan-bold', color)
    : state.groupSearch?.phase === 'query'
      ? ansi(`群组搜索：${renderTextCursor(state.groupSearch.query, state.groupSearch.cursor)}  ←/→ 移动  Enter 搜索  Esc 返回 Channel`, 'cyan-bold', color)
      : state.groupSearch?.phase === 'results'
        ? ansi('↑/↓ 选择  →/Enter 绑定或打开  ←/Esc 修改关键词  q 退出', 'dim', color)
    : state.editing
      ? ansi(
        `${state.editing.purpose === 'agent-input' ? '真人介入' : `编辑 ${state.editing.label}`}  方向键移动  Home/End 行首尾  Ctrl+Home/End 全文首尾  Backspace/Delete 删除  Enter ${state.editing.purpose === 'agent-input' ? '发送' : '保存'}  ${state.editing.multiline
          ? `${state.editing.purpose === 'agent-input' ? 'PageUp/PageDown 浏览历史  ' : ''}Shift+Enter 换行  Esc ${state.editing.purpose === 'agent-input' ? '返回' : '取消'}  Ctrl+V 粘贴  Ctrl+C 复制`
          : 'Esc 取消'}`,
        'cyan-bold',
        color,
      )
      : state.tab === 'settings'
        ? ansi('Tab 切换总览  ←/Esc 返回总览  q 退出', 'dim', color)
        : state.settingsInstanceName
          ? ansi('↑/↓ 选择  →/Enter 编辑或选择下一项  ←/Esc 返回  q 退出', 'dim', color)
          : state.detailConversationId
            ? ansi('i 发送给 Agent  Tab 切换 CONVERSATION/MESSAGES/MEMBERS  ↑/↓ 选择或滚动  →/Enter 编辑设置  e/s 定位设置  d 删除  ←/Esc 返回  q 退出', 'dim', color)
            : state.detailChannel
              ? ansi('↑/↓ 选择  →/Enter 操作、选择下一项或下钻  d 删除会话  ←/Esc 返回 Instance  q 退出', 'dim', color)
          : state.detailInstanceName
            ? ansi('↑/↓ 选择  →/Enter 编辑或下钻  s 定位 INSTANCE 设置  d 删除 Instance  ←/Esc 返回  q 退出', 'dim', color)
            : ansi('↑/↓ 选择  →/Enter 下钻  a 新增  d 删除 Instance  Tab 全局设置  q 退出', 'dim', color));
  return fitFrame(lines, width, height);
}

function renderGlobalOverview(
  snapshots: Array<{ instance: ViewInstance; snapshot: Record<string, unknown> }>,
  state: ManagementViewState,
  width: number,
  color: boolean,
  requiredTools: RequiredToolStatus[],
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

  if (requiredTools.length > 0) lines.push('', ...renderRequiredTools(requiredTools, width, color));

  const alerts = snapshots.flatMap(({ instance, snapshot }) => tagRows(instance.name, snapshot.alerts));
  if (alerts.length > 0) {
    lines.push('', heading('ALERTS', color), ...alerts.map((row) => renderAlert(
      `${row.instance}/${text(row.scope)}/${text(row.target)}`,
      row.error,
      row.at,
      width,
      color,
    )));
  }
  return lines;
}

function renderRequiredTools(tools: RequiredToolStatus[], width: number, color: boolean): string[] {
  return [
    heading('TOOLS', color),
    ...table(
      ['TOOL', 'STATE', 'VERSION', 'COMMAND', 'ERROR'],
      tools.map((tool) => [tool.tool, tool.state, tool.version, tool.command, tool.error ?? '-']),
      width,
      semanticTable(color),
    ),
  ];
}

function renderInstanceOverview(
  instance: ViewInstance,
  snapshot: Record<string, unknown>,
  state: ManagementViewState,
  width: number,
  height: number,
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
  const settings = instanceSettingEntries(instance);
  state.selectedSetting = clamp(state.selectedSetting, 0, Math.max(0, settings.length - 1));
  const ancillaryPageSize = clamp(Math.floor((Math.max(20, height) - 27) / 4), 1, 4);
  const channelPageSize = Math.min(Math.max(1, channels.length), ancillaryPageSize);
  const runtimePageSize = Math.min(Math.max(1, runtimeAdapters.length), ancillaryPageSize);
  const ancillaryRows = Math.min(channels.length, channelPageSize) + Math.min(runtimeAdapters.length, runtimePageSize);
  const ancillaryHints = Number(channels.length > channelPageSize) + Number(runtimeAdapters.length > runtimePageSize);
  const conversationPageSize = clamp(
    Math.max(20, height) - 27 - ancillaryRows - ancillaryHints - Number(conversations.length > 1),
    1,
    8,
  );
  const channelWindow = viewportRows(channels, state.selectedChannel, channelPageSize);
  const conversationWindow = viewportRows(conversations, state.selectedConversation, conversationPageSize);
  const runtimeWindow = viewportRows(runtimeAdapters, 0, runtimePageSize);
  const host = object(snapshot.host);
  const lines = [
    `${heading(`实例详情 / ${instance.name}`, color)}  Agent=${instance.config.identity.name}  host=${statusText(text(host.state) ?? 'unknown', color)}  pid=${text(host.pid) ?? '-'}  ${statusText(instance.hostOwnership, color)}`,
    '', state.instanceFocus === 'settings' ? ansi('[ INSTANCE ]', 'cyan-bold', color) : heading('INSTANCE', color),
  ];
  lines.push(...table(
    ['', 'SETTING', 'VALUE', 'EFFECT'],
    settings.map((entry, index) => [
      state.instanceFocus === 'settings' && index === state.selectedSetting ? '>' : ' ', entry.label, entry.value || '(空)', entry.hint,
    ]),
    width,
    {
      separator: ' │ ', dividerSeparator: '─┼─', dividerFill: '─',
      decorate: tableDecorator(color, state.instanceFocus === 'settings' ? state.selectedSetting : -1, 1),
    },
  ));
  lines.push('', heading('CHANNELS', color));
  lines.push(...table(
    ['', 'CHANNEL', 'PROFILE', 'STATE', 'PID', 'LAST EVENT', 'ERROR'],
    channelWindow.rows.map((row, index) => [
      state.instanceFocus === 'channels' && channelWindow.start + index === state.selectedChannel ? '>' : ' ',
      row.channelId, row.profileId, row.state, row.pid, age(row.lastEventAt), row.error ?? '-',
    ]),
    width,
    semanticTable(color, state.instanceFocus === 'channels' ? state.selectedChannel - channelWindow.start : -1, 2),
  ));
  if (channelWindow.overflow) lines.push(ansi(viewportStatus(channelWindow), 'dim', color));
  lines.push('', heading('CONVERSATIONS', color));
  lines.push(...table(
    ['', 'CHANNEL', 'TITLE', 'MODE', 'PENDING', 'HISTORY', 'DELIVERY', 'WORKER', 'SESSION', 'RUNTIME'],
    conversationWindow.rows.map((row, index) => [
      state.instanceFocus === 'conversations' && conversationWindow.start + index === state.selectedConversation ? '>' : ' ', row.channelId, row.title, row.mode, row.pending,
      `${row.historyForwarded ?? 0}/${row.historyLoaded ?? 0}`, row.onboardingState ?? '-',
      row.workerState, row.sessionState, row.runtimeId,
    ]), width, semanticTable(color, state.instanceFocus === 'conversations' ? state.selectedConversation - conversationWindow.start : -1, 2),
  ));
  if (conversationWindow.overflow) lines.push(ansi(viewportStatus(conversationWindow), 'dim', color));
  lines.push('', heading('RUNTIMES', color));
  lines.push(...table(
    ['RUNTIME', 'LABEL', 'STATE', 'MODEL', 'RECOVERY', 'ERROR'],
    runtimeWindow.rows.map((row) => [row.runtimeId, row.label, row.state, row.model ?? '-', row.contextRecovery ?? '-', row.error ?? '-']),
    width,
    semanticTable(color),
  ));
  if (runtimeWindow.overflow) lines.push(ansi(viewportStatus(runtimeWindow), 'dim', color));
  return lines;
}

function renderAlert(target: string, error: unknown, at: unknown, width: number, color: boolean): string {
  const raw = text(error) ?? 'unknown';
  const summary = /Request is repeated with uuid\b/i.test(raw)
    ? 'delivery_unknown: duplicate_uuid'
    : /^Command failed:/i.test(raw)
      ? 'command_failed'
      : raw.replace(/\s+/g, ' ').trim();
  return ansi(truncate(`- ${target}: ${summary} (${age(at)})`, Math.max(20, width)), 'red-bold', color);
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
        [selected?.kind === 'groups-subscription' ? '>' : ' ', '群聊订阅', channel.subscriptions.groups, subscriptionEffect(channel.subscriptions.groups, '群聊')],
        [selected?.kind === 'groups-default-mode' ? '>' : ' ', '群聊默认模式', channel.defaultModes.groups, '只影响之后新建且未显式指定模式的群聊'],
        [selected?.kind === 'directs-subscription' ? '>' : ' ', '私聊订阅', channel.subscriptions.directs, subscriptionEffect(channel.subscriptions.directs, '私聊')],
        [selected?.kind === 'directs-default-mode' ? '>' : ' ', '私聊默认模式', channel.defaultModes.directs, '只影响之后新建且未显式指定模式的私聊'],
      ],
      width,
      {
        separator: ' │ ', dividerSeparator: '─┼─', dividerFill: '─',
        decorate: tableDecorator(color, [
          'enabled', 'groups-subscription', 'groups-default-mode', 'directs-subscription', 'directs-default-mode',
        ].indexOf(selected?.kind ?? ''), 2),
      },
    ),
    '', heading('GROUPS', color),
    ...table(
      ['', 'GROUP', 'STATE', 'MODE', 'RESPONSIBILITY', 'RUNTIME'],
      [
        ...groups.map((group) => [
          selected?.kind === 'conversation' && selected.conversation.id === group.id ? '>' : ' ', group.title,
          group.enabled ? 'enabled' : 'disabled', group.mode, displayResponsibility(group.responsibility), group.runtimeId,
        ]),
        [
          selected?.kind === 'search-group' ? '>' : ' ', '+ 搜索并绑定指定群聊', '-', channel.defaultModes.groups,
          '未配置（使用 Agent 自身职责）', instance.config.runtime.id,
        ],
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
        direct.enabled ? 'enabled' : 'disabled', direct.mode, displayResponsibility(direct.responsibility), direct.runtimeId,
      ]),
      width,
      semanticTable(color, selected?.kind === 'conversation'
        ? directs.findIndex((direct) => direct.id === selected.conversation.id)
        : -1, 2),
    ),
    ansi('指定私聊使用稳定 openDingTalkId 登记；事件能提供人员姓名时显示姓名，不按姓名猜测 ID。可用 conversation add 添加后在此管理。', 'dim', color),
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

function renderConversationDetail(
  instance: ViewInstance | null,
  detail: Record<string, unknown> | null,
  state: ManagementViewState,
  width: number,
  height: number,
  color: boolean,
): string[] {
  if (!detail || !instance) return [ansi('会话不存在或已删除', 'red-bold', color)];
  const conversation = object(detail.conversation);
  const session = object(detail.session);
  const worker = object(detail.worker);
  const context = object(detail.context);
  const members = array(detail.members);
  const messages = array(detail.messages);
  state.selectedMember = clamp(state.selectedMember, 0, Math.max(0, members.length - 1));
  const stableMessageIndex = state.selectedMessageSequence === null
    ? -1
    : messages.findIndex((row) => number(row.sequence) === state.selectedMessageSequence);
  state.selectedMessage = stableMessageIndex >= 0
    ? stableMessageIndex
    : clamp(state.selectedMessage, 0, Math.max(0, messages.length - 1));
  state.selectedMessageSequence = messages.length > 0 ? number(messages[state.selectedMessage]?.sequence) : null;
  const conversationId = text(conversation.id);
  const conversationSettings = conversationId ? conversationSettingEntries(instance, conversationId) : [];
  state.selectedSetting = clamp(state.selectedSetting, 0, Math.max(0, conversationSettings.length - 1));
  const pageSize = clamp(height - 25, 1, 8);
  const memberWindow = viewportRows(members, state.selectedMember, pageSize);
  const messageWindow = viewportRows(messages, state.selectedMessage, pageSize);
  const lines = [
    heading(`会话详情 / ${text(conversation.title) ?? '-'}`, color),
    `Channel ${text(conversation.channelId)}/${text(conversation.channelProfileId)}  kind=${text(conversation.kind)}  enabled=${statusText(text(conversation.enabled) ?? 'false', color)}`,
    `mode=${statusText(text(conversation.mode) ?? 'unknown', color)}  runtime=${text(conversation.runtimeId)}  policy=v${text(conversation.policyVersion)}  warm=${text(conversation.workerWarmSeconds)}s`,
    `Session ${statusText(text(session.lifecycle) ?? 'unprovisioned', color)}  id=${text(session.providerSessionPrefix) ?? '-'}  generation=${text(session.generation) ?? '-'}`,
    `Worker ${statusText(text(worker.state) ?? 'stopped', color)}  pid=${text(worker.processId) ?? '-'}  error=${errorText(text(worker.error) ?? '-', color)}`,
    ansi(`Checkpoint v${text(context.version) ?? '0'} @ seq ${text(context.throughSequence) ?? '0'}  facts=${text(context.facts) ?? '0'} decisions=${text(context.decisions) ?? '0'} commitments=${text(context.commitments) ?? '0'} open=${text(context.openQuestions) ?? '0'}`, 'cyan', color),
    '', state.conversationDetailFocus === 'settings' ? ansi('[ CONVERSATION ]', 'cyan-bold', color) : heading('CONVERSATION', color),
  ];
  lines.push(...table(
    ['', 'SETTING', 'VALUE', 'EFFECT'],
    conversationSettings.map((entry, index) => [
      state.conversationDetailFocus === 'settings' && index === state.selectedSetting ? '>' : ' ',
      entry.label.replace(` · ${text(conversation.title)}`, ''), entry.value || '(空)', entry.hint,
    ]),
    width,
    {
      separator: ' │ ', dividerSeparator: '─┼─', dividerFill: '─',
      decorate: tableDecorator(color, state.conversationDetailFocus === 'settings' ? state.selectedSetting : -1, 1),
    },
  ));
  const messagesHeading = state.conversationDetailFocus === 'messages'
    ? ansi('[ RECENT MESSAGES ]', 'cyan-bold', color)
    : heading('RECENT MESSAGES', color);
  const membersHeading = state.conversationDetailFocus === 'members'
    ? ansi('[ MEMBERS ]', 'cyan-bold', color)
    : heading('MEMBERS', color);
  const gap = 3;
  const panelWidth = Math.max(30, width - gap);
  const membersWidth = Math.max(12, Math.floor(panelWidth * 0.36));
  const messagesWidth = Math.max(18, panelWidth - membersWidth);
  const headers = ['', 'SEQ', 'SENDER', 'STATE', 'AGE', 'CONTENT'];
  const messageLines = [messagesHeading, ...table(headers, messageWindow.rows.map((row, index) => {
    const values: unknown[] = [
      state.conversationDetailFocus === 'messages' && messageWindow.start + index === state.selectedMessage ? '>' : ' ',
      row.sequence, row.sender, row.state, age(row.receivedAt), row.preview ?? '隐藏（--show-content）',
    ];
    return values;
  }), messagesWidth, { ...semanticTable(color, state.conversationDetailFocus === 'messages' ? state.selectedMessage - messageWindow.start : -1, 2), minimumWidth: 20 })];
  if (messageWindow.overflow) messageLines.push(ansi(viewportStatus(messageWindow), 'dim', color));
  const memberLines = [membersHeading, ...table(
    ['', 'NAME', 'ORG ROLE', 'CHANNEL ROLE', 'BOUNDARY'],
    memberWindow.rows.map((row, index) => [
      state.conversationDetailFocus === 'members' && memberWindow.start + index === state.selectedMember ? '>' : ' ',
      row.displayName, row.organizationRole || '-', row.conversationRole || '-', row.responsibilityBoundary || '-',
    ]),
    membersWidth,
    { ...semanticTable(color, state.conversationDetailFocus === 'members' ? state.selectedMember - memberWindow.start : -1, 2), minimumWidth: 20 },
  )];
  if (memberWindow.overflow) memberLines.push(ansi(viewportStatus(memberWindow), 'dim', color));
  lines.push('', ...sideBySide(messageLines, messagesWidth, memberLines, membersWidth, gap));
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
  return [
    heading('全局设置', color),
    ansi('作用域：当前 agent-channel-host View 及其管理的全部 Instances。', 'dim', color),
    '',
    ...table(
      ['SETTING', 'VALUE', 'SCOPE'],
      [
        ['Instances', instances.length, '全局只读状态'],
        ['View-owned Hosts', owned, '由当前 View 管理'],
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
    ansi(instance.hostOwnership === 'view'
        ? '当前 Host 由 view 启动；配置在后续 turn/batch 生效。'
        : '当前为一次性只读快照；未启动 Host。', instance.hostOwnership === 'view' ? 'yellow' : 'dim', color),
    `当前会话：${text(conversation.title) ?? '无（当前仅编辑 instance 配置）'}`,
  ];
  for (const section of ['instance', 'channels', 'conversation'] as const) {
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

export function renderStatusView(
  instances: ViewInstance[],
  showContent = false,
  width = 120,
  requiredTools: RequiredToolStatus[] = [],
): string {
  const state = createManagementViewState();
  const snapshots = instances.map((instance) => ({ instance, snapshot: instance.store.status(showContent) }));
  const lines = [
    `${CLI_NAME} view  v${PRODUCT_VERSION}  instances=${instances.length}  refreshed=${formatViewTime()}`,
    ...renderGlobalOverview(snapshots, state, width, false, requiredTools),
    '',
    '只读聚合快照；交互模式会逐 instance 启动或 attach Host，并从总览下钻详情与 Instance 设置',
  ];
  return fitFrame(lines, width);
}

function fitFrame(lines: string[], width: number, height?: number): string {
  const safeWidth = Math.max(1, width);
  const fitted = lines.flatMap((line) => wrapAnsiLine(line, safeWidth));
  if (height === undefined || fitted.length <= height) return fitted.join('\n');
  const headerCount = Math.min(3, fitted.length);
  const footerCount = Math.min(2, fitted.length - headerCount);
  const body = fitted.slice(headerCount, fitted.length - footerCount);
  const capacity = Math.max(1, height - headerCount - footerCount);
  const selected = body.findIndex((line) => /^>/.test(stripAnsi(line)) || line.includes('█'));
  const start = clamp(
    selected < 0 ? 0 : selected - Math.floor(capacity / 2),
    0,
    Math.max(0, body.length - capacity),
  );
  return [...fitted.slice(0, headerCount), ...body.slice(start, start + capacity), ...fitted.slice(-footerCount)].join('\n');
}

function wrapAnsiLine(value: string, width: number): string[] {
  if (ansiDisplayWidth(value) <= width && !value.includes('\n') && !value.includes('\r')) return [value];
  const plain = stripAnsi(value);
  const wrapped: string[] = [];
  const lines = plain.split(/\r\n|\n|\r/);
  if (lines.length === 0) return [''];
  for (const line of lines) {
    if (line === '') {
      wrapped.push('');
      continue;
    }
    const wrappedLine = ansiDisplayWidth(line);
    if (wrappedLine <= width) {
      wrapped.push(line);
      continue;
    }
    let current = '';
    let used = 0;
    for (const segment of graphemeSegments(line)) {
      const segmentWidth = graphemeDisplayWidth(segment);
      if (current && used + segmentWidth > width) {
        wrapped.push(current);
        current = '';
        used = 0;
      }
      current += segment;
      used += segmentWidth;
    }
    wrapped.push(current);
  }
  return wrapped;
}

function channelGroups(instance: ViewInstance, target: Pick<ChannelTarget, 'channelId' | 'profileId'>): Conversation[] {
  return channelConversations(instance, target).filter((conversation) => conversation.kind === 'group');
}

function channelDirects(instance: ViewInstance, target: Pick<ChannelTarget, 'channelId' | 'profileId'>): Conversation[] {
  return channelConversations(instance, target)
    .filter((conversation) => conversation.kind === 'direct')
    .map((conversation) => ({
      ...conversation,
      title: displayConversationTitle(
        conversation,
        instance.store.listConversationMembers(conversation.id)
          .find((member) => member.externalUserId === conversation.externalId)?.displayName ?? null,
      ),
    }));
}

function channelConversations(instance: ViewInstance, target: Pick<ChannelTarget, 'channelId' | 'profileId'>): Conversation[] {
  return instance.store.listConversations().filter((conversation) => (
    conversation.channelId === target.channelId
    && conversation.channelProfileId === target.profileId
  ));
}

type ChannelManagementItem =
  | { kind: 'enabled' | 'groups-subscription' | 'groups-default-mode' | 'directs-subscription' | 'directs-default-mode' | 'search-group' }
  | { kind: 'conversation'; conversation: Conversation };

function channelManagementItems(
  instance: ViewInstance,
  target: Pick<ChannelTarget, 'channelId' | 'profileId'>,
): ChannelManagementItem[] {
  return [
    { kind: 'enabled' },
    { kind: 'groups-subscription' },
    { kind: 'groups-default-mode' },
    { kind: 'directs-subscription' },
    { kind: 'directs-default-mode' },
    ...channelGroups(instance, target).map((conversation) => ({ kind: 'conversation' as const, conversation })),
    { kind: 'search-group' },
    ...channelDirects(instance, target).map((conversation) => ({ kind: 'conversation' as const, conversation })),
  ];
}

function subscriptionEffect(mode: ChannelSubscriptionMode, kind: '群聊' | '私聊'): string {
  if (mode === 'none') return '拒绝该类全部消息';
  if (mode === 'all') return `未知${kind}按对应默认模式建档`;
  return '仅准入已启用的指定会话';
}

function findChannelGroup(
  instance: ViewInstance,
  target: Pick<ChannelTarget, 'channelId' | 'profileId'>,
  externalId: string,
): Conversation | null {
  return channelGroups(instance, target).find((conversation) => conversation.externalId === externalId) ?? null;
}

function moveConversationDetailSelection(
  state: ManagementViewState,
  instance: ViewInstance,
  detail: Record<string, unknown>,
  key: string,
): boolean {
  const direction = key === '\u001b[A' || key.toLowerCase() === 'k' ? -1
    : key === '\u001b[B' || key.toLowerCase() === 'j' ? 1
      : key === '\u001b[5~' ? -6
        : key === '\u001b[6~' ? 6 : 0;
  const boundary = key === '\u001b[H' ? 'first' : key === '\u001b[F' ? 'last' : null;
  if (direction === 0 && boundary === null) return false;
  const conversationId = text(object(detail.conversation).id);
  const rows = state.conversationDetailFocus === 'settings'
    ? conversationId ? conversationSettingEntries(instance, conversationId) : []
    : state.conversationDetailFocus === 'members' ? array(detail.members) : array(detail.messages);
  const current = state.conversationDetailFocus === 'settings'
    ? state.selectedSetting
    : state.conversationDetailFocus === 'members' ? state.selectedMember : state.selectedMessage;
  const next = boundary === 'first' ? 0
    : boundary === 'last' ? Math.max(0, rows.length - 1)
      : clamp(current + direction, 0, Math.max(0, rows.length - 1));
  if (state.conversationDetailFocus === 'settings') {
    state.selectedSetting = next;
  } else if (state.conversationDetailFocus === 'members') {
    state.selectedMember = next;
  } else {
    state.selectedMessage = next;
    state.selectedMessageSequence = rows.length > 0 ? number(object(rows[next]).sequence) : null;
  }
  return true;
}

function moveInstanceSelection(state: ManagementViewState, instance: ViewInstance | null, direction: number): void {
  if (!instance) return;
  const settingCount = instanceSettingEntries(instance).length;
  const channelCount = configuredChannels(instance.config).length;
  const conversationCount = instance.store.listConversations().length;
  const total = settingCount + channelCount + conversationCount;
  if (total === 0) return;
  const current = state.instanceFocus === 'settings'
    ? state.selectedSetting
    : state.instanceFocus === 'channels'
      ? settingCount + state.selectedChannel
      : settingCount + channelCount + state.selectedConversation;
  const next = clamp(current + direction, 0, total - 1);
  if (next < settingCount) {
    state.instanceFocus = 'settings';
    state.selectedSetting = next;
  } else if (next < settingCount + channelCount) {
    state.instanceFocus = 'channels';
    state.selectedChannel = next - settingCount;
  } else {
    state.instanceFocus = 'conversations';
    state.selectedConversation = next - settingCount - channelCount;
    state.selectedConversationId = instance.store.listConversations()[state.selectedConversation]?.id ?? null;
  }
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
    const conversations = detailInstance.store.listConversations();
    const selectedById = state.selectedConversationId
      ? conversations.findIndex((conversation) => conversation.id === state.selectedConversationId)
      : -1;
    state.selectedConversation = selectedById >= 0
      ? selectedById
      : clamp(state.selectedConversation, 0, Math.max(0, conversations.length - 1));
    state.selectedConversationId = conversations[state.selectedConversation]?.id ?? null;
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
  minimumWidth?: number;
}

function table(headers: string[], rows: unknown[][], width: number, options: TableOptions = {}): string[] {
  if (rows.length === 0) return ['  (none)'];
  const separator = options.separator ?? '  ';
  const usable = Math.max(options.minimumWidth ?? 60, width - 2);
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

function sideBySide(left: string[], leftWidth: number, right: string[], rightWidth: number, gap: number): string[] {
  const rows = Math.max(left.length, right.length);
  return Array.from({ length: rows }, (_, index) => {
    const leftCell = left[index] ?? '';
    const rightCell = right[index] ?? '';
    return `${padAnsi(truncateAnsi(leftCell, leftWidth), leftWidth)}${' '.repeat(gap)}${truncateAnsi(rightCell, rightWidth)}`;
  });
}

function truncateAnsi(value: string, width: number): string {
  if (ansiDisplayWidth(value) <= width) return value;
  return truncate(stripAnsi(value), width);
}

function padAnsi(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - ansiDisplayWidth(value)))}`;
}

function ansiDisplayWidth(value: string): number {
  return terminalDisplayWidth(stripAnsi(value));
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
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

function statusText(value: string, color: boolean): string {
  const token = value.trim().toLowerCase();
  if (/^(error|failed|fatal|unknown|delivery_unknown)$/.test(token)) return ansi(value, 'red-bold', color);
  if (/^(running|ready|forwarded|submitted|delivered|success|reply|enabled|true)$/.test(token)) return ansi(value, 'green-bold', color);
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

function displayResponsibility(value: unknown): string {
  return text(value)?.trim() || '未配置（使用 Agent 自身职责）';
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

function editSingleLine(line: { value: string; cursor: number }, key: string, options: { multiline?: boolean } = {}): void {
  const characters = Array.from(line.value);
  line.cursor = clamp(line.cursor, 0, characters.length);
  const visual = line as typeof line & { wrapWidth?: number; preferredColumn?: number | null };
  if (key === '\u001b[A' || key === '\u001b[B') {
    const layout = visualLineLayout(line.value, Math.max(1, visual.wrapWidth ?? Number.MAX_SAFE_INTEGER));
    const currentLine = visualLineAtCursor(layout, line.cursor);
    const currentColumn = visualColumnAtCursor(characters, layout[currentLine]!.start, line.cursor);
    const targetLine = clamp(currentLine + (key === '\u001b[A' ? -1 : 1), 0, layout.length - 1);
    const preferredColumn = visual.preferredColumn ?? currentColumn;
    line.cursor = cursorAtVisualColumn(characters, layout[targetLine]!, preferredColumn);
    visual.preferredColumn = preferredColumn;
    return;
  }
  if (key === '\u001b[H' || key === '\u001b[1~' || key === '\u001b[F' || key === '\u001b[4~') {
    const layout = visualLineLayout(line.value, Math.max(1, visual.wrapWidth ?? Number.MAX_SAFE_INTEGER));
    const currentLine = visualLineAtCursor(layout, line.cursor);
    line.cursor = key === '\u001b[H' || key === '\u001b[1~'
      ? layout[currentLine]!.start
      : layout[currentLine]!.end;
    visual.preferredColumn = null;
    return;
  }
  if (key === '\u001b[1;5H' || key === '\u001b[7;5~') {
    line.cursor = 0;
    visual.preferredColumn = null;
    return;
  }
  if (key === '\u001b[1;5F' || key === '\u001b[8;5~') {
    line.cursor = characters.length;
    visual.preferredColumn = null;
    return;
  }
  visual.preferredColumn = null;
  if (key === '\u001b[D') {
    line.cursor = Math.max(0, line.cursor - 1);
    return;
  }
  if (key === '\u001b[C') {
    line.cursor = Math.min(characters.length, line.cursor + 1);
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
  if (key.startsWith('\u001b')) return;
  const allowNewLine = options.multiline === true;
  const inserted = Array.from(key)
    .map((character) => (character === '\r' ? '\n' : character))
    .filter((character) => !isControlCharacter(character) || (allowNewLine && character === '\n'));
  if (inserted.length === 0) return;
  characters.splice(line.cursor, 0, ...inserted);
  line.cursor += inserted.length;
  line.value = characters.join('');
}

function isControlCharacter(character: string): boolean {
  if (character.length !== 1) return false;
  const codePoint = character.codePointAt(0)!;
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function isSaveKey(key: string, isMultiline: boolean): boolean {
  return key === '\r' || (key === '\n' && !isMultiline);
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function isSingleLine(value: string): boolean {
  return /^[\r\n]+$/.test(value);
}

function extractBracketedPasteText(key: string): string | null {
  const start = key.indexOf(BRACKETED_PASTE_START);
  if (start < 0) return null;
  const end = key.indexOf(BRACKETED_PASTE_END, start + BRACKETED_PASTE_START.length);
  if (end < 0) return null;
  return normalizeLineEndings(key.slice(start + BRACKETED_PASTE_START.length, end));
}

function extractInsertedText(key: string): string | null {
  const bracketed = extractBracketedPasteText(key);
  if (bracketed !== null) return bracketed;
  if (key.length === 1 || !/[\r\n]/.test(key) || isSingleLine(key)) return null;
  return normalizeLineEndings(key);
}

function copyEditingValue(value: string): string {
  editingClipboard = value;
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  try {
    process.stdout.write(`\u001b]52;c;${encoded}\u0007`);
  } catch {
    // ignore
  }
  return EDITING_COPY_NOTICE;
}

interface VisualLine {
  start: number;
  end: number;
  width: number;
}

function visualLineLayout(value: string, width: number): VisualLine[] {
  const characters = Array.from(value);
  if (characters.length === 0) return [{ start: 0, end: 0, width: 0 }];
  const lines: VisualLine[] = [];
  let start = 0;
  let used = 0;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    if (character === '\r') {
      const end = index;
      if (index + 1 < characters.length && characters[index + 1] === '\n') {
        index += 1;
      }
      lines.push({ start, end, width: used });
      start = index + 1;
      used = 0;
      continue;
    }
    if (character === '\n') {
      lines.push({ start, end: index, width: used });
      start = index + 1;
      used = 0;
      continue;
    }
    const characterWidth = graphemeDisplayWidth(character);
    if (index > start && used + characterWidth > width) {
      lines.push({ start, end: index, width: used });
      start = index;
      used = 0;
    }
    used += characterWidth;
  }
  lines.push({ start, end: characters.length, width: used });
  return lines;
}

function visualLineAtCursor(lines: VisualLine[], cursor: number): number {
  const index = lines.findIndex((line, lineIndex) => {
    const next = lines[lineIndex + 1];
    if (!next) return cursor <= line.end;
    if (cursor < line.end) return true;
    return next.start > line.end && cursor < next.start;
  });
  return index < 0 ? lines.length - 1 : index;
}

function visualColumnAtCursor(characters: string[], start: number, cursor: number): number {
  return characters.slice(start, cursor).reduce((width, character) => width + graphemeDisplayWidth(character), 0);
}

function cursorAtVisualColumn(characters: string[], line: VisualLine, column: number): number {
  let used = 0;
  for (let index = line.start; index < line.end; index += 1) {
    const characterWidth = graphemeDisplayWidth(characters[index]!);
    if (used + characterWidth > column) return index;
    used += characterWidth;
  }
  return line.end;
}

function renderTextCursor(value: string, cursor: number): string {
  const characters = Array.from(value);
  const index = clamp(cursor, 0, characters.length);
  return `${characters.slice(0, index).join('')}█${characters.slice(index).join('')}`;
}

function renderAgentInputPanel(
  editing: NonNullable<ManagementViewState['editing']>,
  transcript: AgentTranscript | null,
  width: number,
  panelHeight: number,
  color: boolean,
): string[] {
  const innerWidth = Math.max(10, width - 4);
  const contentWidth = Math.max(1, innerWidth - 1);
  editing.wrapWidth = contentWidth;
  const allInputRows = wrapAnsiLine(renderTextCursor(editing.value, editing.cursor), contentWidth);
  const inputCapacity = Math.max(1, Math.min(5, panelHeight - 9));
  const cursorRow = Math.max(0, allInputRows.findIndex((line) => line.includes('█')));
  const inputStart = clamp(cursorRow - inputCapacity + 1, 0, Math.max(0, allInputRows.length - inputCapacity));
  const inputRows = allInputRows.slice(inputStart, inputStart + inputCapacity);
  const timelineCapacity = Math.max(1, panelHeight - inputRows.length - 8);
  const timelineRows = transcript?.entries.flatMap((entry) => renderTranscriptEntry(entry, contentWidth)) ?? [];
  if (timelineRows.length === 0) {
    timelineRows.push(safeTranscriptText(transcript?.message ?? '正在读取固定 Agent session 的执行记录…'));
  }
  const maxScroll = Math.max(0, timelineRows.length - timelineCapacity);
  const scroll = clamp(editing.timelineScroll ?? 0, 0, maxScroll);
  editing.timelineScroll = scroll;
  const timelineStart = Math.max(0, timelineRows.length - timelineCapacity - scroll);
  const visibleTimeline = timelineRows.slice(timelineStart, timelineStart + timelineCapacity);
  const session = transcript?.sessionIdPrefix ? `session=${transcript.sessionIdPrefix}…` : 'session=尚未创建';
  const status = transcript?.state === 'ready' ? '历史 + 实时' : '等待记录';
  return [
    heading(`真人介入 / ${editing.label.replace(/^发送给 Agent · /, '')}`, color),
    ansi(`执行记录（${status}，${session}）`, transcript?.state === 'error' ? 'red-bold' : 'dim', color),
    `┌${'─'.repeat(innerWidth + 2)}┐`,
    ...visibleTimeline.map((line) => `│ ${pad(line, innerWidth)} │`),
    `└${'─'.repeat(innerWidth + 2)}┘`,
    ansi(
      `记录 ${transcript?.entries.length ?? 0} 项 · 显示行 ${timelineStart + 1}-${timelineStart + visibleTimeline.length}/${timelineRows.length}${scroll > 0 ? ' · 已离开最新位置' : ' · 跟随最新'}`,
      'dim',
      color,
    ),
    ansi('输入消息', 'cyan-bold', color),
    `┌${'─'.repeat(innerWidth + 2)}┐`,
    ...inputRows.map((line) => `│ ${pad(line, innerWidth)} │`),
    `└${'─'.repeat(innerWidth + 2)}┘`,
  ];
}

function renderTranscriptEntry(entry: AgentTranscriptEntry, width: number): string[] {
  const symbol = ({ user: '›', assistant: '●', reasoning: '✻', tool: '⚙' })[entry.kind];
  const clock = transcriptClock(entry.at);
  const content = safeTranscriptText(entry.content);
  const lines = wrapAnsiLine(`${clock} ${symbol} ${entry.label}：${content}`, width);
  if (entry.kind === 'tool' && entry.result !== undefined) {
    const result = compactTranscriptText(entry.result, 240);
    lines.push(...wrapAnsiLine(`  └ ${entry.error ? '失败' : '结果'}：${result}`, width));
  }
  return lines;
}

function transcriptClock(value: string | null): string {
  if (!value) return '--:--:--';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value.slice(11, 19) || '--:--:--';
  const p = (part: number): string => String(part).padStart(2, '0');
  return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function safeTranscriptText(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/\t/g, '  ');
}

function compactTranscriptText(value: string, max: number): string {
  const compact = safeTranscriptText(value).replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : `${compact.slice(0, max)}…`;
}

function renderEditingPanel(
  editing: NonNullable<ManagementViewState['editing']>,
  width: number,
  color: boolean,
): string[] {
  const innerWidth = Math.max(10, width - 4);
  const contentWidth = Math.max(1, innerWidth - 1);
  editing.wrapWidth = contentWidth;
  const wrapped = wrapAnsiLine(renderTextCursor(editing.value, editing.cursor), contentWidth);
  return [
    heading(`编辑 / ${editing.label}`, color),
    ansi('完整内容按终端宽度自动换行；编辑期间暂停展示背后的详情，保存或取消后返回原位置。', 'dim', color),
    '',
    `┌${'─'.repeat(innerWidth + 2)}┐`,
    ...wrapped.map((line) => `│ ${pad(line, innerWidth)} │`),
    `└${'─'.repeat(innerWidth + 2)}┘`,
  ];
}

function textLength(value: string): number {
  return Array.from(value).length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface Viewport<T> {
  rows: T[];
  start: number;
  end: number;
  total: number;
  overflow: boolean;
}

function sectionPageSize(height: number, sections: number): number {
  return clamp(Math.floor((Math.max(12, height) - 22) / sections), 1, 8);
}

function viewportRows<T>(rows: T[], selected: number, pageSize: number): Viewport<T> {
  const size = Math.max(1, pageSize);
  const safeSelected = clamp(selected, 0, Math.max(0, rows.length - 1));
  const start = Math.min(Math.max(0, safeSelected - size + 1), Math.max(0, rows.length - size));
  const end = Math.min(rows.length, start + size);
  return { rows: rows.slice(start, end), start, end, total: rows.length, overflow: rows.length > size };
}

function viewportStatus(viewport: Viewport<unknown>): string {
  const above = viewport.start;
  const below = viewport.total - viewport.end;
  return `显示 ${viewport.total === 0 ? 0 : viewport.start + 1}-${viewport.end} / 共 ${viewport.total} 条`
    + `${above > 0 ? `  ↑ 还有 ${above} 条` : ''}${below > 0 ? `  ↓ 还有 ${below} 条` : ''}`;
}
