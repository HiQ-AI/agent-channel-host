import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDwsEvent } from '../src/dws.js';
import { Store } from '../src/store.js';
import { renderStatusView } from '../src/view.js';

test('status/view 共享中立快照且默认不泄露正文、外部 ID 或完整 provider session ID', () => {
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'open-secret-user', title: '编辑器私聊', responsibility: '回答问题', mode: 'shadow',
  });
  const event = normalizeDwsEvent({
    type: 'user_im_message_receive_o2o_all', event_id: 'event-secret',
    sender_open_dingtalk_id: 'open-secret-user', sender_name: '张三', content: '高度敏感的消息正文',
  })!;
  store.admitEvent(conversation, event);
  store.saveSession({
    conversationId: conversation.id,
    runtimeId: 'codex',
    providerSessionId: 'provider-session-complete-secret',
    generation: 1,
    lifecycle: 'ready',
    protocolFingerprint: 'codex:test',
    runtimeCwd: 'D:/agent',
    bootstrapTurnId: 'bootstrap',
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  });
  store.setWorkerState({
    conversationId: conversation.id,
    workerId: 'worker-secret',
    runtimeId: 'codex',
    state: 'running',
    processId: 1234,
    claimedFromSequence: 1,
    claimedToSequence: 1,
  });
  store.setRuntimeAdapter({
    runtimeId: 'codex', label: 'Codex App Server', state: 'ready',
    model: 'gpt-test', protocolFingerprint: 'codex:test',
  });
  store.setChannelConnection({
    channelId: 'dingtalk', profileId: 'default', label: 'DingTalk DWS',
    state: 'ready', ownerPid: 4321, connectedAt: new Date().toISOString(),
  });
  try {
    const snapshot = store.status();
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /open-secret-user|高度敏感|provider-session-complete-secret|张三/);
    assert.match(serialized, /provider-ses/);
    assert.match(serialized, /张\*\*\*三/);
    const rendered = renderStatusView('test', snapshot, 120);
    for (const section of ['CHANNELS', 'MESSAGES', 'CONVERSATIONS', 'RUNTIMES']) assert.match(rendered, new RegExp(section));
    assert.match(rendered, /gpt-test/);
    assert.doesNotMatch(rendered, /open-secret-user|高度敏感|provider-session-complete-secret/);
    assert.match(JSON.stringify(store.status(true)), /高度敏感的消息正文/);
  } finally {
    store.close();
  }
});
