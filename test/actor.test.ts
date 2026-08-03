import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { normalizeDwsEvent } from '../src/dws.js';
import { ConversationWorker } from '../src/actor.js';
import type { AgentSession } from '../src/contracts.js';
import type { DeliveryRun } from '../src/types.js';

class RecordingSession implements AgentSession {
  currentSessionId = 'thread-fixed-123456789';
  processId = null;
  prompts: string[] = [];
  async start(): Promise<void> {}
  async deliver(prompt: string): Promise<DeliveryRun> {
    this.prompts.push(prompt);
    return { turnId: `turn-${this.prompts.length}`, status: 'completed' };
  }
  async interruptActive(): Promise<boolean> { return false; }
  async stop(): Promise<void> {}
}

test('实时消息逐条顺序传入固定 runtime session，Host 不调用 Channel send', async () => {
  const config = defaultConfig('actor', '.', 'Agent');
  config.scheduling.quietWindowMilliseconds = 0;
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'direct-actor', title: 'Actor 私聊', responsibility: '', mode: 'reply',
  });
  const session = new RecordingSession();
  const worker = new ConversationWorker(
    config, conversation, session, store, () => undefined,
  );
  const admit = (id: string) => store.admitEvent(conversation, normalizeDwsEvent({
    type: 'user_im_message_receive_o2o_all', event_id: id,
    sender_open_dingtalk_id: conversation.externalId, sender_name: '同事甲', content: id,
  })!);
  try {
    await worker.start();
    admit('第一条');
    admit('第二条');
    worker.signal();
    await waitFor(() => store.status().processed === 2);
    assert.equal(session.prompts.length, 2);
    assert.match(session.prompts[0]!, /内容：第一条/);
    assert.doesNotMatch(session.prompts[0]!, /第二条/);
    assert.match(session.prompts[1]!, /内容：第二条/);
    assert.equal(store.status().submitted, 0);
  } finally {
    await worker.stop();
    store.close();
  }
});

test('首次群历史逐条传入 runtime，不接收决定也不发送回复', async () => {
  const config = defaultConfig('history', '.', 'Agent');
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'group', externalId: 'cid-history', title: '历史群', responsibility: '', mode: 'reply',
  });
  const session = new RecordingSession();
  const worker = new ConversationWorker(
    config, conversation, session, store, () => undefined, () => undefined,
    async () => ({
      count: 2,
      messages: [
        { sender: '同事甲', time: '2026-08-03 10:00:00', content: '历史一' },
        { sender: '同事乙', time: '2026-08-03 10:01:00', content: '历史二' },
      ],
    }),
  );
  try {
    await worker.start();
    assert.equal(session.prompts.length, 2);
    assert.match(session.prompts[0]!, /历史一/);
    assert.doesNotMatch(session.prompts[0]!, /历史二/);
    assert.match(session.prompts[1]!, /历史二/);
    assert.equal(store.getGroupOnboarding(conversation.id)?.state, 'completed');
  } finally {
    await worker.stop();
    store.close();
  }
});

test('runtime 投递失败保留 failed inbox，重启 reconciliation 后可再次投递', async () => {
  const config = defaultConfig('recovery', '.', 'Agent');
  config.scheduling.quietWindowMilliseconds = 0;
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'recovery-user', title: '恢复私聊', responsibility: '', mode: 'shadow',
  });
  const failing: AgentSession = {
    currentSessionId: 'fixed', processId: null, start: async () => undefined,
    deliver: async () => { throw new Error('runtime unavailable'); },
    interruptActive: async () => false, stop: async () => undefined,
  };
  const event = normalizeDwsEvent({
    type: 'user_im_message_receive_o2o_all', event_id: 'recover-event',
    sender_open_dingtalk_id: conversation.externalId, content: '待恢复',
  })!;
  store.admitEvent(conversation, event);
  const first = new ConversationWorker(config, conversation, failing, store, () => undefined);
  await first.start();
  first.signal();
  await waitFor(() => store.status().failed_messages === 1);
  await first.stop();
  assert.deepEqual(store.recoverPendingWork(), [conversation.id]);
  const recovered = new RecordingSession();
  const second = new ConversationWorker(config, conversation, recovered, store, () => undefined);
  try {
    await second.start();
    second.signal();
    await waitFor(() => store.status().processed === 1);
    assert.equal(recovered.prompts.length, 1);
  } finally {
    await second.stop();
    store.close();
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待条件超时');
}
