import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_WORKER_WARM_SECONDS, MAX_WORKER_WARM_SECONDS } from './types.js';
import type {
  AdmittedEvent,
  Conversation,
  ConversationKind,
  ConversationMode,
  Decision,
  GroupOnboardingRecord,
  NormalizedEvent,
  OutboxRecord,
  RuntimeWorkerRecord,
  SessionRecord,
} from './types.js';

type Row = Record<string, unknown>;
const LEGACY_MAX_IDLE_TIMEOUT_MINUTES = 35_791;

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
          worker_warm_seconds,enabled,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)
      `).run(
        id, channelId, channelProfileId, input.kind, input.externalId, input.title,
        input.responsibility, input.mode, runtimeId, workerWarmSeconds, now, now,
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
    const result = this.db.prepare('UPDATE conversations SET enabled=?,updated_at=? WHERE id=?')
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
    return Number(result.changes) === 1;
  }

  setConversationMode(id: string, mode: ConversationMode): boolean {
    const result = this.db.prepare('UPDATE conversations SET mode=?,updated_at=? WHERE id=?')
      .run(mode, new Date().toISOString(), id);
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
    const sql = `SELECT * FROM conversations${enabledOnly ? ' WHERE enabled=1' : ''} ORDER BY kind,title`;
    return (this.db.prepare(sql).all() as Row[]).map((row) => mapConversation(row)!);
  }

  getSession(conversationId: string): SessionRecord | null {
    return mapSession(this.db.prepare('SELECT * FROM runtime_sessions WHERE conversation_id=?').get(conversationId) as Row | undefined);
  }

  saveSession(session: SessionRecord): void {
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

  admitEvent(conversation: Conversation, event: NormalizedEvent): { admitted: boolean; event: AdmittedEvent | null } {
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

  claimPendingEvents(
    conversation: Conversation,
    workerId: string,
    limit: number,
    nowMs = Date.now(),
    claimTtlMs = 300_000,
  ): AdmittedEvent[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        UPDATE inbound_events SET processing_state='admitted',claim_owner=NULL,
          claim_expires_at_ms=NULL,claimed_at=NULL
        WHERE conversation_id=? AND processing_state='claimed' AND claim_expires_at_ms<=?
      `).run(conversation.id, nowMs);
      const rows = this.db.prepare(`
        SELECT * FROM inbound_events
        WHERE conversation_id=? AND processing_state='admitted'
        ORDER BY sequence LIMIT ?
      `).all(conversation.id, limit) as Row[];
      if (rows.length === 0) {
        this.db.exec('COMMIT');
        return [];
      }
      const claimedAt = new Date(nowMs).toISOString();
      const claim = this.db.prepare(`
        UPDATE inbound_events SET processing_state='claimed',claim_owner=?,claim_expires_at_ms=?,claimed_at=?
        WHERE id=? AND processing_state='admitted'
      `);
      for (const row of rows) claim.run(workerId, nowMs + claimTtlMs, claimedAt, String(row.id));
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

  recordBatchDecision(
    events: AdmittedEvent[],
    workerId: string,
    turnId: string | null,
    turnStatus: 'completed' | 'failed',
    decision: Decision | null,
    subagentThreadId: string | null = null,
  ): void {
    if (events.length === 0) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const statement = this.db.prepare(`
        INSERT INTO decisions(
          inbound_event_id,turn_id,turn_status,action,responsibility_match,category,reply_text,reason_code,
          work_type,delegation,subagent_thread_id,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(inbound_event_id) DO UPDATE SET
          turn_id=excluded.turn_id,turn_status=excluded.turn_status,action=excluded.action,
          responsibility_match=excluded.responsibility_match,category=excluded.category,
          reply_text=excluded.reply_text,reason_code=excluded.reason_code,work_type=excluded.work_type,
          delegation=excluded.delegation,subagent_thread_id=excluded.subagent_thread_id,created_at=excluded.created_at
      `);
      const complete = this.db.prepare(`
        UPDATE inbound_events SET processing_state=?,claim_owner=NULL,claim_expires_at_ms=NULL,claimed_at=NULL
        WHERE id=? AND processing_state='claimed' AND claim_owner=?
      `);
      const now = new Date().toISOString();
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index]!;
        const isTail = index === events.length - 1;
        const itemDecision = isTail ? decision : null;
        statement.run(
          event.id, turnId, turnStatus, itemDecision?.action ?? null,
          itemDecision ? (itemDecision.responsibilityMatch ? 1 : 0) : null,
          itemDecision?.category ?? (turnStatus === 'completed' ? 'batch_context' : null),
          itemDecision?.replyText ?? null,
          itemDecision?.reasonCode ?? (turnStatus === 'completed' ? 'included_in_batch' : null),
          itemDecision?.workType ?? null,
          itemDecision?.delegation ?? null,
          isTail ? subagentThreadId : null,
          now,
        );
        complete.run(turnStatus, event.id, workerId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recoverPendingWork(): string[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE inbound_events SET processing_state='admitted',claim_owner=NULL,
          claim_expires_at_ms=NULL,claimed_at=NULL
        WHERE processing_state='claimed'
      `).run();
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
          (c.kind='group' AND g.state<>'submitted' AND (g.intro_text IS NULL OR c.mode='reply'))
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
    state: 'starting' | 'ready' | 'stopped' | 'error';
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
    error?: string | null;
  }): void {
    const now = new Date().toISOString();
    const current = this.db.prepare('SELECT * FROM runtime_adapters WHERE runtime_id=?')
      .get(input.runtimeId) as Row | undefined;
    this.db.prepare(`
      INSERT INTO runtime_adapters(runtime_id,label,state,model,protocol_fingerprint,error,updated_at)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(runtime_id) DO UPDATE SET
        label=excluded.label,state=excluded.state,model=excluded.model,
        protocol_fingerprint=excluded.protocol_fingerprint,error=excluded.error,updated_at=excluded.updated_at
    `).run(
      input.runtimeId,
      input.label,
      input.state,
      input.model,
      input.protocolFingerprint !== undefined
        ? input.protocolFingerprint
        : current?.protocol_fingerprint ? String(current.protocol_fingerprint) : null,
      input.error ?? null,
      now,
    );
  }

  status(includeContent = false): Record<string, unknown> {
    const counts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM conversations WHERE enabled=1) AS enabled_conversations,
        (SELECT COUNT(*) FROM runtime_sessions WHERE lifecycle='ready') AS recoverable_sessions,
        (SELECT COUNT(*) FROM inbound_events) AS received,
        (SELECT COUNT(*) FROM inbound_events WHERE processing_state='admitted') AS pending_messages,
        (SELECT COUNT(*) FROM inbound_events WHERE processing_state='claimed') AS claimed_messages,
        (SELECT COUNT(*) FROM inbound_events WHERE processing_state='completed') AS processed,
        (SELECT COUNT(*) FROM inbound_events WHERE processing_state='failed') AS failed_messages,
        (SELECT COUNT(*) FROM outbox WHERE state='submitted') AS submitted,
        (SELECT COUNT(*) FROM outbox WHERE state IN ('pending','sending')) AS pending_outbox,
        (SELECT COUNT(*) FROM group_onboarding WHERE state<>'submitted') AS pending_group_onboarding
    `).get() as Row;
    const channels = this.db.prepare(`
      SELECT channel_id,profile_id,label,state,owner_pid,connected_at,last_event_at,error,updated_at
      FROM channel_connections ORDER BY channel_id,profile_id
    `).all() as Row[];
    const runtimeAdapters = this.db.prepare(`
      SELECT runtime_id,label,state,model,protocol_fingerprint,error,updated_at
      FROM runtime_adapters ORDER BY runtime_id
    `).all() as Row[];
    const conversations = this.db.prepare(`
      SELECT c.*,w.worker_id,w.state AS worker_state,w.process_id,w.claimed_from_sequence,
        w.claimed_to_sequence,w.last_signal_at,w.warm_until,w.error AS worker_error,w.updated_at AS worker_updated_at,
        s.provider_session_id,s.lifecycle AS session_state,s.generation,s.protocol_fingerprint,
        r.label AS runtime_label,r.model AS runtime_model,r.state AS runtime_adapter_state,
        (SELECT COUNT(*) FROM inbound_events e
          WHERE e.conversation_id=c.id AND e.processing_state IN ('admitted','claimed')) AS pending_count,
        (SELECT COALESCE(MAX(sequence),0) FROM inbound_events e WHERE e.conversation_id=c.id) AS latest_sequence
      FROM conversations c
      LEFT JOIN runtime_workers w ON w.conversation_id=c.id
      LEFT JOIN runtime_sessions s ON s.conversation_id=c.id
      LEFT JOIN runtime_adapters r ON r.runtime_id=c.runtime_id
      ORDER BY c.channel_id,c.title
    `).all() as Row[];
    const messages = this.db.prepare(`
      SELECT e.sequence,e.received_at,e.processing_state,e.sender_name,e.sender_id,e.body_json,
        c.title,c.kind,c.channel_id,c.runtime_id,d.action,o.state AS outbox_state
      FROM inbound_events e
      JOIN conversations c ON c.id=e.conversation_id
      LEFT JOIN decisions d ON d.inbound_event_id=e.id
      LEFT JOIN outbox o ON o.inbound_event_id=e.id
      ORDER BY e.received_at DESC,e.sequence DESC LIMIT 12
    `).all() as Row[];
    const failedOutbox = this.db.prepare(`
      SELECT c.title,o.error,o.updated_at FROM outbox o
      JOIN conversations c ON c.id=o.conversation_id
      WHERE o.state='failed' ORDER BY o.updated_at DESC LIMIT 5
    `).all() as Row[];
    const failedOnboarding = this.db.prepare(`
      SELECT c.title,g.error,g.updated_at FROM group_onboarding g
      JOIN conversations c ON c.id=g.conversation_id
      WHERE g.state='failed' ORDER BY g.updated_at DESC LIMIT 5
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
        scope: 'worker', target: String(row.title), error: String(row.worker_error), at: String(row.worker_updated_at),
      })),
      ...runtimeAdapters.filter((row) => row.error).map((row) => ({
        scope: 'runtime', target: String(row.runtime_id), error: String(row.error), at: String(row.updated_at),
      })),
      ...failedOutbox.map((row) => ({
        scope: 'outbox', target: String(row.title), error: String(row.error ?? 'send-failed'), at: String(row.updated_at),
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
        error: row.error ? String(row.error) : null,
        updatedAt: String(row.updated_at),
      })),
      conversations: conversations.map((row) => ({
        idPrefix: String(row.id).slice(0, 8), channelId: String(row.channel_id),
        channelProfileId: String(row.channel_profile_id), kind: String(row.kind), title: String(row.title),
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
      })),
      messages: messages.map((row) => ({
        title: row.title,
        kind: row.kind,
        channelId: row.channel_id,
        runtimeId: row.runtime_id,
        sequence: Number(row.sequence),
        sender: redactSender(row.sender_name ?? row.sender_id),
        state: row.processing_state,
        action: row.action ?? null,
        outboxState: row.outbox_state ?? null,
        receivedAt: row.received_at,
        ...(includeContent ? { preview: bodyPreview(row.body_json) } : {}),
      })),
      runtimes: runtimeRows.map((row) => ({
        runtimeId: String(row.runtime_id), label: row.runtime_label ? String(row.runtime_label) : String(row.runtime_id),
        model: row.runtime_model ? String(row.runtime_model) : null,
        adapterState: row.runtime_adapter_state ? String(row.runtime_adapter_state) : 'unknown',
        conversation: String(row.title),
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

function mapConversation(row: Row | undefined): Conversation | null {
  if (!row) return null;
  return {
    id: String(row.id), channelId: String(row.channel_id), channelProfileId: String(row.channel_profile_id),
    kind: row.kind as ConversationKind, externalId: String(row.external_id),
    title: String(row.title), responsibility: String(row.responsibility), mode: row.mode as ConversationMode,
    runtimeId: String(row.runtime_id), workerWarmSeconds: Number(row.worker_warm_seconds),
    enabled: Boolean(row.enabled), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
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

function mapAdmittedEvent(row: Row, conversation: Conversation): AdmittedEvent {
  const body = JSON.parse(String(row.body_json)) as Record<string, unknown>;
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    sequence: Number(row.sequence),
    channelId: conversation.channelId,
    channelProfileId: conversation.channelProfileId,
    fingerprint: String(row.fingerprint),
    eventId: row.event_id ? String(row.event_id) : null,
    messageId: row.message_id ? String(row.message_id) : null,
    conversationExternalId: conversation.externalId,
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
