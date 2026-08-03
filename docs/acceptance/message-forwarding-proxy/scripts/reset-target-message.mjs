import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, cp, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../../../dist/src/store.js';

const options = parseArgs(process.argv.slice(2));
const statePath = resolve(options.state);
await access(statePath);
const instanceDirectory = dirname(statePath);
const beforeHash = await sha256(statePath);

const inspection = inspectTarget(statePath, options);
if (options.check) {
  const afterHash = await sha256(statePath);
  if (beforeHash !== afterHash) throw new Error('check 模式下 state.sqlite3 内容发生变化');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: 'check',
    statePath,
    stateSha256: beforeHash,
    target: inspection.target,
    hostRunning: inspection.hostRunning,
    schemaVersion: inspection.schemaVersion,
    blockers: inspection.blockers,
    plannedChanges: [
      '完整备份 state.sqlite3/WAL/SHM、config.yaml 和 recovery 目录',
      '只删除目标入站对应的 decision 和未提交 outbox',
      '只把目标入站恢复为 admitted 并清零失败计数',
      '提升目标 Conversation session generation 并删除旧 provider session 映射',
    ],
  }, null, 2)}\n`);
  process.exit(inspection.blockers.length === 0 ? 0 : 2);
}

if (!options.backupDir) throw new Error('apply 模式必须提供 --backup-dir');
if (inspection.blockers.length > 0) {
  throw new Error(`存在阻断项，拒绝 apply：${inspection.blockers.join('；')}`);
}
const backupDirectory = resolve(options.backupDir);
await assertMissing(backupDirectory);
await mkdir(backupDirectory, { recursive: false });
await backupInstanceState(instanceDirectory, backupDirectory);

const store = new Store(statePath);
try {
  const target = resolveTarget(store.db, options);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const conversation = store.db.prepare(
      'SELECT session_generation FROM conversations WHERE id=?',
    ).get(target.conversationId);
    if (!conversation) throw new Error('目标 Conversation 已不存在');
    const session = store.db.prepare(
      'SELECT provider_session_id FROM runtime_sessions WHERE conversation_id=?',
    ).get(target.conversationId);
    const previousGeneration = Number(conversation.session_generation);
    const nextGeneration = previousGeneration + 1;
    const now = new Date().toISOString();

    store.db.prepare('DELETE FROM outbox WHERE inbound_event_id=?').run(target.eventId);
    store.db.prepare('DELETE FROM decisions WHERE inbound_event_id=?').run(target.eventId);
    store.db.prepare(`
      UPDATE inbound_events SET
        processing_state='admitted',failure_count=0,last_error='manual-target-replay',
        claim_owner=NULL,claim_expires_at_ms=NULL,claimed_at=NULL
      WHERE id=?
    `).run(target.eventId);
    store.db.prepare(`
      INSERT INTO runtime_session_resets(
        id,conversation_id,previous_generation,next_generation,previous_provider_session_id,reason,created_at
      ) VALUES(?,?,?,?,?,'manual-target-replay',?)
    `).run(
      randomUUID(),
      target.conversationId,
      previousGeneration,
      nextGeneration,
      session?.provider_session_id ? String(session.provider_session_id) : null,
      now,
    );
    store.db.prepare('DELETE FROM runtime_sessions WHERE conversation_id=?').run(target.conversationId);
    store.db.prepare('UPDATE conversations SET session_generation=?,updated_at=? WHERE id=?')
      .run(nextGeneration, now, target.conversationId);
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
} finally {
  store.close();
}

const verified = inspectTarget(statePath, options);
if (verified.target.processingState !== 'admitted'
  || verified.target.failureCount !== 0
  || verified.target.hasDecision
  || verified.target.outboxState !== null) {
  throw new Error(`apply 后回读不符合预期：${JSON.stringify(verified.target)}`);
}
process.stdout.write(`${JSON.stringify({
  ok: true,
  mode: 'apply',
  backupDirectory,
  target: verified.target,
  schemaVersion: verified.schemaVersion,
}, null, 2)}\n`);

function inspectTarget(path, input) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const target = resolveTarget(db, input);
    const hostLease = tableExists(db, 'host_lease')
      ? db.prepare("SELECT owner_id,expires_at_ms FROM host_lease WHERE lease_key='host'").get()
      : null;
    const hostRunning = Boolean(hostLease && Number(hostLease.expires_at_ms) > Date.now());
    const pendingOther = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM inbound_events
      WHERE conversation_id=? AND id<>? AND processing_state IN ('admitted','claimed')
    `).get(target.conversationId, target.eventId).count);
    const blockers = [];
    if (hostRunning) blockers.push('Host lease 仍存活，必须先停止唯一 owner');
    if (target.outboxState === 'submitted') blockers.push('目标消息已有 submitted outbox，拒绝重复回复');
    if (!target.isLatest) blockers.push('目标消息不是该 Conversation 最新 sequence，当前 freshness 门禁会抑制回复');
    if (pendingOther > 0) blockers.push('同一 Conversation 还有其他 admitted/claimed 消息');
    return {
      schemaVersion: Number(db.prepare('PRAGMA user_version').get().user_version),
      hostRunning,
      blockers,
      target: {
        conversationIdPrefix: target.conversationId.slice(0, 8),
        eventIdPrefix: target.eventId.slice(0, 8),
        title: target.title,
        sequence: target.sequence,
        processingState: target.processingState,
        failureCount: target.failureCount,
        hasDecision: target.hasDecision,
        outboxState: target.outboxState,
        sessionGeneration: target.sessionGeneration,
        providerSessionIdPrefix: target.providerSessionId?.slice(0, 12) ?? null,
        isLatest: target.isLatest,
      },
    };
  } finally {
    db.close();
  }
}

