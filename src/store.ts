import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type {
  AdmittedEvent,
  Conversation,
  ConversationKind,
  ConversationMode,
  Decision,
  GroupOnboardingRecord,
  NormalizedEvent,
  OutboxRecord,
  SessionRecord,
} from './types.js';

type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('group','direct')),
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        responsibility TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('shadow','reply')),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(kind, external_id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        lifecycle TEXT NOT NULL CHECK(lifecycle IN ('provisioning','ready','failed')),
        codex_version TEXT NOT NULL,
        schema_sha256 TEXT NOT NULL,
        runtime_cwd TEXT NOT NULL,
        bootstrap_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbound_events (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        event_id TEXT,
        message_id TEXT,
        sender_id TEXT,
        sender_name TEXT,
        body_json TEXT NOT NULL,
        occurred_at TEXT,
        received_at TEXT NOT NULL,
        processing_state TEXT NOT NULL DEFAULT 'admitted',
        UNIQUE(conversation_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS decisions (
        inbound_event_id TEXT PRIMARY KEY REFERENCES inbound_events(id) ON DELETE CASCADE,
        turn_id TEXT,
        turn_status TEXT NOT NULL,
        action TEXT,
        responsibility_match INTEGER,
        category TEXT,
        reply_text TEXT,
        reason_code TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        inbound_event_id TEXT NOT NULL UNIQUE REFERENCES inbound_events(id) ON DELETE CASCADE,
        input_sequence INTEGER NOT NULL,
        uuid TEXT NOT NULL UNIQUE,
        text TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','sending','submitted','failed','suppressed')),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS host_lease (
        lease_key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_inbound_conversation_sequence
        ON inbound_events(conversation_id, sequence DESC);
      CREATE INDEX IF NOT EXISTS idx_outbox_state ON outbox(state, created_at);
    `);
    const version = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (version < 2) {
      this.db.exec(`
        ALTER TABLE decisions ADD COLUMN work_type TEXT;
        ALTER TABLE decisions ADD COLUMN delegation TEXT;
        ALTER TABLE decisions ADD COLUMN subagent_thread_id TEXT;
        CREATE TABLE group_onboarding (
          conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
          state TEXT NOT NULL CHECK(state IN ('pending','prepared','sending','submitted','failed')),
          history_count INTEGER,
          history_loaded_at TEXT,
          intro_turn_id TEXT,
          intro_text TEXT,
          intro_uuid TEXT UNIQUE,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO group_onboarding(conversation_id,state,created_at,updated_at)
          SELECT id,'pending',created_at,updated_at FROM conversations WHERE kind='group';
        PRAGMA user_version=2;
      `);
    }
  }

  addConversation(input: {
    kind: ConversationKind;
    externalId: string;
    title: string;
    responsibility: string;
    mode: ConversationMode;
  }): Conversation {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO conversations(id,kind,external_id,title,responsibility,mode,enabled,created_at,updated_at)
        VALUES(?,?,?,?,?,?,1,?,?)
      `).run(id, input.kind, input.externalId, input.title, input.responsibility, input.mode, now, now);
      if (input.kind === 'group') {
        this.db.prepare(`
          INSERT INTO group_onboarding(conversation_id,state,created_at,updated_at) VALUES(?,'pending',?,?)
        `).run(id, now, now);
      }
      this.db.exec('COMMIT');
      return this.getConversation(id)!;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  setConversationEnabled(id: string, enabled: boolean): boolean {
    const result = this.db.prepare('UPDATE conversations SET enabled=?,updated_at=? WHERE id=?')
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
    return Number(result.changes) === 1;
  }

  setConversationMode(id: string, mode: ConversationMode): boolean {
    const result = this.db.prepare('UPDATE conversations SET mode=?,updated_at=? WHERE id=?')
      .run(mode, new Date().toISOString(), id);
    return Number(result.changes) === 1;
  }

  getConversation(id: string): Conversation | null {
    return mapConversation(this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as Row | undefined);
  }

  findEnabledConversation(kind: ConversationKind, externalId: string): Conversation | null {
    return mapConversation(this.db.prepare(
      'SELECT * FROM conversations WHERE kind=? AND external_id=? AND enabled=1',
    ).get(kind, externalId) as Row | undefined);
  }

  listConversations(enabledOnly = false): Conversation[] {
    const sql = `SELECT * FROM conversations${enabledOnly ? ' WHERE enabled=1' : ''} ORDER BY kind,title`;
    return (this.db.prepare(sql).all() as Row[]).map((row) => mapConversation(row)!);
  }

  getSession(conversationId: string): SessionRecord | null {
    return mapSession(this.db.prepare('SELECT * FROM sessions WHERE conversation_id=?').get(conversationId) as Row | undefined);
  }

  saveSession(session: SessionRecord): void {
    this.db.prepare(`
      INSERT INTO sessions(conversation_id,thread_id,lifecycle,codex_version,schema_sha256,runtime_cwd,bootstrap_turn_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        thread_id=excluded.thread_id,lifecycle=excluded.lifecycle,codex_version=excluded.codex_version,
        schema_sha256=excluded.schema_sha256,runtime_cwd=excluded.runtime_cwd,
        bootstrap_turn_id=excluded.bootstrap_turn_id,updated_at=excluded.updated_at
    `).run(
      session.conversationId, session.threadId, session.lifecycle, session.codexVersion,
      session.schemaSha256, session.runtimeCwd, session.bootstrapTurnId,
      session.createdAt, session.updatedAt,
    );
  }

  admitEvent(conversation: Conversation, event: NormalizedEvent): { admitted: boolean; event: AdmittedEvent | null } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const duplicate = this.db.prepare('SELECT id FROM inbound_events WHERE fingerprint=?').get(event.fingerprint);
      if (duplicate) {
        this.db.exec('COMMIT');
        return { admitted: false, event: null };
      }
      const latest = this.db.prepare(
        'SELECT COALESCE(MAX(sequence),0) AS sequence FROM inbound_events WHERE conversation_id=?',
      ).get(conversation.id) as Row;
      const sequence = Number(latest.sequence) + 1;
      const id = randomUUID();
      const body = JSON.stringify({
        content: event.content,
        quotedMessage: event.quotedMessage,
        forwardedMessages: event.forwardedMessages,
      });
      this.db.prepare(`
        INSERT INTO inbound_events(
          id,conversation_id,sequence,fingerprint,event_id,message_id,sender_id,sender_name,
          body_json,occurred_at,received_at,processing_state
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'admitted')
      `).run(
        id, conversation.id, sequence, event.fingerprint, event.eventId, event.messageId,
        event.senderId, event.senderName, body, event.occurredAt, event.receivedAt,
      );
      this.db.exec('COMMIT');
      return { admitted: true, event: { ...event, id, conversationId: conversation.id, sequence } };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordDecision(
    eventId: string,
    turnId: string | null,
    turnStatus: string,
    decision: Decision | null,
    subagentThreadId: string | null = null,
  ): void {
    this.db.prepare(`
      INSERT INTO decisions(
        inbound_event_id,turn_id,turn_status,action,responsibility_match,category,reply_text,reason_code,
        work_type,delegation,subagent_thread_id,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(inbound_event_id) DO UPDATE SET
        turn_id=excluded.turn_id,turn_status=excluded.turn_status,action=excluded.action,
        responsibility_match=excluded.responsibility_match,category=excluded.category,
        reply_text=excluded.reply_text,reason_code=excluded.reason_code,work_type=excluded.work_type,
        delegation=excluded.delegation,subagent_thread_id=excluded.subagent_thread_id,created_at=excluded.created_at
    `).run(
      eventId, turnId, turnStatus, decision?.action ?? null,
      decision ? (decision.responsibilityMatch ? 1 : 0) : null,
      decision?.category ?? null, decision?.replyText ?? null, decision?.reasonCode ?? null,
      decision?.workType ?? null, decision?.delegation ?? null, subagentThreadId,
      new Date().toISOString(),
    );
    this.db.prepare('UPDATE inbound_events SET processing_state=? WHERE id=?').run(turnStatus, eventId);
  }

  enqueueOutbox(event: AdmittedEvent, text: string, uuid: string): OutboxRecord | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const latest = this.latestSequence(event.conversationId);
      if (latest !== event.sequence) {
        this.db.exec('COMMIT');
        return null;
      }
      const now = new Date().toISOString();
      const id = randomUUID();
      this.db.prepare(`
        INSERT INTO outbox(id,conversation_id,inbound_event_id,input_sequence,uuid,text,state,error,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'pending',NULL,?,?)
      `).run(id, event.conversationId, event.id, event.sequence, uuid, text, now, now);
      this.db.exec('COMMIT');
      return this.getOutbox(id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  claimOutboxIfFresh(id: string): OutboxRecord | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.getOutbox(id);
      if (!row || row.state !== 'pending') {
        this.db.exec('COMMIT');
        return null;
      }
      const now = new Date().toISOString();
      if (this.latestSequence(row.conversationId) !== row.inputSequence) {
        this.db.prepare("UPDATE outbox SET state='suppressed',error='newer-message-admitted',updated_at=? WHERE id=?")
          .run(now, id);
        this.db.exec('COMMIT');
        return null;
      }
      this.db.prepare("UPDATE outbox SET state='sending',updated_at=? WHERE id=? AND state='pending'").run(now, id);
      this.db.exec('COMMIT');
      return this.getOutbox(id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  finishOutbox(id: string, state: 'submitted' | 'failed', error: string | null): void {
    this.db.prepare('UPDATE outbox SET state=?,error=?,updated_at=? WHERE id=?')
      .run(state, error, new Date().toISOString(), id);
  }

  getOutbox(id: string): OutboxRecord | null {
    return mapOutbox(this.db.prepare('SELECT * FROM outbox WHERE id=?').get(id) as Row | undefined);
  }

  latestSequence(conversationId: string): number {
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(sequence),0) AS sequence FROM inbound_events WHERE conversation_id=?',
    ).get(conversationId) as Row;
    return Number(row.sequence);
  }

  getGroupOnboarding(conversationId: string): GroupOnboardingRecord | null {
    return mapGroupOnboarding(this.db.prepare(
      'SELECT * FROM group_onboarding WHERE conversation_id=?',
    ).get(conversationId) as Row | undefined);
  }

  prepareGroupOnboarding(
    conversationId: string,
    historyCount: number,
    introTurnId: string,
    introText: string,
    introUuid: string,
  ): GroupOnboardingRecord {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE group_onboarding SET
        state='prepared',history_count=?,history_loaded_at=?,intro_turn_id=?,intro_text=?,intro_uuid=?,
        error=NULL,updated_at=?
      WHERE conversation_id=? AND state<>'submitted'
    `).run(historyCount, now, introTurnId, introText, introUuid, now, conversationId);
    const record = this.getGroupOnboarding(conversationId);
    if (!record) throw new Error(`群 onboarding 不存在：${conversationId}`);
    return record;
  }

  claimGroupOnboardingIntro(conversationId: string): GroupOnboardingRecord | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getGroupOnboarding(conversationId);
      if (!current || current.state === 'submitted' || !current.introText || !current.introUuid) {
        this.db.exec('COMMIT');
        return null;
      }
      this.db.prepare("UPDATE group_onboarding SET state='sending',error=NULL,updated_at=? WHERE conversation_id=?")
        .run(new Date().toISOString(), conversationId);
      this.db.exec('COMMIT');
      return this.getGroupOnboarding(conversationId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  finishGroupOnboardingIntro(conversationId: string, state: 'submitted' | 'failed', error: string | null): void {
    this.db.prepare('UPDATE group_onboarding SET state=?,error=?,updated_at=? WHERE conversation_id=?')
      .run(state, error, new Date().toISOString(), conversationId);
  }

  acquireLease(key: string, ownerId: string, nowMs: number, ttlMs: number): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT * FROM host_lease WHERE lease_key=?').get(key) as Row | undefined;
      if (current && Number(current.expires_at_ms) > nowMs && current.owner_id !== ownerId) {
        this.db.exec('COMMIT');
        return false;
      }
      this.db.prepare(`
        INSERT INTO host_lease(lease_key,owner_id,expires_at_ms,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(lease_key) DO UPDATE SET owner_id=excluded.owner_id,expires_at_ms=excluded.expires_at_ms,updated_at=excluded.updated_at
      `).run(key, ownerId, nowMs + ttlMs, new Date(nowMs).toISOString());
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  renewLease(key: string, ownerId: string, nowMs: number, ttlMs: number): boolean {
    const result = this.db.prepare(
      'UPDATE host_lease SET expires_at_ms=?,updated_at=? WHERE lease_key=? AND owner_id=?',
    ).run(nowMs + ttlMs, new Date(nowMs).toISOString(), key, ownerId);
    return Number(result.changes) === 1;
  }

  releaseLease(key: string, ownerId: string): void {
    this.db.prepare('DELETE FROM host_lease WHERE lease_key=? AND owner_id=?').run(key, ownerId);
  }

  status(): Record<string, unknown> {
    const counts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM conversations WHERE enabled=1) AS enabled_conversations,
        (SELECT COUNT(*) FROM sessions WHERE lifecycle='ready') AS recoverable_sessions,
        (SELECT COUNT(*) FROM inbound_events) AS received,
        (SELECT COUNT(*) FROM decisions WHERE turn_status='completed') AS processed,
        (SELECT COUNT(*) FROM outbox WHERE state='submitted') AS submitted,
        (SELECT COUNT(*) FROM outbox WHERE state IN ('pending','sending')) AS pending_outbox,
        (SELECT COUNT(*) FROM group_onboarding WHERE state<>'submitted') AS pending_group_onboarding
    `).get() as Row;
    const sessions = this.db.prepare(`
      SELECT c.title,c.kind,s.thread_id,s.lifecycle,s.updated_at
      FROM sessions s JOIN conversations c ON c.id=s.conversation_id ORDER BY c.title
    `).all() as Row[];
    const lease = this.db.prepare(
      'SELECT expires_at_ms,updated_at FROM host_lease WHERE lease_key=?',
    ).get('host') as Row | undefined;
    return {
      ...counts,
      hostState: lease && Number(lease.expires_at_ms) > Date.now() ? 'running' : 'stopped',
      hostHeartbeatAt: lease?.updated_at ?? null,
      sessions: sessions.map((row) => ({
        title: row.title,
        kind: row.kind,
        threadIdPrefix: String(row.thread_id).slice(0, 12),
        lifecycle: row.lifecycle,
        updatedAt: row.updated_at,
      })),
    };
  }
}

function mapConversation(row: Row | undefined): Conversation | null {
  if (!row) return null;
  return {
    id: String(row.id), kind: row.kind as ConversationKind, externalId: String(row.external_id),
    title: String(row.title), responsibility: String(row.responsibility), mode: row.mode as ConversationMode,
    enabled: Boolean(row.enabled), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function mapSession(row: Row | undefined): SessionRecord | null {
  if (!row) return null;
  return {
    conversationId: String(row.conversation_id), threadId: String(row.thread_id),
    lifecycle: row.lifecycle as SessionRecord['lifecycle'], codexVersion: String(row.codex_version),
    schemaSha256: String(row.schema_sha256), runtimeCwd: String(row.runtime_cwd),
    bootstrapTurnId: row.bootstrap_turn_id ? String(row.bootstrap_turn_id) : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function mapOutbox(row: Row | undefined): OutboxRecord | null {
  if (!row) return null;
  return {
    id: String(row.id), conversationId: String(row.conversation_id), inboundEventId: String(row.inbound_event_id),
    inputSequence: Number(row.input_sequence), uuid: String(row.uuid), text: String(row.text),
    state: row.state as OutboxRecord['state'], error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function mapGroupOnboarding(row: Row | undefined): GroupOnboardingRecord | null {
  if (!row) return null;
  return {
    conversationId: String(row.conversation_id),
    state: row.state as GroupOnboardingRecord['state'],
    historyCount: row.history_count === null ? null : Number(row.history_count),
    historyLoadedAt: row.history_loaded_at ? String(row.history_loaded_at) : null,
    introTurnId: row.intro_turn_id ? String(row.intro_turn_id) : null,
    introText: row.intro_text ? String(row.intro_text) : null,
    introUuid: row.intro_uuid ? String(row.intro_uuid) : null,
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
