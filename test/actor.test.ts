import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { normalizeDwsEvent, type DwsSender } from '../src/dws.js';
import { ConversationActor, type ResidentSession } from '../src/actor.js';
import type { DecisionRun } from '../src/app-server.js';

class FakeSession implements ResidentSession {
  currentThreadId = 'thread-fixed-123456789';
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
        action: 'reply', responsibilityMatch: true, category: 'question',
        replyText: '第二条消息的答复\n\n- Agent代回', reasonCode: 'within_responsibility',
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
  const store = new Store(':memory:');
  const conversation = store.addConversation({
    kind: 'group', externalId: 'cid-actor', title: 'Actor 群', responsibility: '回答问题', mode: 'reply',
  });
  const admitted = (id: string) => store.admitEvent(conversation, normalizeDwsEvent({
    type: 'user_im_message_receive_group_all', event_id: id, conversation_id: 'cid-actor', content: id,
  })!).event!;
  const first = admitted('evt-1');
  const session = new FakeSession();
  let sent = 0;
  const sender = { send: async () => { sent += 1; } } as unknown as DwsSender;
  const logs: Array<Record<string, unknown>> = [];
  const actor = new ConversationActor(config, conversation, session, store, sender, (record) => logs.push(record));
  await actor.start();
  actor.submit(first);
  await new Promise((resolve) => setImmediate(resolve));
  const second = admitted('evt-2');
  actor.submit(second);
  await waitFor(() => sent === 1);
  assert.equal(session.interrupts, 1);
  assert.equal(session.calls, 2);
  assert.equal(sent, 1);
  assert.equal(store.status().processed, 1);
  assert.equal(store.status().submitted, 1);
  assert.ok(logs.some((record) => record.turnStatus === 'interrupted'));
  await actor.stop();
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
