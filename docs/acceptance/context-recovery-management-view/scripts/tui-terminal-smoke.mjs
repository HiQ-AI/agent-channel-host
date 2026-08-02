import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defaultConfig } from '../../../../dist/src/config.js';
import { Store } from '../../../../dist/src/store.js';
import { runView } from '../../../../dist/src/view.js';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('缺少 smoke 状态目录');
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('必须在真实交互终端运行');

await mkdir(root, { recursive: true });
const resultPath = join(root, 'result.json');
const store = new Store(join(root, 'state.sqlite3'));
const config = defaultConfig('tui-smoke', root, '小小鹏', '编辑器需求、方案与 bug 排查答疑');
const first = store.addConversation({
  kind: 'group', externalId: 'synthetic-group', title: '编辑器验证群',
  responsibility: '回答编辑器需求、方案与 bug 排查；不负责开发实现', mode: 'shadow',
});
store.addConversation({
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
store.setChannelConnection({
  channelId: 'slack', profileId: 'synthetic', label: 'Synthetic Slack', state: 'stopped', ownerPid: null,
});
store.setRuntimeAdapter({
  runtimeId: 'codex', label: 'Codex CLI', state: 'stopped', model: 'gpt-5.6-sol', contextRecovery: 'session-start-hook',
});
store.setRuntimeAdapter({
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
  [10_000, '\t'],
  [12_000, '\r'],
  [14_000, '\u001b'],
  [16_000, 'q'],
];
for (const [delay, key] of keys) setTimeout(() => process.stdin.emit('data', Buffer.from(key)), delay);

try {
  await runView(store, config, {
    instance: 'tui-smoke', intervalSeconds: 10, once: false, showContent: false,
    attachedToExistingHost: true, notices: ['合成终端 smoke；未连接 Channel'],
  });
  assert.match(transcript, /\[ 总览 \]/);
  assert.match(transcript, /编辑器验证群/);
  assert.match(transcript, /跨 Channel 私聊/);
  assert.match(transcript, /\[ 设置 \]/);
  assert.match(transcript, /编辑 Agent 名称/);
  await writeFile(resultPath, JSON.stringify({
    ok: true,
    tty: { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY },
    observed: ['overview', 'settings', 'editing', 'exit'],
    channelStarted: false,
  }, null, 2));
} finally {
  process.stdout.write = originalWrite;
  store.close();
}
