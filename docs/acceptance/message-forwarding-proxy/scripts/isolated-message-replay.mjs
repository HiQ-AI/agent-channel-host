import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { validateConfig } from '../../../../dist/src/config.js';
import { CodexRuntimeAdapter } from '../../../../dist/src/codex-runtime.js';
import { ConversationWorker } from '../../../../dist/src/actor.js';
import { Store } from '../../../../dist/src/store.js';

const instanceDirectoryArg = process.argv[2];
const conversationTitleArg = process.argv[3];
if (!instanceDirectoryArg || !conversationTitleArg) {
  throw new Error('用法：node isolated-message-replay.mjs <copied-instance-directory> <conversation-title>');
}
const instanceDirectory = resolve(instanceDirectoryArg);
const config = validateConfig(YAML.parse(await readFile(resolve(instanceDirectory, 'config.yaml'), 'utf8')));
const store = new Store(resolve(instanceDirectory, 'state.sqlite3'));
const conversation = store.listConversations().find((item) => item.title === conversationTitleArg);
if (!conversation) throw new Error('隔离副本中找不到目标 Conversation');
const target = store.db.prepare(`
  SELECT id,sequence,processing_state FROM inbound_events
  WHERE conversation_id=? ORDER BY sequence
`).all(conversation.id);
if (target.length !== 1 || Number(target[0].sequence) !== 1) {
  throw new Error(`目标消息数量或 sequence 异常：${JSON.stringify(target)}`);
}
if (target[0].processing_state !== 'admitted') {
  throw new Error(`目标消息尚未完成定点 reset：${target[0].processing_state}`);
}

const runtime = await CodexRuntimeAdapter.create(config, store);
const session = runtime.createSession(conversation);
const sent = [];
const logs = [];
const worker = new ConversationWorker(
  config,
  conversation,
  session,
  store,
  {
    send: async (_target, record) => {
      sent.push({ text: record.text, uuid: record.uuid });
    },
  },
  (record) => logs.push(record),
);
try {
  await worker.start();
  worker.signal();
  await waitFor(() => {
    const row = store.db.prepare('SELECT processing_state FROM inbound_events WHERE id=?').get(target[0].id);
    return row?.processing_state === 'completed' || row?.processing_state === 'failed';
  });
  const result = store.db.prepare(`
    SELECT e.processing_state,e.failure_count,e.last_error,d.action,d.reply_text,o.state AS outbox_state
    FROM inbound_events e
    LEFT JOIN decisions d ON d.inbound_event_id=e.id
    LEFT JOIN outbox o ON o.inbound_event_id=e.id
    WHERE e.id=?
  `).get(target[0].id);
  const sessionRecord = store.getSession(conversation.id);
  process.stdout.write(`${JSON.stringify({
    ok: result.processing_state === 'completed',
    result: {
      processingState: result.processing_state,
      failureCount: Number(result.failure_count),
      error: result.last_error,
      action: result.action,
      replyText: result.reply_text,
      outboxState: result.outbox_state,
    },
    sent,
    session: sessionRecord ? {
      generation: sessionRecord.generation,
      providerSessionIdPrefix: sessionRecord.providerSessionId.slice(0, 12),
      lifecycle: sessionRecord.lifecycle,
    } : null,
    logTypes: logs.map((item) => item.type),
  }, null, 2)}\n`);
  if (result.processing_state !== 'completed') process.exitCode = 2;
} finally {
  await worker.stop().catch(() => undefined);
  store.close();
}

async function waitFor(predicate) {
  while (true) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}
