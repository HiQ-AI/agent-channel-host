import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import {
  DIRECT_EVENT,
  DwsSender,
  GROUP_EVENT,
  consumerArgs,
  dwsProcessExitError,
  fetchRecentGroupHistory,
  inspectDwsBusStatus,
  normalizeDwsEvent,
  parseDwsCommandFailure,
  searchDwsGroups,
  subscribedEventKeys,
} from '../src/dws.js';
import { defaultConfig } from '../src/config.js';
import { ChannelDeliveryUnknownError } from '../src/contracts.js';

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
  const claimState = store.db.prepare(
    'SELECT claim_owner,claim_expires_at_ms FROM inbound_events WHERE id=?',
  ).get(claimed[0]!.id) as { claim_owner: string; claim_expires_at_ms: number | null };
  assert.equal(claimState.claim_owner, 'worker-a');
  assert.equal(claimState.claim_expires_at_ms, null);
  store.releaseClaimedEvents(claimed, 'worker-a');
  assert.equal(store.claimPendingEvents(conversation, 'worker-b', 1).length, 1);
  assert.deepEqual(store.recoverPendingWork(), [conversation.id]);
  assert.equal(store.status().pending_messages, 2);
  assert.equal(store.status().claimed_messages, 0);
  assert.equal(store.getConversation(conversation.id)?.sessionGeneration, 2);
  store.close();
});

test('启动 reconciliation 恢复可重试 failed inbox/outbox，并跳过完成项和失败上限', () => {
  const store = new Store(':memory:');
  const inbox = store.addConversation({
    kind: 'direct', externalId: 'recover-inbox', title: '恢复私聊', responsibility: '回答问题', mode: 'shadow',
  });
  const makeEvent = (externalId: string, id: string) => normalizeDwsEvent({
    type: 'user_im_message_receive_o2o_all', event_id: id,
    sender_open_dingtalk_id: externalId, content: id,
  })!;
  for (let index = 1; index <= 5; index += 1) store.admitEvent(inbox, makeEvent(inbox.externalId, `recover-${index}`));
  store.db.prepare("UPDATE inbound_events SET processing_state='claimed',claim_owner='dead-worker' WHERE conversation_id=? AND sequence=2")
    .run(inbox.id);
  store.db.prepare("UPDATE inbound_events SET processing_state='failed',failure_count=1,last_error='temporary' WHERE conversation_id=? AND sequence=3")
    .run(inbox.id);
  store.db.prepare("UPDATE inbound_events SET processing_state='failed',failure_count=3,last_error='terminal' WHERE conversation_id=? AND sequence=4")
    .run(inbox.id);
  store.db.prepare("UPDATE inbound_events SET processing_state='completed' WHERE conversation_id=? AND sequence=5").run(inbox.id);

  const send = store.addConversation({
    kind: 'direct', externalId: 'recover-outbox', title: '恢复发送', responsibility: '回答问题', mode: 'reply',
  });
  const outboundEvent = store.admitEvent(send, makeEvent(send.externalId, 'recover-outbox-event')).event!;
  const original = store.enqueueOutbox(outboundEvent, '恢复回复', '00000000-0000-4000-8000-000000000777')!;
  store.db.prepare("UPDATE outbox SET state='failed',attempt_count=1,error='temporary-send' WHERE id=?").run(original.id);

  const exhaustedSend = store.addConversation({
    kind: 'direct', externalId: 'exhausted-outbox', title: '达到重试上限', responsibility: '回答问题', mode: 'reply',
  });
  const exhaustedEvent = store.admitEvent(
    exhaustedSend,
    makeEvent(exhaustedSend.externalId, 'exhausted-outbox-event'),
  ).event!;
  const exhausted = store.enqueueOutbox(exhaustedEvent, '不应继续发送', '00000000-0000-4000-8000-000000000779')!;
  store.db.prepare("UPDATE inbound_events SET processing_state='completed' WHERE id=?").run(exhaustedEvent.id);
  store.db.prepare("UPDATE outbox SET state='sending',attempt_count=3 WHERE id=?").run(exhausted.id);

  const completedSend = store.addConversation({
    kind: 'direct', externalId: 'completed-outbox', title: '已发送', responsibility: '回答问题', mode: 'reply',
  });
  const completedEvent = store.admitEvent(completedSend, makeEvent(completedSend.externalId, 'completed-outbox-event')).event!;
  const submitted = store.enqueueOutbox(completedEvent, '已发送回复', '00000000-0000-4000-8000-000000000778')!;
  store.db.prepare("UPDATE inbound_events SET processing_state='completed' WHERE id=?").run(completedEvent.id);
  store.db.prepare("UPDATE outbox SET state='submitted',attempt_count=1 WHERE id=?").run(submitted.id);

  assert.deepEqual(store.recoverPendingWork(), [inbox.id, send.id].sort());
  const states = store.db.prepare(`
    SELECT sequence,processing_state,failure_count FROM inbound_events
    WHERE conversation_id=? ORDER BY sequence
  `).all(inbox.id) as Array<{ sequence: number; processing_state: string; failure_count: number }>;
  assert.deepEqual(states.map((row) => [row.sequence, row.processing_state, row.failure_count]), [
    [1, 'admitted', 0], [2, 'admitted', 0], [3, 'admitted', 1], [4, 'failed', 3], [5, 'completed', 0],
  ]);
  const pending = store.listPendingOutbox(send.id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.uuid, original.uuid);
  assert.equal(store.getOutbox(submitted.id)?.state, 'submitted');
  assert.equal(store.getOutbox(exhausted.id)?.state, 'failed');
  assert.equal(store.getOutbox(exhausted.id)?.error, 'recovery-attempt-limit');
  const claimed = store.claimOutboxIfFresh(original.id);
  assert.equal(claimed?.uuid, original.uuid);
  assert.equal(claimed?.attemptCount, 2);
  store.close();
});

