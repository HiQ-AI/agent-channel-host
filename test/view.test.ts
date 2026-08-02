import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultConfig } from '../src/config.js';
import { normalizeDwsEvent } from '../src/dws.js';
import { Store } from '../src/store.js';
import {
  createManagementViewState, createSettingEntries, handleManagementViewInput, renderManagementView, renderStatusView,
  shouldStartHostForView,
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
    const rendered = renderStatusView('test', snapshot, 120);
    for (const section of ['CHANNELS', 'MESSAGES', 'CONVERSATIONS', 'RUNTIMES']) assert.match(rendered, new RegExp(section));
    assert.match(rendered, /gpt-test/);
    assert.doesNotMatch(rendered, /open-secret-user|高度敏感|provider-session-complete-secret/);
    assert.match(JSON.stringify(store.status(true)), /高度敏感的消息正文/);
  } finally {
    store.close();
  }
});

test('management view 默认显示跨会话总览，可进入详情并切换设置 tab', () => {
  const store = new Store(':memory:');
  const config = defaultConfig('management-view', '.', 'Agent', '角色');
  const first = store.addConversation({
    kind: 'direct', externalId: 'member-a', title: '私聊 A', responsibility: '答疑', mode: 'shadow',
  });
  store.addConversation({
    channelId: 'slack', channelProfileId: 'workspace', runtimeId: 'claude',
    kind: 'group', externalId: 'channel-b', title: '群 B', responsibility: '评审', mode: 'shadow',
  });
  try {
    const snapshot = store.status();
    const state = createManagementViewState();
    const detail = store.conversationDetail(first.id);
    const settings = createSettingEntries(config, store, first.id);
    const overview = renderManagementView('management-view', snapshot, config, state, detail, settings, 140);
    assert.match(overview, /\[ 总览 \]\s+设置/);
    assert.match(overview, /私聊 A/);
    assert.match(overview, /群 B/);
    assert.match(overview, /dingtalk/);
    assert.match(overview, /slack/);

    state.detailConversationId = first.id;
    const detailView = renderManagementView('management-view', snapshot, config, state, detail, settings, 140);
    assert.match(detailView, /会话详情 \/ 私聊 A/);
    assert.doesNotMatch(detailView, /member-a/);

    state.detailConversationId = null;
    state.tab = 'settings';
    const settingsView = renderManagementView('management-view', snapshot, config, state, detail, settings, 140);
    assert.match(settingsView, /总览\s+\[ 设置 \]/);
    assert.match(settingsView, /Agent 名称/);
    assert.match(settingsView, /会话职责 · 私聊 A/);
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

test('management view 按键可从总览进入详情并切换设置编辑', async () => {
  const store = new Store(':memory:');
  const config = defaultConfig('view-input', '.', 'Agent', '角色');
  const conversation = store.addConversation({
    kind: 'group', externalId: 'view-input-group', title: '按键验证群', responsibility: '答疑', mode: 'shadow',
  });
  const state = createManagementViewState();
  let stopped = false;
  try {
    await handleManagementViewInput('\r', state, config, store, () => { stopped = true; });
    assert.equal(state.detailConversationId, conversation.id);
    await handleManagementViewInput('\u001b', state, config, store, () => { stopped = true; });
    assert.equal(state.detailConversationId, null);
    await handleManagementViewInput('\t', state, config, store, () => { stopped = true; });
    assert.equal(state.tab, 'settings');
    await handleManagementViewInput('\r', state, config, store, () => { stopped = true; });
    assert.equal(state.editing?.key, 'identity.name');
    await handleManagementViewInput('\u001b', state, config, store, () => { stopped = true; });
    assert.equal(state.editing, null);
    await handleManagementViewInput('q', state, config, store, () => { stopped = true; });
    assert.equal(stopped, true);
  } finally {
    store.close();
  }
});
