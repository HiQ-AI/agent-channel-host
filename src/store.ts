import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_WORKER_WARM_SECONDS, MAX_RECOVERY_ATTEMPTS, MAX_WORKER_WARM_SECONDS } from './types.js';
import type {
  AdmittedEvent,
  Conversation,
  ConversationContext,
  ConversationKind,
  ConversationMember,
  ConversationMode,
  GroupOnboardingRecord,
  NormalizedEvent,
  OutboxRecord,
  RuntimeWorkerRecord,
  SessionRecord,
} from './types.js';
import { safeName } from './paths.js';
import { displayConversationTitle } from './conversation-title.js';

type Row = Record<string, unknown>;
const LEGACY_MAX_IDLE_TIMEOUT_MINUTES = 35_791;

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    try {
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  recoveryContextFile(conversationId: string): string {
    if (this.path === ':memory:') throw new Error('内存数据库没有 recovery context 文件');
    return join(dirname(this.path), 'recovery', `${safeName(conversationId)}.json`);
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
    const upgradedVersion = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (upgradedVersion < 3) {
      this.db.exec(`
        ALTER TABLE conversations ADD COLUMN session_lifecycle TEXT NOT NULL DEFAULT 'resident'
          CHECK(session_lifecycle IN ('resident','idle'));
        ALTER TABLE conversations ADD COLUMN idle_timeout_minutes INTEGER NOT NULL DEFAULT 5
          CHECK(idle_timeout_minutes BETWEEN 1 AND ${LEGACY_MAX_IDLE_TIMEOUT_MINUTES});
        UPDATE conversations SET session_lifecycle='idle' WHERE kind='direct';
        PRAGMA user_version=3;
      `);
    }
    const lifecycleVersion = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (lifecycleVersion < 4) {
      this.db.exec('PRAGMA foreign_keys=OFF');
      try {
        this.db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE conversations_v4 (
            id TEXT PRIMARY KEY,
            channel_id TEXT NOT NULL,
            channel_profile_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('group','direct')),
            external_id TEXT NOT NULL,
            title TEXT NOT NULL,
            responsibility TEXT NOT NULL,
            mode TEXT NOT NULL CHECK(mode IN ('shadow','reply')),
            runtime_id TEXT NOT NULL,
            worker_warm_seconds INTEGER NOT NULL DEFAULT ${DEFAULT_WORKER_WARM_SECONDS}
              CHECK(worker_warm_seconds BETWEEN 0 AND ${MAX_WORKER_WARM_SECONDS}),
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(channel_id,channel_profile_id,kind,external_id)
          );
          INSERT INTO conversations_v4(
            id,channel_id,channel_profile_id,kind,external_id,title,responsibility,mode,
            runtime_id,worker_warm_seconds,enabled,created_at,updated_at
          )
          SELECT id,'dingtalk','default',kind,external_id,title,responsibility,mode,
            'codex',${DEFAULT_WORKER_WARM_SECONDS},enabled,created_at,updated_at
          FROM conversations;
          DROP TABLE conversations;
          ALTER TABLE conversations_v4 RENAME TO conversations;

          CREATE TABLE runtime_sessions (
            conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
            runtime_id TEXT NOT NULL,
            provider_session_id TEXT NOT NULL,
            generation INTEGER NOT NULL CHECK(generation > 0),
            lifecycle TEXT NOT NULL CHECK(lifecycle IN ('provisioning','ready','failed')),
            protocol_fingerprint TEXT NOT NULL,
            runtime_cwd TEXT NOT NULL,
            bootstrap_turn_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO runtime_sessions(
            conversation_id,runtime_id,provider_session_id,generation,lifecycle,
            protocol_fingerprint,runtime_cwd,bootstrap_turn_id,created_at,updated_at
          )
          SELECT conversation_id,'codex',thread_id,1,lifecycle,
            codex_version || ':' || schema_sha256,runtime_cwd,bootstrap_turn_id,created_at,updated_at
          FROM sessions;
          DROP TABLE sessions;

          ALTER TABLE inbound_events ADD COLUMN claim_owner TEXT;
          ALTER TABLE inbound_events ADD COLUMN claim_expires_at_ms INTEGER;
          ALTER TABLE inbound_events ADD COLUMN claimed_at TEXT;
          CREATE INDEX idx_inbound_pending ON inbound_events(conversation_id,processing_state,sequence);

          CREATE TABLE runtime_workers (
            conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
            worker_id TEXT,
            runtime_id TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('starting','running','warm','stopped','error')),
            process_id INTEGER,
            claimed_from_sequence INTEGER,
            claimed_to_sequence INTEGER,
            last_signal_at TEXT,
            warm_until TEXT,
            error TEXT,
            started_at TEXT,
            updated_at TEXT NOT NULL
          );
          INSERT INTO runtime_workers(conversation_id,runtime_id,state,updated_at)
            SELECT id,runtime_id,'stopped',updated_at FROM conversations;

          CREATE TABLE channel_connections (
            channel_id TEXT NOT NULL,
            profile_id TEXT NOT NULL,
            label TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('starting','ready','stopped','error')),
            owner_pid INTEGER,
            connected_at TEXT,
            last_event_at TEXT,
            error TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(channel_id,profile_id)
          );
          CREATE TABLE runtime_adapters (
            runtime_id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('starting','ready','stopped','error')),
            model TEXT,
            protocol_fingerprint TEXT,
            error TEXT,
            updated_at TEXT NOT NULL
          );
          PRAGMA user_version=4;
          COMMIT;
        `);
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* transaction was not active */ }
        throw error;
      } finally {
        this.db.exec('PRAGMA foreign_keys=ON');
      }
    }
    const eventWorkerVersion = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (eventWorkerVersion < 5) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE conversations ADD COLUMN policy_version INTEGER NOT NULL DEFAULT 1
          CHECK(policy_version > 0);
        ALTER TABLE runtime_adapters ADD COLUMN context_recovery TEXT;
        CREATE TABLE conversation_context (
          conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
          version INTEGER NOT NULL CHECK(version > 0),
          through_sequence INTEGER NOT NULL CHECK(through_sequence >= 0),
          current_topic TEXT NOT NULL,
          facts_json TEXT NOT NULL,
          decisions_json TEXT NOT NULL,
          commitments_json TEXT NOT NULL,
          open_questions_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE conversation_members (
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          external_user_id TEXT NOT NULL,
          display_name TEXT,
          organization_role TEXT NOT NULL DEFAULT '',
          conversation_role TEXT NOT NULL DEFAULT '',
          responsibility_boundary TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL CHECK(source IN ('message','manual')),
          version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
          updated_at TEXT NOT NULL,
          PRIMARY KEY(conversation_id,external_user_id)
        );
        CREATE INDEX idx_conversation_members_name
          ON conversation_members(conversation_id,display_name);
        PRAGMA user_version=5;
        COMMIT;
      `);
    }
    const contextVersion = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (contextVersion < 6) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE channel_connections_v6 (
          channel_id TEXT NOT NULL,
          profile_id TEXT NOT NULL,
          label TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('starting','ready','stopped','disabled','error')),
          owner_pid INTEGER,
          connected_at TEXT,
          last_event_at TEXT,
          error TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(channel_id,profile_id)
        );
        INSERT INTO channel_connections_v6(
          channel_id,profile_id,label,state,owner_pid,connected_at,last_event_at,error,updated_at
        )
          SELECT channel_id,profile_id,label,state,owner_pid,connected_at,last_event_at,error,updated_at
          FROM channel_connections;
        DROP TABLE channel_connections;
        ALTER TABLE channel_connections_v6 RENAME TO channel_connections;
        PRAGMA user_version=6;
        COMMIT;
      `);
    }
    const channelVersion = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (channelVersion < 7) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE inbound_events ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0
          CHECK(failure_count >= 0);
        ALTER TABLE inbound_events ADD COLUMN last_error TEXT;
        UPDATE inbound_events SET failure_count=1 WHERE processing_state='failed';
        ALTER TABLE outbox ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0
          CHECK(attempt_count >= 0);
        UPDATE outbox SET attempt_count=1 WHERE state IN ('sending','submitted','failed');
        PRAGMA user_version=7;
        COMMIT;
      `);
    }
    const sessionGenerationVersion = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (sessionGenerationVersion < 8) {
      const resetPendingOnboarding = this.db.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='group_onboarding'",
      ).get() ? `
        UPDATE group_onboarding SET
          state='pending',history_count=NULL,history_loaded_at=NULL,intro_turn_id=NULL,
          intro_text=NULL,intro_uuid=NULL,error=NULL,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE state<>'submitted';
      ` : '';
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE conversations ADD COLUMN session_generation INTEGER NOT NULL DEFAULT 1
          CHECK(session_generation > 0);
        UPDATE conversations SET session_generation=COALESCE(
          (SELECT generation FROM runtime_sessions s WHERE s.conversation_id=conversations.id),
          1
        );
        ${resetPendingOnboarding}
        CREATE TABLE runtime_session_resets (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          previous_generation INTEGER NOT NULL,
          next_generation INTEGER NOT NULL,
          previous_provider_session_id TEXT,
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_runtime_session_resets_conversation
          ON runtime_session_resets(conversation_id,created_at);
        PRAGMA user_version=8;
        COMMIT;
      `);
    }
    const deliveryStateVersion = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (deliveryStateVersion < 9) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS group_onboarding (
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
        BEGIN IMMEDIATE;
        CREATE TABLE outbox_v9 (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          inbound_event_id TEXT NOT NULL UNIQUE REFERENCES inbound_events(id) ON DELETE CASCADE,
          input_sequence INTEGER NOT NULL,
          uuid TEXT NOT NULL UNIQUE,
          text TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('pending','sending','submitted','failed','suppressed','delivery_unknown')),
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0)
        );
        INSERT INTO outbox_v9(
          id,conversation_id,inbound_event_id,input_sequence,uuid,text,state,error,created_at,updated_at,attempt_count
        ) SELECT
          id,conversation_id,inbound_event_id,input_sequence,uuid,text,state,error,created_at,updated_at,attempt_count
        FROM outbox;
        DROP TABLE outbox;
        ALTER TABLE outbox_v9 RENAME TO outbox;
        CREATE INDEX idx_outbox_state ON outbox(state,created_at);

        CREATE TABLE group_onboarding_v9 (
          conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
          state TEXT NOT NULL CHECK(state IN ('pending','prepared','sending','submitted','failed','delivery_unknown')),
          history_count INTEGER,
          history_loaded_at TEXT,
          intro_turn_id TEXT,
          intro_text TEXT,
          intro_uuid TEXT UNIQUE,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO group_onboarding_v9(
          conversation_id,state,history_count,history_loaded_at,intro_turn_id,intro_text,intro_uuid,error,created_at,updated_at
        ) SELECT
          conversation_id,state,history_count,history_loaded_at,intro_turn_id,intro_text,intro_uuid,error,created_at,updated_at
        FROM group_onboarding;
        DROP TABLE group_onboarding;
        ALTER TABLE group_onboarding_v9 RENAME TO group_onboarding;
        PRAGMA user_version=9;
        COMMIT;
      `);
    }
    const onboardingEvidenceVersion = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (onboardingEvidenceVersion < 10) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE group_onboarding_v10 (
          conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
          state TEXT NOT NULL CHECK(state IN (
            'pending','prepared','sending','completed','submitted','delivered','failed','delivery_unknown'
          )),
          history_count INTEGER,
          history_loaded_at TEXT,
          intro_turn_id TEXT,
          intro_text TEXT,
          intro_uuid TEXT UNIQUE,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO group_onboarding_v10(
          conversation_id,state,history_count,history_loaded_at,intro_turn_id,intro_text,intro_uuid,error,created_at,updated_at
        ) SELECT
          conversation_id,
          CASE WHEN state='submitted' AND intro_text IS NULL THEN 'completed' ELSE state END,
          history_count,history_loaded_at,intro_turn_id,intro_text,intro_uuid,error,created_at,updated_at
        FROM group_onboarding;
        DROP TABLE group_onboarding;
        ALTER TABLE group_onboarding_v10 RENAME TO group_onboarding;
        PRAGMA user_version=10;
        COMMIT;
      `);
    }
    const perMessageHistoryVersion = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (perMessageHistoryVersion < 11) {
      this.db.exec(`
        ALTER TABLE inbound_events ADD COLUMN ingress TEXT NOT NULL DEFAULT 'live';
        PRAGMA user_version=11;
      `);
    }
    const forwardingStateVersion = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (forwardingStateVersion < 12) {
      this.db.exec('PRAGMA foreign_keys=OFF');
      try {
        this.db.exec(`
          BEGIN IMMEDIATE;
          ALTER TABLE inbound_events ADD COLUMN forwarded_turn_id TEXT;
          ALTER TABLE inbound_events ADD COLUMN forwarded_at TEXT;
          UPDATE inbound_events SET
            forwarded_turn_id=(SELECT d.turn_id FROM decisions d WHERE d.inbound_event_id=inbound_events.id),
            forwarded_at=COALESCE(
              (SELECT d.created_at FROM decisions d WHERE d.inbound_event_id=inbound_events.id),
              received_at
            ),
            processing_state='forwarded'
          WHERE processing_state='completed';
          DROP TABLE decisions;

          CREATE TABLE group_onboarding_v12 (
            conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
            state TEXT NOT NULL CHECK(state IN (
              'pending','prepared','sending','forwarded','submitted','delivered','failed','delivery_unknown'
            )),
            history_count INTEGER,
            history_loaded_at TEXT,
            intro_turn_id TEXT,
            intro_text TEXT,
            intro_uuid TEXT UNIQUE,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO group_onboarding_v12(
            conversation_id,state,history_count,history_loaded_at,intro_turn_id,intro_text,intro_uuid,error,created_at,updated_at
          ) SELECT
            conversation_id,CASE WHEN state='completed' THEN 'forwarded' ELSE state END,
            history_count,history_loaded_at,intro_turn_id,intro_text,intro_uuid,error,created_at,updated_at
          FROM group_onboarding;
          DROP TABLE group_onboarding;
          ALTER TABLE group_onboarding_v12 RENAME TO group_onboarding;
          PRAGMA user_version=12;
          COMMIT;
        `);
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* transaction was not active */ }
        throw error;
      } finally {
        this.db.exec('PRAGMA foreign_keys=ON');
      }
    }
  }

  addConversation(input: {
    channelId?: string;
    channelProfileId?: string;
    kind: ConversationKind;
    externalId: string;
    title: string;
    responsibility: string;
    mode: ConversationMode;
    runtimeId?: string;
    workerWarmSeconds?: number;
  }): Conversation {
    const now = new Date().toISOString();
    const id = randomUUID();
    const channelId = input.channelId ?? 'dingtalk';
    const channelProfileId = input.channelProfileId ?? 'default';
    const runtimeId = input.runtimeId ?? 'codex';
    const workerWarmSeconds = input.workerWarmSeconds ?? DEFAULT_WORKER_WARM_SECONDS;
    assertWorkerWarmSeconds(workerWarmSeconds);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO conversations(
          id,channel_id,channel_profile_id,kind,external_id,title,responsibility,mode,runtime_id,
          worker_warm_seconds,policy_version,enabled,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,1,1,?,?)
      `).run(
        id, channelId, channelProfileId, input.kind, input.externalId, input.title,
        input.responsibility.trim(), input.mode, runtimeId, workerWarmSeconds, now, now,
      );
      this.db.prepare(`
        INSERT INTO runtime_workers(conversation_id,runtime_id,state,updated_at) VALUES(?,?,'stopped',?)
      `).run(id, runtimeId, now);
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
    const result = this.db.prepare('UPDATE conversations SET enabled=?,policy_version=policy_version+1,updated_at=? WHERE id=?')
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
    return Number(result.changes) === 1;
  }

  setConversationTitle(id: string, title: string): boolean {
    const value = title.trim();
    if (!value) throw new Error('title 不能为空');
    const result = this.db.prepare('UPDATE conversations SET title=?,policy_version=policy_version+1,updated_at=? WHERE id=?')
      .run(value, new Date().toISOString(), id);
    return Number(result.changes) === 1;
  }

  setConversationMode(id: string, mode: ConversationMode): boolean {
    const result = this.db.prepare('UPDATE conversations SET mode=?,policy_version=policy_version+1,updated_at=? WHERE id=?')
      .run(mode, new Date().toISOString(), id);
    return Number(result.changes) === 1;
  }

  setConversationResponsibility(id: string, responsibility: string): boolean {
    const value = responsibility.trim();
    const current = this.getConversation(id);
    if (!current) return false;
    if (current.responsibility === value) return true;
    const result = this.db.prepare(`
      UPDATE conversations SET responsibility=?,policy_version=policy_version+1,updated_at=? WHERE id=?
    `).run(value, new Date().toISOString(), id);
    return Number(result.changes) === 1;
  }

  setWorkerWarmSeconds(id: string, workerWarmSeconds: number): boolean {
    assertWorkerWarmSeconds(workerWarmSeconds);
    const result = this.db.prepare('UPDATE conversations SET worker_warm_seconds=?,updated_at=? WHERE id=?')
      .run(workerWarmSeconds, new Date().toISOString(), id);
    return Number(result.changes) === 1;
  }

  getConversation(id: string): Conversation | null {
    return mapConversation(this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as Row | undefined);
  }

  findConversation(
    channelId: string,
    channelProfileId: string,
    kind: ConversationKind,
    externalId: string,
  ): Conversation | null {
    return mapConversation(this.db.prepare(
      `SELECT * FROM conversations
       WHERE channel_id=? AND channel_profile_id=? AND kind=? AND external_id=?`,
    ).get(channelId, channelProfileId, kind, externalId) as Row | undefined);
  }

  findEnabledConversation(
    channelId: string,
    channelProfileId: string,
    kind: ConversationKind,
    externalId: string,
  ): Conversation | null {
    return mapConversation(this.db.prepare(
      `SELECT * FROM conversations
       WHERE channel_id=? AND channel_profile_id=? AND kind=? AND external_id=? AND enabled=1`,
    ).get(channelId, channelProfileId, kind, externalId) as Row | undefined);
  }

  listConversations(enabledOnly = false): Conversation[] {
    const sql = `SELECT * FROM conversations${enabledOnly ? ' WHERE enabled=1' : ''} ORDER BY kind,title,id`;
    return (this.db.prepare(sql).all() as Row[]).map((row) => mapConversation(row)!);
  }

  conversationBackfillStart(conversation: Conversation, overlapMs = 2_000): Date {
    const rows = this.db.prepare(`
      SELECT occurred_at FROM inbound_events
      WHERE conversation_id=? AND occurred_at IS NOT NULL
    `).all(conversation.id) as Row[];
    let latest = Date.parse(conversation.createdAt);
    for (const row of rows) {
      const parsed = parseStoredMessageTime(row.occurred_at);
      if (parsed !== null && parsed > latest) latest = parsed;
    }
    return new Date(Math.max(0, latest - overlapMs));
  }

  deleteConversation(id: string): boolean {
    const existing = this.getConversation(id);
    if (!existing) return false;
    const recovery = this.path === ':memory:' ? null : this.recoveryContextFile(id);
    const stagedRecovery = recovery && existsSync(recovery) ? `${recovery}.${process.pid}.deleting` : null;
    if (recovery && stagedRecovery) renameSync(recovery, stagedRecovery);
    this.db.exec('BEGIN IMMEDIATE');
    let changes = 0;
    try {
      this.db.prepare('DELETE FROM host_lease WHERE lease_key=?').run(`conversation:${id}`);
      const result = this.db.prepare('DELETE FROM conversations WHERE id=?').run(id);
      changes = Number(result.changes);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (recovery && stagedRecovery && existsSync(stagedRecovery)) renameSync(stagedRecovery, recovery);
      throw error;
    }
    if (stagedRecovery) rmSync(stagedRecovery, { force: true });
    return changes === 1;
  }

  getConversationContext(conversationId: string): ConversationContext | null {
    return mapConversationContext(this.db.prepare(
      'SELECT * FROM conversation_context WHERE conversation_id=?',
    ).get(conversationId) as Row | undefined);
  }

  listConversationMembers(conversationId: string): ConversationMember[] {
    return (this.db.prepare(`
      SELECT * FROM conversation_members WHERE conversation_id=?
      ORDER BY COALESCE(display_name,external_user_id)
    `).all(conversationId) as Row[]).map(mapConversationMember);
  }

  updateConversationMember(
    conversationId: string,
    externalUserId: string,
    patch: Partial<Pick<ConversationMember,
      'displayName' | 'organizationRole' | 'conversationRole' | 'responsibilityBoundary'>>,
  ): ConversationMember {
    if (!this.getConversation(conversationId)) throw new Error(`conversation 不存在：${conversationId}`);
    const existing = this.db.prepare(`
      SELECT * FROM conversation_members WHERE conversation_id=? AND external_user_id=?
    `).get(conversationId, externalUserId) as Row | undefined;
    const current = existing ? mapConversationMember(existing) : null;
    const displayName = patch.displayName === undefined ? current?.displayName ?? null : cleanOptional(patch.displayName, 200, 'displayName');
    const organizationRole = patch.organizationRole === undefined
      ? current?.organizationRole ?? '' : cleanText(patch.organizationRole, 300, 'organizationRole');
    const conversationRole = patch.conversationRole === undefined
      ? current?.conversationRole ?? '' : cleanText(patch.conversationRole, 300, 'conversationRole');
    const responsibilityBoundary = patch.responsibilityBoundary === undefined
      ? current?.responsibilityBoundary ?? '' : cleanText(patch.responsibilityBoundary, 1_000, 'responsibilityBoundary');
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO conversation_members(
        conversation_id,external_user_id,display_name,organization_role,conversation_role,
        responsibility_boundary,source,version,updated_at
      ) VALUES(?,?,?,?,?,?,'manual',1,?)
      ON CONFLICT(conversation_id,external_user_id) DO UPDATE SET
        display_name=excluded.display_name,organization_role=excluded.organization_role,
        conversation_role=excluded.conversation_role,responsibility_boundary=excluded.responsibility_boundary,
        source='manual',version=conversation_members.version+1,updated_at=excluded.updated_at
    `).run(
      conversationId, externalUserId, displayName, organizationRole, conversationRole,
      responsibilityBoundary, now,
    );
    return mapConversationMember(this.db.prepare(`
      SELECT * FROM conversation_members WHERE conversation_id=? AND external_user_id=?
    `).get(conversationId, externalUserId) as Row);
  }

  getSession(conversationId: string): SessionRecord | null {
    return mapSession(this.db.prepare('SELECT * FROM runtime_sessions WHERE conversation_id=?').get(conversationId) as Row | undefined);
  }

  saveSession(session: SessionRecord): void {
    const conversation = this.getConversation(session.conversationId);
    if (!conversation) throw new Error(`conversation 不存在：${session.conversationId}`);
    if (session.generation !== conversation.sessionGeneration) {
      throw new Error(`session generation=${session.generation} 与 conversation generation=${conversation.sessionGeneration} 不一致`);
    }
    this.db.prepare(`
      INSERT INTO runtime_sessions(
        conversation_id,runtime_id,provider_session_id,generation,lifecycle,protocol_fingerprint,
        runtime_cwd,bootstrap_turn_id,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        runtime_id=excluded.runtime_id,provider_session_id=excluded.provider_session_id,
        generation=excluded.generation,lifecycle=excluded.lifecycle,
        protocol_fingerprint=excluded.protocol_fingerprint,runtime_cwd=excluded.runtime_cwd,
        bootstrap_turn_id=excluded.bootstrap_turn_id,updated_at=excluded.updated_at
    `).run(
      session.conversationId, session.runtimeId, session.providerSessionId, session.generation,
      session.lifecycle, session.protocolFingerprint, session.runtimeCwd, session.bootstrapTurnId,
      session.createdAt, session.updatedAt,
    );
  }

  rotateConversationSession(conversationId: string, reason: string): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const nextGeneration = this.rotateConversationSessionInTransaction(conversationId, reason, new Date().toISOString());
      this.db.exec('COMMIT');
      return nextGeneration;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private rotateConversationSessionInTransaction(conversationId: string, reason: string, now: string): number {
    const conversation = this.db.prepare(
      'SELECT session_generation FROM conversations WHERE id=?',
    ).get(conversationId) as Row | undefined;
    if (!conversation) throw new Error(`conversation 不存在：${conversationId}`);
    const previousGeneration = Number(conversation.session_generation);
    const nextGeneration = previousGeneration + 1;
    const session = this.db.prepare(
      'SELECT provider_session_id FROM runtime_sessions WHERE conversation_id=?',
    ).get(conversationId) as Row | undefined;
    this.db.prepare(`
      INSERT INTO runtime_session_resets(
        id,conversation_id,previous_generation,next_generation,previous_provider_session_id,reason,created_at
      ) VALUES(?,?,?,?,?,?,?)
    `).run(
      randomUUID(), conversationId, previousGeneration, nextGeneration,
      session?.provider_session_id ? String(session.provider_session_id) : null, reason, now,
    );
    this.db.prepare('DELETE FROM runtime_sessions WHERE conversation_id=?').run(conversationId);
    this.db.prepare('UPDATE conversations SET session_generation=?,updated_at=? WHERE id=?')
      .run(nextGeneration, now, conversationId);
    return nextGeneration;
  }

  admitEvent(
    conversation: Conversation,
    event: NormalizedEvent,
    ingress: AdmittedEvent['ingress'] = 'live',
  ): { admitted: boolean; event: AdmittedEvent | null } {
    if (
      conversation.channelId !== event.channelId
      || conversation.channelProfileId !== event.channelProfileId
      || conversation.kind !== event.kind
      || conversation.externalId !== event.conversationExternalId
    ) {
      throw new Error('event route 与 conversation binding 不一致');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const duplicate = event.messageId
        ? this.db.prepare(`
            SELECT id FROM inbound_events
            WHERE fingerprint=? OR (conversation_id=? AND message_id=?) LIMIT 1
          `).get(event.fingerprint, conversation.id, event.messageId)
        : this.db.prepare('SELECT id FROM inbound_events WHERE fingerprint=?').get(event.fingerprint);
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
          body_json,occurred_at,received_at,processing_state,ingress
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'admitted',?)
      `).run(
        id, conversation.id, sequence, event.fingerprint, event.eventId, event.messageId,
        event.senderId, event.senderName, body, event.occurredAt, event.receivedAt, ingress,
      );
      if (event.senderId) {
        this.db.prepare(`
          INSERT INTO conversation_members(
            conversation_id,external_user_id,display_name,source,version,updated_at
          ) VALUES(?,?,?,'message',1,?)
          ON CONFLICT(conversation_id,external_user_id) DO UPDATE SET
            display_name=COALESCE(excluded.display_name,conversation_members.display_name),
            source=CASE WHEN conversation_members.source='manual' THEN 'manual' ELSE 'message' END,
            version=conversation_members.version + CASE
              WHEN excluded.display_name IS NOT NULL
                AND excluded.display_name<>COALESCE(conversation_members.display_name,'') THEN 1 ELSE 0 END,
            updated_at=CASE
              WHEN excluded.display_name IS NOT NULL
                AND excluded.display_name<>COALESCE(conversation_members.display_name,'')
              THEN excluded.updated_at ELSE conversation_members.updated_at END
        `).run(conversation.id, event.senderId, event.senderName, event.receivedAt);
      }
      this.db.exec('COMMIT');
      return { admitted: true, event: { ...event, id, conversationId: conversation.id, sequence, ingress } };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  claimPendingEvents(
    conversation: Conversation,
    workerId: string,
    limit: number,
    ingress?: AdmittedEvent['ingress'],
  ): AdmittedEvent[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare(`
        SELECT * FROM inbound_events
        WHERE conversation_id=? AND processing_state='admitted'
          AND (? IS NULL OR ingress=?)
        ORDER BY sequence LIMIT ?
      `).all(conversation.id, ingress ?? null, ingress ?? null, limit) as Row[];
      if (rows.length === 0) {
        this.db.exec('COMMIT');
        return [];
      }
      const claimedAt = new Date().toISOString();
      const claim = this.db.prepare(`
        UPDATE inbound_events SET processing_state='claimed',claim_owner=?,claim_expires_at_ms=NULL,claimed_at=?
        WHERE id=? AND processing_state='admitted'
      `);
      for (const row of rows) claim.run(workerId, claimedAt, String(row.id));
      this.db.exec('COMMIT');
      return rows.map((row) => mapAdmittedEvent(row, conversation));
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  releaseClaimedEvents(events: AdmittedEvent[], workerId: string): void {
    if (events.length === 0) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const release = this.db.prepare(`
        UPDATE inbound_events SET processing_state='admitted',claim_owner=NULL,
          claim_expires_at_ms=NULL,claimed_at=NULL
        WHERE id=? AND processing_state='claimed' AND claim_owner=?
      `);
      for (const event of events) release.run(event.id, workerId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  markBatchForwarded(events: AdmittedEvent[], workerId: string, turnId: string): void {
    if (events.length === 0) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const forward = this.db.prepare(`
        UPDATE inbound_events SET processing_state='forwarded',
          forwarded_turn_id=?,forwarded_at=?,last_error=NULL,
          claim_owner=NULL,claim_expires_at_ms=NULL,claimed_at=NULL
        WHERE id=? AND processing_state='claimed' AND claim_owner=?
      `);
      const now = new Date().toISOString();
      for (const event of events) forward.run(turnId, now, event.id, workerId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  markBatchFailed(events: AdmittedEvent[], workerId: string, error: string): void {
    if (events.length === 0) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const fail = this.db.prepare(`
        UPDATE inbound_events SET processing_state='failed',
          failure_count=failure_count+1,last_error=?,
          claim_owner=NULL,claim_expires_at_ms=NULL,claimed_at=NULL
        WHERE id=? AND processing_state='claimed' AND claim_owner=?
      `);
      for (const event of events) fail.run(error, event.id, workerId);
      this.db.exec('COMMIT');
    } catch (caught) {
      this.db.exec('ROLLBACK');
      throw caught;
    }
  }

  recoverPendingWork(): string[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = new Date().toISOString();
      const rotations = new Map<string, string>();
      const interrupted = this.db.prepare(`
        SELECT DISTINCT conversation_id FROM inbound_events WHERE processing_state='claimed'
      `).all() as Row[];
      for (const row of interrupted) {
        rotations.set(String(row.conversation_id), 'host-restart-claimed-turn');
      }
      const retryingFailed = this.db.prepare(`
        SELECT DISTINCT conversation_id FROM inbound_events
        WHERE processing_state='failed' AND failure_count<?
      `).all(MAX_RECOVERY_ATTEMPTS) as Row[];
      for (const row of retryingFailed) {
        const conversationId = String(row.conversation_id);
        if (!rotations.has(conversationId)) rotations.set(conversationId, 'host-restart-retry-failed-turn');
      }
      const pendingGroupHistory = this.db.prepare(`
        SELECT g.conversation_id FROM group_onboarding g
        JOIN runtime_sessions s ON s.conversation_id=g.conversation_id
        WHERE g.state NOT IN ('forwarded','submitted','delivered','delivery_unknown') AND g.intro_text IS NULL
      `).all() as Row[];
      for (const row of pendingGroupHistory) {
        const conversationId = String(row.conversation_id);
        if (!rotations.has(conversationId)) rotations.set(conversationId, 'host-restart-pending-group-history');
      }
      for (const [conversationId, reason] of rotations) {
        this.rotateConversationSessionInTransaction(conversationId, reason, now);
      }
      this.db.prepare(`
        UPDATE inbound_events SET processing_state='admitted',claim_owner=NULL,
          claim_expires_at_ms=NULL,claimed_at=NULL
        WHERE processing_state='claimed'
      `).run();
      this.db.prepare(`
        UPDATE inbound_events SET processing_state='admitted',claim_owner=NULL,
          claim_expires_at_ms=NULL,claimed_at=NULL
        WHERE processing_state='failed' AND failure_count<?
      `).run(MAX_RECOVERY_ATTEMPTS);
      this.db.prepare(`
        UPDATE runtime_workers SET worker_id=NULL,state='stopped',process_id=NULL,
          claimed_from_sequence=NULL,claimed_to_sequence=NULL,warm_until=NULL,
          error=CASE WHEN state IN ('starting','running') THEN 'host-restarted' ELSE error END,
          updated_at=?
      `).run(now);
      const rows = this.db.prepare(`
        SELECT DISTINCT c.id
        FROM conversations c
        LEFT JOIN inbound_events e ON e.conversation_id=c.id AND e.processing_state='admitted'
        LEFT JOIN group_onboarding g ON g.conversation_id=c.id
        WHERE c.enabled=1 AND (
          e.id IS NOT NULL OR
          (c.kind='group' AND g.state NOT IN ('forwarded','submitted','delivered','delivery_unknown')
            AND g.intro_text IS NULL)
        )
        ORDER BY c.id
      `).all() as Row[];
      this.db.exec('COMMIT');
      return rows.map((row) => String(row.id));
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  pendingEventCount(conversationId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM inbound_events
      WHERE conversation_id=? AND processing_state IN ('admitted','claimed')
    `).get(conversationId) as Row;
    return Number(row.count);
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
      const conversation = this.getConversation(row.conversationId);
      const inbound = this.db.prepare('SELECT ingress FROM inbound_events WHERE id=?')
        .get(row.inboundEventId) as Row | undefined;
      const ingress = (inbound?.ingress ?? 'live') as AdmittedEvent['ingress'];
      if (!conversation?.enabled) {
        this.db.prepare("UPDATE outbox SET state='suppressed',error='conversation-not-reply',updated_at=? WHERE id=?")
          .run(now, id);
        this.db.exec('COMMIT');
        return null;
      }
      if (conversation.mode !== 'reply') {
        if (ingress === 'history') {
          this.db.exec('COMMIT');
          return null;
        }
        this.db.prepare("UPDATE outbox SET state='suppressed',error='conversation-not-reply',updated_at=? WHERE id=?")
          .run(now, id);
        this.db.exec('COMMIT');
        return null;
      }
      if (!this.isOutboxInputFresh(row.conversationId, row.inputSequence, ingress)) {
        this.db.prepare("UPDATE outbox SET state='suppressed',error='newer-message-admitted',updated_at=? WHERE id=?")
          .run(now, id);
        this.db.exec('COMMIT');
        return null;
      }
      this.db.prepare(`
        UPDATE outbox SET state='sending',attempt_count=attempt_count+1,error=NULL,updated_at=?
        WHERE id=? AND state='pending'
      `).run(now, id);
      this.db.exec('COMMIT');
      return this.getOutbox(id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private isOutboxInputFresh(
    conversationId: string,
    inputSequence: number,
    ingress: AdmittedEvent['ingress'],
  ): boolean {
    if (ingress === 'live') return this.latestSequence(conversationId) === inputSequence;
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(sequence),0) AS sequence FROM inbound_events
      WHERE conversation_id=? AND ingress='live'
    `).get(conversationId) as Row;
    return Number(row.sequence) <= inputSequence;
  }

  finishOutbox(id: string, state: 'submitted' | 'failed' | 'delivery_unknown', error: string | null): void {
    this.db.prepare('UPDATE outbox SET state=?,error=?,updated_at=? WHERE id=?')
      .run(state, error, new Date().toISOString(), id);
  }

  getOutbox(id: string): OutboxRecord | null {
    return mapOutbox(this.db.prepare('SELECT * FROM outbox WHERE id=?').get(id) as Row | undefined);
  }

  listPendingOutbox(conversationId: string): OutboxRecord[] {
    return (this.db.prepare(`
      SELECT * FROM outbox WHERE conversation_id=? AND state='pending'
      ORDER BY input_sequence,id
    `).all(conversationId) as Row[]).map((row) => mapOutbox(row)!);
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

  markGroupHistoryLoaded(conversationId: string, historyCount: number): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE group_onboarding SET history_count=?,history_loaded_at=?,error=NULL,updated_at=?
      WHERE conversation_id=? AND state NOT IN ('submitted','delivered','delivery_unknown')
    `).run(historyCount, now, now, conversationId);
  }

  historyEventState(fingerprint: string): string | null {
    const row = this.db.prepare(`
      SELECT processing_state FROM inbound_events WHERE fingerprint=? AND ingress='history'
    `).get(fingerprint) as Row | undefined;
    return row ? String(row.processing_state) : null;
  }

  historyEventCount(conversationId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM inbound_events WHERE conversation_id=? AND ingress='history'
    `).get(conversationId) as Row;
    return Number(row.count);
  }

  refreshGroupOnboardingFromHistory(conversationId: string): GroupOnboardingRecord {
    const stats = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN e.processing_state='forwarded' THEN 1 ELSE 0 END) AS forwarded,
        SUM(CASE WHEN e.processing_state='failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN o.state='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN o.state='sending' THEN 1 ELSE 0 END) AS sending,
        SUM(CASE WHEN o.state='submitted' THEN 1 ELSE 0 END) AS submitted,
        SUM(CASE WHEN o.state='failed' THEN 1 ELSE 0 END) AS outbox_failed,
        SUM(CASE WHEN o.state='delivery_unknown' THEN 1 ELSE 0 END) AS delivery_unknown,
        MAX(e.forwarded_turn_id) AS last_turn_id,
        MAX(COALESCE(e.last_error,o.error)) AS error
      FROM inbound_events e
      LEFT JOIN outbox o ON o.inbound_event_id=e.id
      WHERE e.conversation_id=? AND e.ingress='history'
    `).get(conversationId) as Row;
    const total = Number(stats.total ?? 0);
    const forwarded = Number(stats.forwarded ?? 0);
    let state: GroupOnboardingRecord['state'];
    if (Number(stats.delivery_unknown ?? 0) > 0) state = 'delivery_unknown';
    else if (Number(stats.failed ?? 0) > 0 || Number(stats.outbox_failed ?? 0) > 0) state = 'failed';
    else if (forwarded < total) state = 'pending';
    else if (Number(stats.sending ?? 0) > 0) state = 'sending';
    else if (Number(stats.pending ?? 0) > 0) state = 'prepared';
    else if (Number(stats.submitted ?? 0) > 0) state = 'submitted';
    else state = 'forwarded';
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE group_onboarding SET state=?,history_count=?,history_loaded_at=COALESCE(history_loaded_at,?),
        intro_turn_id=?,intro_text=NULL,intro_uuid=NULL,error=?,updated_at=?
      WHERE conversation_id=?
    `).run(
      state, total, now, stats.last_turn_id ? String(stats.last_turn_id) : null,
      stats.error ? String(stats.error) : null, now, conversationId,
    );
    const record = this.getGroupOnboarding(conversationId);
    if (!record) throw new Error(`群 onboarding 不存在：${conversationId}`);
    return record;
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
      WHERE conversation_id=? AND state NOT IN ('forwarded','submitted','delivered','delivery_unknown')
    `).run(historyCount, now, introTurnId, introText, introUuid, now, conversationId);
    const record = this.getGroupOnboarding(conversationId);
    if (!record) throw new Error(`群 onboarding 不存在：${conversationId}`);
    return record;
  }

  completeGroupOnboardingSilently(
    conversationId: string,
    historyCount: number,
    turnId: string | null,
  ): GroupOnboardingRecord {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE group_onboarding SET
        state='forwarded',history_count=?,history_loaded_at=?,intro_turn_id=?,
        intro_text=NULL,intro_uuid=NULL,error=NULL,updated_at=?
      WHERE conversation_id=? AND state NOT IN ('forwarded','submitted','delivered','delivery_unknown')
    `).run(historyCount, now, turnId, now, conversationId);
    const record = this.getGroupOnboarding(conversationId);
    if (!record) throw new Error(`群 onboarding 不存在：${conversationId}`);
    return record;
  }

  claimGroupOnboardingIntro(conversationId: string): GroupOnboardingRecord | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getGroupOnboarding(conversationId);
      if (!current || ['forwarded', 'submitted', 'delivered', 'delivery_unknown'].includes(current.state)
        || !current.introText || !current.introUuid) {
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

  finishGroupOnboardingIntro(
    conversationId: string,
    state: 'submitted' | 'delivered' | 'failed' | 'delivery_unknown',
    error: string | null,
  ): void {
    this.db.prepare('UPDATE group_onboarding SET state=?,error=?,updated_at=? WHERE conversation_id=?')
      .run(state, error, new Date().toISOString(), conversationId);
  }

  claimGroupOnboardingReconciliation(
    conversationId: string,
    expectedUuid: string,
    nextUuid: string,
  ): GroupOnboardingRecord {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getGroupOnboarding(conversationId);
      if (!current || current.state !== 'delivery_unknown' || current.introUuid !== expectedUuid
        || !current.introText || !current.introTurnId) {
        throw new Error('onboarding 结果不明状态已变化，拒绝重发');
      }
      this.db.prepare(`
        UPDATE group_onboarding SET state='sending',intro_uuid=?,error=NULL,updated_at=?
        WHERE conversation_id=? AND state='delivery_unknown' AND intro_uuid=?
      `).run(nextUuid, new Date().toISOString(), conversationId, expectedUuid);
      this.db.exec('COMMIT');
      return this.getGroupOnboarding(conversationId)!;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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

  releaseStoppedExternalHost(expectedPid: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const owned = this.db.prepare(`
        SELECT COUNT(*) AS count FROM channel_connections
        WHERE owner_pid=? AND state IN ('starting','ready','error')
      `).get(expectedPid) as Row;
      if (Number(owned.count) === 0) throw new Error(`PID ${expectedPid} 不再是当前 Instance 的 Channel owner`);
      this.db.prepare(`
        UPDATE channel_connections SET state='stopped',owner_pid=NULL,error=NULL,updated_at=?
        WHERE owner_pid=?
      `).run(new Date().toISOString(), expectedPid);
      this.db.prepare('DELETE FROM host_lease WHERE lease_key=?').run('host');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  setWorkerState(input: {
    conversationId: string;
    workerId: string | null;
    runtimeId: string;
    state: RuntimeWorkerRecord['state'];
    processId?: number | null;
    claimedFromSequence?: number | null;
    claimedToSequence?: number | null;
    lastSignalAt?: string | null;
    warmUntil?: string | null;
    error?: string | null;
    startedAt?: string | null;
  }): void {
    const current = this.getWorker(input.conversationId);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO runtime_workers(
        conversation_id,worker_id,runtime_id,state,process_id,claimed_from_sequence,claimed_to_sequence,
        last_signal_at,warm_until,error,started_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        worker_id=excluded.worker_id,runtime_id=excluded.runtime_id,state=excluded.state,
        process_id=excluded.process_id,claimed_from_sequence=excluded.claimed_from_sequence,
        claimed_to_sequence=excluded.claimed_to_sequence,last_signal_at=excluded.last_signal_at,
        warm_until=excluded.warm_until,error=excluded.error,started_at=excluded.started_at,
        updated_at=excluded.updated_at
    `).run(
      input.conversationId,
      input.workerId,
      input.runtimeId,
      input.state,
      input.processId !== undefined ? input.processId : current?.processId ?? null,
      input.claimedFromSequence !== undefined ? input.claimedFromSequence : current?.claimedFromSequence ?? null,
      input.claimedToSequence !== undefined ? input.claimedToSequence : current?.claimedToSequence ?? null,
      input.lastSignalAt ?? current?.lastSignalAt ?? null,
      input.warmUntil ?? null,
      input.error ?? null,
      input.startedAt ?? current?.startedAt ?? (input.state === 'starting' ? now : null),
      now,
    );
  }

  getWorker(conversationId: string): RuntimeWorkerRecord | null {
    return mapWorker(this.db.prepare(
      'SELECT * FROM runtime_workers WHERE conversation_id=?',
    ).get(conversationId) as Row | undefined);
  }

  setChannelConnection(input: {
    channelId: string;
    profileId: string;
    label: string;
    state: 'starting' | 'ready' | 'stopped' | 'disabled' | 'error';
    ownerPid: number | null;
    connectedAt?: string | null;
    lastEventAt?: string | null;
    error?: string | null;
  }): void {
    const now = new Date().toISOString();
    const current = this.db.prepare(`
      SELECT * FROM channel_connections WHERE channel_id=? AND profile_id=?
    `).get(input.channelId, input.profileId) as Row | undefined;
    this.db.prepare(`
      INSERT INTO channel_connections(
        channel_id,profile_id,label,state,owner_pid,connected_at,last_event_at,error,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(channel_id,profile_id) DO UPDATE SET
        label=excluded.label,state=excluded.state,owner_pid=excluded.owner_pid,
        connected_at=excluded.connected_at,last_event_at=excluded.last_event_at,
        error=excluded.error,updated_at=excluded.updated_at
    `).run(
      input.channelId,
      input.profileId,
      input.label,
      input.state,
      input.ownerPid,
      input.connectedAt ?? (current?.connected_at ? String(current.connected_at) : null),
      input.lastEventAt ?? (current?.last_event_at ? String(current.last_event_at) : null),
      input.error ?? null,
      now,
    );
  }

  noteChannelEvent(channelId: string, profileId: string, at: string): void {
    this.db.prepare(`
      UPDATE channel_connections SET last_event_at=?,updated_at=? WHERE channel_id=? AND profile_id=?
    `).run(at, at, channelId, profileId);
  }

  setRuntimeAdapter(input: {
    runtimeId: string;
    label: string;
    state: 'starting' | 'ready' | 'stopped' | 'error';
    model: string | null;
    protocolFingerprint?: string | null;
    contextRecovery?: string | null;
    error?: string | null;
  }): void {
    const now = new Date().toISOString();
    const current = this.db.prepare('SELECT * FROM runtime_adapters WHERE runtime_id=?')
      .get(input.runtimeId) as Row | undefined;
    this.db.prepare(`
      INSERT INTO runtime_adapters(runtime_id,label,state,model,protocol_fingerprint,context_recovery,error,updated_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(runtime_id) DO UPDATE SET
        label=excluded.label,state=excluded.state,model=excluded.model,
        protocol_fingerprint=excluded.protocol_fingerprint,context_recovery=excluded.context_recovery,
        error=excluded.error,updated_at=excluded.updated_at
    `).run(
      input.runtimeId,
      input.label,
      input.state,
      input.model,
      input.protocolFingerprint !== undefined
        ? input.protocolFingerprint
        : current?.protocol_fingerprint ? String(current.protocol_fingerprint) : null,
      input.contextRecovery !== undefined
        ? input.contextRecovery
        : current?.context_recovery ? String(current.context_recovery) : null,
      input.error ?? null,
      now,
    );
  }

  conversationDetail(conversationId: string, includeContent = false): Record<string, unknown> | null {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return null;
    const session = this.getSession(conversationId);
    const worker = this.getWorker(conversationId);
    const context = this.getConversationContext(conversationId);
    const members = this.listConversationMembers(conversationId);
    const messages = this.db.prepare(`
      SELECT sequence,received_at,processing_state,sender_name,sender_id,body_json
      FROM inbound_events WHERE conversation_id=? ORDER BY sequence DESC LIMIT 12
    `).all(conversationId) as Row[];
    return {
      conversation: {
        id: conversation.id,
        channelId: conversation.channelId,
        channelProfileId: conversation.channelProfileId,
        kind: conversation.kind,
        title: displayConversationTitle(
          conversation,
          members.find((member) => member.externalUserId === conversation.externalId)?.displayName ?? null,
        ),
        responsibility: conversation.responsibility,
        policyVersion: conversation.policyVersion,
        mode: conversation.mode,
        runtimeId: conversation.runtimeId,
        workerWarmSeconds: conversation.workerWarmSeconds,
        enabled: conversation.enabled,
      },
      session: session ? {
        runtimeId: session.runtimeId,
        providerSessionPrefix: session.providerSessionId.slice(0, 12),
        generation: session.generation,
        lifecycle: session.lifecycle,
      } : null,
      worker,
      context: context ? {
        version: context.version,
        throughSequence: context.throughSequence,
        updatedAt: context.updatedAt,
        facts: context.facts.length,
        decisions: context.decisions.length,
        commitments: context.commitments.length,
        openQuestions: context.openQuestions.length,
        ...(includeContent ? {
          currentTopic: context.currentTopic,
          factItems: context.facts,
          decisionItems: context.decisions,
          commitmentItems: context.commitments,
          openQuestionItems: context.openQuestions,
        } : {}),
      } : null,
      members: members.map((member) => ({
        displayName: redactSender(member.displayName ?? member.externalUserId),
        organizationRole: member.organizationRole,
        conversationRole: member.conversationRole,
        responsibilityBoundary: member.responsibilityBoundary,
        source: member.source,
        version: member.version,
      })),
      messages: messages.map((row) => ({
        sequence: Number(row.sequence),
        sender: redactSender(row.sender_name ?? row.sender_id),
        state: String(row.processing_state),
        receivedAt: String(row.received_at),
        ...(includeContent ? { preview: bodyPreview(row.body_json) } : {}),
      })),
    };
  }

  status(includeContent = false): Record<string, unknown> {
    const counts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM conversations WHERE enabled=1) AS enabled_conversations,
        (SELECT COUNT(*) FROM runtime_sessions WHERE lifecycle='ready') AS recoverable_sessions,
        (SELECT COUNT(*) FROM inbound_events) AS received,
        (SELECT COUNT(*) FROM inbound_events WHERE processing_state='admitted') AS pending_messages,
        (SELECT COUNT(*) FROM inbound_events WHERE processing_state='claimed') AS claimed_messages,
        (SELECT COUNT(*) FROM inbound_events WHERE processing_state='forwarded') AS forwarded_messages,
        (SELECT COUNT(*) FROM inbound_events WHERE processing_state='failed') AS failed_messages,
        (SELECT COUNT(*) FROM outbox WHERE state='submitted') AS submitted,
        (SELECT COUNT(*) FROM outbox WHERE state IN ('pending','sending')) AS pending_outbox,
        (SELECT COUNT(*) FROM group_onboarding WHERE state IN ('pending','prepared','sending','failed')) AS pending_group_onboarding,
        (SELECT COUNT(*) FROM inbound_events WHERE ingress='history')
          + (SELECT COALESCE(SUM(g.history_count),0) FROM group_onboarding g
             WHERE g.history_loaded_at IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM inbound_events e WHERE e.conversation_id=g.conversation_id AND e.ingress='history'
             )) AS history_loaded,
        (SELECT COUNT(*) FROM inbound_events WHERE ingress='history' AND processing_state='forwarded') AS history_forwarded
    `).get() as Row;
    const channels = this.db.prepare(`
      SELECT channel_id,profile_id,label,state,owner_pid,connected_at,last_event_at,error,updated_at
      FROM channel_connections ORDER BY channel_id,profile_id
    `).all() as Row[];
    const runtimeAdapters = this.db.prepare(`
      SELECT runtime_id,label,state,model,protocol_fingerprint,context_recovery,error,updated_at
      FROM runtime_adapters ORDER BY runtime_id
    `).all() as Row[];
    const conversations = this.db.prepare(`
      SELECT c.*,w.worker_id,w.state AS worker_state,w.process_id,w.claimed_from_sequence,
        w.claimed_to_sequence,w.last_signal_at,w.warm_until,w.error AS worker_error,w.updated_at AS worker_updated_at,
        s.provider_session_id,s.lifecycle AS session_state,s.generation,s.protocol_fingerprint,
        x.version AS context_version,x.through_sequence AS context_through_sequence,
        r.label AS runtime_label,r.model AS runtime_model,r.state AS runtime_adapter_state,
        g.state AS onboarding_state,g.history_count,g.history_loaded_at,g.intro_turn_id,
        (SELECT COUNT(*) FROM inbound_events he
          WHERE he.conversation_id=c.id AND he.ingress='history') AS history_event_count,
        (SELECT COUNT(*) FROM inbound_events he
          WHERE he.conversation_id=c.id AND he.ingress='history' AND he.processing_state='forwarded') AS history_forwarded_count,
        (SELECT COUNT(*) FROM inbound_events e
          WHERE e.conversation_id=c.id AND e.processing_state IN ('admitted','claimed')) AS pending_count,
        (SELECT COALESCE(MAX(sequence),0) FROM inbound_events e WHERE e.conversation_id=c.id) AS latest_sequence,
        (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id=c.id) AS member_count,
        (SELECT m.display_name FROM conversation_members m
          WHERE m.conversation_id=c.id AND m.external_user_id=c.external_id LIMIT 1) AS direct_display_name
      FROM conversations c
      LEFT JOIN runtime_workers w ON w.conversation_id=c.id
      LEFT JOIN runtime_sessions s ON s.conversation_id=c.id
      LEFT JOIN conversation_context x ON x.conversation_id=c.id
      LEFT JOIN runtime_adapters r ON r.runtime_id=c.runtime_id
      LEFT JOIN group_onboarding g ON g.conversation_id=c.id
      ORDER BY c.kind,c.title,c.id
    `).all() as Row[];
    const messages = this.db.prepare(`
      SELECT e.conversation_id,e.sequence,e.received_at,e.processing_state,e.sender_name,e.sender_id,e.body_json,
        c.title,c.kind,c.external_id,c.channel_id,c.runtime_id,o.state AS outbox_state,
        (SELECT m.display_name FROM conversation_members m
          WHERE m.conversation_id=c.id AND m.external_user_id=c.external_id LIMIT 1) AS direct_display_name
      FROM inbound_events e
      JOIN conversations c ON c.id=e.conversation_id
      LEFT JOIN outbox o ON o.inbound_event_id=e.id
      ORDER BY e.received_at DESC,e.sequence DESC LIMIT 12
    `).all() as Row[];
    const failedOutbox = this.db.prepare(`
      SELECT c.title,c.kind,c.external_id,o.error,o.updated_at,
        (SELECT m.display_name FROM conversation_members m
          WHERE m.conversation_id=c.id AND m.external_user_id=c.external_id LIMIT 1) AS direct_display_name
      FROM outbox o
      JOIN conversations c ON c.id=o.conversation_id
      WHERE o.state IN ('failed','delivery_unknown') ORDER BY o.updated_at DESC LIMIT 5
    `).all() as Row[];
    const failedOnboarding = this.db.prepare(`
      SELECT c.title,g.error,g.updated_at FROM group_onboarding g
      JOIN conversations c ON c.id=g.conversation_id
      WHERE g.state IN ('failed','delivery_unknown') ORDER BY g.updated_at DESC LIMIT 5
    `).all() as Row[];
    const lease = this.db.prepare(
      'SELECT expires_at_ms,updated_at FROM host_lease WHERE lease_key=?',
    ).get('host') as Row | undefined;
    const hostState = lease && Number(lease.expires_at_ms) > Date.now() ? 'running' : 'stopped';
    const activeChannel = channels.find((row) => ['starting', 'ready'].includes(String(row.state)));
    const runtimeRows = conversations.filter((row) => row.provider_session_id || row.worker_state);
    const alerts = [
      ...channels.filter((row) => row.error).map((row) => ({
        scope: 'channel', target: `${String(row.channel_id)}/${String(row.profile_id)}`,
        error: String(row.error), at: String(row.updated_at),
      })),
      ...conversations.filter((row) => row.worker_error).map((row) => ({
        scope: 'worker', target: displayTitleFromRow(row), error: String(row.worker_error), at: String(row.worker_updated_at),
      })),
      ...runtimeAdapters.filter((row) => row.error).map((row) => ({
        scope: 'runtime', target: String(row.runtime_id), error: String(row.error), at: String(row.updated_at),
      })),
      ...failedOutbox.map((row) => ({
        scope: 'outbox', target: displayTitleFromRow(row), error: String(row.error ?? 'send-failed'), at: String(row.updated_at),
      })),
      ...failedOnboarding.map((row) => ({
        scope: 'onboarding', target: String(row.title), error: String(row.error ?? 'onboarding-failed'), at: String(row.updated_at),
      })),
    ].slice(0, 10);
    return {
      ...counts,
      generatedAt: new Date().toISOString(),
      hostState,
      hostHeartbeatAt: lease?.updated_at ?? null,
      host: {
        state: hostState,
        pid: activeChannel?.owner_pid ? Number(activeChannel.owner_pid) : null,
        heartbeatAt: lease?.updated_at ?? null,
      },
      channels: channels.map((row) => ({
        channelId: String(row.channel_id), profileId: String(row.profile_id), label: String(row.label),
        state: String(row.state), pid: row.owner_pid === null ? null : Number(row.owner_pid),
        connectedAt: row.connected_at ? String(row.connected_at) : null,
        lastEventAt: row.last_event_at ? String(row.last_event_at) : null,
        error: row.error ? String(row.error) : null, updatedAt: String(row.updated_at),
      })),
      runtimeAdapters: runtimeAdapters.map((row) => ({
        runtimeId: String(row.runtime_id), label: String(row.label), state: String(row.state),
        model: row.model ? String(row.model) : null,
        protocolFingerprintPrefix: row.protocol_fingerprint ? String(row.protocol_fingerprint).slice(0, 20) : null,
        contextRecovery: row.context_recovery ? String(row.context_recovery) : 'unavailable',
        error: row.error ? String(row.error) : null,
        updatedAt: String(row.updated_at),
      })),
      conversations: conversations.map((row) => ({
        id: String(row.id), idPrefix: String(row.id).slice(0, 8), channelId: String(row.channel_id),
        channelProfileId: String(row.channel_profile_id), kind: String(row.kind), title: displayTitleFromRow(row),
        responsibility: String(row.responsibility), policyVersion: Number(row.policy_version),
        mode: String(row.mode), runtimeId: String(row.runtime_id), enabled: Boolean(row.enabled),
        workerWarmSeconds: Number(row.worker_warm_seconds), pending: Number(row.pending_count),
        latestSequence: Number(row.latest_sequence), workerState: String(row.worker_state ?? 'stopped'),
        workerPid: row.process_id === null || row.process_id === undefined ? null : Number(row.process_id),
        claim: row.claimed_from_sequence === null || row.claimed_from_sequence === undefined ? null : {
          from: Number(row.claimed_from_sequence), to: Number(row.claimed_to_sequence),
        },
        warmUntil: row.warm_until ? String(row.warm_until) : null,
        sessionState: row.session_state ? String(row.session_state) : 'unprovisioned',
        providerSessionPrefix: row.provider_session_id ? String(row.provider_session_id).slice(0, 12) : null,
        generation: row.generation === null || row.generation === undefined ? null : Number(row.generation),
        contextVersion: row.context_version === null || row.context_version === undefined ? 0 : Number(row.context_version),
        contextThroughSequence: row.context_through_sequence === null || row.context_through_sequence === undefined
          ? 0 : Number(row.context_through_sequence),
        memberCount: Number(row.member_count),
        historyLoaded: Number(row.history_event_count) > 0
          ? Number(row.history_event_count) : row.history_loaded_at ? Number(row.history_count ?? 0) : 0,
        historyForwarded: Number(row.history_forwarded_count ?? 0),
        onboardingState: row.onboarding_state ? String(row.onboarding_state) : null,
      })),
      messages: messages.map((row) => ({
        conversationId: row.conversation_id,
        title: displayTitleFromRow(row),
        kind: row.kind,
        channelId: row.channel_id,
        runtimeId: row.runtime_id,
        sequence: Number(row.sequence),
        sender: redactSender(row.sender_name ?? row.sender_id),
        state: row.processing_state,
        outboxState: row.outbox_state ?? null,
        receivedAt: row.received_at,
        ...(includeContent ? { preview: bodyPreview(row.body_json) } : {}),
      })),
      runtimes: runtimeRows.map((row) => ({
        runtimeId: String(row.runtime_id), label: row.runtime_label ? String(row.runtime_label) : String(row.runtime_id),
        model: row.runtime_model ? String(row.runtime_model) : null,
        adapterState: row.runtime_adapter_state ? String(row.runtime_adapter_state) : 'unknown',
        conversation: displayTitleFromRow(row),
        workerState: String(row.worker_state ?? 'stopped'),
        processId: row.process_id === null || row.process_id === undefined ? null : Number(row.process_id),
        sessionState: row.session_state ? String(row.session_state) : 'unprovisioned',
        providerSessionPrefix: row.provider_session_id ? String(row.provider_session_id).slice(0, 12) : null,
        generation: row.generation === null || row.generation === undefined ? null : Number(row.generation),
      })),
      alerts,
    };
  }
}

function displayTitleFromRow(row: Row): string {
  return displayConversationTitle(
    {
      kind: row.kind as ConversationKind,
      externalId: String(row.external_id),
      title: String(row.title),
    },
    row.direct_display_name ? String(row.direct_display_name) : null,
  );
}

function mapConversation(row: Row | undefined): Conversation | null {
  if (!row) return null;
  return {
    id: String(row.id), channelId: String(row.channel_id), channelProfileId: String(row.channel_profile_id),
    kind: row.kind as ConversationKind, externalId: String(row.external_id),
    title: String(row.title), responsibility: String(row.responsibility), mode: row.mode as ConversationMode,
    runtimeId: String(row.runtime_id), workerWarmSeconds: Number(row.worker_warm_seconds),
    policyVersion: Number(row.policy_version ?? 1),
    sessionGeneration: Number(row.session_generation ?? 1),
    enabled: Boolean(row.enabled), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function parseStoredMessageTime(value: unknown): number | null {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : null;
}

function assertWorkerWarmSeconds(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_WORKER_WARM_SECONDS) {
    throw new Error(`workerWarmSeconds 必须是 0-${MAX_WORKER_WARM_SECONDS} 的整数`);
  }
}

function mapSession(row: Row | undefined): SessionRecord | null {
  if (!row) return null;
  return {
    conversationId: String(row.conversation_id), runtimeId: String(row.runtime_id),
    providerSessionId: String(row.provider_session_id), generation: Number(row.generation),
    lifecycle: row.lifecycle as SessionRecord['lifecycle'], protocolFingerprint: String(row.protocol_fingerprint),
    runtimeCwd: String(row.runtime_cwd),
    bootstrapTurnId: row.bootstrap_turn_id ? String(row.bootstrap_turn_id) : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function mapConversationContext(row: Row | undefined): ConversationContext | null {
  if (!row) return null;
  return {
    conversationId: String(row.conversation_id),
    version: Number(row.version),
    throughSequence: Number(row.through_sequence),
    currentTopic: String(row.current_topic),
    facts: stringArray(row.facts_json),
    decisions: stringArray(row.decisions_json),
    commitments: stringArray(row.commitments_json),
    openQuestions: stringArray(row.open_questions_json),
    updatedAt: String(row.updated_at),
  };
}

function mapConversationMember(row: Row): ConversationMember {
  return {
    conversationId: String(row.conversation_id),
    externalUserId: String(row.external_user_id),
    displayName: row.display_name ? String(row.display_name) : null,
    organizationRole: String(row.organization_role ?? ''),
    conversationRole: String(row.conversation_role ?? ''),
    responsibilityBoundary: String(row.responsibility_boundary ?? ''),
    source: row.source as ConversationMember['source'],
    version: Number(row.version),
    updatedAt: String(row.updated_at),
  };
}

function mapAdmittedEvent(row: Row, conversation: Conversation): AdmittedEvent {
  const body = JSON.parse(String(row.body_json)) as Record<string, unknown>;
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    sequence: Number(row.sequence),
    ingress: (row.ingress ?? 'live') as AdmittedEvent['ingress'],
    channelId: conversation.channelId,
    channelProfileId: conversation.channelProfileId,
    fingerprint: String(row.fingerprint),
    eventId: row.event_id ? String(row.event_id) : null,
    messageId: row.message_id ? String(row.message_id) : null,
    conversationExternalId: conversation.externalId,
    conversationTitle: conversation.title,
    kind: conversation.kind,
    senderId: row.sender_id ? String(row.sender_id) : null,
    senderName: row.sender_name ? String(row.sender_name) : null,
    content: body.content ?? null,
    quotedMessage: body.quotedMessage ?? null,
    forwardedMessages: body.forwardedMessages ?? null,
    occurredAt: row.occurred_at ? String(row.occurred_at) : null,
    receivedAt: String(row.received_at),
    source: {},
  };
}

function mapWorker(row: Row | undefined): RuntimeWorkerRecord | null {
  if (!row) return null;
  return {
    conversationId: String(row.conversation_id),
    workerId: row.worker_id ? String(row.worker_id) : null,
    runtimeId: String(row.runtime_id),
    state: row.state as RuntimeWorkerRecord['state'],
    processId: row.process_id === null ? null : Number(row.process_id),
    claimedFromSequence: row.claimed_from_sequence === null ? null : Number(row.claimed_from_sequence),
    claimedToSequence: row.claimed_to_sequence === null ? null : Number(row.claimed_to_sequence),
    lastSignalAt: row.last_signal_at ? String(row.last_signal_at) : null,
    warmUntil: row.warm_until ? String(row.warm_until) : null,
    error: row.error ? String(row.error) : null,
    startedAt: row.started_at ? String(row.started_at) : null,
    updatedAt: String(row.updated_at),
  };
}

function redactSender(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!text) return null;
  return text.length === 1 ? `${text}*` : `${text.slice(0, 1)}***${text.slice(-1)}`;
}

function bodyPreview(value: unknown): string {
  try {
    const body = JSON.parse(String(value)) as Record<string, unknown>;
    const content = body.content;
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    return text.length <= 120 ? text : `${text.slice(0, 120)}…`;
  } catch {
    return '[unavailable]';
  }
}

function mapOutbox(row: Row | undefined): OutboxRecord | null {
  if (!row) return null;
  return {
    id: String(row.id), conversationId: String(row.conversation_id), inboundEventId: String(row.inbound_event_id),
    inputSequence: Number(row.input_sequence), uuid: String(row.uuid), text: String(row.text),
    state: row.state as OutboxRecord['state'], attemptCount: Number(row.attempt_count ?? 0),
    error: row.error ? String(row.error) : null,
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

function stringArray(value: unknown): string[] {
  const parsed = JSON.parse(String(value)) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('conversation context JSON 无效');
  }
  return parsed;
}

function cleanText(value: string, max: number, field: string): string {
  const text = value.trim();
  if (text.length > max) throw new Error(`${field} 长度不能超过 ${max}`);
  return text;
}

function cleanOptional(value: string | null, max: number, field: string): string | null {
  if (value === null) return null;
  const text = cleanText(value, max, field);
  return text || null;
}
