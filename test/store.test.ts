import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { normalizeDwsEvent, consumerArgs, fetchRecentGroupHistory } from '../src/dws.js';
import { defaultConfig } from '../src/config.js';

test('授权会话才可持久化，事件按会话单调编号并去重', () => {
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'group', externalId: 'cid-1', title: '测试群', responsibility: '回答测试问题', mode: 'shadow',
  });
  const event = normalizeDwsEvent({
    type: 'user_im_message_receive_group_all',
    event_id: 'evt-1', message_id: 'msg-1', conversation_id: 'cid-1', sender: '同事甲', content: '问题一',
  });
  assert.ok(event);
  const first = store.admitEvent(conversation, event);
  assert.equal(first.admitted, true);
  assert.equal(first.event?.sequence, 1);
  assert.equal(store.admitEvent(conversation, event).admitted, false);
  const secondEvent = normalizeDwsEvent({
    type: 'user_im_message_receive_group_all',
    event_id: 'evt-2', message_id: 'msg-2', conversation_id: 'cid-1', sender: '同事乙', content: '问题二',
  })!;
  assert.equal(store.admitEvent(conversation, secondEvent).event?.sequence, 2);
  assert.equal(store.latestSequence(conversation.id), 2);
  store.close();
});

test('conversation 使用中立 channel/runtime binding，并可设置 Worker warm TTL', () => {
  const store = new Store(':memory:');
  const group = store.addConversation({
    kind: 'group', externalId: 'shared-id', title: '钉钉群', responsibility: '参与讨论', mode: 'shadow',
  });
  const otherChannel = store.addConversation({
    channelId: 'slack', channelProfileId: 'workspace-a', runtimeId: 'claude',
    kind: 'group', externalId: 'shared-id', title: 'Slack 群', responsibility: '参与讨论', mode: 'shadow',
    workerWarmSeconds: 12,
  });
  assert.equal(group.channelId, 'dingtalk');
  assert.equal(group.channelProfileId, 'default');
  assert.equal(group.runtimeId, 'codex');
  assert.equal(group.workerWarmSeconds, 30);
  assert.equal(otherChannel.runtimeId, 'claude');
  assert.equal(otherChannel.workerWarmSeconds, 12);
  assert.equal(store.findEnabledConversation('dingtalk', 'default', 'group', 'shared-id')?.id, group.id);
  assert.equal(store.findEnabledConversation('slack', 'workspace-a', 'group', 'shared-id')?.id, otherChannel.id);
  const dingtalkEvent = normalizeDwsEvent({
    type: 'user_im_message_receive_group_all', event_id: 'same-event', conversation_id: 'shared-id', content: 'same',
  }, 'dingtalk', 'default')!;
  const slackEvent = normalizeDwsEvent({
    type: 'user_im_message_receive_group_all', event_id: 'same-event', conversation_id: 'shared-id', content: 'same',
  }, 'slack', 'workspace-a')!;
  assert.notEqual(dingtalkEvent.fingerprint, slackEvent.fingerprint);
  assert.equal(store.admitEvent(group, dingtalkEvent).admitted, true);
  assert.equal(store.admitEvent(otherChannel, slackEvent).admitted, true);
  assert.equal(store.setWorkerWarmSeconds(group.id, 0), true);
  assert.equal(store.getConversation(group.id)?.workerWarmSeconds, 0);
  assert.throws(() => store.setWorkerWarmSeconds(group.id, -1), /0-2147483/);
  assert.throws(() => store.setWorkerWarmSeconds(group.id, 2_147_484), /0-2147483/);
  store.close();
});

test('pending message 可事务 claim、释放并在 Host 重启时 reconciliation', () => {
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'claim-user', title: 'Claim 私聊', responsibility: '回答问题', mode: 'shadow',
  });
  const makeEvent = (id: string) => normalizeDwsEvent({
    type: 'user_im_message_receive_o2o_all', event_id: id,
    sender_open_dingtalk_id: 'claim-user', content: id,
  })!;
  store.admitEvent(conversation, makeEvent('claim-1'));
  store.admitEvent(conversation, makeEvent('claim-2'));
  const claimed = store.claimPendingEvents(conversation, 'worker-a', 20);
  assert.deepEqual(claimed.map((event) => event.sequence), [1, 2]);
  assert.deepEqual(store.claimPendingEvents(conversation, 'worker-b', 20), []);
  store.releaseClaimedEvents(claimed, 'worker-a');
  assert.equal(store.claimPendingEvents(conversation, 'worker-b', 1).length, 1);
  assert.deepEqual(store.recoverPendingWork(), [conversation.id]);
  assert.equal(store.status().pending_messages, 2);
  assert.equal(store.status().claimed_messages, 0);
  store.close();
});

