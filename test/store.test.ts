import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { normalizeDwsEvent, consumerArgs } from '../src/dws.js';
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
  config.runtime.dwsProfile = 'corp:user';
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
