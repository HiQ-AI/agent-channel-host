import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultConfig, loadConfig } from '../src/config.js';
import { anonymousConversationTitle } from '../src/conversation-title.js';
import { normalizeDwsEvent } from '../src/dws.js';
import { Store } from '../src/store.js';
import type { Conversation } from '../src/types.js';
import { PRODUCT_VERSION } from '../src/product.js';
import {
  bindHostToInteractiveView, createManagementViewState, createSettingEntries, handleManagementViewInput, inspectRequiredTools, renderFrameDiff, renderManagementView,
  renderPendingOperation, renderStatusView,
  shouldStartHostForView, shouldUseColor, terminalDisplayWidth, VIEW_ALTERNATE_SCREEN_ENTER, VIEW_ALTERNATE_SCREEN_EXIT,
  type ViewInstance,
} from '../src/view.js';

test('View 总览展示 Node.js、DWS、Codex CLI 三项启动时工具探测', async () => {
  const store = new Store(':memory:');
  const config = defaultConfig('tool-status', '.', 'Agent');
  config.channel.command = process.execPath;
  config.runtime.command = process.execPath;
  try {
    const tools = await inspectRequiredTools([viewInstance('tool-status', config, store)]);
    assert.deepEqual(tools.map((tool) => tool.tool), ['Node.js', 'DWS', 'Codex CLI']);
    assert.ok(tools.every((tool) => tool.state === 'ready'));
    const rendered = renderManagementView(
      [viewInstance('tool-status', config, store)], createManagementViewState(), null, [], 120, false, false, 30, tools,
    );
    assert.match(rendered, /TOOLS/);
    assert.match(rendered, /Node\.js\s+ready\s+v\d+/);
    assert.match(rendered, /DWS\s+ready\s+v\d+/);
    assert.match(rendered, /Codex CLI\s+ready\s+v\d+/);
  } finally {
    store.close();
  }
});

test('view 顶部显示当前版本号与标准时间格式', () => {
  const store = new Store(':memory:');
  const config = defaultConfig('view-version', '.', 'Agent');
  const state = createManagementViewState();
  try {
    const rendered = renderManagementView([viewInstance('view-version', config, store)], state, null, [], 120);
    const plain = stripAnsi(rendered);
    assert.match(plain, new RegExp(`\\bv${PRODUCT_VERSION.replaceAll('.', '\\.')}`));
    assert.match(plain, /\brefreshed=\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\b/);
    const status = renderStatusView([viewInstance('view-version', defaultConfig('view-version-status', '.', 'Agent'), store)], false, 120);
    assert.match(stripAnsi(status), new RegExp(`\\bv${PRODUCT_VERSION.replaceAll('.', '\\.')}`));
    assert.match(stripAnsi(status), /\brefreshed=\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\b/);
  } finally {
    store.close();
  }
});

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
    const rendered = renderStatusView([viewInstance('test', defaultConfig('test', '.', 'Agent'), store)], false, 120);
    assert.match(rendered, /INSTANCES/);
    assert.doesNotMatch(rendered, /MESSAGES received=|HISTORY loaded=/);
    assert.doesNotMatch(rendered, /^CHANNELS$|^CONVERSATIONS$|^RUNTIMES$/m);
    assert.doesNotMatch(rendered, /gpt-test/);
    assert.doesNotMatch(rendered, /open-secret-user|高度敏感|provider-session-complete-secret/);
    assert.match(JSON.stringify(store.status(true)), /高度敏感的消息正文/);
  } finally {
    store.close();
  }
});

test('ALERTS 将遗留 DWS 长错误压缩为单行脱敏摘要', () => {
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'group', externalId: 'cid-sensitive', title: '测试群', responsibility: '', mode: 'reply',
  });
  store.prepareGroupOnboarding(conversation.id, 1, 'turn-alert', '敏感回复正文', 'stable-alert-uuid');
  store.finishGroupOnboardingIntro(
    conversation.id,
    'failed',
    "Command failed: dws chat message send --group cid-sensitive --text 敏感回复正文 --uuid stable-alert-uuid\n"
      + "Request is repeated with uuid 'stable-alert-uuid'",
  );
  const config = defaultConfig('alert-summary', '.', 'Agent');
  const instance = viewInstance('alert-summary', config, store);
  const state = createManagementViewState();
  try {
    const rendered = renderManagementView([instance], state, null, [], 72);
    assert.match(rendered, /onboarding\/测试群: delivery_unknown: duplicate_uuid/);
    assert.doesNotMatch(rendered, /敏感回复正文|cid-sensitive|stable-alert-uuid|Command failed:/);
    const alertLine = rendered.split('\n').find((line) => line.includes('onboarding/测试群'))!;
    assert.ok(terminalDisplayWidth(alertLine) <= 72);
  } finally {
    store.close();
  }
});

