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
  async steer(_prompt: string): Promise<{ turnId: string }> { return { turnId: 'turn-active' }; }
  async interruptActive(): Promise<boolean> { return false; }
  async stop(): Promise<void> {}
}

class SteeringSession extends RecordingSession {
  private complete: ((value: DeliveryRun) => void) | null = null;
  steered: string[] = [];
  override deliver(prompt: string): Promise<DeliveryRun> {
    this.prompts.push(prompt);
    return new Promise((resolve) => { this.complete = resolve; });
  }
  async steer(prompt: string): Promise<{ turnId: string }> {
    this.steered.push(prompt);
    return { turnId: 'active-turn' };
  }
  finish(): void {
    this.complete?.({ turnId: 'active-turn', status: 'completed' });
    this.complete = null;
  }
}

class FailingSteeringSession extends SteeringSession {
  override async steer(prompt: string): Promise<{ turnId: string }> {
    this.steered.push(prompt);
    throw new Error('steer rejected');
  }
}

class InterventionSession extends RecordingSession {
  currentTurnId: string | null = 'turn-intervention';
  supportsActiveSteer = true;
  received: Array<{ prompt: string; expectedTurnId?: string; clientUserMessageId?: string }> = [];
  override async steer(
    prompt: string,
    expectedTurnId?: string,
    clientUserMessageId?: string,
  ): Promise<{ turnId: string }> {
    this.received.push({ prompt, expectedTurnId, clientUserMessageId });
    return { turnId: this.currentTurnId! };
  }
}

test('实时消息按可用批次传入固定 runtime session，Host 不调用 Channel send', async () => {
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
    await waitFor(() => store.status().forwarded_messages === 2);
    assert.equal(session.prompts.length, 1);
    assert.match(session.prompts[0]!, /内容：第一条/);
    assert.match(session.prompts[0]!, /内容：第二条/);
    assert.equal(store.status().submitted, 0);
  } finally {
    await worker.stop();
    store.close();
  }
});

test('首次群历史合成一次引导传入 runtime，不接收决定也不发送回复', async () => {
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
        { sender: '同事甲', senderId: 'open-id-a', time: '2026-08-03 10:00:00', content: '历史一' },
        { sender: '同事乙', senderId: 'open-id-b', time: '2026-08-03 10:01:00', content: '历史二' },
      ],
    }),
  );
  try {
    await worker.start();
    assert.equal(session.prompts.length, 1);
    assert.match(session.prompts[0]!, /历史一/);
    assert.match(session.prompts[0]!, /历史二/);
    assert.equal(store.getGroupOnboarding(conversation.id)?.state, 'forwarded');
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
    steer: async () => { throw new Error('runtime unavailable'); },
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
    await waitFor(() => store.status().forwarded_messages === 1);
    assert.equal(recovered.prompts.length, 1);
  } finally {
    await second.stop();
    store.close();
  }
});

test('活动 turn 中的新消息立即 steer，不等待当前 Agent 处理完成', async () => {
  const config = defaultConfig('steer', '.', 'Agent');
  config.scheduling.quietWindowMilliseconds = 0;
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'steer-user', title: 'Steer 私聊', responsibility: '', mode: 'reply',
  });
  const session = new SteeringSession();
  const worker = new ConversationWorker(config, conversation, session, store, () => undefined);
  const admit = (id: string) => store.admitEvent(conversation, normalizeDwsEvent({
    type: 'user_im_message_receive_o2o_all', event_id: id,
    sender_open_dingtalk_id: conversation.externalId, sender_name: '同事甲', content: id,
  })!);
  try {
    await worker.start();
    admit('首条');
    worker.signal();
    await waitFor(() => session.prompts.length === 1);
    admit('追问');
    worker.signal();
    await waitFor(() => session.steered.length === 1);
    assert.match(session.steered[0]!, /内容：追问/);
    assert.equal(store.status().forwarded_messages, 0);
    session.finish();
    await waitFor(() => store.status().forwarded_messages === 2);
  } finally {
    await worker.stop();
    store.close();
  }
});

