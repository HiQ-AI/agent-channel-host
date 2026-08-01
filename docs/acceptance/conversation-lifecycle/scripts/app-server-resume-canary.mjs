import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defaultConfig } from '../../../../dist/src/config.js';
import { Store } from '../../../../dist/src/store.js';
import { verifyCodexProtocol } from '../../../../dist/src/protocol.js';
import { AppServerSession } from '../../../../dist/src/app-server.js';

const root = resolve(process.argv[2] ?? '.resume-canary');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const config = defaultConfig('resume-canary', root, '验证员工', '验证空闲释放后恢复原会话');
const store = new Store(join(root, 'state.sqlite3'));
const conversation = store.addConversation({
  kind: 'direct', externalId: 'resume-canary-user', title: '恢复 canary',
  responsibility: '只验证 thread 恢复', mode: 'shadow', sessionLifecycle: 'idle', idleTimeoutMinutes: 5,
});
let first;
let second;
try {
  const protocol = await verifyCodexProtocol(config, join(root, 'protocol'));
  first = new AppServerSession(config, conversation, protocol, store);
  const started = await first.start();
  await first.stop();
  first = null;

  second = new AppServerSession(config, conversation, protocol, store);
  const resumed = await second.start();
  if (resumed.mode !== 'resumed') throw new Error(`第二次启动未 resume：${resumed.mode}`);
  if (resumed.threadId !== started.threadId) throw new Error('resume 返回了不同 thread ID');
  const decision = await second.runDecision(`
[宿主离线恢复验收事件；不是钉钉消息]
当前没有待处理消息，禁止发言。返回 action="silent"、responsibilityMatch=false、category="resume_canary"、replyText=""、reasonCode="resumed"、workType="discussion"、delegation="not_required"。
`.trim());
  if (decision.status !== 'completed' || decision.decision?.action !== 'silent') {
    throw new Error('恢复后的固定 thread 未完成 silent turn');
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    firstMode: started.mode,
    secondMode: resumed.mode,
    sameThreadId: resumed.threadId === started.threadId,
    threadIdPrefix: resumed.threadId.slice(0, 12),
    turnIdPrefix: decision.turnId.slice(0, 12),
  }, null, 2)}\n`);
} finally {
  await first?.stop().catch(() => undefined);
  await second?.stop().catch(() => undefined);
  store.close();
}
