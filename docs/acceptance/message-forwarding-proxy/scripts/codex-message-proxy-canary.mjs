import { access, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defaultConfig } from '../../../../dist/src/config.js';
import { CodexCommandSession, verifyCodexCommand } from '../../../../dist/src/codex-command.js';
import { Store } from '../../../../dist/src/store.js';

const rootArg = process.argv[2];
if (!rootArg) throw new Error('用法：node codex-message-proxy-canary.mjs <empty-state-directory>');
const root = resolve(rootArg);
const statePath = join(root, 'state.sqlite3');
await access(statePath).then(
  () => { throw new Error(`状态库已存在，拒绝覆盖：${statePath}`); },
  () => undefined,
);
await mkdir(root, { recursive: true });

const marker = `message-proxy-${Date.now().toString(36)}`;
const config = defaultConfig('message-proxy-canary', resolve('..'), 'Canary');
const store = new Store(statePath);
const conversation = store.addConversation({
  kind: 'direct',
  externalId: 'offline-canary-user',
  title: 'Offline canary',
  responsibility: 'local metadata only',
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
  const firstRun = await first.runDecision(
    `发送者：验证者\n时间：2026-08-03 00:00:00\n内容：记住标记 ${marker}。只返回 {"action":"silent","replyText":""}`,
  );
  const providerSessionId = first.currentSessionId;
  if (!providerSessionId || firstRun.decision?.action !== 'silent') throw new Error('首轮未按最小协议完成');
  await first.stop();

  second = new CodexCommandSession(config, conversation, runtime, store);
  const secondStartup = await second.start();
  const secondRun = await second.runDecision(
    '发送者：验证者\n时间：2026-08-03 00:01:00\n内容：从当前 session 既有上下文回忆上一轮标记。返回 action="reply"，replyText 只写标记。',
  );
  const recoveredSessionId = second.currentSessionId;
  if (providerSessionId !== recoveredSessionId) throw new Error('provider session ID 不一致');
  if (secondRun.decision?.action !== 'reply' || secondRun.decision.replyText.trim() !== marker) {
    throw new Error(`上下文回忆失败：${JSON.stringify(secondRun.decision)}`);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    firstStartupMode: firstStartup.mode,
    secondStartupMode: secondStartup.mode,
    sameProviderSessionId: true,
    contextRecalled: true,
    providerSessionIdPrefix: providerSessionId.slice(0, 12),
    firstDecision: firstRun.decision,
    secondAction: secondRun.decision.action,
    runtimeVersion: runtime.version,
    model: config.runtime.model,
    effort: config.runtime.effort,
  }, null, 2)}\n`);
} finally {
  await first?.stop().catch(() => undefined);
  await second?.stop().catch(() => undefined);
  store.close();
}
