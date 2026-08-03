import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { initializeInstance } from '../../../../dist/src/instance.js';
import { Store } from '../../../../dist/src/store.js';
import { runView } from '../../../../dist/src/view.js';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('缺少 smoke 状态目录');
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('必须在真实交互终端运行');

await mkdir(root, { recursive: true });
const resultPath = join(root, 'result.json');
const env = { ...process.env, AGENT_CHANNEL_HOME: root };
const firstInitialized = await initializeInstance({
  instance: 'tui-smoke', cwd: root, name: '小小鹏', role: '编辑器需求、方案与 bug 排查答疑', channelEnabled: false,
}, env);
const secondInitialized = await initializeInstance({
  instance: 'second-agent', cwd: root, name: '翠丝', role: '跨 Channel 方案评审', channelEnabled: false,
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
  [5_000, '\r'],
  [6_000, '\r'],
  [8_000, '\u001b'],
  [10_000, 's'],
  [11_000, '\u001b'],
  [12_000, '\u001b'],
  [13_000, 'j'],
  [14_000, '\r'],
  [15_000, 's'],
  [16_000, '\u001b'],
  [17_000, '\u001b'],
  [18_000, 'a'],
  [19_000, 'created-agent'],
  [20_000, '\r'],
  [21_000, '\r'],
  [22_000, '\r'],
  [23_000, '\r'],
  [24_000, 'j'],
  [24_200, 'j'],
  [24_400, 'j'],
  [24_600, 'j'],
  [24_800, 'j'],
  [25_000, 'j'],
  [25_200, 'j'],
  [26_000, '\r'],
  [27_000, '\t'],
  [29_000, 'q'],
];
for (const [delay, key] of keys) setTimeout(() => process.stdin.emit('data', Buffer.from(key)), delay);

const instances = [
  { name: 'tui-smoke', config, configFile: firstInitialized.configFile, store, hostOwnership: 'attached', notices: ['合成终端 smoke；未连接 Channel'] },
  { name: 'second-agent', config: secondConfig, configFile: secondInitialized.configFile, store: secondStore, hostOwnership: 'attached', notices: [] },
];
const createdStores = [];
let createdStarted = false;
let channelToggled = false;
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
    afterSettingApplied: async (_instance, entry) => {
      channelToggled = entry.key === 'channel:dingtalk:default:enabled';
      return '合成 Host 生命周期回执';
    },
  });
  const plainTranscript = transcript.replace(/\u001b\[[0-9;]*m/g, '');
  assert.match(transcript, /\u001b\[[0-9;]*m/);
  assert.match(plainTranscript, /\[ 总览 \]/);
  assert.match(plainTranscript, /instances=2/);
  assert.match(plainTranscript, /second-agent/);
  assert.match(plainTranscript, /编辑器验证群/);
  assert.match(plainTranscript, /跨 Channel 私聊/);
  assert.match(plainTranscript, /INSTANCES/);
  assert.match(plainTranscript, /Instance 设置 \/ second-agent/);
  assert.match(plainTranscript, /SETTING\s+│\s+VALUE\s+│\s+EFFECT/);
  assert.match(plainTranscript, /─+┼─+┼─+/);
  assert.match(plainTranscript, /新增 Instance · Instance 名称/);
  assert.match(plainTranscript, /Instance 设置 \/ created-agent/);
  assert.match(plainTranscript, /dingtalk\/default\s+│\s+enabled/);
  assert.match(plainTranscript, /\[ 全局设置 \]/);
  assert.match(plainTranscript, /暂无可修改的全局配置/);
  assert.equal(createdStarted, true);
  assert.equal(channelToggled, true);
  await writeFile(resultPath, JSON.stringify({
    ok: true,
    tty: { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY },
    observed: ['global-overview', 'instance-detail', 'conversation-detail', 'instances-index', 'instance-settings', 'instance-create', 'channel-toggle', 'global-settings', 'exit'],
    colorObserved: true,
    settingsColumnsDelimited: true,
    instanceCreated: true,
    channelToggleObserved: true,
    globalSettingsSeparated: true,
    channelStarted: false,
  }, null, 2));
} finally {
  process.stdout.write = originalWrite;
  store.close();
  secondStore.close();
  for (const createdStore of createdStores) createdStore.close();
}
