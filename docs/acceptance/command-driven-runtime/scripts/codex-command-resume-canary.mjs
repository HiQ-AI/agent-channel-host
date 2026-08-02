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

const marker = 'cmd-runtime-context-7f3a';
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
let seeded;
let interrupted;
let recovered;
try {
  seeded = new CodexCommandSession(config, conversation, runtime, store);
  const seedStartup = await seeded.start();
  const seedRun = await seeded.runDecision(seedPrompt(marker));
  const providerSessionId = seeded.currentSessionId;
  if (!providerSessionId || seedRun.decision?.category !== 'seeded') throw new Error('seed turn 未完成');
  await seeded.stop();

  interrupted = new CodexCommandSession(config, conversation, runtime, store);
  const interruptStartup = await interrupted.start();
  const activeRun = interrupted.runDecision(interruptPrompt());
  if (!interrupted.processId) throw new Error('真实 Codex command 未进入 active 状态');
  const interruptRequested = await interrupted.interruptActive();
  const interruptedRun = await activeRun;
  if (!interruptRequested || interruptedRun.status !== 'interrupted') {
    throw new Error('真实 Codex command 未返回 interrupted');
  }
  await interrupted.stop();

  recovered = new CodexCommandSession(config, conversation, runtime, store);
  const recoveryStartup = await recovered.start();
  const recoveryRun = await recovered.runDecision(recallPrompt());
  const recoveredSessionId = recovered.currentSessionId;
  const contextRecalled = recoveryRun.decision?.category === marker;
  if (providerSessionId !== recoveredSessionId) throw new Error('中断恢复后 provider session ID 不一致');
  if (!contextRecalled) throw new Error(`恢复 turn 未回忆 marker，实际 category=${recoveryRun.decision?.category}`);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    seedStartupMode: seedStartup.mode,
    interruptStartupMode: interruptStartup.mode,
    recoveryStartupMode: recoveryStartup.mode,
    interruptRequested,
    interruptedStatus: interruptedRun.status,
    sameProviderSessionId: true,
    contextRecalled,
    providerSessionIdPrefix: providerSessionId.slice(0, 12),
    seedAction: seedRun.decision.action,
    recoveryAction: recoveryRun.decision?.action,
    runtimeVersion: runtime.version,
    model: config.runtime.model,
    effort: config.runtime.effort,
  }, null, 2)}\n`);
} finally {
  await seeded?.stop().catch(() => undefined);
  await interrupted?.stop().catch(() => undefined);
  await recovered?.stop().catch(() => undefined);
  store.close();
}

function seedPrompt(contextMarker) {
  return `
[宿主离线验证事件；不是 Channel 消息]
记住上下文标记“${contextMarker}”，供后续 turn 回忆。本轮禁止发言，返回 action="silent"、responsibilityMatch=false、category="seeded"、replyText=""、reasonCode="context_seeded"、workType="discussion"、delegation="not_required"。
`.trim();
}

function interruptPrompt() {
  return `
[宿主离线中断验证事件；不是 Channel 消息]
分析这个控制事件并准备严格 silent 决策；宿主会在运行中终止本轮，本轮任何未完成输出都不得发送。
`.trim();
}

function recallPrompt() {
  return `
[宿主离线恢复验证事件；不是 Channel 消息]
恢复后从当前固定 session 的既有上下文中找出上一轮要求记住的标记（本提示没有给出标记内容），把该标记原样放入 category。其余字段返回 action="silent"、responsibilityMatch=false、replyText=""、reasonCode="context_recalled"、workType="discussion"、delegation="not_required"。
`.trim();
}
