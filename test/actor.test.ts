import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { normalizeDwsEvent } from '../src/dws.js';
import { ConversationWorker } from '../src/actor.js';
import type { AgentSession, ChannelAdapter } from '../src/contracts.js';
import type { DecisionRun } from '../src/types.js';

class FakeSession implements AgentSession {
  currentSessionId = 'thread-fixed-123456789';
  processId = 1234;
  calls = 0;
  interrupts = 0;
  private resolveActive: ((value: DecisionRun) => void) | null = null;

  async start(): Promise<void> {}

  runDecision(): Promise<DecisionRun> {
    this.calls += 1;
    if (this.calls === 1) {
      return new Promise((resolve) => { this.resolveActive = resolve; });
    }
    return Promise.resolve({
      turnId: `turn-${this.calls}`,
      status: 'completed',
      decision: {
        action: 'reply', replyText: '第二条消息的答复',
      },
    });
  }

  async interruptActive(): Promise<boolean> {
    if (!this.resolveActive) return false;
    this.interrupts += 1;
    const resolve = this.resolveActive;
    this.resolveActive = null;
    resolve({ turnId: 'turn-1', status: 'interrupted', decision: null });
    return true;
  }

  async stop(): Promise<void> {}
}

test('新消息 durable admission 后中断 active turn，并在同一固定 session 开新 turn', async () => {
  const config = defaultConfig('actor', '.', 'Agent', 'role');
  config.scheduling.quietWindowMilliseconds = 0;
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'group', externalId: 'cid-actor', title: 'Actor 群', responsibility: '回答问题', mode: 'reply',
  });
  store.prepareGroupOnboarding(conversation.id, 0, 'intro-turn', '已介绍\n\n- Agent代回', 'intro-uuid');
  store.finishGroupOnboardingIntro(conversation.id, 'submitted', null);
  const admitted = (id: string) => store.admitEvent(conversation, normalizeDwsEvent({
    type: 'user_im_message_receive_group_all', event_id: id, conversation_id: 'cid-actor', content: id,
  })!).event!;
  const first = admitted('evt-1');
  const session = new FakeSession();
  let sent = 0;
  const sender = { send: async () => { sent += 1; } } as Pick<ChannelAdapter, 'send'>;
  const logs: Array<Record<string, unknown>> = [];
  const worker = new ConversationWorker(config, conversation, session, store, sender, (record) => logs.push(record));
  await worker.start();
  worker.signal();
  await waitFor(() => session.calls === 1);
  const second = admitted('evt-2');
  worker.signal();
  await waitFor(() => sent === 1);
  assert.equal(session.interrupts, 1);
  assert.equal(session.calls, 2);
  assert.equal(sent, 1);
  assert.equal(store.status().processed, 2);
  assert.equal(store.status().submitted, 1);
  assert.ok(logs.some((record) => record.type === 'BATCH_INTERRUPTED'));
  await worker.stop();
  store.close();
});

class OnboardingSession implements AgentSession {
  currentSessionId = 'thread-onboarding-123456789';
  processId = 5678;
  decisionCalls = 0;

  async start(): Promise<void> {}

  async runDecision(): Promise<DecisionRun> {
    this.decisionCalls += 1;
    return {
      turnId: 'intro-turn-123456789',
      status: 'completed',
      decision: {
        action: 'reply', replyText: '近期讨论里这个问题需要补充说明。',
      },
    };
  }

  async interruptActive(): Promise<boolean> { return false; }
  async stop(): Promise<void> {}
}

test('首次群历史由 Agent 判断；reply 在 shadow 只准备，切 reply 后用同一 UUID 发送', async () => {
  const config = defaultConfig('onboarding', '.', 'Agent', 'role');
  const store = new Store(':memory:');
  const shadow = store.addConversation({
    kind: 'group', externalId: 'cid-onboarding', title: 'Onboarding 群', responsibility: '参与讨论', mode: 'shadow',
  });
  const firstSession = new OnboardingSession();
  const sent: Array<{ text: string; uuid: string }> = [];
  const sender = {
    send: async (_conversation: unknown, record: { text: string; uuid: string }) => { sent.push(record); },
  } as Pick<ChannelAdapter, 'send'>;
  const historyLoads: number[] = [];
  const firstActor = new ConversationWorker(
    config, shadow, firstSession, store, sender, () => undefined, () => undefined,
    async () => {
      historyLoads.push(1);
      return {
        count: 2,
        messages: [
          { sender: '同事甲', time: '2026-08-03 10:00:00', content: '近期讨论一' },
          { sender: '同事乙', time: '2026-08-03 10:01:00', content: '近期讨论二' },
        ],
      };
    },
  );
  await firstActor.start();
  assert.equal(firstSession.decisionCalls, 1);
  assert.equal(historyLoads.length, 1);
  assert.equal(sent.length, 0);
  assert.equal(store.getGroupOnboarding(shadow.id)?.state, 'prepared');
  const preparedUuid = store.getGroupOnboarding(shadow.id)?.introUuid;
  await firstActor.stop();

  store.setConversationMode(shadow.id, 'reply');
  const reply = store.getConversation(shadow.id)!;
  const resumedSession = new OnboardingSession();
  const secondActor = new ConversationWorker(
    config, reply, resumedSession, store, sender, () => undefined, () => undefined,
    async () => { throw new Error('已准备 onboarding 不应重复读取历史'); },
  );
  await secondActor.start();
  assert.equal(resumedSession.decisionCalls, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.uuid, preparedUuid);
  assert.equal(store.getGroupOnboarding(shadow.id)?.state, 'submitted');
  await secondActor.stop();

  const thirdActor = new ConversationWorker(
    config, reply, new OnboardingSession(), store, sender, () => undefined, () => undefined,
    async () => { throw new Error('已完成 onboarding 不应读取历史'); },
  );
  await thirdActor.start();
  assert.equal(sent.length, 1);
  await thirdActor.stop();
  store.close();
});