test('outbox 在有更新消息时拒绝旧决定，发送前再次检查 freshness', () => {
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'group', externalId: 'cid-2', title: '测试群', responsibility: '测试', mode: 'reply',
  });
  const makeEvent = (id: string) => normalizeDwsEvent({
    type: 'user_im_message_receive_group_all', event_id: id, conversation_id: 'cid-2', content: id,
  })!;
  const first = store.admitEvent(conversation, makeEvent('evt-a')).event!;
  const pending = store.enqueueOutbox(first, '第一条回复', '00000000-0000-4000-8000-000000000001');
  assert.ok(pending);
  store.admitEvent(conversation, makeEvent('evt-b'));
  assert.equal(store.claimOutboxIfFresh(pending!.id), null);
  assert.equal(store.getOutbox(pending!.id)?.state, 'suppressed');
  assert.equal(store.enqueueOutbox(first, '过时回复', '00000000-0000-4000-8000-000000000002'), null);
  store.close();
});

test('lease 只允许一个存活 owner', () => {
  const store = new Store(':memory:');
  assert.equal(store.acquireLease('host', 'one', 1_000, 1_000), true);
  assert.equal(store.acquireLease('host', 'two', 1_500, 1_000), false);
  assert.equal(store.acquireLease('host', 'two', 2_001, 1_000), true);
  store.close();
});

test('DWS consumer 参数固定读取 flatten NDJSON stdout', () => {
  const config = defaultConfig('test', '.', 'Agent', 'role');
  config.channel.profile = 'corp:user';
  assert.deepEqual(consumerArgs('user_im_message_receive_group_all', config), [
    'event', 'consume', 'user_im_message_receive_group_all', '--ephemeral', '--flatten', '--format', 'ndjson',
    '--profile', 'corp:user',
  ]);
});

test('私聊 allowlist 使用对端 openDingTalkId，不与 conversationId 混淆', () => {
  const event = normalizeDwsEvent({
    type: 'user_im_message_receive_o2o_all', event_id: 'direct-event-1', conversation_id: 'conversation-1',
    sender_open_dingtalk_id: 'open-user-1', content: 'hello',
  });
  assert.equal(event?.kind, 'direct');
  assert.equal(event?.conversationExternalId, 'open-user-1');
});

test('首次群历史固定从当前本地时间向前拉 50 条，并按时间从早到晚投影', async () => {
  const config = defaultConfig('history', '.', 'Agent', 'role');
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'group', externalId: 'cid-history', title: '历史群', responsibility: '了解讨论', mode: 'shadow',
  });
  let captured: string[] = [];
  const history = await fetchRecentGroupHistory(
    config,
    conversation,
    new Date(2026, 7, 1, 1, 2, 3),
    async (_config, args) => {
      captured = args;
      return {
        success: true,
        result: [
          {
            openMessageId: 'secret-new', senderName: '同事乙', createTime: '2026-08-01 01:00:00', content: '新消息',
            quotedMessage: { openMessageId: 'secret-quoted', senderName: '同事丙', content: '引用内容' },
          },
          {
            openMessageId: 'secret-old', senderName: '同事甲', createTime: '2026-08-01 00:59:00', content: '旧消息',
            forwardMessages: [{ openMessageId: 'secret-forwarded', senderName: '同事丁', content: '转发内容' }],
          },
        ],
      };
    },
  );
  assert.deepEqual(captured, [
    'chat', 'message', 'list', '--group', 'cid-history', '--time', '2026-08-01 01:02:03',
    '--direction', 'older', '--limit', '50',
  ]);
  assert.equal(history.count, 2);
  assert.ok(history.prompt.indexOf('旧消息') < history.prompt.indexOf('新消息'));
  assert.match(history.prompt, /引用内容/);
  assert.match(history.prompt, /转发内容/);
  assert.doesNotMatch(history.prompt, /secret-(old|new|quoted|forwarded)/);
  store.close();
});

