import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.js';
import { inspectOnboardingDelivery, reconcileOnboardingDelivery } from '../src/delivery-reconciliation.js';
import { Store } from '../src/store.js';

test('delivery --check 只回查可见性且不改变 delivery_unknown', async () => {
  const fixture = await createFixture('check');
  try {
    const before = await version(fixture.databasePath);
    const result = await inspectOnboardingDelivery(fixture.config, fixture.databasePath, fixture.conversationId, {
      loadHistory: async () => ({ count: 2, messages: [
        { sender: '甲', time: '1', content: '普通消息' },
        { sender: 'Agent', time: '2', content: fixture.reply },
      ] }),
    });
    assert.deepEqual(result, { state: 'delivery_unknown', historyLoaded: 2, historyJudged: 2, visibleMatches: 1 });
    assert.equal(await version(fixture.databasePath), before);
    const store = new Store(fixture.databasePath);
    assert.equal(store.getGroupOnboarding(fixture.conversationId)?.state, 'delivery_unknown');
    store.close();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('显式协调在确认不可见后使用新 UUID 单次发送并回读为 delivered', async () => {
  const fixture = await createFixture('resend');
  const sends: Array<{ text: string; uuid: string }> = [];
  let reads = 0;
  try {
    const result = await reconcileOnboardingDelivery(
      fixture.config, fixture.databasePath, fixture.conversationId, fixture.backupDirectory,
      {
        loadHistory: async () => {
          reads += 1;
          return reads === 1
            ? { count: 2, messages: [] }
            : { count: 3, messages: [{ sender: 'Agent', time: '3', content: fixture.reply }] };
        },
        send: async (_conversation, record) => { sends.push(record); },
        wait: async () => undefined,
      },
    );
    assert.equal(result.action, 'resent');
    assert.equal(result.finalState, 'delivered');
    assert.equal(result.visibleMatches, 1);
    assert.equal(sends.length, 1);
    assert.equal(sends[0]!.text, fixture.reply);
    assert.notEqual(sends[0]!.uuid, fixture.originalUuid);
    assert.equal((await readdir(fixture.backupDirectory)).length, 1);
    const store = new Store(fixture.databasePath);
    assert.equal(store.getGroupOnboarding(fixture.conversationId)?.state, 'delivered');
    assert.equal(store.status().history_loaded, 2);
    assert.equal(store.status().history_judged, 2);
    store.close();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('显式协调发现回复已经可见时只标记 delivered 而不重发', async () => {
  const fixture = await createFixture('visible');
  let sends = 0;
  try {
    const result = await reconcileOnboardingDelivery(
      fixture.config, fixture.databasePath, fixture.conversationId, fixture.backupDirectory,
      {
        loadHistory: async () => ({ count: 3, messages: [{ sender: 'Agent', time: '3', content: fixture.reply }] }),
        send: async () => { sends += 1; },
      },
    );
    assert.equal(result.action, 'already_visible');
    assert.equal(result.finalState, 'delivered');
    assert.equal(sends, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('DWS 折叠空行后仍视为同一可见正文，submitted 只升级 delivered 不重发', async () => {
  const fixture = await createFixture('submitted-visible');
  let sends = 0;
  try {
    const before = new Store(fixture.databasePath);
    before.finishGroupOnboardingIntro(fixture.conversationId, 'submitted', null);
    before.close();
    const visible = fixture.reply.replace('\n\n', '\n');
    const result = await reconcileOnboardingDelivery(
      fixture.config, fixture.databasePath, fixture.conversationId, fixture.backupDirectory,
      {
        loadHistory: async () => ({ count: 3, messages: [{ sender: 'Agent', time: '3', content: visible }] }),
        send: async () => { sends += 1; },
      },
    );
    assert.equal(result.action, 'already_visible');
    assert.equal(result.finalState, 'delivered');
    assert.equal(result.visibleMatches, 1);
    assert.equal(sends, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(suffix: string) {
  const root = await mkdtemp(join(tmpdir(), `agent-channel-delivery-${suffix}-`));
  const databasePath = join(root, 'state.sqlite3');
  const backupDirectory = join(root, 'backup');
  const config = defaultConfig(`delivery-${suffix}`, root, 'Agent');
  const store = new Store(databasePath);
  const conversation = store.addConversation({
    kind: 'group', externalId: `cid-${suffix}`, title: '测试群', responsibility: '答疑', mode: 'reply',
  });
  const reply = '这是已判断回复\n\n- Agent代回';
  const originalUuid = '11111111-1111-4111-8111-111111111111';
  store.prepareGroupOnboarding(conversation.id, 2, 'turn-history', reply, originalUuid);
  store.finishGroupOnboardingIntro(conversation.id, 'delivery_unknown', 'duplicate_uuid');
  store.close();
  return { root, databasePath, backupDirectory, config, conversationId: conversation.id, reply, originalUuid };
}

async function version(databasePath: string): Promise<number> {
  const store = new Store(databasePath);
  const value = Number((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  store.close();
  return value;
}