test('delivery_unknown 是需关注但不自动重试的发送终态', () => {
  const store = new Store(':memory:');
  const group = store.addConversation({
    kind: 'group', externalId: 'delivery-unknown-group', title: '未知终态群', responsibility: '', mode: 'reply',
  });
  store.prepareGroupOnboarding(group.id, 1, 'unknown-turn', '本轮回复', 'unknown-onboarding-uuid');
  store.finishGroupOnboardingIntro(group.id, 'delivery_unknown', 'delivery_unknown:duplicate_uuid');

  const direct = store.addConversation({
    kind: 'direct', externalId: 'delivery-unknown-user', title: '未知终态私聊', responsibility: '', mode: 'reply',
  });
  const event = store.admitEvent(direct, normalizeDwsEvent({
    type: 'user_im_message_receive_o2o_all', event_id: 'delivery-unknown-event',
    sender_open_dingtalk_id: direct.externalId, content: '需要回复',
  })!).event!;
  const outbox = store.enqueueOutbox(event, '本轮回复', 'unknown-outbox-uuid')!;
  store.db.prepare("UPDATE inbound_events SET processing_state='completed' WHERE id=?").run(event.id);
  assert.ok(store.claimOutboxIfFresh(outbox.id));
  store.finishOutbox(outbox.id, 'delivery_unknown', 'delivery_unknown:duplicate_uuid');

  assert.equal(store.getGroupOnboarding(group.id)?.state, 'delivery_unknown');
  assert.equal(store.getOutbox(outbox.id)?.state, 'delivery_unknown');
  assert.equal(store.status().pending_group_onboarding, 0);
  assert.equal((store.status().alerts as unknown[]).length, 2);
  assert.deepEqual(store.recoverPendingWork(), []);
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

test('批次决定、inbox 完成与可选 outbox 在同一事务提交', () => {
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'atomic-user', title: '原子私聊', responsibility: '本地备注', mode: 'reply',
  });
  const normalized = normalizeDwsEvent({
    type: 'user_im_message_receive_o2o_all',
    event_id: 'atomic-event',
    sender_open_dingtalk_id: conversation.externalId,
    content: '需要回复',
  })!;
  store.admitEvent(conversation, normalized);
  const claimed = store.claimPendingEvents(conversation, 'atomic-worker', 20);
  const outbox = store.recordBatchDecision(
    claimed,
    'atomic-worker',
    'atomic-turn',
    'completed',
    { action: 'reply', replyText: '处理结果' },
    { text: '处理结果', uuid: '00000000-0000-4000-8000-000000000088' },
  );
  assert.equal(store.status().processed, 1);
  assert.equal(outbox?.state, 'pending');
  assert.equal(outbox?.text, '处理结果');
  const decision = store.db.prepare(`
    SELECT action,reply_text,responsibility_match,category,reason_code,work_type,delegation
    FROM decisions WHERE inbound_event_id=?
  `).get(claimed[0]!.id) as Record<string, unknown>;
  assert.deepEqual({ ...decision }, {
    action: 'reply',
    reply_text: '处理结果',
    responsibility_match: null,
    category: null,
    reason_code: null,
    work_type: null,
    delegation: null,
  });
  store.close();
});

