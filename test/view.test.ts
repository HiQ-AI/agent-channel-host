import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultConfig, loadConfig } from '../src/config.js';
import { anonymousConversationTitle } from '../src/conversation-title.js';
import { normalizeDwsEvent } from '../src/dws.js';
import { Store } from '../src/store.js';
import {
  createManagementViewState, createSettingEntries, handleManagementViewInput, renderManagementView, renderStatusView,
  shouldStartHostForView, shouldUseColor, terminalDisplayWidth, VIEW_ALTERNATE_SCREEN_ENTER, VIEW_ALTERNATE_SCREEN_EXIT,
  type ViewInstance,
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
    assert.match(rendered, /INSTANCES/);
    assert.match(rendered, /MESSAGES/);
    assert.doesNotMatch(rendered, /^CHANNELS$|^CONVERSATIONS$|^RUNTIMES$/m);
    assert.doesNotMatch(rendered, /gpt-test/);
    assert.doesNotMatch(rendered, /open-secret-user|高度敏感|provider-session-complete-secret/);
    assert.match(JSON.stringify(store.status(true)), /高度敏感的消息正文/);
  } finally {
    store.close();
  }
});

test('既有匿名私聊只读展示已持久化人员姓名且不改写原始会话标题', () => {
  const store = new Store(':memory:');
  const externalId = 'member-with-known-name';
  const conversation = store.addConversation({
    kind: 'direct', externalId, title: anonymousConversationTitle('direct', externalId),
    responsibility: '回答问题', mode: 'reply',
  });
  store.updateConversationMember(conversation.id, externalId, { displayName: '同事甲' });
  store.admitEvent(conversation, normalizeDwsEvent({
    type: 'user_im_message_receive_o2o_all', event_id: 'known-direct-name-event',
    sender_open_dingtalk_id: externalId, sender_name: '同事甲', content: '消息',
  })!);
  const config = defaultConfig('known-direct-name', '.', '小小鹏', '回答编辑器问题');
  const instance = viewInstance('known-direct-name', config, store);
  try {
    const snapshotConversation = (store.status().conversations as Array<{ title: string }>)[0];
    assert.equal(snapshotConversation?.title, '同事甲');
    assert.equal((store.status().messages as Array<{ title: string }>)[0]?.title, '同事甲');
    assert.equal((store.conversationDetail(conversation.id)?.conversation as { title: string }).title, '同事甲');

    const state = createManagementViewState();
    state.detailInstanceName = instance.name;
    state.detailChannel = { instanceName: instance.name, channelId: 'dingtalk', profileId: 'default' };
    const rendered = renderManagementView([instance], state, null, [], 120);
    assert.match(rendered, /同事甲/);
    assert.doesNotMatch(rendered, /未命名私聊|私聊 · [0-9a-f]{8}/);

    assert.equal(store.getConversation(conversation.id)?.title, anonymousConversationTitle('direct', externalId));
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
    assert.doesNotMatch(overview, /私聊 A|群 B|dingtalk|slack/);

    state.detailInstanceName = 'management-view';
    const instanceView = renderManagementView(instances, state, detail, settings, 140);
    assert.match(instanceView, /CHANNELS/);
    assert.match(instanceView, /CONVERSATIONS/);
    assert.match(instanceView, /RUNTIMES/);
    assert.match(instanceView, /RECENT MESSAGES/);
    assert.match(instanceView, /私聊 A/);

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
    state.detailInstanceName = 'colored-view';
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
    assert.equal(entries.find((entry) => entry.key === 'runtime.effort')?.input, 'select');
    assert.deepEqual(entries.find((entry) => entry.key === 'runtime.effort')?.options, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    assert.equal(entries.find((entry) => entry.key.endsWith(':mode'))?.input, 'select');
    assert.deepEqual(entries.find((entry) => entry.key.endsWith(':mode'))?.options, ['shadow', 'reply']);
    await entries.find((entry) => entry.key === 'identity.role')!.apply('更新后的角色');
    assert.equal(config.identity.role, '更新后的角色');
    assert.match(await readFile(configFile, 'utf8'), /role: 更新后的角色/);
    await assert.rejects(entries.find((entry) => entry.key === 'runtime.effort')!.apply('light'), /Invalid option/);

    entries = createSettingEntries(config, store, conversation.id, configFile);
    await entries.find((entry) => entry.key.endsWith(':title'))!.apply('更新后的私聊');
    await entries.find((entry) => entry.key.endsWith(':enabled'))!.apply('disabled');
    await entries.find((entry) => entry.key.endsWith(':responsibility'))!.apply('新职责边界');
    const state = createManagementViewState();
    const instance = { ...viewInstance('view-settings', config, store), configFile };
    state.detailInstanceName = instance.name;
    state.detailConversationId = conversation.id;
    state.settingsInstanceName = instance.name;
    state.selectedSetting = entries.findIndex((entry) => entry.key.endsWith(':mode'));
    await handleManagementViewInput('\r', state, [instance], () => undefined);
    assert.equal(state.editing, null);
    assert.equal(state.notice, '会话模式 · 更新后的私聊 已选择 reply');
    await entries.find((entry) => entry.key.endsWith(':organizationRole'))!.apply('产品经理');
    assert.equal(store.getConversation(conversation.id)?.responsibility, '新职责边界');
    assert.equal(store.getConversation(conversation.id)?.mode, 'reply');
    assert.equal(store.getConversation(conversation.id)?.title, '更新后的私聊');
    assert.equal(store.getConversation(conversation.id)?.enabled, false);
    assert.equal(store.getConversation(conversation.id)?.policyVersion, 5);
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

test('management view 使用右键下钻、左键返回并可进入 instance 设置编辑', async () => {
  const store = new Store(':memory:');
  const config = defaultConfig('view-input', '.', 'Agent', '角色');
  const conversation = store.addConversation({
    kind: 'group', externalId: 'view-input-group', title: '按键验证群', responsibility: '答疑', mode: 'shadow',
  });
  const state = createManagementViewState();
  const instances = [viewInstance('view-input', config, store)];
  let stopped = false;
  try {
    await handleManagementViewInput('\u001b[C', state, instances, () => { stopped = true; });
    assert.equal(state.detailInstanceName, 'view-input');
    assert.equal(state.instanceFocus, 'channels');
    await handleManagementViewInput('\u001b[B', state, instances, () => { stopped = true; });
    assert.equal(state.instanceFocus, 'conversations');
    await handleManagementViewInput('\u001b[C', state, instances, () => { stopped = true; });
    assert.equal(state.detailConversationId, conversation.id);
    await handleManagementViewInput('\u001b[D', state, instances, () => { stopped = true; });
    assert.equal(state.detailConversationId, null);
    await handleManagementViewInput('s', state, instances, () => { stopped = true; });
    assert.equal(state.tab, 'overview');
    assert.equal(state.settingsInstanceName, 'view-input');
    await handleManagementViewInput('\u001b[C', state, instances, () => { stopped = true; });
    assert.equal(state.editing?.key, 'identity.name');
    await handleManagementViewInput('\u001b', state, instances, () => { stopped = true; });
    assert.equal(state.editing, null);
    await handleManagementViewInput('q', state, instances, () => { stopped = true; });
    assert.equal(stopped, false);
    assert.equal(state.exitConfirmation, true);
    await handleManagementViewInput('q', state, instances, () => { stopped = true; });
    assert.equal(stopped, true);
  } finally {
    store.close();
  }
});

test('退出确认说明 Host 影响，取消后保留编辑现场且 Ctrl+C/Enter 二次确认', async () => {
  const firstStore = new Store(':memory:');
  const secondStore = new Store(':memory:');
  const first = viewInstance('exit-owned', defaultConfig('exit-owned', '.', '小小鹏', '编辑器答疑'), firstStore);
  const second = viewInstance('exit-attached', defaultConfig('exit-attached', '.', '翠丝', '方案评审'), secondStore);
  first.hostOwnership = 'view';
  const instances = [first, second];
  const state = createManagementViewState();
  state.detailInstanceName = first.name;
  state.settingsInstanceName = first.name;
  let stopped = false;
  try {
    await handleManagementViewInput('\r', state, instances, () => { stopped = true; });
    assert.equal(state.editing?.value, '小小鹏');
    await handleManagementViewInput('\u0003', state, instances, () => { stopped = true; });
    assert.equal(stopped, false);
    assert.equal(state.exitConfirmation, true);
    assert.equal(state.editing?.value, '小小鹏');
    const confirmation = renderManagementView(
      instances, state, null, createSettingEntries(first.config, first.store, null), 96,
    );
    assert.match(confirmation, /退出确认/);
    assert.match(confirmation, /停止 1 个由当前 View 启动的 Host/);
    assert.match(confirmation, /attached\/readonly Host 保持运行/);

    await handleManagementViewInput('\u001b', state, instances, () => { stopped = true; });
    assert.equal(state.exitConfirmation, false);
    assert.equal(state.editing?.value, '小小鹏');
    await handleManagementViewInput('q', state, instances, () => { stopped = true; });
    assert.equal(state.editing?.value, '小小鹏q');
    assert.equal(state.exitConfirmation, false);
    await handleManagementViewInput('\u0003', state, instances, () => { stopped = true; });
    await handleManagementViewInput('\r', state, instances, () => { stopped = true; });
    assert.equal(stopped, true);
  } finally {
    firstStore.close();
    secondStore.close();
  }
});

test('Instance 设置表按终端显示宽度对齐中文、全角、emoji 与组合字符', () => {
  const store = new Store(':memory:');
  const config = defaultConfig('display-width', '.', '小小鹏🙂', '回答编辑器需求、方案以及 bug 排查');
  config.identity.signature = 'Ａgent e\u0301';
  const instance = viewInstance('display-width', config, store);
  const state = createManagementViewState();
  state.detailInstanceName = instance.name;
  state.settingsInstanceName = instance.name;
  try {
    assert.equal(terminalDisplayWidth('Agent 名称'), 10);
    assert.equal(terminalDisplayWidth('Ａ'), 2);
    assert.equal(terminalDisplayWidth('🙂'), 2);
    assert.equal(terminalDisplayWidth('e\u0301'), 1);
    const rendered = renderManagementView(
      [instance], state, null, createSettingEntries(config, store, null), 96,
    );
    const lines = rendered.split('\n');
    const headingIndex = lines.findIndex((line) => line === 'INSTANCE');
    assert.notEqual(headingIndex, -1);
    const rows = lines.slice(headingIndex + 1).filter((line) => line.includes('│'));
    assert.ok(rows.length > 2);
    const expected = rows[0]!.split('│').slice(0, -1).map(terminalDisplayWidth);
    for (const row of rows.slice(1)) {
      assert.deepEqual(row.split('│').slice(0, -1).map(terminalDisplayWidth), expected);
      assert.ok(terminalDisplayWidth(row) <= 94);
    }
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

test('Channel 独立页面第一项可直接 toggle，并原子持久化及通知 Host 生命周期管理器', async () => {
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
  state.detailChannel = { instanceName: instance.name, channelId: 'dingtalk', profileId: 'default' };
  state.selectedChannelItem = 0;
  let appliedKey = '';
  try {
    await handleManagementViewInput('\u001b[C', state, instances, () => undefined, {
      afterSettingApplied: async (_target, entry) => { appliedKey = entry.key; return '目标 Host 已重启'; },
    });
    assert.equal(config.channel.enabled, false);
    assert.equal((await loadConfig('toggle-channel', configFile)).channel.enabled, false);
    assert.equal(appliedKey, 'channel:dingtalk:default:enabled');
    assert.equal(state.notice, '目标 Host 已重启');
    const rendered = renderManagementView(instances, state, null, [], 120);
    assert.match(rendered, /Channel 设置 \/ toggle-channel \/ dingtalk\/default/);
    assert.match(rendered, />\s+│ 启用 \/ 停用\s+│ disabled/);
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
    assert.deepEqual(state.detailChannel, { instanceName: 'new-agent', channelId: 'dingtalk', profileId: 'default' });
    assert.equal(started, 'new-agent');
    assert.equal(createdInputs[0]?.name, 'DingTalk Agent');
    assert.match(createdInputs[0]?.role ?? '', /职责范围/);
  } finally {
    for (const store of createdStores) store.close();
  }
});

test('Channel 群搜索只用候选 ID 建立现有 registry 绑定，默认继承角色且重复选择不新增', async () => {
  const store = new Store(':memory:');
  const config = defaultConfig('group-search', '.', '小小鹏', '回答编辑器方案与 bug 排查');
  const instance = viewInstance('group-search', config, store);
  const instances = [instance];
  const state = createManagementViewState();
  state.detailInstanceName = instance.name;
  state.detailChannel = { instanceName: instance.name, channelId: 'dingtalk', profileId: 'default' };
  config.channel.defaultModes.groups = 'reply';
  state.selectedChannelItem = 5;
  const searches: string[] = [];
  const actions = {
    searchGroups: async (_instance: ViewInstance, query: string) => {
      searches.push(query);
      return [
        { title: '广场＆编辑器迭代中...', externalId: 'synthetic-open-conversation-id' },
        { title: '重复候选', externalId: 'synthetic-open-conversation-id' },
        { title: '', externalId: 'invalid' },
      ];
    },
  };
  try {
    await handleManagementViewInput('\u001b[C', state, instances, () => undefined, actions);
    assert.equal(state.groupSearch?.phase, 'query');
    await handleManagementViewInput('编辑器', state, instances, () => undefined, actions);
    await handleManagementViewInput('\r', state, instances, () => undefined, actions);
    assert.equal(state.groupSearch?.phase, 'results');
    assert.equal(state.groupSearch?.results.length, 1);
    const searchView = renderManagementView(instances, state, null, [], 120);
    assert.match(searchView, /广场＆编辑器迭代中/);
    assert.doesNotMatch(searchView, /synthetic-open-conversation-id/);
    await handleManagementViewInput('\u001b[C', state, instances, () => undefined, actions);
    const bound = store.listConversations();
    assert.equal(bound.length, 1);
    assert.equal(bound[0]?.kind, 'group');
    assert.equal(bound[0]?.responsibility, config.identity.role);
    assert.equal(bound[0]?.mode, 'reply');
    assert.equal(bound[0]?.channelId, 'dingtalk');
    assert.equal(bound[0]?.runtimeId, 'codex');
    assert.equal(state.detailConversationId, bound[0]?.id);
    assert.deepEqual(searches, ['编辑器']);

    await handleManagementViewInput('\u001b[D', state, instances, () => undefined, actions);
    state.selectedChannelItem = 5;
    await handleManagementViewInput('\u001b[C', state, instances, () => undefined, actions);
    assert.equal(state.detailConversationId, bound[0]?.id);
    assert.equal(store.listConversations().length, 1);
  } finally {
    store.close();
  }
});

test('Tab 只切顶层，左右键负责层级导航，alternate screen 序列成对', async () => {
  const store = new Store(':memory:');
  const config = defaultConfig('navigation', '.', 'Agent', '角色');
  const state = createManagementViewState();
  const instances = [viewInstance('navigation', config, store)];
  try {
    await handleManagementViewInput('\u001b[C', state, instances, () => undefined);
    assert.equal(state.detailInstanceName, 'navigation');
    assert.equal(state.tab, 'overview');
    await handleManagementViewInput('\t', state, instances, () => undefined);
    assert.equal(state.tab, 'overview');
    await handleManagementViewInput('\u001b[D', state, instances, () => undefined);
    assert.equal(state.detailInstanceName, null);
    await handleManagementViewInput('\t', state, instances, () => undefined);
    assert.equal(state.tab, 'settings');
    await handleManagementViewInput('\u001b[D', state, instances, () => undefined);
    assert.equal(state.tab, 'overview');
    assert.equal(VIEW_ALTERNATE_SCREEN_ENTER, '\u001b[?1049h\u001b[?25l');
    assert.equal(VIEW_ALTERNATE_SCREEN_EXIT, '\u001b[?25h\u001b[?1049l');
  } finally {
    store.close();
  }
});

test('设置、群搜索和 Instance 向导支持光标移动、Home End 及前后删除', async () => {
  const store = new Store(':memory:');
  const config = defaultConfig('cursor-edit', '.', 'Agent', '角色');
  const instance = viewInstance('cursor-edit', config, store);
  const instances = [instance];
  const state = createManagementViewState();
  state.detailInstanceName = instance.name;
  state.settingsInstanceName = instance.name;
  try {
    await handleManagementViewInput('\r', state, instances, () => undefined);
    await handleManagementViewInput('\u001b[D', state, instances, () => undefined);
    await handleManagementViewInput('\u001b[D', state, instances, () => undefined);
    await handleManagementViewInput('X', state, instances, () => undefined);
    assert.equal(state.editing?.value, 'AgeXnt');
    assert.equal(state.editing?.cursor, 4);
    await handleManagementViewInput('\u001b[H', state, instances, () => undefined);
    await handleManagementViewInput('\u001b[3~', state, instances, () => undefined);
    await handleManagementViewInput('\u001b[F', state, instances, () => undefined);
    await handleManagementViewInput('\b', state, instances, () => undefined);
    assert.equal(state.editing?.value, 'geXn');
    assert.match(renderManagementView(instances, state, null, createSettingEntries(config, store, null), 120), /geXn█/);
    await handleManagementViewInput('\u001b', state, instances, () => undefined);

    state.settingsInstanceName = null;
    state.detailChannel = { instanceName: instance.name, channelId: 'dingtalk', profileId: 'default' };
    state.selectedChannelItem = 5;
    const actions = { searchGroups: async () => [] };
    await handleManagementViewInput('\u001b[C', state, instances, () => undefined, actions);
    await handleManagementViewInput('编器', state, instances, () => undefined, actions);
    await handleManagementViewInput('\u001b[D', state, instances, () => undefined, actions);
    await handleManagementViewInput('辑', state, instances, () => undefined, actions);
    assert.equal(state.groupSearch?.query, '编辑器');
    assert.equal(state.groupSearch?.cursor, 2);
    await handleManagementViewInput('\u001b[H', state, instances, () => undefined, actions);
    await handleManagementViewInput('\u001b[C', state, instances, () => undefined, actions);
    await handleManagementViewInput('\u001b[3~', state, instances, () => undefined, actions);
    await handleManagementViewInput('辑', state, instances, () => undefined, actions);
    assert.equal(state.groupSearch?.query, '编辑器');

    const createState = createManagementViewState();
    await handleManagementViewInput('a', createState, [], () => undefined, {
      createInstance: async () => { throw new Error('本用例不提交向导'); },
    });
    await handleManagementViewInput('ew', createState, [], () => undefined);
    await handleManagementViewInput('\u001b[H', createState, [], () => undefined);
    await handleManagementViewInput('n', createState, [], () => undefined);
    await handleManagementViewInput('\u001b[F', createState, [], () => undefined);
    await handleManagementViewInput('\b', createState, [], () => undefined);
    await handleManagementViewInput('w', createState, [], () => undefined);
    assert.equal(createState.creatingInstance?.value, 'new');
    assert.equal(createState.creatingInstance?.cursor, 3);
  } finally {
    store.close();
  }
});

test('Channel 页面分别选择群聊/私聊订阅与默认模式，并展示两类指定绑定', async () => {
  const root = resolve('.test-view-channel-subscriptions');
  const configFile = resolve(root, 'config.yaml');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const store = new Store(':memory:');
  const config = defaultConfig('channel-subscriptions', '.', 'Agent', 'role');
  const group = store.addConversation({
    kind: 'group', externalId: 'group-binding', title: '指定群聊', responsibility: '答疑', mode: 'shadow',
  });
  const direct = store.addConversation({
    kind: 'direct', externalId: 'direct-binding', title: '指定私聊', responsibility: '答疑', mode: 'shadow',
  });
  const instance = { ...viewInstance('channel-subscriptions', config, store), configFile };
  const state = createManagementViewState();
  state.detailInstanceName = instance.name;
  state.detailChannel = { instanceName: instance.name, channelId: 'dingtalk', profileId: 'default' };
  let restarts = 0;
  const actions = { afterSettingApplied: async () => { restarts += 1; return 'Host 已重启'; } };
  try {
    state.selectedChannelItem = 1;
    await handleManagementViewInput('\r', state, [instance], () => undefined, actions);
    assert.equal(config.channel.subscriptions.groups, 'all');
    state.selectedChannelItem = 2;
    await handleManagementViewInput('\r', state, [instance], () => undefined, actions);
    assert.equal(config.channel.defaultModes.groups, 'reply');
    state.selectedChannelItem = 3;
    await handleManagementViewInput('\r', state, [instance], () => undefined, actions);
    assert.equal(config.channel.subscriptions.directs, 'all');
    state.selectedChannelItem = 4;
    await handleManagementViewInput('\r', state, [instance], () => undefined, actions);
    assert.equal(config.channel.defaultModes.directs, 'reply');
    assert.equal(restarts, 4);
    const loaded = await loadConfig(instance.name, configFile);
    assert.deepEqual(loaded.channel.subscriptions, { groups: 'all', directs: 'all' });
    assert.deepEqual(loaded.channel.defaultModes, { groups: 'reply', directs: 'reply' });
    const rendered = renderManagementView([instance], state, null, [], 120);
    assert.match(rendered, /群聊订阅\s+│ all/);
    assert.match(rendered, /群聊默认模式\s+│ reply/);
    assert.match(rendered, /私聊订阅\s+│ all/);
    assert.match(rendered, /私聊默认模式\s+│ reply/);
    assert.match(rendered, /GROUPS[\s\S]*指定群聊/);
    assert.match(rendered, /DIRECTS[\s\S]*指定私聊/);
    state.selectedChannelItem = 5;
    await handleManagementViewInput('\r', state, [instance], () => undefined, actions);
    assert.equal(state.detailConversationId, group.id);
    state.detailConversationId = null;
    state.selectedChannelItem = 7;
    await handleManagementViewInput('\r', state, [instance], () => undefined, actions);
    assert.equal(state.detailConversationId, direct.id);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Instance 与 Conversation 删除均需二次确认，取消无副作用并由 action 执行生命周期', async () => {
  const firstStore = new Store(':memory:');
  const secondStore = new Store(':memory:');
  const first = viewInstance('delete-instance', defaultConfig('delete-instance', '.', 'Agent', 'role'), firstStore);
  const second = viewInstance('keep-instance', defaultConfig('keep-instance', '.', 'Agent', 'role'), secondStore);
  const conversation = firstStore.addConversation({
    kind: 'group', externalId: 'delete-conversation', title: '待删除会话', responsibility: '答疑', mode: 'shadow',
  });
  const instances = [first, second];
  const state = createManagementViewState();
  state.detailInstanceName = first.name;
  state.detailConversationId = conversation.id;
  let deletedConversation = '';
  let deletedInstance = '';
  const actions = {
    deleteConversation: async (instance: ViewInstance, id: string) => {
      deletedConversation = `${instance.name}/${id}`;
      instance.store.deleteConversation(id);
    },
    deleteInstance: async (instance: ViewInstance) => { deletedInstance = instance.name; },
  };
  try {
    await handleManagementViewInput('d', state, instances, () => undefined, actions);
    assert.equal(state.destructiveConfirmation?.kind, 'conversation');
    assert.match(renderManagementView(instances, state, firstStore.conversationDetail(conversation.id), [], 120), /删除确认/);
    await handleManagementViewInput('\u001b', state, instances, () => undefined, actions);
    assert.ok(firstStore.getConversation(conversation.id));
    await handleManagementViewInput('d', state, instances, () => undefined, actions);
    await handleManagementViewInput('\r', state, instances, () => undefined, actions);
    assert.equal(deletedConversation, `${first.name}/${conversation.id}`);
    assert.equal(firstStore.getConversation(conversation.id), null);
    assert.equal(state.detailConversationId, null);
    const conversationRefreshed = renderManagementView(instances, state, null, [], 120);
    assert.match(conversationRefreshed, /CONVERSATIONS\n  \(none\)/);
    assert.match(conversationRefreshed, /Conversation 待删除会话 已删除/);
    assert.doesNotMatch(conversationRefreshed, /删除确认/);

    state.detailInstanceName = null;
    state.selectedInstance = 0;
    await handleManagementViewInput('d', state, instances, () => undefined, actions);
    assert.equal(state.destructiveConfirmation?.kind, 'instance');
    await handleManagementViewInput('d', state, instances, () => undefined, actions);
    assert.equal(deletedInstance, first.name);
    assert.deepEqual(instances.map((instance) => instance.name), [second.name]);
    const refreshed = renderManagementView(instances, state, null, [], 120);
    assert.match(refreshed, /instances=1/);
    assert.doesNotMatch(refreshed, />\s+delete-instance/);
    assert.match(refreshed, />\s+keep-instance/);
    assert.equal(state.selectedInstance, 0);
    assert.match(refreshed, /Instance delete-instance 已删除/);
    assert.doesNotMatch(refreshed, /删除确认/);
  } finally {
    firstStore.close();
    secondStore.close();
  }
});

function viewInstance(name: string, config: ReturnType<typeof defaultConfig>, store: Store): ViewInstance {
  return { name, config, store, hostOwnership: 'attached', notices: [] };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}