test('v1 会话迁移后补 onboarding 和每类生命周期默认值', () => {
  const path = resolve('.test-migration-state', 'state.sqlite3');
  rmSync(dirname(path), { recursive: true, force: true });
  mkdirSync(dirname(path), { recursive: true });
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,kind TEXT NOT NULL,external_id TEXT NOT NULL,title TEXT NOT NULL,
      responsibility TEXT NOT NULL,mode TEXT NOT NULL,enabled INTEGER NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(kind, external_id)
    );
    CREATE TABLE decisions (
      inbound_event_id TEXT PRIMARY KEY,turn_id TEXT,turn_status TEXT NOT NULL,action TEXT,
      responsibility_match INTEGER,category TEXT,reply_text TEXT,reason_code TEXT,created_at TEXT NOT NULL
    );
    INSERT INTO conversations VALUES('group-v1','group','cid-v1','旧群','参与讨论','shadow',1,'2026-01-01','2026-01-01');
    INSERT INTO conversations VALUES('direct-v1','direct','user-v1','旧私聊','回答问题','shadow',1,'2026-01-01','2026-01-01');
    PRAGMA user_version=1;
  `);
  old.close();
  try {
    const migrated = new Store(path);
    assert.equal(migrated.getGroupOnboarding('group-v1')?.state, 'pending');
    assert.equal(migrated.status().pending_group_onboarding, 1);
    assert.equal(migrated.getConversation('group-v1')?.channelId, 'dingtalk');
    assert.equal(migrated.getConversation('direct-v1')?.runtimeId, 'codex');
    assert.equal(migrated.getConversation('direct-v1')?.workerWarmSeconds, 30);
    assert.equal((migrated.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 4);
    migrated.close();
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test('v2 会话迁移到 v4 时得到固定逻辑 session 和按需 Worker 默认值', () => {
  const path = resolve('.test-v2-lifecycle-state', 'state.sqlite3');
  rmSync(dirname(path), { recursive: true, force: true });
  mkdirSync(dirname(path), { recursive: true });
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,kind TEXT NOT NULL,external_id TEXT NOT NULL,title TEXT NOT NULL,
      responsibility TEXT NOT NULL,mode TEXT NOT NULL,enabled INTEGER NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(kind, external_id)
    );
    CREATE TABLE decisions (
      inbound_event_id TEXT PRIMARY KEY,turn_id TEXT,turn_status TEXT NOT NULL,action TEXT,
      responsibility_match INTEGER,category TEXT,reply_text TEXT,reason_code TEXT,
      work_type TEXT,delegation TEXT,subagent_thread_id TEXT,created_at TEXT NOT NULL
    );
    INSERT INTO conversations VALUES('group-v2','group','cid-v2','v2群','参与讨论','shadow',1,'2026-01-01','2026-01-01');
    INSERT INTO conversations VALUES('direct-v2','direct','user-v2','v2私聊','回答问题','shadow',1,'2026-01-01','2026-01-01');
    PRAGMA user_version=2;
  `);
  old.close();
  try {
    const migrated = new Store(path);
    assert.equal(migrated.getConversation('group-v2')?.channelId, 'dingtalk');
    assert.equal(migrated.getConversation('direct-v2')?.runtimeId, 'codex');
    assert.equal(migrated.getConversation('direct-v2')?.workerWarmSeconds, 30);
    assert.equal((migrated.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 4);
    migrated.close();
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test('v3 Codex thread 迁移为中立 runtime session 且完整 provider ID 不变', () => {
  const path = resolve('.test-v3-runtime-session-state', 'state.sqlite3');
  rmSync(dirname(path), { recursive: true, force: true });
  mkdirSync(dirname(path), { recursive: true });
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,kind TEXT NOT NULL,external_id TEXT NOT NULL,title TEXT NOT NULL,
      responsibility TEXT NOT NULL,mode TEXT NOT NULL,enabled INTEGER NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      session_lifecycle TEXT NOT NULL,idle_timeout_minutes INTEGER NOT NULL,
      UNIQUE(kind,external_id)
    );
    CREATE TABLE sessions (
      conversation_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,lifecycle TEXT NOT NULL,
      codex_version TEXT NOT NULL,schema_sha256 TEXT NOT NULL,runtime_cwd TEXT NOT NULL,
      bootstrap_turn_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE group_onboarding (
      conversation_id TEXT PRIMARY KEY,state TEXT NOT NULL,history_count INTEGER,history_loaded_at TEXT,
      intro_turn_id TEXT,intro_text TEXT,intro_uuid TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    INSERT INTO conversations VALUES(
      'group-v3','group','cid-v3','v3群','参与讨论','shadow',1,
      '2026-01-01','2026-01-01','resident',5
    );
    INSERT INTO sessions VALUES(
      'group-v3','thread-complete-v3','ready','codex-cli 0.145.0','schema-v3','D:/agent',
      'bootstrap-v3','2026-01-01','2026-01-02'
    );
    INSERT INTO group_onboarding VALUES(
      'group-v3','submitted',0,'2026-01-01','intro','hello','uuid',NULL,'2026-01-01','2026-01-01'
    );
    PRAGMA user_version=3;
  `);
  old.close();
  try {
    const migrated = new Store(path);
    const session = migrated.getSession('group-v3');
    assert.equal(session?.runtimeId, 'codex');
    assert.equal(session?.providerSessionId, 'thread-complete-v3');
    assert.equal(session?.generation, 1);
    assert.equal(session?.protocolFingerprint, 'codex-cli 0.145.0:schema-v3');
    assert.equal(migrated.getConversation('group-v3')?.workerWarmSeconds, 30);
    assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal((migrated.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 4);
    migrated.close();
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});