test('重启发现活动 claim 时删除旧 provider session、提升 generation 并留审计', () => {
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'rotate-user', title: '重置私聊', responsibility: '本地备注', mode: 'shadow',
  });
  store.saveSession({
    conversationId: conversation.id,
    runtimeId: 'codex',
    providerSessionId: 'polluted-session',
    generation: 1,
    lifecycle: 'ready',
    protocolFingerprint: 'old-protocol',
    runtimeCwd: '.',
    bootstrapTurnId: 'old-turn',
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  });
  store.admitEvent(conversation, normalizeDwsEvent({
    type: 'user_im_message_receive_o2o_all',
    event_id: 'rotate-event',
    sender_open_dingtalk_id: conversation.externalId,
    content: '处理中断',
  })!);
  store.claimPendingEvents(conversation, 'dead-worker', 20);

  assert.deepEqual(store.recoverPendingWork(), [conversation.id]);
  assert.equal(store.getSession(conversation.id), null);
  assert.equal(store.getConversation(conversation.id)?.sessionGeneration, 2);
  const audit = store.db.prepare(`
    SELECT previous_generation,next_generation,previous_provider_session_id,reason
    FROM runtime_session_resets WHERE conversation_id=?
  `).get(conversation.id) as Record<string, unknown>;
  assert.deepEqual({ ...audit }, {
    previous_generation: 1,
    next_generation: 2,
    previous_provider_session_id: 'polluted-session',
    reason: 'host-restart-claimed-turn',
  });
  store.close();
});

test('lease 只允许一个存活 owner', () => {
  const store = new Store(':memory:');
  assert.equal(store.acquireLease('host', 'one', 1_000, 1_000), true);
  assert.equal(store.acquireLease('host', 'two', 1_500, 1_000), false);
  assert.equal(store.acquireLease('host', 'two', 2_001, 1_000), true);
  store.close();
});

