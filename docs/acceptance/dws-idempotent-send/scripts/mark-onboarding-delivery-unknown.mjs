import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../../../dist/src/store.js';

const options = parseArgs(process.argv.slice(2));
const statePath = resolve(options.state);
await access(statePath);
const beforeHash = await sha256(statePath);
const inspection = inspect(statePath, options.conversationId);

if (options.check) {
  const afterHash = await sha256(statePath);
  if (beforeHash !== afterHash) throw new Error('check 模式下 state.sqlite3 内容发生变化');
  process.stdout.write(`${JSON.stringify({
    ok: inspection.blockers.length === 0,
    mode: 'check',
    stateSha256: beforeHash,
    schemaVersion: inspection.schemaVersion,
    target: inspection.publicTarget,
    blockers: inspection.blockers,
    plannedChanges: [
      '备份完整 SQLite/WAL/SHM',
      '迁移到当前 schema',
      '仅把目标 onboarding 从 submitted 改为 delivery_unknown',
      '保留 history、turn、reply、UUID 和其他记录',
    ],
  }, null, 2)}\n`);
  process.exit(inspection.blockers.length === 0 ? 0 : 2);
}

if (inspection.blockers.length > 0) throw new Error(`存在阻断项：${inspection.blockers.join('；')}`);
if (!options.backupDir) throw new Error('apply 模式必须提供 --backup-dir');
const backupDirectory = resolve(options.backupDir);
await assertMissing(backupDirectory);
await mkdir(backupDirectory, { recursive: false });
await backupSqlite(dirname(statePath), backupDirectory);

const store = new Store(statePath);
try {
  const before = readTarget(store.db, options.conversationId);
  if (before.state !== 'submitted') throw new Error(`目标状态已变化：${before.state}`);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const result = store.db.prepare(`
      UPDATE group_onboarding
      SET state='delivery_unknown',error='delivery_unknown:duplicate_uuid',updated_at=?
      WHERE conversation_id=? AND state='submitted'
    `).run(new Date().toISOString(), options.conversationId);
    if (Number(result.changes) !== 1) throw new Error('目标状态更新数量不是 1');
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
  const after = readTarget(store.db, options.conversationId);
  if (after.state !== 'delivery_unknown' || after.error !== 'delivery_unknown:duplicate_uuid') {
    throw new Error('apply 后状态回读不符合预期');
  }
  for (const key of ['history_count', 'history_loaded_at', 'intro_turn_id', 'intro_text', 'intro_uuid']) {
    if (before[key] !== after[key]) throw new Error(`apply 意外修改字段：${key}`);
  }
} finally {
  store.close();
}

const verified = inspect(statePath, options.conversationId);
process.stdout.write(`${JSON.stringify({
  ok: verified.publicTarget.state === 'delivery_unknown',
  mode: 'apply',
  backupDirectory,
  schemaVersion: verified.schemaVersion,
  target: verified.publicTarget,
}, null, 2)}\n`);

function inspect(path, conversationId) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const target = readTarget(db, conversationId);
    const lease = db.prepare("SELECT expires_at_ms FROM host_lease WHERE lease_key='host'").get();
    const blockers = [];
    if (lease && Number(lease.expires_at_ms) > Date.now()) blockers.push('Host lease 仍存活');
    if (target.state !== 'submitted') blockers.push(`目标状态不是待纠正的 submitted：${target.state}`);
    if (!target.intro_text || !target.intro_uuid || !target.intro_turn_id) blockers.push('目标 onboarding 内容不完整');
    return {
      schemaVersion: Number(db.prepare('PRAGMA user_version').get().user_version),
      blockers,
      publicTarget: {
        conversationIdPrefix: conversationId.slice(0, 8),
        state: target.state,
        error: target.error ?? null,
        historyCount: target.history_count ?? null,
        hasTurn: Boolean(target.intro_turn_id),
        hasReply: Boolean(target.intro_text),
        hasUuid: Boolean(target.intro_uuid),
      },
    };
  } finally {
    db.close();
  }
}

function readTarget(db, conversationId) {
  const rows = db.prepare('SELECT * FROM group_onboarding WHERE conversation_id=?').all(conversationId);
  if (rows.length !== 1) throw new Error(`目标 onboarding 匹配数量必须为 1，实际 ${rows.length}`);
  return rows[0];
}

async function backupSqlite(instanceDirectory, backupDirectory) {
  const entries = await readdir(instanceDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || (entry.name !== 'state.sqlite3' && !entry.name.startsWith('state.sqlite3-'))) continue;
    await copyFile(join(instanceDirectory, entry.name), join(backupDirectory, entry.name));
  }
  const copied = join(backupDirectory, basename(options.state));
  if ((await stat(copied)).size === 0) throw new Error('SQLite 备份为空');
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
  if (!values.state || !values.conversationid) throw new Error('必须提供 --state 和 --conversation-id');
  if (Boolean(values.check) === Boolean(values.apply)) throw new Error('必须且只能选择 --check 或 --apply');
  return {
    state: String(values.state),
    conversationId: String(values.conversationid),
    backupDir: values.backupdir ? String(values.backupdir) : null,
    check: Boolean(values.check),
    apply: Boolean(values.apply),
  };
}
