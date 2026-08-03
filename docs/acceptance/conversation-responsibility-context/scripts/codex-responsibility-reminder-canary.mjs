import { access, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defaultConfig } from '../../../../dist/src/config.js';
import { CodexCommandSession, verifyCodexCommand } from '../../../../dist/src/codex-command.js';
import { Store } from '../../../../dist/src/store.js';

const rootArg = process.argv[2];
if (!rootArg) throw new Error('用法：node codex-responsibility-reminder-canary.mjs <empty-state-directory>');
const root = resolve(rootArg);
const statePath = join(root, 'state.sqlite3');
await access(statePath).then(
  () => { throw new Error(`状态库已存在，拒绝覆盖：${statePath}`); },
  () => undefined,
);
await mkdir(root, { recursive: true });

const firstProbe = `RESPONSIBILITY-OK-${Date.now().toString(36)}`;
const changedProbe = `RESPONSIBILITY-CHANGED-${Date.now().toString(36)}`;
const config = defaultConfig('responsibility-canary', resolve('..'), 'Canary');
const store = new Store(statePath);
const conversation = store.addConversation({
  kind: 'direct',
  externalId: 'offline-responsibility-canary',
  title: 'Offline responsibility canary',
  responsibility: `收到内容恰好为 RESPONSIBILITY_CHECK 时返回 reply，replyText 只写 ${firstProbe}；其他消息返回 silent。`,
  mode: 'shadow',
  channelId: config.channel.id,
  channelProfileId: config.channel.profileId,
  runtimeId: config.runtime.id,
  workerWarmSeconds: 0,
});
const runtime = await verifyCodexCommand(config);
const session = new CodexCommandSession(config, conversation, runtime, store);
try {
  const startup = await session.start();
  const seeded = await session.runDecision(message('初始化职责上下文'));
  const providerSessionId = session.currentSessionId;
  if (!providerSessionId || seeded.decision?.action !== 'silent') throw new Error('首轮职责提醒未完成 silent 初始化');

  const retained = await session.runDecision(message('RESPONSIBILITY_CHECK'));
  if (retained.decision?.action !== 'reply' || retained.decision.replyText.trim() !== firstProbe) {
    throw new Error(`第二轮未沿用同一 session 中的职责：${JSON.stringify(retained.decision)}`);
  }

  store.setConversationResponsibility(
    conversation.id,
    `收到内容恰好为 RESPONSIBILITY_CHANGED_CHECK 时返回 reply，replyText 只写 ${changedProbe}；其他消息返回 silent。`,
  );
  const changed = await session.runDecision(message('RESPONSIBILITY_CHANGED_CHECK'));
  if (changed.decision?.action !== 'reply' || changed.decision.replyText.trim() !== changedProbe) {
    throw new Error(`职责变更后的首轮未生效：${JSON.stringify(changed.decision)}`);
  }
  if (session.currentSessionId !== providerSessionId) throw new Error('职责变更错误地创建了新 provider session');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    startupMode: startup.mode,
    sameProviderSessionId: true,
    retainedWithoutSecondReminder: true,
    changedResponsibilityAppliedNextTurn: true,
    providerSessionIdPrefix: providerSessionId.slice(0, 12),
    runtimeVersion: runtime.version,
    model: config.runtime.model,
    effort: config.runtime.effort,
  }, null, 2)}\n`);
} finally {
  await session.stop().catch(() => undefined);
  store.close();
}

function message(content) {
  return `以下是收到的消息：\n\n消息 1\n发送者：离线验证者\n时间：2026-08-03 20:00:00\n内容：${content}\n\n处理完成后只返回一个 JSON：\n- 不需要回复：{"action":"silent","replyText":""}\n- 需要回复：{"action":"reply","replyText":"回复内容"}`;
}