test('活动 turn 已结束导致引导失败时，把新消息补送到下一 turn', async () => {
  const config = defaultConfig('steer-fail', '.', 'Agent');
  config.scheduling.quietWindowMilliseconds = 0;
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'steer-fail-user', title: 'Steer 失败私聊', responsibility: '', mode: 'reply',
  });
  const session = new FailingSteeringSession();
  const worker = new ConversationWorker(config, conversation, session, store, () => undefined);
  const admit = (id: string) => store.admitEvent(conversation, normalizeDwsEvent({
    type: 'user_im_message_receive_o2o_all', event_id: id,
    sender_open_dingtalk_id: conversation.externalId, sender_name: '同事甲', content: id,
  })!);
  try {
    await worker.start();
    admit('首条');
    worker.signal();
    await waitFor(() => session.prompts.length === 1);
    admit('必须引导');
    worker.signal();
    await waitFor(() => session.steered.length === 1);
    session.finish();
    await waitFor(() => session.prompts.length === 2);
    assert.match(session.prompts[1]!, /内容：必须引导/);
    session.finish();
    await waitFor(() => store.status().forwarded_messages === 2);
    assert.equal(store.status().failed_messages, 0);
    assert.equal(store.pendingEventCount(conversation.id), 0);
  } finally {
    await worker.stop();
    store.close();
  }
});

test('Worker 只把匹配 thread/turn 的幂等指令 steer 到当前活动 turn', async () => {
  const config = defaultConfig('intervention', '.', 'Agent');
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'intervention-user', title: '介入私聊', responsibility: '', mode: 'reply',
  });
  const session = new InterventionSession();
  const worker = new ConversationWorker(config, conversation, session, store, () => undefined);
  try {
    await worker.start();
    const target = store.getInterventionTarget(conversation.id)!;
    assert.deepEqual(
      { threadId: target.threadId, turnId: target.turnId, canIntervene: target.canIntervene },
      { threadId: session.currentSessionId, turnId: session.currentTurnId, canIntervene: true },
    );
    store.submitIntervention({
      requestId: 'human-request-1', conversationId: conversation.id,
      expectedThreadId: session.currentSessionId!, expectedTurnId: session.currentTurnId!,
      instruction: '先检查当前假设', expiresAt: new Date(Date.now() + 60_000),
    });
    worker.processInterventions();
    await waitFor(() => store.getIntervention('human-request-1')?.state === 'succeeded');
    assert.deepEqual(session.received, [{
      prompt: '# 人工介入\n\n先检查当前假设',
      expectedTurnId: 'turn-intervention',
      clientUserMessageId: 'human-request-1',
    }]);

    store.submitIntervention({
      requestId: 'human-request-2', conversationId: conversation.id,
      expectedThreadId: session.currentSessionId!, expectedTurnId: 'stale-turn',
      instruction: '这条不能进入下一轮', expiresAt: new Date(Date.now() + 60_000),
    });
    worker.processInterventions();
    await waitFor(() => store.getIntervention('human-request-2')?.state === 'rejected');
    assert.equal(store.getIntervention('human-request-2')?.resultCode, 'turn_mismatch');
    assert.equal(session.received.length, 1);

    store.submitIntervention({
      requestId: 'human-request-3', conversationId: conversation.id,
      expectedThreadId: 'stale-thread', expectedTurnId: session.currentTurnId!,
      instruction: '错误 thread 也不能执行', expiresAt: new Date(Date.now() + 60_000),
    });
    worker.processInterventions();
    await waitFor(() => store.getIntervention('human-request-3')?.state === 'rejected');
    assert.equal(store.getIntervention('human-request-3')?.resultCode, 'thread_mismatch');
    assert.equal(session.received.length, 1);
  } finally {
    await worker.stop();
    assert.equal(store.getInterventionTarget(conversation.id)?.canIntervene, false);
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