test('首次群历史返回 silent 时标记完成且不发送、不重复读取', async () => {
  const config = defaultConfig('onboarding-silent', '.', 'Agent', 'role');
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'group', externalId: 'cid-onboarding-silent', title: '静默群', responsibility: '本地备注', mode: 'reply',
  });
  const prompts: string[] = [];
  const session: AgentSession = {
    currentSessionId: 'thread-onboarding-silent',
    processId: null,
    start: async () => undefined,
    runDecision: async (prompt) => {
      prompts.push(prompt);
      return { turnId: 'history-silent-turn', status: 'completed', decision: { action: 'silent', replyText: '' } };
    },
    interruptActive: async () => false,
    stop: async () => undefined,
  };
  let sends = 0;
  const worker = new ConversationWorker(
    config,
    conversation,
    session,
    store,
    { send: async () => { sends += 1; } },
    () => undefined,
    () => undefined,
    async () => ({
      count: 1,
      messages: [{ sender: '同事甲', time: '2026-08-03 10:00:00', content: '仅供了解的历史消息' }],
    }),
  );
  await worker.start();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /发送者：同事甲/);
  assert.equal(prompts[0]!.includes('静默群'), false);
  assert.equal(sends, 0);
  assert.equal(store.getGroupOnboarding(conversation.id)?.state, 'submitted');
  assert.equal(store.getGroupOnboarding(conversation.id)?.introText, null);
  await worker.stop();

  const restarted = new ConversationWorker(
    config,
    conversation,
    { ...session, start: async () => undefined, stop: async () => undefined },
    store,
    { send: async () => { sends += 1; } },
    () => undefined,
    () => undefined,
    async () => { throw new Error('已静默完成时不应重复读取历史'); },
  );
  await restarted.start();
  assert.equal(prompts.length, 1);
  assert.equal(sends, 0);
  await restarted.stop();
  store.close();
});

test('群 onboarding 发送失败后以同一 UUID 重试', async () => {
  const config = defaultConfig('onboarding-retry', '.', 'Agent', 'role');
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'group', externalId: 'cid-onboarding-retry', title: '重试群', responsibility: '参与讨论', mode: 'reply',
  });
  store.prepareGroupOnboarding(conversation.id, 1, 'intro-turn', '大家好\n\n- Agent代回', 'stable-intro-uuid');
  const uuids: string[] = [];
  let attempts = 0;
  const sender = {
    send: async (_target: unknown, record: { uuid: string }) => {
      attempts += 1;
      uuids.push(record.uuid);
      if (attempts === 1) throw new Error('模拟发送失败');
    },
  } as Pick<ChannelAdapter, 'send'>;

  const first = new ConversationWorker(config, conversation, new OnboardingSession(), store, sender, () => undefined);
  await first.start();
  assert.equal(store.getGroupOnboarding(conversation.id)?.state, 'failed');
  await first.stop();

  const second = new ConversationWorker(config, conversation, new OnboardingSession(), store, sender, () => undefined);
  await second.start();
  assert.equal(store.getGroupOnboarding(conversation.id)?.state, 'submitted');
  assert.deepEqual(uuids, ['stable-intro-uuid', 'stable-intro-uuid']);
  await second.stop();
  store.close();
});