test('首次群历史不再把批次 turn 冒充为逐消息判断结果', () => {
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'group', externalId: 'cid-history-evidence', title: '历史证据群', responsibility: '答疑', mode: 'reply',
  });
  store.prepareGroupOnboarding(conversation.id, 2, 'history-turn', '回复', 'history-uuid');
  store.finishGroupOnboardingIntro(conversation.id, 'delivery_unknown', 'duplicate_uuid');
  const instance = viewInstance('history-evidence', defaultConfig('history-evidence', '.', 'Agent'), store);
  const state = createManagementViewState();
  state.detailInstanceName = instance.name;
  try {
    const snapshot = store.status();
    assert.equal(snapshot.received, 0);
    assert.equal(snapshot.forwarded_messages, 0);
    assert.equal(snapshot.history_loaded, 2);
    assert.equal(snapshot.history_forwarded, 0);
    const rendered = renderManagementView([instance], state, null, [], 140);
    assert.match(rendered, /历史证据群.*0\/2.*delivery_unknown/);
    assert.doesNotMatch(rendered, /MESSAGES received=|HISTORY loaded=|RECENT MESSAGES|ALERTS/);
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
  const config = defaultConfig('known-direct-name', '.', '小小鹏');
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
  const config = defaultConfig('management-view', '.', 'Agent');
  const secondConfig = defaultConfig('second-agent', '.', 'Second Agent');
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
    assert.doesNotMatch(overview, /MESSAGES received=|HISTORY loaded=/);

    state.detailInstanceName = 'management-view';
    const instanceView = renderManagementView(instances, state, detail, settings, 140);
    assert.match(instanceView, /CHANNELS/);
    assert.match(instanceView, /CONVERSATIONS/);
    assert.match(instanceView, /RUNTIMES/);
    assert.match(instanceView, /私聊 A/);
    assert.doesNotMatch(instanceView, /MESSAGES received=|HISTORY loaded=|RECENT MESSAGES|ALERTS/);
    assert.ok(instanceView.indexOf('CHANNELS') < instanceView.indexOf('CONVERSATIONS'));
    assert.ok(instanceView.indexOf('CONVERSATIONS') < instanceView.indexOf('RUNTIMES'));

    state.detailConversationId = first.id;
    const detailView = renderManagementView(instances, state, detail, settings, 140);
    assert.match(detailView, /会话详情 \/ 私聊 A/);
    assert.match(detailView, /RECENT MESSAGES/);
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
  const config = defaultConfig('colored-view', '.', 'Agent');
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

test('重新启用群聊要求刷新 Host，私聊启用仍保持即时准入', () => {
  const store = new Store(':memory:');
  const config = defaultConfig('conversation-enable', '.', 'Agent');
  const group = store.addConversation({ kind: 'group', externalId: 'group', title: '群聊', responsibility: '', mode: 'shadow' });
  const direct = store.addConversation({ kind: 'direct', externalId: 'direct', title: '私聊', responsibility: '', mode: 'shadow' });
  try {
    store.setConversationEnabled(group.id, false);
    store.setConversationEnabled(direct.id, false);
    const groupEnabled = createSettingEntries(config, store, group.id).find((entry) => entry.key.endsWith(':enabled'))!;
    const directEnabled = createSettingEntries(config, store, direct.id).find((entry) => entry.key.endsWith(':enabled'))!;
    assert.equal(groupEnabled.restartHost, true);
    assert.equal(directEnabled.restartHost, false);
  } finally {
    store.close();
  }
});

test('instance 设置使用清晰的列分隔符并保持左对齐', () => {
  const store = new Store(':memory:');
  const config = defaultConfig('settings-layout', '.', 'Agent');
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

test('Instance 与内嵌 Conversation 设置共用 schema，但不提供成员资料编辑', async () => {
  const root = resolve('.test-view-settings');
  const configFile = resolve(root, 'config.yaml');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const store = new Store(':memory:');
  const config = defaultConfig('view-settings', '.', 'Agent');
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
    const runtimeCwd = entries.find((entry) => entry.key === 'runtime.cwd');
    assert.ok(runtimeCwd);
    assert.equal(runtimeCwd.value, resolve('.'));
    assert.equal(runtimeCwd.restartHost, true);
    const changedCwd = resolve(root, 'runtime-cwd');
    await runtimeCwd.apply(changedCwd);
    assert.equal(config.runtime.cwd, changedCwd);
    assert.match(await readFile(configFile, 'utf8'), /runtime-cwd/);
    await assert.rejects(runtimeCwd.apply('  '), /Runtime cwd 不能为空/);
    entries = createSettingEntries(config, store, conversation.id, configFile);
    assert.equal(entries.find((entry) => entry.key === 'runtime.effort')?.input, 'select');
    assert.deepEqual(entries.find((entry) => entry.key === 'runtime.effort')?.options, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    assert.equal(entries.find((entry) => entry.key.endsWith(':mode'))?.input, 'select');
    assert.deepEqual(entries.find((entry) => entry.key.endsWith(':mode'))?.options, ['shadow', 'reply']);
    assert.equal(entries.some((entry) => entry.key === 'identity.role'), false);
    assert.equal(entries.some((entry) => entry.key === 'identity.signature'), false);
    assert.equal(entries.some((entry) => entry.key.startsWith('member:')), false);
    assert.doesNotMatch(await readFile(configFile, 'utf8'), /\n\s+(role|signature):/);
    await assert.rejects(entries.find((entry) => entry.key === 'runtime.effort')!.apply('light'), /Invalid option/);

    entries = createSettingEntries(config, store, conversation.id, configFile);
    await entries.find((entry) => entry.key.endsWith(':title'))!.apply('更新后的私聊');
    await entries.find((entry) => entry.key.endsWith(':enabled'))!.apply('disabled');
    await entries.find((entry) => entry.key.endsWith(':responsibility'))!.apply('新职责边界');
    const reminderInterval = entries.find((entry) => entry.key.endsWith(':responsibilityReminderInterval'))!;
    assert.equal(reminderInterval.value, '15');
    await reminderInterval.apply('0');
    await assert.rejects(reminderInterval.apply('100'), /0-99/);
    const state = createManagementViewState();
    const instance = { ...viewInstance('view-settings', config, store), configFile };
    state.detailInstanceName = instance.name;
    state.detailConversationId = conversation.id;
    state.conversationDetailFocus = 'settings';
    state.selectedSetting = entries.filter((entry) => entry.section === 'conversation')
      .findIndex((entry) => entry.key.endsWith(':mode'));
    await handleManagementViewInput('\r', state, [instance], () => undefined);
    assert.equal(state.editing, null);
    assert.equal(state.notice, '会话模式 · 更新后的私聊 已选择 reply');
    assert.equal(store.getConversation(conversation.id)?.responsibility, '新职责边界');
    assert.equal(store.getConversation(conversation.id)?.mode, 'reply');
    assert.equal(store.getConversation(conversation.id)?.title, '更新后的私聊');
    assert.equal(store.getConversation(conversation.id)?.enabled, false);
    assert.equal(store.getConversation(conversation.id)?.responsibilityReminderInterval, 0);
    assert.equal(store.getConversation(conversation.id)?.policyVersion, 6);
    assert.equal(store.listConversationMembers(conversation.id)[0]?.organizationRole, '');
    const detailView = renderManagementView([instance], state, store.conversationDetail(conversation.id), entries, 140);
    assert.match(detailView, /RECENT MESSAGES.*MEMBERS/);
    assert.match(detailView, /成\*\*\*甲/);
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

test('交互式 View 对运行中的外部 Host 先停止再绑定为 View-owned，once 保持只读', async () => {
  const runningStore = new Store(':memory:');
  runningStore.acquireLease('host', 'external', Date.now(), 30_000);
  const running = viewInstance('running', defaultConfig('running', '.', 'Agent'), runningStore);
  const calls: string[] = [];
  await bindHostToInteractiveView(false, running, async (instance) => {
    calls.push(`stop:${instance.hostOwnership}`);
    instance.store.releaseLease('host', 'external');
  }, (instance) => {
    calls.push(`start:${instance.hostOwnership}`);
    instance.hostOwnership = 'view';
  });
  assert.deepEqual(calls, ['stop:attached', 'start:readonly']);
  assert.equal(running.hostOwnership, 'view');

  const once = viewInstance('once', defaultConfig('once', '.', 'Agent'), new Store(':memory:'));
  await bindHostToInteractiveView(true, once, async () => { throw new Error('不应停止'); }, () => { throw new Error('不应启动'); });
  assert.equal(once.hostOwnership, 'readonly');
  runningStore.close();
  once.store.close();
});

test('view 颜色遵循 TTY、NO_COLOR 与 dumb terminal', () => {
  assert.equal(shouldUseColor(true, {}), true);
  assert.equal(shouldUseColor(false, {}), false);
  assert.equal(shouldUseColor(true, { NO_COLOR: '' }), false);
  assert.equal(shouldUseColor(true, { TERM: 'dumb' }), false);
});

test('management view 从会话详情直接编辑内嵌 Conversation 设置', async () => {
  const store = new Store(':memory:');
  const config = defaultConfig('view-input', '.', 'Agent');
  const conversation = store.addConversation({
    kind: 'group', externalId: 'view-input-group', title: '按键验证群', responsibility: '答疑', mode: 'shadow',
  });
  const state = createManagementViewState();
  const instances = [viewInstance('view-input', config, store)];
  let stopped = false;
  try {
    await handleManagementViewInput('\u001b[C', state, instances, () => { stopped = true; });
    assert.equal(state.detailInstanceName, 'view-input');
    assert.equal(state.instanceFocus, 'settings');
    await handleManagementViewInput('\u001b[6~', state, instances, () => { stopped = true; });
    assert.equal(state.instanceFocus, 'channels');
    await handleManagementViewInput('\u001b[B', state, instances, () => { stopped = true; });
    assert.equal(state.instanceFocus, 'conversations');
    await handleManagementViewInput('\u001b[C', state, instances, () => { stopped = true; });
    assert.equal(state.detailConversationId, conversation.id);
    assert.equal(state.conversationDetailFocus, 'settings');
    await handleManagementViewInput('s', state, instances, () => { stopped = true; });
    assert.equal(state.tab, 'overview');
    assert.equal(state.settingsInstanceName, null);
    assert.equal(state.detailConversationId, conversation.id);
    assert.equal(state.conversationDetailFocus, 'settings');
    await handleManagementViewInput('\u001b[B', state, instances, () => { stopped = true; });
    assert.equal(state.selectedSetting, 1);
    renderManagementView(instances, state, store.conversationDetail(conversation.id), [], 120);
    renderManagementView(instances, state, store.conversationDetail(conversation.id), [], 120);
    assert.equal(state.selectedSetting, 1, '即时重绘和后续自动刷新不得把内嵌设置选择重置为首项');
    await handleManagementViewInput('\u001b[A', state, instances, () => { stopped = true; });
    assert.equal(state.selectedSetting, 0);
    await handleManagementViewInput('\u001b[C', state, instances, () => { stopped = true; });
    assert.equal(state.editing?.key, `conversation:${conversation.id}:title`);
    await handleManagementViewInput('\u001b', state, instances, () => { stopped = true; });
    assert.equal(state.editing, null);
    await handleManagementViewInput('\u001b[B', state, instances, () => { stopped = true; });
    await handleManagementViewInput('\u001b[B', state, instances, () => { stopped = true; });
    assert.equal(state.selectedSetting, 2);
    await handleManagementViewInput('\u001b[C', state, instances, () => { stopped = true; });
    const longResponsibility = '负责编辑器方案、评审、排查和开发协作；先回复后处理，耗时操作放后台；'.repeat(6);
    const responsibilityEditor = state.editing as { value: string; cursor: number } | null;
    assert.ok(responsibilityEditor);
    responsibilityEditor.value = longResponsibility;
    responsibilityEditor.cursor = [...longResponsibility].length;
    const editingFrame = renderManagementView(
      instances, state, store.conversationDetail(conversation.id), [], 120,
    );
    assert.ok(editingFrame.split('\n').every((line) => terminalDisplayWidth(line) <= 120));
    assert.match(editingFrame, /█/, '长职责编辑时必须显示光标及其附近文本');
    await handleManagementViewInput('\r', state, instances, () => { stopped = true; });
    const savedFrame = renderManagementView(
      instances, state, store.conversationDetail(conversation.id), [], 120,
    );
    const refreshedFrame = renderManagementView(
      instances, state, store.conversationDetail(conversation.id), [], 120,
    );
    assert.ok(savedFrame.split('\n').every((line) => terminalDisplayWidth(line) <= 120));
    assert.deepEqual(refreshedFrame.split('\n').slice(1), savedFrame.split('\n').slice(1));
    assert.equal(store.getConversation(conversation.id)?.responsibility, longResponsibility);
    const expandedFrame = renderManagementView(
      instances, state, store.conversationDetail(conversation.id), [], 120, false, false, 60,
    );
    assert.doesNotMatch(expandedFrame, /^职责：/m, '详情头部不应重复展开长会话职责');
    assert.match(expandedFrame, /会话职责/, '会话职责仍保留在 CONVERSATION 设置表中');
    await handleManagementViewInput('q', state, instances, () => { stopped = true; });
    assert.equal(stopped, false);
    assert.equal(state.exitConfirmation, true);
    await handleManagementViewInput('q', state, instances, () => { stopped = true; });
    assert.equal(stopped, true);
  } finally {
    store.close();
  }
});

test('CONVERSATIONS 以稳定 ID 选择，跨 Channel 排序和标题刷新后下钻不漂移', async () => {
  const store = new Store(':memory:');
  const config = defaultConfig('stable-conversation-selection', '.', 'Agent');
  const selected = store.addConversation({
    channelId: 'z-channel', channelProfileId: 'workspace', runtimeId: 'codex',
    kind: 'direct', externalId: 'selected-direct', title: 'A 私聊', responsibility: '答疑', mode: 'shadow',
  });
  const sibling = store.addConversation({
    channelId: 'a-channel', channelProfileId: 'workspace', runtimeId: 'codex',
    kind: 'direct', externalId: 'sibling-direct', title: 'B 私聊', responsibility: '答疑', mode: 'shadow',
  });
  store.addConversation({
    channelId: 'a-channel', channelProfileId: 'workspace', runtimeId: 'codex',
    kind: 'group', externalId: 'group-row', title: '群聊', responsibility: '答疑', mode: 'shadow',
  });
  const instance = viewInstance('stable-conversation-selection', config, store);
  const state = createManagementViewState();
  state.detailInstanceName = instance.name;
  state.instanceFocus = 'conversations';
  state.selectedConversation = 0;
  state.selectedConversationId = selected.id;
  try {
    assert.deepEqual(
      (store.status().conversations as Array<{ id: string }>).map((row) => row.id),
      store.listConversations().map((conversation) => conversation.id),
    );
    store.setConversationTitle(selected.id, 'Z 私聊');
    await handleManagementViewInput('\u001b[C', state, [instance], () => undefined);
    assert.equal(state.selectedConversationId, selected.id);
    assert.equal(state.detailConversationId, selected.id);
    assert.equal(state.selectedConversation, 1);
    assert.notEqual(state.detailConversationId, sibling.id);
    const rendered = renderManagementView(
      [instance], state, store.conversationDetail(state.detailConversationId!), [], 120,
    );
    assert.match(rendered, /会话详情 \/ Z 私聊/);
  } finally {
    store.close();
  }
});

test('退出确认说明 Host 影响，取消后保留编辑现场且 Ctrl+C/Enter 二次确认', async () => {
  const firstStore = new Store(':memory:');
  const secondStore = new Store(':memory:');
  const first = viewInstance('exit-owned', defaultConfig('exit-owned', '.', '小小鹏'), firstStore);
  const second = viewInstance('exit-owned-second', defaultConfig('exit-owned-second', '.', '翠丝'), secondStore);
  first.hostOwnership = 'view';
  second.hostOwnership = 'view';
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
    assert.match(confirmation, /停止全部 2 个由当前 View 管理的 Host/);

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
  const config = defaultConfig('display-width', '.', '小小鹏🙂');
  config.runtime.model = 'Ａgent e\u0301';
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

test('INSTANCES 在上层 view 中下钻后直接编辑内嵌 INSTANCE 设置', async () => {
  const firstStore = new Store(':memory:');
  const secondStore = new Store(':memory:');
  const firstConfig = defaultConfig('first', '.', 'First Agent');
  const secondConfig = defaultConfig('second', '.', 'Second Agent');
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
    assert.equal(state.instanceFocus, 'settings');
    await handleManagementViewInput('s', state, instances, () => undefined);
    assert.equal(state.settingsInstanceName, null);
    assert.equal(state.instanceFocus, 'settings');
    await handleManagementViewInput('\r', state, instances, () => undefined);
    assert.equal(state.editing?.key, 'identity.name');
    assert.equal(state.editing?.value, 'Second Agent');
    const rendered = renderManagementView(instances, state, null, createSettingEntries(secondConfig, secondStore, null), 120);
    assert.match(rendered, /编辑 \/ Agent 名称/);
    assert.match(rendered, /Second Agent█/);
    assert.doesNotMatch(rendered, /\[ INSTANCE \]/);

    await handleManagementViewInput('\u001b', state, instances, () => undefined);
    assert.equal(state.editing, null);
    const returned = renderManagementView(instances, state, null, createSettingEntries(secondConfig, secondStore, null), 120);
    assert.match(returned, /\[ INSTANCE \]/);
    assert.ok(returned.indexOf('[ INSTANCE ]') < returned.indexOf('CHANNELS'));
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
  const config = defaultConfig('toggle-channel', '.', 'Agent');
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
  const createdInputs: Array<{ instance: string; cwd: string; name: string }> = [];
  let started = '';
  const createdStores: Store[] = [];
  const actions = {
    createInstance: async (input: { instance: string; cwd: string; name: string }) => {
      createdInputs.push(input);
      const config = defaultConfig(input.instance, input.cwd, input.name);
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
    assert.equal(instances.length, 1);
    assert.equal(instances[0]?.name, 'new-agent');
    assert.equal(instances[0]?.config.channel.enabled, false);
    assert.deepEqual(state.detailChannel, { instanceName: 'new-agent', channelId: 'dingtalk', profileId: 'default' });
    assert.equal(started, 'new-agent');
    assert.equal(createdInputs[0]?.name, 'DingTalk Agent');
    assert.equal(Object.hasOwn(createdInputs[0] ?? {}, 'role'), false);
  } finally {
    for (const store of createdStores) store.close();
  }
});

test('Channel 群搜索只用候选 ID 建立现有 registry 绑定，职责未配置且重复选择不新增', async () => {
  const store = new Store(':memory:');
  const config = defaultConfig('group-search', '.', '小小鹏');
  const instance = viewInstance('group-search', config, store);
  const instances = [instance];
  const state = createManagementViewState();
  state.detailInstanceName = instance.name;
  state.detailChannel = { instanceName: instance.name, channelId: 'dingtalk', profileId: 'default' };
  config.channel.defaultModes.groups = 'reply';
  state.selectedChannelItem = 5;
  const searches: string[] = [];
  const added: string[] = [];
  const actions = {
    searchGroups: async (_instance: ViewInstance, query: string) => {
      searches.push(query);
      return [
        { title: '广场＆编辑器迭代中...', externalId: 'synthetic-open-conversation-id' },
        { title: '重复候选', externalId: 'synthetic-open-conversation-id' },
        { title: '', externalId: 'invalid' },
      ];
    },
    afterConversationAdded: async (_instance: ViewInstance, conversation: Conversation) => {
      added.push(conversation.id);
      return 'Host 已重启并开始加载最近 50 条消息';
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
    assert.equal(bound[0]?.responsibility, '');
    assert.equal(bound[0]?.mode, 'reply');
    assert.equal(bound[0]?.channelId, 'dingtalk');
    assert.equal(bound[0]?.runtimeId, 'codex');
    assert.equal(state.detailConversationId, bound[0]?.id);
    assert.deepEqual(searches, ['编辑器']);
    assert.deepEqual(added, [bound[0]!.id]);
    assert.match(state.notice ?? '', /最近 50 条消息/);

    await handleManagementViewInput('\u001b[D', state, instances, () => undefined, actions);
    state.selectedChannelItem = 5;
    await handleManagementViewInput('\u001b[C', state, instances, () => undefined, actions);
    assert.equal(state.detailConversationId, bound[0]?.id);
    assert.equal(store.listConversations().length, 1);
    assert.deepEqual(added, [bound[0]!.id]);
  } finally {
    store.close();
  }
});

test('Tab 只切顶层，左右键负责层级导航，alternate screen 序列成对', async () => {
  const store = new Store(':memory:');
  const config = defaultConfig('navigation', '.', 'Agent');
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

test('帧渲染首次清屏、后续只改变化行并清理缩短的尾行', () => {
  assert.equal(renderFrameDiff('', '第一行\n第二行'), '\u001b[H\u001b[2J第一行\n第二行');
  assert.equal(renderFrameDiff('第一行\n第二行', '第一行\n新内容'), '\u001b[2;1H\u001b[2K新内容');
  assert.equal(renderFrameDiff('第一行\n第二行', '第一行'), '\u001b[2;1H\u001b[2K');
  assert.equal(renderFrameDiff('相同', '相同'), '');
  assert.equal(renderFrameDiff('旧', '新', true), '\u001b[H\u001b[2J新');
});

test('p 暂停 View 显示但不停止 Host，恢复后继续刷新', async () => {
  const store = new Store(':memory:');
  const state = createManagementViewState();
  const instances = [viewInstance('pause-view', defaultConfig('pause-view', '.', 'Agent'), store)];
  try {
    await handleManagementViewInput('p', state, instances, () => undefined);
    assert.equal(state.paused, true);
    const paused = renderManagementView(instances, state, null, [], 120);
    assert.match(paused, /PAUSED/);
    assert.match(paused, /Host 仍在后台运行/);
    await handleManagementViewInput('\u001b[B', state, instances, () => undefined);
    assert.equal(state.selectedInstance, 0);
    await handleManagementViewInput('p', state, instances, () => undefined);
    assert.equal(state.paused, false);
    assert.equal(state.notice, '已恢复实时刷新');
  } finally {
    store.close();
  }
});

test('大表格按终端高度建立内部视口，并以 sequence 保持消息选中位置', async () => {
  const store = new Store(':memory:');
  const config = defaultConfig('viewport', '.', 'Agent');
  const conversations = Array.from({ length: 10 }, (_, index) => store.addConversation({
    kind: 'group', externalId: `viewport-group-${index}`, title: `会话-${index}`,
    responsibility: '', mode: 'shadow',
  }));
  const target = conversations[0]!;
  for (let index = 0; index < 10; index += 1) {
    store.updateConversationMember(target.id, `member-${index}`, { displayName: `成员-${index}` });
    store.admitEvent(target, normalizeDwsEvent({
      type: 'user_im_message_receive_group', event_id: `viewport-event-${index}`,
      conversation_id: target.externalId, sender_open_dingtalk_id: `member-${index}`,
      sender_name: `成员-${index}`, content: `这是第 ${index} 条用于视口验证的消息内容`,
    })!);
  }
  const instance = viewInstance('viewport', config, store);
  const state = createManagementViewState();
  state.detailInstanceName = instance.name;
  state.instanceFocus = 'conversations';
  state.selectedConversation = 9;
  state.selectedConversationId = conversations[9]!.id;
  try {
    const instanceView = renderManagementView([instance], state, null, [], 120, false, false, 24);
    assert.ok(instanceView.split('\n').length <= 24);
    assert.match(instanceView, /显示 10-10 \/ 共 10 条/);
    assert.match(instanceView, />\s+dingtalk\s+会话-9/);
    assert.doesNotMatch(instanceView, /会话-0/);
    await handleManagementViewInput('\u001b[H', state, [instance], () => undefined);
    assert.equal(state.selectedConversation, 0);
    await handleManagementViewInput('\u001b[6~', state, [instance], () => undefined);
    assert.equal(state.selectedConversation, 6);

    state.detailConversationId = target.id;
    state.selectedConversationId = target.id;
    state.conversationDetailFocus = 'messages';
    let detail = store.conversationDetail(target.id, true)!;
    let detailView = renderManagementView([instance], state, detail, [], 120, true, false, 29);
    assert.ok(detailView.split('\n').length <= 29);
    assert.ok(detailView.split('\n').every((line) => terminalDisplayWidth(line) <= 120));
    assert.match(detailView, /CONTENT/);
    assert.match(detailView, /用于视口验证的消息内容/);
    assert.match(detailView, /RECENT MESSAGES.*MEMBERS/);
    assert.match(detailView, /显示 1-4 \/ 共 10 条/);
    await handleManagementViewInput('\u001b[6~', state, [instance], () => undefined);
    const selectedSequence = state.selectedMessageSequence;
    assert.ok(selectedSequence !== null);
    store.admitEvent(target, normalizeDwsEvent({
      type: 'user_im_message_receive_group', event_id: 'viewport-event-new',
      conversation_id: target.externalId, sender_open_dingtalk_id: 'member-new',
      sender_name: '新成员', content: '新到达但不抢走当前消息焦点',
    })!);
    detail = store.conversationDetail(target.id, true)!;
    detailView = renderManagementView([instance], state, detail, [], 120, true, false, 29);
    assert.equal(state.selectedMessageSequence, selectedSequence);
    assert.match(detailView, /↑ 还有/);
    await handleManagementViewInput('\t', state, [instance], () => undefined);
    assert.equal(state.conversationDetailFocus, 'members');
    await handleManagementViewInput('\u001b[F', state, [instance], () => undefined);
    assert.equal(state.selectedMember, 10);
    assert.match(renderManagementView([instance], state, detail, [], 120, true, false, 29), />\s+新\*\*\*员/);
    await handleManagementViewInput('\t', state, [instance], () => undefined);
    assert.equal(state.conversationDetailFocus, 'settings');
  } finally {
    store.close();
  }
});

test('会话详情可输入多行消息并发送给当前固定 Agent session', async () => {
  const store = new Store(':memory:');
  const config = defaultConfig('view-agent-input', '.', 'Agent');
  const conversation = store.addConversation({
    kind: 'group', externalId: 'view-input-group', title: 'View 输入群', responsibility: '', mode: 'shadow',
  });
  const instance = viewInstance('view-agent-input', config, store);
  const state = createManagementViewState();
  state.detailInstanceName = instance.name;
  state.detailConversationId = conversation.id;
  state.selectedConversationId = conversation.id;
  const sent: string[] = [];
  const actions = {
    sendToAgent: async (_instance: ViewInstance, conversationId: string, text: string) => {
      assert.equal(conversationId, conversation.id);
      sent.push(text);
    },
  };
  try {
    await handleManagementViewInput('i', state, [instance], () => undefined, actions);
    assert.equal(state.editing?.purpose, 'agent-input');
    await handleManagementViewInput('第一行', state, [instance], () => undefined, actions);
    await handleManagementViewInput('\n', state, [instance], () => undefined, actions);
    await handleManagementViewInput('第二行', state, [instance], () => undefined, actions);
    assert.equal(state.editing?.value, '第一行\n第二行');
    await handleManagementViewInput('\r', state, [instance], () => undefined, actions);
    assert.deepEqual(sent, ['第一行\n第二行']);
    assert.equal(state.editing, null);
    assert.equal(state.notice, '消息已进入当前会话的 Agent inbox');
  } finally {
    store.close();
  }
});

test('设置、群搜索和 Instance 向导支持光标移动、Home End 及前后删除', async () => {
  const store = new Store(':memory:');
  const config = defaultConfig('cursor-edit', '.', 'Agent');
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

test('多行文本编辑按视觉行上下移动并保持显示列', async () => {
  const store = new Store(':memory:');
  const config = defaultConfig('multiline-cursor', '.', 'Agent');
  const instance = viewInstance('multiline-cursor', config, store);
  const state = createManagementViewState();
  state.detailInstanceName = instance.name;
  state.editing = {
    key: 'conversation:responsibility',
    label: '会话职责',
    value: '甲乙丙丁戊己庚辛壬癸',
    cursor: 10,
  };
  try {
    renderManagementView([instance], state, null, [], 11);
    assert.equal(state.editing.wrapWidth, 9);

    await handleManagementViewInput('\u001b[A', state, [instance], () => undefined);
    assert.equal(state.editing.cursor, 6);
    await handleManagementViewInput('\u001b[A', state, [instance], () => undefined);
    assert.equal(state.editing.cursor, 2);
    await handleManagementViewInput('\u001b[B', state, [instance], () => undefined);
    assert.equal(state.editing.cursor, 6);

    await handleManagementViewInput('\u001b[H', state, [instance], () => undefined);
    assert.equal(state.editing.cursor, 4);
    await handleManagementViewInput('\u001b[F', state, [instance], () => undefined);
    assert.equal(state.editing.cursor, 8);
    await handleManagementViewInput('\u001b[1;5H', state, [instance], () => undefined);
    assert.equal(state.editing.cursor, 0);
    await handleManagementViewInput('\u001b[1;5F', state, [instance], () => undefined);
    assert.equal(state.editing.cursor, 10);
  } finally {
    store.close();
  }
});

test('长文本设置页支持粘贴换行内容、复制与粘贴快捷键', async () => {
  const store = new Store(':memory:');
  const config = defaultConfig('multiline-edit', '.', 'Agent');
  const conversation = store.addConversation({
    kind: 'group',
    externalId: 'multiline-group',
    title: '多行编辑',
    responsibility: '旧职责',
    mode: 'reply',
  });
  const instance = viewInstance('multiline-edit', config, store);
  const state = createManagementViewState();
  state.detailInstanceName = instance.name;
  state.detailConversationId = conversation.id;
  state.conversationDetailFocus = 'settings';
  try {
    state.editing = {
      key: `conversation:${conversation.id}:responsibility`,
      label: '会话职责 · 多行编辑',
      value: '旧职责',
      cursor: 3,
      multiline: true,
    };
    await handleManagementViewInput('第一段\n第二段', state, [instance], () => undefined);
    assert.equal(state.editing?.value, '旧职责第一段\n第二段');
    await handleManagementViewInput('\u0003', state, [instance], () => undefined);
    assert.equal(state.notice, '已复制输入内容到剪贴板，可用 Ctrl+V 粘贴');
    state.editing.value = '清空';
    state.editing.cursor = 2;
    await handleManagementViewInput('\n', state, [instance], () => undefined);
    assert.equal(state.editing?.value, '清空\n');
    await handleManagementViewInput('\u0016', state, [instance], () => undefined);
    assert.equal(state.editing?.value, '清空\n旧职责第一段\n第二段');
    await handleManagementViewInput('\r', state, [instance], () => undefined);
    assert.equal(store.getConversation(conversation.id)?.responsibility, '清空\n旧职责第一段\n第二段');
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
  const config = defaultConfig('channel-subscriptions', '.', 'Agent');
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
  const actions = {
    afterSettingApplied: async () => { restarts += 1; return 'Host 已重启'; },
    deleteConversation: async (_instance: ViewInstance, id: string) => { store.deleteConversation(id); },
  };
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
    state.detailConversationId = null;
    state.selectedChannelItem = 5;
    await handleManagementViewInput('d', state, [instance], () => undefined, actions);
    assert.equal(state.destructiveConfirmation?.conversationId, group.id);
    await handleManagementViewInput('\r', state, [instance], () => undefined, actions);
    assert.equal(store.getConversation(group.id), null);
    assert.ok(state.detailChannel);
    assert.equal(state.destructiveConfirmation, null);
    state.selectedChannelItem = 6;
    await handleManagementViewInput('d', state, [instance], () => undefined, actions);
    assert.equal(
      (state.destructiveConfirmation as { conversationId: string | null } | null)?.conversationId,
      direct.id,
    );
    await handleManagementViewInput('d', state, [instance], () => undefined, actions);
    assert.equal(store.getConversation(direct.id), null);
    assert.ok(state.detailChannel);
    state.selectedChannelItem = 0;
    await handleManagementViewInput('d', state, [instance], () => undefined, actions);
    assert.equal(state.destructiveConfirmation, null);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('耗时设置在等待前进入进度态，持续帧不读取 Store，完成后自动清理', async () => {
  const root = resolve('.test-view-pending-operation');
  const configFile = resolve(root, 'config.yaml');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const store = new Store(':memory:');
  const config = defaultConfig('pending-operation', '.', 'Agent');
  const instance = { ...viewInstance('pending-operation', config, store), configFile };
  const state = createManagementViewState();
  state.detailInstanceName = instance.name;
  state.detailChannel = { instanceName: instance.name, channelId: 'dingtalk', profileId: 'default' };
  state.selectedChannelItem = 4;
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  let lifecycleCalls = 0;
  try {
    const handling = handleManagementViewInput('\r', state, [instance], () => undefined, {
      afterSettingApplied: async () => {
        lifecycleCalls += 1;
        await gate;
        return 'Host 已重启';
      },
    });
    assert.equal(state.pendingOperation?.label, '应用 私聊默认模式');
    const startedAt = state.pendingOperation!.startedAt;
    store.close();
    const first = renderPendingOperation('稳定页面\n不会读取已关闭 Store', state.pendingOperation!, 80, 8, 0, false, startedAt + 500);
    const second = renderPendingOperation('稳定页面\n不会读取已关闭 Store', state.pendingOperation!, 80, 8, 1, false, startedAt + 700);
    assert.match(first, /⠋ 处理中：应用 私聊默认模式  已用时 0\.5s/);
    assert.match(first, /输入已暂时锁定，完成后自动刷新/);
    assert.match(second, /⠙ 处理中/);
    release();
    await handling;
    assert.equal(state.pendingOperation, null);
    assert.equal(state.notice, 'Host 已重启');
    assert.equal(lifecycleCalls, 1);
    assert.equal(config.channel.defaultModes.directs, 'reply');
  } finally {
    try { store.close(); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test('Instance 与 Conversation 删除均需二次确认，取消无副作用并由 action 执行生命周期', async () => {
  const firstStore = new Store(':memory:');
  const secondStore = new Store(':memory:');
  const first = viewInstance('delete-instance', defaultConfig('delete-instance', '.', 'Agent'), firstStore);
  const second = viewInstance('keep-instance', defaultConfig('keep-instance', '.', 'Agent'), secondStore);
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
