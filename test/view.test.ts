import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultConfig, loadConfig } from '../src/config.js';
import { normalizeDwsEvent } from '../src/dws.js';
import { Store } from '../src/store.js';
import {
  createManagementViewState, createSettingEntries, handleManagementViewInput, renderManagementView, renderStatusView,
  shouldStartHostForView, shouldUseColor, type ViewInstance,
} from '../src/view.js';

test('status/view 共享中立快照且默认不泄露正文、外部 ID 或完整 provider session ID', () => {
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'open-secret-user', title: '编辑器私聊', responsibility: '回答问题', mode: 'shadow',
  });
  const event = normalizeDwsEvent({
    type: 'user_im_message_receive_o2o_all', event_id: 'event-secret',
    sender_open_dingtalk_id: 'open-secret-user', sender_name: '张三', content: '高度敏感的消息正文',
  })!;
  store.admitEvent(conversation, event);
  store.saveSession({
    conversationId: conversation.id,
    runtimeId: 'codex',
    providerSessionId: 'provider-session-complete-secret',
    generation: 1,
    lifecycle: 'ready',
    protocolFingerprint: 'codex:test',
    runtimeCwd: 'D:/agent',
    bootstrapTurnId: 'bootstrap',
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  });
  store.setWorkerState({
    conversationId: conversation.id,
    workerId: 'worker-secret',
    runtimeId: 'codex',
    state: 'running',
    processId: 1234,
    claimedFromSequence: 1,
    claimedToSequence: 1,
  });
  store.setRuntimeAdapter({
    runtimeId: 'codex', label: 'Codex CLI', state: 'ready',
    model: 'gpt-test', protocolFingerprint: 'codex:test',
  });
  store.setChannelConnection({
    channelId: 'dingtalk', profileId: 'default', label: 'DingTalk DWS',
    state: 'ready', ownerPid: 4321, connectedAt: new Date().toISOString(),
  });
  try {
    const snapshot = store.status();
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /open-secret-user|高度敏感|provider-session-complete-secret|张三/);
    assert.match(serialized, /provider-ses/);
    assert.match(serialized, /张\*\*\*三/);
    const rendered = renderStatusView([viewInstance('test', defaultConfig('test', '.', 'Agent', '角色'), store)], false, 120);
    for (const section of ['CHANNELS', 'MESSAGES', 'CONVERSATIONS', 'RUNTIMES']) assert.match(rendered, new RegExp(section));
    assert.match(rendered, /gpt-test/);
    assert.doesNotMatch(rendered, /open-secret-user|高度敏感|provider-session-complete-secret/);
    assert.match(JSON.stringify(store.status(true)), /高度敏感的消息正文/);
  } finally {
    store.close();
  }
});

test('management view 明确分离总览内 INSTANCES 与全局设置', () => {
  const store = new Store(':memory:');
  const secondStore = new Store(':memory:');
  const config = defaultConfig('management-view', '.', 'Agent', '角色');
  const secondConfig = defaultConfig('second-agent', '.', 'Second Agent', '评审');
  const first = store.addConversation({
    kind: 'direct', externalId: 'member-a', title: '私聊 A', responsibility: '答疑', mode: 'shadow',
  });
  secondStore.addConversation({
    channelId: 'slack', channelProfileId: 'workspace', runtimeId: 'claude',
    kind: 'group', externalId: 'channel-b', title: '群 B', responsibility: '评审', mode: 'shadow',
  });
  try {
    const instances = [
      viewInstance('management-view', config, store),
      viewInstance('second-agent', secondConfig, secondStore),
    ];
    const state = createManagementViewState();
    const detail = store.conversationDetail(first.id);
    const settings = createSettingEntries(config, store, first.id);
    const overview = renderManagementView(instances, state, detail, settings, 140);
    assert.match(overview, /\[ 总览 \]\s+全局设置/);
    assert.match(overview, /management-view/);
    assert.match(overview, /second-agent/);
    assert.match(overview, /私聊 A/);
    assert.match(overview, /群 B/);
    assert.match(overview, /dingtalk/);
    assert.match(overview, /slack/);

    state.detailInstanceName = 'management-view';
    state.detailConversationId = first.id;
    const detailView = renderManagementView(instances, state, detail, settings, 140);
    assert.match(detailView, /会话详情 \/ 私聊 A/);
    assert.doesNotMatch(detailView, /member-a/);

    state.detailInstanceName = null;
    state.detailConversationId = null;
    state.tab = 'overview';
    state.detailInstanceName = 'management-view';
    state.settingsInstanceName = 'management-view';
    const instanceSettings = renderManagementView(instances, state, detail, settings, 140);
    assert.match(instanceSettings, /\[ 总览 \]\s+全局设置/);
    assert.match(instanceSettings, /Instance 设置 \/ management-view/);
    assert.match(instanceSettings, /Agent 名称/);
    assert.match(instanceSettings, /会话职责 · 私聊 A/);

    state.tab = 'settings';
    state.settingsInstanceName = null;
    const globalSettings = renderManagementView(instances, state, detail, [], 140);
    assert.match(globalSettings, /总览\s+\[ 全局设置 \]/);
    assert.match(globalSettings, /作用域：当前 agent-channel-host View/);
    assert.match(globalSettings, /暂无可修改的全局配置/);
    assert.doesNotMatch(globalSettings, /Agent 名称|会话职责/);
  } finally {
    store.close();
    secondStore.close();
  }
});