test('Worker 启动时用原 UUID 提交 reconciliation 恢复的 outbox', async () => {
  const config = defaultConfig('outbox-recovery', '.', 'Agent', 'role');
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'outbox-recovery-user', title: '恢复私聊', responsibility: '回答问题', mode: 'reply',
  });
  const event = store.admitEvent(conversation, normalizeDwsEvent({
    type: 'user_im_message_receive_o2o_all', event_id: 'outbox-recovery-event',
    sender_open_dingtalk_id: conversation.externalId, content: '恢复发送',
  })!).event!;
  const outbox = store.enqueueOutbox(event, '恢复后的回复', '00000000-0000-4000-8000-000000000779')!;
  store.db.prepare("UPDATE outbox SET state='failed',attempt_count=1,error='temporary-send' WHERE id=?").run(outbox.id);
  assert.deepEqual(store.recoverPendingWork(), [conversation.id]);
  const sent: Array<{ text: string; uuid: string }> = [];
  const worker = new ConversationWorker(
    config,
    conversation,
    new OnboardingSession(),
    store,
    { send: async (_target, record) => { sent.push({ text: record.text, uuid: record.uuid }); } },
    () => undefined,
  );
  try {
    await worker.start();
    assert.deepEqual(sent, [{ text: '恢复后的回复', uuid: outbox.uuid }]);
    assert.equal(store.getOutbox(outbox.id)?.state, 'submitted');
    assert.equal(store.getOutbox(outbox.id)?.attemptCount, 2);
  } finally {
    await worker.stop();
    store.close();
  }
});

test('单个 conversation 的无效决策 fail closed，但 Worker 与 Channel 生命周期不被终止', async () => {
  const config = defaultConfig('decision-isolation', '.', 'Agent', 'role');
  config.scheduling.quietWindowMilliseconds = 0;
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'direct', externalId: 'decision-isolation', title: '隔离私聊', responsibility: '答疑', mode: 'shadow',
  });
  let calls = 0;
  const session: AgentSession = {
    currentSessionId: 'session-decision-isolation',
    processId: null,
    start: async () => undefined,
    interruptActive: async () => false,
    stop: async () => undefined,
    runDecision: async () => {
      calls += 1;
      if (calls === 1) throw new Error('模拟结构化决策校验失败');
      return {
        turnId: 'recovered-turn', status: 'completed',
        decision: { action: 'silent', replyText: '' },
      };
    },
  };
  const worker = new ConversationWorker(
    config, conversation, session, store, { send: async () => undefined }, () => undefined,
  );
  const admitEvent = (eventId: string) => store.admitEvent(conversation, normalizeDwsEvent({
    type: 'user_im_message_receive_o2o_all', event_id: eventId,
    sender_open_dingtalk_id: conversation.externalId, content: eventId,
  })!);
  try {
    await worker.start();
    admitEvent('invalid-decision');
    worker.signal();
    await waitFor(() => store.status().failed_messages === 1);
    admitEvent('next-message');
    worker.signal();
    await waitFor(() => store.status().processed === 1);
    const status = store.status();
    assert.equal(status.received, 2);
    assert.equal(status.failed_messages, 1);
    assert.equal(status.processed, 1);
    assert.equal(calls, 2);
  } finally {
    await worker.stop();
    store.close();
  }
});

test('runtime 自己的后台工作不由 Host 编排，actor 仍可继续处理下一条群消息', async () => {
  const config = defaultConfig('runtime-background-actor', '.', 'Agent', 'role');
  config.scheduling.quietWindowMilliseconds = 0;
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'group', externalId: 'cid-runtime-background', title: 'Runtime 后台工作群', responsibility: '参与讨论', mode: 'shadow',
  });
  store.prepareGroupOnboarding(conversation.id, 0, 'intro-turn', '已介绍\n\n- Agent代回', 'intro-uuid');
  store.finishGroupOnboardingIntro(conversation.id, 'submitted', null);
  let calls = 0;
  let workerFinished = false;
  const session: AgentSession = {
    currentSessionId: 'thread-runtime-background-123456789',
    processId: 9012,
    start: async () => undefined,
    interruptActive: async () => false,
    stop: async () => undefined,
    hasBackgroundWork: () => !workerFinished,
    runDecision: async () => {
      calls += 1;
      return calls === 1 ? {
        turnId: 'implementation-turn', status: 'completed',
        decision: { action: 'reply', replyText: '我已接手处理。' },
      } : {
        turnId: 'discussion-turn', status: 'completed',
        decision: { action: 'silent', replyText: '' },
      };
    },
  };
  const worker = new ConversationWorker(
    config, conversation, session, store, { send: async () => undefined }, () => undefined,
  );
  const admitted = (id: string) => store.admitEvent(conversation, normalizeDwsEvent({
    type: 'user_im_message_receive_group_all', event_id: id, conversation_id: 'cid-runtime-background', content: id,
  })!).event!;
  await worker.start();
  admitted('implementation-event');
  worker.signal();
  await waitFor(() => calls === 1);
  admitted('follow-up-event');
  worker.signal();
  await waitFor(() => calls === 2 && store.status().processed === 2);
  assert.equal(worker.isBusy(), true);
  workerFinished = true;
  await waitFor(() => !worker.isBusy());
  await worker.stop();
  store.close();
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待条件超时');
}