function resolveTarget(db, input) {
  const sessionGeneration = columnExists(db, 'conversations', 'session_generation')
    ? 'c.session_generation'
    : '1';
  const rows = input.eventId
    ? db.prepare(`
        SELECT c.id AS conversation_id,c.title,${sessionGeneration} AS session_generation,
          e.id AS event_id,e.sequence,e.processing_state,e.failure_count,
          d.inbound_event_id AS decision_id,o.state AS outbox_state,s.provider_session_id,
          (e.sequence=(SELECT MAX(sequence) FROM inbound_events WHERE conversation_id=e.conversation_id)) AS is_latest
        FROM inbound_events e
        JOIN conversations c ON c.id=e.conversation_id
        LEFT JOIN decisions d ON d.inbound_event_id=e.id
        LEFT JOIN outbox o ON o.inbound_event_id=e.id
        LEFT JOIN runtime_sessions s ON s.conversation_id=c.id
        WHERE e.id=?
      `).all(input.eventId)
    : db.prepare(`
        SELECT c.id AS conversation_id,c.title,${sessionGeneration} AS session_generation,
          e.id AS event_id,e.sequence,e.processing_state,e.failure_count,
          d.inbound_event_id AS decision_id,o.state AS outbox_state,s.provider_session_id,
          (e.sequence=(SELECT MAX(sequence) FROM inbound_events WHERE conversation_id=e.conversation_id)) AS is_latest
        FROM inbound_events e
        JOIN conversations c ON c.id=e.conversation_id
        LEFT JOIN decisions d ON d.inbound_event_id=e.id
        LEFT JOIN outbox o ON o.inbound_event_id=e.id
        LEFT JOIN runtime_sessions s ON s.conversation_id=c.id
        WHERE c.title=? AND e.sequence=?
      `).all(input.conversationTitle, input.sequence);
  if (rows.length !== 1) throw new Error(`目标消息匹配数量必须为 1，实际 ${rows.length}`);
  const row = rows[0];
  return {
    conversationId: String(row.conversation_id),
    eventId: String(row.event_id),
    title: String(row.title),
    sequence: Number(row.sequence),
    processingState: String(row.processing_state),
    failureCount: Number(row.failure_count),
    hasDecision: Boolean(row.decision_id),
    outboxState: row.outbox_state ? String(row.outbox_state) : null,
    sessionGeneration: Number(row.session_generation),
    providerSessionId: row.provider_session_id ? String(row.provider_session_id) : null,
    isLatest: Boolean(row.is_latest),
  };
}

async function backupInstanceState(instanceDirectory, backupDirectory) {
  const entries = await readdir(instanceDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const source = join(instanceDirectory, entry.name);
    const destination = join(backupDirectory, entry.name);
    if (entry.isFile() && (
      entry.name === 'config.yaml'
      || entry.name === 'state.sqlite3'
      || entry.name.startsWith('state.sqlite3-')
    )) {
      await copyFile(source, destination);
    } else if (entry.isDirectory() && entry.name === 'recovery') {
      await cp(source, destination, { recursive: true, errorOnExist: true });
    }
  }
  const stateBackup = join(backupDirectory, basename(options.state));
  const info = await stat(stateBackup);
  if (info.size === 0) throw new Error('SQLite 备份为空');
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info("${table}")`).all().some((row) => row.name === column);
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function assertMissing(path) {
  await access(path).then(
    () => { throw new Error(`备份目录已存在，拒绝覆盖：${path}`); },
    () => undefined,
  );
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--check' || token === '--apply') {
      values[token.slice(2)] = true;
      continue;
    }
    if (!token.startsWith('--')) throw new Error(`未知参数：${token}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${token} 缺少值`);
    values[token.slice(2).replaceAll('-', '')] = value;
    index += 1;
  }
  if (!values.state) throw new Error('必须提供 --state');
  if (Boolean(values.check) === Boolean(values.apply)) throw new Error('必须且只能选择 --check 或 --apply');
  const eventId = values.eventid ? String(values.eventid) : null;
  const conversationTitle = values.conversationtitle ? String(values.conversationtitle) : null;
  const sequence = values.sequence === undefined ? null : Number(values.sequence);
  if (!eventId && (!conversationTitle || !Number.isInteger(sequence) || sequence < 1)) {
    throw new Error('必须提供 --event-id，或同时提供 --conversation-title 与正整数 --sequence');
  }
  if (eventId && (conversationTitle || sequence !== null)) {
    throw new Error('--event-id 与 title/sequence 选择器不能混用');
  }
  return {
    state: String(values.state),
    check: Boolean(values.check),
    apply: Boolean(values.apply),
    backupDir: values.backupdir ? String(values.backupdir) : null,
    eventId,
    conversationTitle,
    sequence,
  };
}