test('删除 Conversation 级联清理业务状态、Worker lease 与外置 recovery', () => {
  const path = resolve('.test-delete-conversation', 'state.sqlite3');
  rmSync(dirname(path), { recursive: true, force: true });
  const store = new Store(path);
  const conversation = store.addConversation({
    kind: 'group', externalId: 'delete-group', title: '待删除群', responsibility: '测试', mode: 'reply',
  });
  try {
    const event = normalizeDwsEvent({
      type: 'user_im_message_receive_group_all', event_id: 'delete-event', conversation_id: 'delete-group',
      sender_open_dingtalk_id: 'delete-sender', sender: '同事甲', content: '待删除消息',
    })!;
    const admitted = store.admitEvent(conversation, event).event!;
    store.enqueueOutbox(admitted, '待删除回复', '00000000-0000-4000-8000-000000000099');
    store.saveSession({
      conversationId: conversation.id, runtimeId: 'codex', providerSessionId: 'delete-session', generation: 1,
      lifecycle: 'ready', protocolFingerprint: 'test', runtimeCwd: '.', bootstrapTurnId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    store.acquireLease(`conversation:${conversation.id}`, 'worker-delete', Date.now(), 60_000);
    const recovery = store.recoveryContextFile(conversation.id);
    mkdirSync(dirname(recovery), { recursive: true });
    writeFileSync(recovery, '{}', 'utf8');

    assert.equal(store.deleteConversation(conversation.id), true);
    assert.equal(store.getConversation(conversation.id), null);
    assert.equal(existsSync(recovery), false);
    for (const table of ['runtime_sessions', 'runtime_workers', 'inbound_events', 'outbox', 'group_onboarding', 'conversation_members']) {
      const row = store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      assert.equal(Number(row.count), 0, table);
    }
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM host_lease WHERE lease_key=?')
      .get(`conversation:${conversation.id}`) as { count: number }).count, 0);
    assert.equal(store.deleteConversation(conversation.id), false);
  } finally {
    store.close();
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test('DWS consumer 参数固定读取 flatten NDJSON stdout', () => {
  const config = defaultConfig('test', '.', 'Agent');
  config.channel.profile = 'corp:user';
  assert.deepEqual(consumerArgs('user_im_message_receive_group_all', config), [
    'event', 'consume', 'user_im_message_receive_group_all', '--ephemeral', '--flatten', '--format', 'ndjson',
    '--profile', 'corp:user',
  ]);
});

test('DWS 只启动配置允许的共享 consumer，全部 none 时不启动事件流', () => {
  const config = defaultConfig('subscription-processes', '.', 'Agent');
  config.channel.subscriptions = { groups: 'selected', directs: 'none' };
  assert.deepEqual(subscribedEventKeys(config), [GROUP_EVENT]);
  config.channel.subscriptions = { groups: 'none', directs: 'all' };
  assert.deepEqual(subscribedEventKeys(config), [DIRECT_EVENT]);
  config.channel.subscriptions = { groups: 'none', directs: 'none' };
  assert.deepEqual(subscribedEventKeys(config), []);
});

test('DWS bus ready 必须同时具备 running 状态与可用 status RPC', () => {
  assert.deepEqual(inspectDwsBusStatus({ bus: { entry: { state: 'running' }, live: { consumers: [] } } }), {
    state: 'running', live: true,
  });
  assert.deepEqual(inspectDwsBusStatus({ bus: { entry: { state: 'running' } } }), {
    state: 'running', live: false,
  });
  assert.deepEqual(inspectDwsBusStatus({ bus: { entry: { state: 'not_running' } } }), {
    state: 'not_running', live: false,
  });
});

test('DWS 子进程异常保留有界 stderr 根因并脱敏凭据', () => {
  const error = dwsProcessExitError('DWS consumer 退出', 5, null, [
    'access_token=secret-value',
    'fork/exec dws.exe: not supported by windows',
  ]);
  assert.match(error.message, /code=5/);
  assert.match(error.message, /not supported by windows/);
  assert.doesNotMatch(error.message, /secret-value/);
});

test('DWS 发送重复 UUID 返回 delivery_unknown，结构化错误不泄露消息正文', async () => {
  const payload = {
    error: {
      category: 'api', reason: 'business_error', server_error_code: '1001', operation: 'tools/call',
      message: "sendPersonalMessageByServerPush error: Request is repeated with uuid 'stable-uuid'.",
    },
  };
  const childError = Object.assign(new Error('Command failed: dws chat message send --text 机密正文'), {
    code: 1,
    stdout: '',
    stderr: JSON.stringify(payload),
  });
  const structured = parseDwsCommandFailure(childError, ['chat', 'message', 'send', '--text', '机密正文']);
  assert.match(structured.message, /duplicate_uuid/);
  assert.doesNotMatch(structured.message, /机密正文|stable-uuid/);

  const sender = new DwsSender(defaultConfig('dws-duplicate', '.', 'Agent'), async () => { throw structured; });
  await assert.rejects(sender.send(
    { kind: 'group', externalId: 'cid-duplicate' },
    { text: '机密正文', uuid: 'stable-uuid' },
  ), (error: Error) => error instanceof ChannelDeliveryUnknownError
    && error.message === 'delivery_unknown:duplicate_uuid');
});

test('DWS 其他业务错误继续 fail closed', async () => {
  const payload = {
    error: {
      category: 'api', reason: 'business_error', server_error_code: '1001', operation: 'tools/call',
      message: 'Permission denied for input 机密正文',
    },
  };
  const structured = parseDwsCommandFailure(Object.assign(new Error('raw'), {
    code: 1,
    stderr: JSON.stringify(payload),
  }), ['chat', 'message', 'send']);
  assert.doesNotMatch(structured.message, /机密正文/);
  const sender = new DwsSender(defaultConfig('dws-failure', '.', 'Agent'), async () => { throw structured; });
  await assert.rejects(sender.send(
    { kind: 'group', externalId: 'cid-failure' },
    { text: '机密正文', uuid: 'new-uuid' },
  ), /reason=business_error/);
});

test('DWS 群搜索只投影有效候选并按 openConversationId 去重', async () => {
  const config = defaultConfig('search', '.', 'Agent');
  let captured: string[] = [];
  const groups = await searchDwsGroups(config, ' 编辑器 ', async (_config, args) => {
    captured = args;
    return {
      success: true,
      result: {
        groups: [
          { title: '编辑器群 A', openConversationId: 'group-a', secret: 'not-projected' },
          { title: '重复项', openConversationId: 'group-a' },
          { title: '编辑器群 B', openConversationId: 'group-b' },
          { title: '', openConversationId: 'invalid-title' },
          { title: 'invalid-id' },
        ],
      },
    };
  });
  assert.deepEqual(captured, ['chat', 'search', '--query', '编辑器']);
  assert.deepEqual(groups, [
    { title: '编辑器群 A', openConversationId: 'group-a' },
    { title: '编辑器群 B', openConversationId: 'group-b' },
  ]);
  await assert.rejects(searchDwsGroups(config, '  ', async () => ({})), /关键词不能为空/);
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
  const config = defaultConfig('history', '.', 'Agent');
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
  assert.deepEqual(history.messages.map((message) => message.sender), ['同事甲', '同事乙']);
  assert.ok(history.messages[0]!.content.includes('旧消息'));
  assert.match(history.messages[0]!.content, /转发内容/);
  assert.match(history.messages[1]!.content, /引用内容/);
  assert.doesNotMatch(JSON.stringify(history.messages), /secret-(old|new|quoted|forwarded)/);
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
    assert.equal((migrated.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 10);
    assert.equal(migrated.getConversation('group-v1')?.policyVersion, 1);
    migrated.close();
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test('v2 会话迁移到当前 schema 时得到固定逻辑 session 和按需 Worker 默认值', () => {
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
    assert.equal((migrated.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 10);
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
    INSERT INTO conversations VALUES(
      'group-v3-submitted','group','cid-v3-submitted','已完成群','参与讨论','shadow',1,
      '2026-01-01','2026-01-01','resident',5
    );
    INSERT INTO sessions VALUES(
      'group-v3','thread-complete-v3','ready','codex-cli 0.145.0','schema-v3','D:/agent',
      'bootstrap-v3','2026-01-01','2026-01-02'
    );
    INSERT INTO group_onboarding VALUES(
      'group-v3','prepared',2,'2026-01-01','intro','旧自我介绍','uuid',NULL,'2026-01-01','2026-01-01'
    );
    INSERT INTO group_onboarding VALUES(
      'group-v3-submitted','submitted',1,'2026-01-01','sent-turn','已发送','sent-uuid',NULL,
      '2026-01-01','2026-01-01'
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
    const onboarding = migrated.getGroupOnboarding('group-v3');
    assert.equal(onboarding?.state, 'pending');
    assert.equal(onboarding?.introText, null);
    assert.equal(onboarding?.introUuid, null);
    assert.equal(migrated.getGroupOnboarding('group-v3-submitted')?.state, 'submitted');
    assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal((migrated.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 10);
    migrated.close();
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test('v5 Channel 状态表迁移后保留旧记录并允许 disabled', () => {
  const path = resolve('.test-v5-channel-state', 'state.sqlite3');
  rmSync(dirname(path), { recursive: true, force: true });
  mkdirSync(dirname(path), { recursive: true });
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE channel_connections (
      channel_id TEXT NOT NULL, profile_id TEXT NOT NULL, label TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('starting','ready','stopped','error')),
      owner_pid INTEGER, connected_at TEXT, last_event_at TEXT, error TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY(channel_id,profile_id)
    );
    INSERT INTO channel_connections VALUES(
      'dingtalk','default','DingTalk DWS','stopped',NULL,NULL,NULL,NULL,'2026-01-01'
    );
    CREATE TABLE runtime_sessions (
      conversation_id TEXT PRIMARY KEY,runtime_id TEXT NOT NULL,provider_session_id TEXT NOT NULL,
      generation INTEGER NOT NULL,lifecycle TEXT NOT NULL,protocol_fingerprint TEXT NOT NULL,
      runtime_cwd TEXT NOT NULL,bootstrap_turn_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    PRAGMA user_version=5;
  `);
  old.close();
  try {
    const migrated = new Store(path);
    try {
      migrated.setChannelConnection({
        channelId: 'dingtalk', profileId: 'default', label: 'DingTalk DWS',
        state: 'disabled', ownerPid: null,
      });
      const row = migrated.db.prepare(`
        SELECT state,label FROM channel_connections WHERE channel_id='dingtalk' AND profile_id='default'
      `).get() as { state: string; label: string };
      assert.equal(row.state, 'disabled');
      assert.equal(row.label, 'DingTalk DWS');
      assert.equal((migrated.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 10);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});
