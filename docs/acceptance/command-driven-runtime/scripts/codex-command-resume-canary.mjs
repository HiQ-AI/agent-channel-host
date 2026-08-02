import { access, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defaultConfig } from '../../../../dist/src/config.js';
import { CodexCommandSession, verifyCodexCommand } from '../../../../dist/src/codex-command.js';
import { Store } from '../../../../dist/src/store.js';

const rootArg = process.argv[2];
if (!rootArg) throw new Error('用法：node codex-command-resume-canary.mjs <empty-state-directory>');
const root = resolve(rootArg);
const statePath = join(root, 'state.sqlite3');
await access(statePath).then(
  () => { throw new Error(`状态库已存在，拒绝覆盖：${statePath}`); },
  () => undefined,
);
await mkdir(root, { recursive: true });

const config = defaultConfig('command-canary', resolve('..'), 'Canary', 'offline runtime canary');
const store = new Store(statePath);
const conversation = store.addConversation({
  kind: 'direct',
  externalId: 'offline-canary-user',
  title: 'Offline canary',
  responsibility: '只执行离线 silent canary',
  mode: 'shadow',
  channelId: config.channel.id,
  channelProfileId: config.channel.profileId,
  runtimeId: config.runtime.id,
  workerWarmSeconds: 0,
});
const runtime = await verifyCodexCommand(config);
let first;
let second;
try {
  first = new CodexCommandSession(config, conversation, runtime, store);
  const firstStartup = await first.start();
  const firstRun = await first.runDecision(canaryPrompt('new'));
  const firstSessionId = first.currentSessionId;
  await first.stop();

  second = new CodexCommandSession(config, conversation, runtime, store);
  const secondStartup = await second.start();
  const secondRun = await second.runDecision(canaryPrompt('resume'));
  const secondSessionId = second.currentSessionId;
  if (!firstSessionId || firstSessionId !== secondSessionId) throw new Error('resume 后 provider session ID 不一致');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    firstStartupMode: firstStartup.mode,
    secondStartupMode: secondStartup.mode,
    sameProviderSessionId: true,
    providerSessionIdPrefix: firstSessionId.slice(0, 12),
    firstAction: firstRun.decision?.action,
    secondAction: secondRun.decision?.action,
    runtimeVersion: runtime.version,
    model: config.runtime.model,
    effort: config.runtime.effort,
  }, null, 2)}\n`);
} finally {
  await first?.stop().catch(() => undefined);
  await second?.stop().catch(() => undefined);
  store.close();
}

function canaryPrompt(stage) {
  return `
[宿主离线验证事件；不是 Channel 消息]
当前没有待处理消息，禁止发言。返回 action="silent"、responsibilityMatch=false、category="${stage}"、replyText=""、reasonCode="offline_canary"、workType="discussion"、delegation="not_required"。
`.trim();
}
