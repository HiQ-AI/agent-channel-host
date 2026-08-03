import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { deleteInstanceData, deleteInstanceWithLifecycle, initializeInstance } from '../../../../dist/src/instance.js';
import { Store } from '../../../../dist/src/store.js';
import { runView } from '../../../../dist/src/view.js';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('缺少 smoke 状态目录');
await mkdir(root, { recursive: true });
const resultPath = join(root, 'result.json');
process.on('uncaughtException', async (error) => {
  await writeFile(join(root, 'error.txt'), error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
process.on('unhandledRejection', async (error) => {
  await writeFile(join(root, 'error.txt'), error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('必须在真实交互终端运行');

const env = { ...process.env, AGENT_CHANNEL_HOME: root };
const firstInitialized = await initializeInstance({
  instance: 'tui-smoke', cwd: root, name: '小小鹏', channelEnabled: false,
}, env);
const secondInitialized = await initializeInstance({
  instance: 'second-agent', cwd: root, name: '翠丝', channelEnabled: false,
}, env);
const store = new Store(firstInitialized.stateFile);
const secondStore = new Store(secondInitialized.stateFile);
const config = firstInitialized.config;
const secondConfig = secondInitialized.config;
const first = store.addConversation({
  kind: 'group', externalId: 'synthetic-group', title: '编辑器验证群',
  responsibility: '回答编辑器需求、方案与 bug 排查；不负责开发实现', mode: 'shadow',
});
secondStore.addConversation({
  channelId: 'slack', channelProfileId: 'synthetic', runtimeId: 'claude',
  kind: 'direct', externalId: 'synthetic-direct', title: '跨 Channel 私聊',
  responsibility: '回答职责范围内问题', mode: 'shadow',
});
store.updateConversationMember(first.id, 'synthetic-member', {
  displayName: '成员甲', organizationRole: '产品经理', conversationRole: '需求提出人',
});
store.setChannelConnection({
  channelId: 'dingtalk', profileId: 'default', label: 'Synthetic DingTalk', state: 'stopped', ownerPid: null,
});
secondStore.setChannelConnection({
  channelId: 'slack', profileId: 'synthetic', label: 'Synthetic Slack', state: 'stopped', ownerPid: null,
});
store.setRuntimeAdapter({
  runtimeId: 'codex', label: 'Codex CLI', state: 'stopped', model: 'gpt-5.6-sol', contextRecovery: 'session-start-hook',
});
secondStore.setRuntimeAdapter({
  runtimeId: 'claude', label: 'Claude CLI', state: 'stopped', model: null, contextRecovery: 'unavailable',
});

const originalWrite = process.stdout.write.bind(process.stdout);
let transcript = '';
process.stdout.write = (chunk, ...args) => {
  transcript += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  return originalWrite(chunk, ...args);
};

const keys = [
  [3_000, '\u001b[C'],
  [4_000, '\u001b[C'],
  [5_000, '\u001b[C'],
  [5_300, '\u001b[B'],
  [5_500, '\u001b[C'],
  [5_700, '\u001b[B'],
  [5_900, '\u001b[C'],
  [6_100, '\u001b[B'],
  [6_300, '\u001b[C'],
  [6_500, '\u001b[B'],
  [6_700, '\u001b[C'],
  [7_300, '\u001b[B'],
  [7_500, '\u001b[B'],
  [7_700, '\u001b[C'],
  [8_400, '编辑器'],
  [9_400, '\r'],
  [10_400, '\u001b[C'],
  [10_800, 'd'],
  [11_100, '\u001b'],
  [11_400, '\u001b[D'],
  [12_400, '\u001b[D'],
  [13_400, 's'],
  [14_400, '\u001b[C'],
  [14_600, '\u001b[H'],
  [14_800, '\u001b[C'],
  [15_000, '·'],
  [15_200, '\u001b[F'],
  [15_400, '\r'],
  [16_400, '\u001b[D'],
  [17_400, '\u001b[D'],
  [18_400, '\t'],
  [19_400, '\u001b[D'],
  [20_400, 'a'],
  [21_400, 'created-agent'],
  [22_400, '\r'],
  [23_400, '\r'],
  [24_400, '\r'],
  [25_400, '\r'],
  [26_400, '\u001b[C'],
  [27_400, '\u001b[D'],
  [28_400, '\u001b[D'],
  [29_400, 'd'],
  [30_400, '\r'],
  [31_400, 'q'],
  [32_400, '\u001b'],
  [33_400, 'q'],
  [34_400, '\r'],
];
for (const [delay, key] of keys) setTimeout(() => process.stdin.emit('data', Buffer.from(key)), delay);

const instances = [
  { name: 'tui-smoke', config, configFile: firstInitialized.configFile, store, hostOwnership: 'attached', notices: ['合成终端 smoke；未连接 Channel'] },
  { name: 'second-agent', config: secondConfig, configFile: secondInitialized.configFile, store: secondStore, hostOwnership: 'attached', notices: [] },
];
const createdStores = [];
let createdStarted = false;
let deletedInstance = '';
const channelToggles = [];
const subscriptionChanges = [];
const defaultModeChanges = [];
const groupSearches = [];
try {
  await runView(instances, { intervalSeconds: 10, once: false, showContent: false }, {
    createInstance: async (input) => {
      const initialized = await initializeInstance({ ...input, channelEnabled: false }, env);
      const createdStore = new Store(initialized.stateFile);
      createdStores.push(createdStore);
      return {
        name: initialized.config.instance,
        config: initialized.config,
        configFile: initialized.configFile,
        store: createdStore,
        hostOwnership: 'readonly',
        notices: [],
      };
    },
    startInstance: async (instance) => { createdStarted = instance.name === 'created-agent'; },
    afterSettingApplied: async (instance, entry) => {
      if (entry.key === 'channel:dingtalk:default:enabled') channelToggles.push(instance.name);
      if (entry.key.includes(':subscriptions:')) subscriptionChanges.push(`${entry.key}=${entry.value}`);
      if (entry.key.includes(':defaultModes:')) defaultModeChanges.push(entry.key);
      if (entry.key.endsWith(':defaultModes:directs')) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 360));
      }
      return '合成 Host 生命周期回执';
    },
    searchGroups: async (instance, query) => {
      groupSearches.push({ instance: instance.name, query });
      return [{ title: '合成搜索结果群', externalId: 'synthetic-search-result-id' }];
    },
    deleteInstance: async (instance) => {
      await deleteInstanceWithLifecycle(
        instance,
        async () => undefined,
        async () => false,
        (name) => deleteInstanceData(name, env),
      );
      deletedInstance = instance.name;
    },
  });
  const plainTranscript = transcript.replace(/\u001b\[[0-9;]*m/g, '');
  const initialFrame = plainTranscript.split('\u001b[H\u001b[2J')[1]?.split('\u001b[H\u001b[2J')[0] ?? '';
  assert.match(transcript, /\u001b\[[0-9;]*m/);
  assert.match(plainTranscript, /\[ 总览 \]/);
  assert.match(plainTranscript, /instances=2/);
  assert.match(plainTranscript, /second-agent/);
  assert.match(plainTranscript, /编辑器验证群/);
  assert.match(plainTranscript, /INSTANCES/);
  assert.doesNotMatch(initialFrame, /^CHANNELS$|^CONVERSATIONS$|^RUNTIMES$|编辑器验证群|跨 Channel 私聊/m);
  const instanceDetailFrame = plainTranscript.split('\u001b[H\u001b[2J')
    .find((frame) => frame.includes('实例详情 / tui-smoke'));
  assert.ok(instanceDetailFrame);
  assert.ok(instanceDetailFrame.indexOf('CONVERSATIONS') < instanceDetailFrame.indexOf('MESSAGES received='));
  assert.match(plainTranscript, /Channel 设置 \/ tui-smoke \/ dingtalk\/default/);
  assert.match(plainTranscript, /群聊订阅\s+│\s+all/);
  assert.match(plainTranscript, /群聊默认模式\s+│\s+reply/);
  assert.match(plainTranscript, /私聊订阅\s+│\s+all/);
  assert.match(plainTranscript, /私聊默认模式\s+│\s+reply/);
  const progressFrames = plainTranscript.split('\u001b[H\u001b[2J')
    .filter((frame) => frame.includes('处理中：应用 私聊默认模式'));
  assert.ok(progressFrames.length >= 2);
  assert.match(progressFrames.join('\n'), /输入已暂时锁定，完成后自动刷新/);
  assert.match(plainTranscript, /GROUPS[\s\S]*DIRECTS/);
  assert.match(plainTranscript, /d 删除会话/);
  assert.match(plainTranscript, /群组搜索 \/ tui-smoke \/ dingtalk\/default/);
  assert.match(plainTranscript, /合成搜索结果群/);
  assert.doesNotMatch(plainTranscript, /synthetic-search-result-id/);
  assert.match(plainTranscript, /Instance 设置 \/ tui-smoke/);
  assert.match(plainTranscript, /Runtime cwd\s+│/);
  assert.match(plainTranscript, /小·小鹏/);
  assert.match(plainTranscript, /SETTING\s+│\s+VALUE\s+│\s+EFFECT/);
  assert.match(plainTranscript, /─+┼─+┼─+/);
  assert.match(plainTranscript, /新增 Instance · Instance 名称/);
  assert.match(plainTranscript, /Channel 设置 \/ created-agent \/ dingtalk\/default/);
  assert.match(plainTranscript, /启用 \/ 停用\s+│\s+enabled/);
  assert.match(plainTranscript, /\[ 全局设置 \]/);
  assert.match(plainTranscript, /暂无可修改的全局配置/);
  assert.match(plainTranscript, /退出确认/);
  assert.match(plainTranscript, /停止 0 个由当前 View 启动的 Host/);
  assert.match(plainTranscript, /Enter\/q\/Ctrl\+C 确认退出\s+Esc\/← 取消/);
  assert.match(plainTranscript, /提示：已取消退出/);
  assert.match(plainTranscript, /删除确认/);
  assert.match(plainTranscript, /提示：已取消删除/);
  const deletedFrame = plainTranscript.split('\u001b[H\u001b[2J')
    .find((frame) => frame.includes('提示：Instance created-agent 已删除'));
  assert.ok(deletedFrame);
  assert.match(deletedFrame, /instances=2/);
  assert.doesNotMatch(deletedFrame, />\s+created-agent/);
  assert.doesNotMatch(deletedFrame, /删除确认/);
  assert.match(transcript, /\u001b\[\?1049h\u001b\[\?25l/);
  assert.match(transcript, /\u001b\[\?25h\u001b\[\?1049l/);
  assert.match(transcript, /\u001b\[\?25h\u001b\[\?1049l$/);
  assert.equal(createdStarted, true);
  assert.equal(deletedInstance, 'created-agent');
  await assert.rejects(access(join(root, 'instances', 'created-agent', 'config.yaml')), { code: 'ENOENT' });
  assert.equal(config.identity.name, '小·小鹏');
  assert.deepEqual(channelToggles, ['tui-smoke', 'created-agent']);
  assert.deepEqual(subscriptionChanges, [
    'channel:dingtalk:default:subscriptions:groups=selected',
    'channel:dingtalk:default:subscriptions:directs=selected',
  ]);
  assert.deepEqual(config.channel.subscriptions, { groups: 'all', directs: 'all' });
  assert.deepEqual(config.channel.defaultModes, { groups: 'reply', directs: 'reply' });
  assert.deepEqual(defaultModeChanges, [
    'channel:dingtalk:default:defaultModes:groups',
    'channel:dingtalk:default:defaultModes:directs',
  ]);
  assert.deepEqual(groupSearches, [{ instance: 'tui-smoke', query: '编辑器' }]);
  const searchedConversation = store.listConversations().find((item) => item.title === '合成搜索结果群');
  assert.ok(searchedConversation);
  assert.equal(searchedConversation.responsibility, '');
  assert.equal(searchedConversation.mode, 'reply');
  await writeFile(resultPath, JSON.stringify({
    ok: true,
    tty: { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY },
    observed: ['lean-global-overview', 'instance-detail', 'conversation-before-messages', 'channel-detail', 'channel-toggle', 'channel-delete-action', 'group-subscription', 'group-default-mode', 'direct-subscription', 'direct-default-mode', 'operation-progress', 'group-search', 'group-bind', 'conversation-detail', 'delete-confirmation', 'delete-cancel', 'instance-delete', 'immediate-delete-refresh', 'instance-settings', 'runtime-cwd-setting', 'cursor-edit', 'instance-create', 'global-settings', 'left-right-navigation', 'alternate-screen', 'exit-confirmation', 'exit-cancel', 'exit'],
    colorObserved: true,
    settingsColumnsDelimited: true,
    conversationBeforeMessages: true,
    runtimeCwdObserved: true,
    channelDeleteActionObserved: true,
    instanceCreated: true,
    channelToggleObserved: channelToggles.length === 2,
    groupSearchObserved: groupSearches.length === 1,
    groupBound: Boolean(searchedConversation),
    subscriptionsObserved: config.channel.subscriptions.groups === 'all' && config.channel.subscriptions.directs === 'all',
    defaultModesObserved: config.channel.defaultModes.groups === 'reply' && config.channel.defaultModes.directs === 'reply',
    operationProgressObserved: progressFrames.length >= 2,
    deleteConfirmationObserved: true,
    instanceDeleteObserved: deletedInstance === 'created-agent',
    immediateDeleteRefreshObserved: Boolean(deletedFrame),
    alternateScreenObserved: true,
    exitConfirmationObserved: true,
    exitCancellationObserved: true,
    cursorEditObserved: config.identity.name === '小·小鹏',
    globalSettingsSeparated: true,
    channelStarted: false,
  }, null, 2));
} finally {
  process.stdout.write = originalWrite;
  closeIfOpen(store);
  closeIfOpen(secondStore);
  for (const createdStore of createdStores) closeIfOpen(createdStore);
}

function closeIfOpen(target) {
  try {
    target.close();
  } catch (error) {
    if (!/database is not open/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }
}
