import { access, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defaultConfig } from '../../../../dist/src/config.js';
import { Store } from '../../../../dist/src/store.js';
import { verifyCodexProtocol } from '../../../../dist/src/protocol.js';
import { AppServerSession } from '../../../../dist/src/app-server.js';

const root = resolve(process.argv[2] ?? '.delegation-canary');
const marker = join(root, 'worker-done.txt');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const config = defaultConfig('delegation-canary', root, '验证员工', '验证主会话后台委派');
const store = new Store(join(root, 'state.sqlite3'));
const conversation = store.addConversation({
  kind: 'direct',
  externalId: 'canary-user',
  title: '后台委派 canary',
  responsibility: '只验证后台 worker 委派',
  mode: 'shadow',
});
let session;
const observedItems = [];
try {
  const protocol = await verifyCodexProtocol(config, join(root, 'protocol'));
  session = new AppServerSession(config, conversation, protocol, store, (method, params) => {
    if (!method.startsWith('item/')) return;
    const item = params.item ?? {};
    observedItems.push({
      method,
      threadId: params.threadId ?? null,
      turnId: params.turnId ?? null,
      type: item.type ?? null,
      tool: item.tool ?? null,
      status: item.status ?? null,
      senderThreadId: item.senderThreadId ?? null,
      receiverThreadIds: item.receiverThreadIds ?? null,
      agentThreadId: item.agentThreadId ?? null,
      agentPath: item.agentPath ?? null,
      kind: item.kind ?? null,
    });
  });
  await session.start();
  const startedAt = Date.now();
  const result = await session.runDecision(`
[宿主离线验收事件；不是钉钉消息]
这是一个具体实施任务。主会话必须调用 spawn_agent 派发一个后台 worker，worker 的唯一任务是：先执行 PowerShell “Start-Sleep -Seconds 15”，然后使用 apply_patch 创建文件“${marker}”，内容为 WORKER_DONE。主会话不得自己执行命令或修改文件，也不得 wait_agent 等待 worker；派发成功后立即返回 action="reply"、responsibilityMatch=true、category="delegation_canary"、replyText="已派后台 worker 处理，我继续保持在线。\\n\\n- 验证员工代回"、reasonCode="worker_started"、workType="implementation"、delegation="started"。
`.trim());
  const mainCompletedAt = Date.now();
  let markerAt = null;
  try {
    await access(marker);
    markerAt = Date.now();
  } catch {
    // Worker should still be running when the main turn returns.
  }
  if (markerAt !== null) throw new Error('主 turn 返回前 worker 已完成，未证明后台运行');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await access(marker);
      markerAt = Date.now();
      break;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  if (markerAt === null) throw new Error('主 turn 返回后 60 秒内 worker 未完成 marker');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mainTurnIdPrefix: result.turnId.slice(0, 12),
    subagentThreadIdPrefix: result.subagentThreadId?.slice(0, 12) ?? null,
    mainElapsedMs: mainCompletedAt - startedAt,
    workerCompletedAfterMainMs: markerAt - mainCompletedAt,
    decision: result.decision,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message, observedItems }, null, 2)}\n`);
  throw error;
} finally {
  await session?.stop().catch(() => undefined);
  store.close();
}
