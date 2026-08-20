import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config.js';
import { normalizeDwsEvent } from '../src/dws.js';
import {
  batchPrompt, conversationResponsibilityReminder, nextResponsibilityReminderCount,
  prependResponsibilityReminder, recentMessagesPrompt, shouldInjectResponsibilityReminder,
} from '../src/prompts.js';
import { Store } from '../src/store.js';

test('职责提醒间隔支持 1-99，0 关闭周期判断但保留职责变化提醒', () => {
  assert.equal(shouldInjectResponsibilityReminder('职责', null, 0, 5), true);
  assert.equal(shouldInjectResponsibilityReminder('职责', '职责', 1, 2), false);
  assert.equal(shouldInjectResponsibilityReminder('职责', '职责', 2, 2), true);
  assert.equal(shouldInjectResponsibilityReminder('职责', '职责', 99, 0), false);
  assert.equal(shouldInjectResponsibilityReminder('新职责', '旧职责', 0, 0), true);
  assert.equal(nextResponsibilityReminderCount(99, false, 0), 0);
});

test('普通群聊 turn 携带发送者 openDingTalkId 与正文姓名加结构化 ID 的 @ 规则', () => {
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

  const prompt = batchPrompt(conversation, [event]);
  assert.match(prompt, /^# 消息来源\n渠道：dingtalk\n类型：group\n目标ID：conversation-id-marker\n群名称：会话标题标记/m);
  assert.equal(prompt.match(/# 消息来源/g)?.length, 1);
  assert.match(prompt, /发送者：发送者甲/);
  assert.match(prompt, /发送者OpenDingTalkId：sender-id-marker/);
  assert.match(prompt, /正文写可见的 @发送者姓名/);
  assert.match(prompt, /--at-open-dingtalk-ids openDingTalkId/);
  assert.match(prompt, /由结构化参数生成真实 @/);
  assert.match(prompt, /禁止把 <@ID> 占位符写进可见正文/);
  assert.equal(prompt.includes('正文必须包含 <@openDingTalkId>'), false);
  assert.equal(prompt.includes('<@sender-id-marker>'), false);
  assert.equal(prompt.includes('不要只写 @姓名'), false);
  assert.match(prompt, /不要猜测 ID/);
  assert.match(prompt, /时间：2026-08-03 12:00:00/);
  assert.match(prompt, /内容：正文内容/);
  assert.match(prompt, /引用内容/);
  assert.match(prompt, /转发内容/);
  for (const forbidden of [
    config.identity.name,
    conversation.responsibility,
    '成员资料标记',
    '组织角色标记',
    'sequence',
    'checkpoint',
    '会话：',
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

test('首次群聊最近消息使用同一来源头且同批只注入一次', () => {
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'group', externalId: 'cid-history', title: '历史群', responsibility: '', mode: 'shadow',
  });
  const prompt = recentMessagesPrompt(conversation, [
    { sender: '同事甲', senderId: 'open-id-a', time: '2026-08-03 11:00:00', content: '历史问题' },
    { sender: '同事乙', senderId: 'open-id-b', time: '2026-08-03 11:02:00', content: '历史补充' },
  ]);
  assert.match(prompt, /发送者：同事甲/);
  assert.match(prompt, /发送者OpenDingTalkId：open-id-a/);
  assert.match(prompt, /时间：2026-08-03 11:02:00/);
  assert.match(prompt, /内容：历史补充/);
  assert.match(prompt, /^# 消息来源\n渠道：dingtalk\n类型：group\n目标ID：cid-history\n群名称：历史群/m);
  assert.equal(prompt.match(/# 消息来源/g)?.length, 1);
  assert.equal(prompt.includes('action'), false);
  assert.equal(prompt.includes('replyText'), false);
  assert.equal(prompt.includes('自我介绍'), false);
  assert.equal(prompt.includes('职责'), false);
  store.close();
});

test('私聊消息来源使用对方 openDingTalkId 和名称，不暴露 Host Conversation UUID', () => {
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'open-dingtalk-user', title: '同事甲', responsibility: '', mode: 'reply',
  });
  const event = store.admitEvent(conversation, normalizeDwsEvent({
    type: 'user_im_message_receive_o2o_all', event_id: 'direct-event',
    sender_open_dingtalk_id: conversation.externalId, sender_name: '同事甲',
    event_time: '2026-08-04 10:00:00', content: '私聊内容',
  })!).event!;
  const prompt = batchPrompt(conversation, [event]);
  assert.match(prompt, /^# 消息来源\n渠道：dingtalk\n类型：direct\n目标ID：open-dingtalk-user\n对方名称：同事甲/m);
  assert.equal(prompt.includes(conversation.id), false);
  assert.equal(prompt.includes('发送者OpenDingTalkId'), false);
  store.close();
});

test('任务续接事件明确标记为宿主控制而不是渠道消息', () => {
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'continuation-user', title: '续接私聊', responsibility: '', mode: 'shadow',
  });
  const event = store.admitEvent(conversation, {
    channelId: conversation.channelId,
    channelProfileId: conversation.channelProfileId,
    fingerprint: 'continuation-prompt', eventId: 'continuation-prompt', messageId: null,
    conversationExternalId: conversation.externalId, conversationTitle: conversation.title,
    kind: conversation.kind, senderId: null, senderName: '本地任务续接控制器',
    content: '恢复 Task TT-1', quotedMessage: null, forwardedMessages: null,
    occurredAt: '2026-08-11T00:00:00.000Z', receivedAt: '2026-08-11T00:00:00.000Z', source: {},
  }, 'continuation').event!;
  const prompt = batchPrompt(conversation, [event]);
  assert.match(prompt, /消息类型：宿主任务续跑事件（不是新的渠道消息）/);
  assert.match(prompt, /不要仅因本控制事件向当前渠道发送消息/);
  assert.match(prompt, /恢复 Task TT-1/);
  store.close();
});