test('management view 在交互终端使用语义颜色，纯文本输出不带 ANSI', () => {
  const store = new Store(':memory:');
  const config = defaultConfig('colored-view', '.', 'Agent', '角色');
  const conversation = store.addConversation({
    kind: 'group', externalId: 'colored-group', title: '彩色验证群', responsibility: '答疑', mode: 'shadow',
  });
  store.setChannelConnection({
    channelId: 'dingtalk', profileId: 'default', label: 'DingTalk', state: 'ready', ownerPid: 1234,
  });
  store.setRuntimeAdapter({ runtimeId: 'codex', label: 'Codex CLI', state: 'ready', model: null });
  try {
    const instances = [viewInstance('colored-view', config, store)];
    const state = createManagementViewState();
    const detail = store.conversationDetail(conversation.id);
    const settings = createSettingEntries(config, store, conversation.id);
    const plain = renderManagementView(instances, state, detail, settings, 120, false, false);
    const colored = renderManagementView(instances, state, detail, settings, 120, false, true);

    assert.doesNotMatch(plain, /\u001b\[/);
    assert.match(colored, /\u001b\[1;36m/);
    assert.match(colored, /\u001b\[1;32mready/);
    assert.equal(stripAnsi(colored).replace(/refreshed=[^\n]+/, 'refreshed=<time>'), plain.replace(/refreshed=[^\n]+/, 'refreshed=<time>'));
    assert.doesNotMatch(renderStatusView(instances), /\u001b\[/);
  } finally {
    store.close();
  }
});

test('instance 设置使用清晰的列分隔符并保持左对齐', () => {
  const store = new Store(':memory:');
  const config = defaultConfig('settings-layout', '.', 'Agent', '角色');
  try {
    const state = createManagementViewState();
    state.tab = 'overview';
    state.detailInstanceName = 'settings-layout';
    state.settingsInstanceName = 'settings-layout';
    const rendered = renderManagementView(
      [viewInstance('settings-layout', config, store)],
      state,
      null,
      createSettingEntries(config, store, null),
      120,
    );
    assert.match(rendered, /SETTING\s+│\s+VALUE\s+│\s+EFFECT/);
    assert.match(rendered, /─+┼─+┼─+/);
    assert.match(rendered, />\s+│ Agent 名称\s+│ Agent\s+│/);
  } finally {
    store.close();
  }
});

test('settings 使用同一 schema 原子保存 config，并更新 conversation 与成员资料', async () => {
  const root = resolve('.test-view-settings');
  const configFile = resolve(root, 'config.yaml');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const store = new Store(':memory:');
  const config = defaultConfig('view-settings', '.', 'Agent', '角色');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'member-settings', title: '设置私聊', responsibility: '旧职责', mode: 'shadow',
  });
  store.updateConversationMember(conversation.id, 'member-settings', { displayName: '成员甲' });
  try {
    let entries = createSettingEntries(config, store, conversation.id, configFile);
    await entries.find((entry) => entry.key === 'identity.name')!.apply('新 Agent');
    assert.equal(config.identity.name, '新 Agent');
    assert.match(await readFile(configFile, 'utf8'), /name: 新 Agent/);
    entries = createSettingEntries(config, store, conversation.id, configFile);
    await entries.find((entry) => entry.key === 'identity.role')!.apply('更新后的角色');
    assert.equal(config.identity.role, '更新后的角色');
    assert.match(await readFile(configFile, 'utf8'), /role: 更新后的角色/);
    await assert.rejects(entries.find((entry) => entry.key === 'runtime.effort')!.apply('light'), /Invalid option/);

    entries = createSettingEntries(config, store, conversation.id, configFile);
    await entries.find((entry) => entry.key.endsWith(':responsibility'))!.apply('新职责边界');
    await entries.find((entry) => entry.key.endsWith(':mode'))!.apply('reply');
    await entries.find((entry) => entry.key.endsWith(':organizationRole'))!.apply('产品经理');
    assert.equal(store.getConversation(conversation.id)?.responsibility, '新职责边界');
    assert.equal(store.getConversation(conversation.id)?.mode, 'reply');
    assert.equal(store.getConversation(conversation.id)?.policyVersion, 3);
    assert.equal(store.listConversationMembers(conversation.id)[0]?.organizationRole, '产品经理');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('view 仅在交互模式且 Host 未运行时启动 owner', () => {
  assert.equal(shouldStartHostForView(false, { hostState: 'stopped' }), true);
  assert.equal(shouldStartHostForView(false, { hostState: 'running' }), false);
  assert.equal(shouldStartHostForView(true, { hostState: 'stopped' }), false);
});

test('view 颜色遵循 TTY、NO_COLOR 与 dumb terminal', () => {
  assert.equal(shouldUseColor(true, {}), true);
  assert.equal(shouldUseColor(false, {}), false);
  assert.equal(shouldUseColor(true, { NO_COLOR: '' }), false);
  assert.equal(shouldUseColor(true, { TERM: 'dumb' }), false);
});

test('management view 按键可从总览进入详情并切换到 instance 设置编辑', async () => {
  const store = new Store(':memory:');
  const config = defaultConfig('view-input', '.', 'Agent', '角色');
  const conversation = store.addConversation({
    kind: 'group', externalId: 'view-input-group', title: '按键验证群', responsibility: '答疑', mode: 'shadow',
  });
  const state = createManagementViewState();
  const instances = [viewInstance('view-input', config, store)];
  let stopped = false;
  try {
    await handleManagementViewInput('\r', state, instances, () => { stopped = true; });
    assert.equal(state.detailInstanceName, 'view-input');
    await handleManagementViewInput('\r', state, instances, () => { stopped = true; });
    assert.equal(state.detailConversationId, conversation.id);
    await handleManagementViewInput('\u001b', state, instances, () => { stopped = true; });
    assert.equal(state.detailConversationId, null);
    await handleManagementViewInput('s', state, instances, () => { stopped = true; });
    assert.equal(state.tab, 'overview');
    assert.equal(state.settingsInstanceName, 'view-input');
    await handleManagementViewInput('\r', state, instances, () => { stopped = true; });
    assert.equal(state.editing?.key, 'identity.name');
    await handleManagementViewInput('\u001b', state, instances, () => { stopped = true; });
    assert.equal(state.editing, null);
    await handleManagementViewInput('q', state, instances, () => { stopped = true; });
    assert.equal(stopped, true);
  } finally {
    store.close();
  }
});

test('INSTANCES 在上层 view 中显式选择 instance 后编辑对应配置', async () => {
  const firstStore = new Store(':memory:');
  const secondStore = new Store(':memory:');
  const firstConfig = defaultConfig('first', '.', 'First Agent', '答疑');
  const secondConfig = defaultConfig('second', '.', 'Second Agent', '评审');
  const instances = [
    viewInstance('first', firstConfig, firstStore),
    viewInstance('second', secondConfig, secondStore),
  ];
  const state = createManagementViewState();
  state.tab = 'overview';
  try {
    await handleManagementViewInput('j', state, instances, () => undefined);
    assert.equal(state.selectedInstance, 1);
    await handleManagementViewInput('\r', state, instances, () => undefined);
    assert.equal(state.detailInstanceName, 'second');
    await handleManagementViewInput('s', state, instances, () => undefined);
    assert.equal(state.settingsInstanceName, 'second');
    await handleManagementViewInput('\r', state, instances, () => undefined);
    assert.equal(state.editing?.key, 'identity.name');
    assert.equal(state.editing?.value, 'Second Agent');
    const rendered = renderManagementView(instances, state, null, createSettingEntries(secondConfig, secondStore, null), 120);
    assert.match(rendered, /Instance 设置 \/ second/);
  } finally {
    firstStore.close();
    secondStore.close();
  }
});

test('instance Channel toggle 原子持久化并通知 Host 生命周期管理器', async () => {
  const root = resolve('.test-view-channel-toggle');
  const configFile = resolve(root, 'config.yaml');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const store = new Store(':memory:');
  const config = defaultConfig('toggle-channel', '.', 'Agent', 'role');
  const instance = { ...viewInstance('toggle-channel', config, store), configFile };
  const instances = [instance];
  const state = createManagementViewState();
  state.tab = 'overview';
  state.detailInstanceName = instance.name;
  state.settingsInstanceName = instance.name;
  const entries = createSettingEntries(config, store, null, configFile);
  state.selectedSetting = entries.findIndex((entry) => entry.key === 'channel:dingtalk:default:enabled');
  let appliedKey = '';
  try {
    await handleManagementViewInput('\r', state, instances, () => undefined, {
      afterSettingApplied: async (_target, entry) => { appliedKey = entry.key; return '目标 Host 已重启'; },
    });
    assert.equal(config.channel.enabled, false);
    assert.equal((await loadConfig('toggle-channel', configFile)).channel.enabled, false);
    assert.equal(appliedKey, 'channel:dingtalk:default:enabled');
    assert.equal(state.notice, '目标 Host 已重启');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('TUI 可在 INSTANCES 中通过受校验向导新增并启动 instance', async () => {
  const instances: ViewInstance[] = [];
  const state = createManagementViewState();
  state.tab = 'overview';
  const createdInputs: Array<{ instance: string; cwd: string; name: string; role: string }> = [];
  let started = '';
  const createdStores: Store[] = [];
  const actions = {
    createInstance: async (input: { instance: string; cwd: string; name: string; role: string }) => {
      createdInputs.push(input);
      const config = defaultConfig(input.instance, input.cwd, input.name, input.role);
      config.channel.enabled = false;
      const store = new Store(':memory:');
      createdStores.push(store);
      return viewInstance(input.instance, config, store);
    },
    startInstance: async (instance: ViewInstance) => { started = instance.name; },
  };
  try {
    await handleManagementViewInput('a', state, instances, () => undefined, actions);
    await handleManagementViewInput('new-agent', state, instances, () => undefined, actions);
    await handleManagementViewInput('\r', state, instances, () => undefined, actions);
    await handleManagementViewInput('\r', state, instances, () => undefined, actions);
    await handleManagementViewInput('\r', state, instances, () => undefined, actions);
    await handleManagementViewInput('\r', state, instances, () => undefined, actions);
    assert.equal(instances.length, 1);
    assert.equal(instances[0]?.name, 'new-agent');
    assert.equal(instances[0]?.config.channel.enabled, false);
    assert.equal(state.settingsInstanceName, 'new-agent');
    assert.equal(started, 'new-agent');
    assert.equal(createdInputs[0]?.name, 'DingTalk Agent');
    assert.match(createdInputs[0]?.role ?? '', /职责范围/);
  } finally {
    for (const store of createdStores) store.close();
  }
});

function viewInstance(name: string, config: ReturnType<typeof defaultConfig>, store: Store): ViewInstance {
  return { name, config, store, hostOwnership: 'attached', notices: [] };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}
