import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config.js';
import { normalizeDwsEvent } from '../src/dws.js';
import { batchPrompt, conversationResponsibilityReminder, prependResponsibilityReminder, recentMessagesPrompt } from '../src/prompts.js';
import { Store } from '../src/store.js';

test('普通 turn 只转发发送者、时间、内容，不注入 Host 会话资料', () => {
  const config = defaultConfig('message-proxy', '.', '身份标记');
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'group',
    externalId: 'conversation-id-marker',
    title: '会话标题标记',
    responsibility: '职责标记',
    mode: 'shadow',
  });
  store.updateConversationMember(conversation.id, 'member-id-marker', {
    displayName: '成员资料标记',
    organizationRole: '组织角色标记',
  });
  const event = store.admitEvent(conversation, normalizeDwsEvent({
    type: 'user_im_message_receive_group_all',
    event_id: 'event-id-marker',
    conversation_id: conversation.externalId,
    sender_id: 'sender-id-marker',
    sender_name: '发送者甲',
    event_time: '2026-08-03 12:00:00',
    content: '正文内容',
    quoted_message: { content: '引用内容' },
    forward_messages: [{ content: '转发内容' }],
  })!).event!;

  const prompt = batchPrompt([event]);
  assert.match(prompt, /发送者：发送者甲/);
  assert.match(prompt, /时间：2026-08-03 12:00:00/);
  assert.match(prompt, /内容：正文内容/);
  assert.match(prompt, /引用内容/);
  assert.match(prompt, /转发内容/);
  for (const forbidden of [
    config.identity.name,
    conversation.externalId,
    conversation.title,
    conversation.responsibility,
    '成员资料标记',
    '组织角色标记',
    'sequence',
    'checkpoint',
    '会话：',
    '群聊',
    '私聊',
  ]) {
    assert.equal(prompt.includes(forbidden), false, `不应注入：${forbidden}`);
  }
  store.close();
});

test('会话职责使用独立短提醒，空值不改变普通消息', () => {
  assert.equal(conversationResponsibilityReminder(' 只做方案与分析 '), '# 会话职责提醒\n只做方案与分析');
  assert.equal(conversationResponsibilityReminder('  '), null);
  assert.equal(
    prependResponsibilityReminder('本轮新增消息', ' 只做方案与分析 '),
    '# 会话职责提醒\n只做方案与分析\n\n本轮新增消息',
  );
  assert.equal(prependResponsibilityReminder('本轮新增消息', '  '), '本轮新增消息');
});

test('首次群聊最近消息使用相同的最小信封与返回约定', () => {
  const prompt = recentMessagesPrompt([
    { sender: '同事甲', time: '2026-08-03 11:00:00', content: '历史问题' },
    { sender: '同事乙', time: '2026-08-03 11:02:00', content: '历史补充' },
  ]);
  assert.match(prompt, /发送者：同事甲/);
  assert.match(prompt, /时间：2026-08-03 11:02:00/);
  assert.match(prompt, /内容：历史补充/);
  assert.match(prompt, /"action":"silent"/);
  assert.match(prompt, /"action":"reply"/);
  assert.equal(prompt.includes('自我介绍'), false);
  assert.equal(prompt.includes('职责'), false);
  assert.equal(prompt.includes('会话'), false);
});
