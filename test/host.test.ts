import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationIdleController, shouldStartConversationAtBoot } from '../src/host.js';
import { Store } from '../src/store.js';

test('resident 会话启动预热，idle 会话按 onboarding 需要决定是否预热', () => {
  const store = new Store(':memory:');
  const residentGroup = store.addConversation({
    kind: 'group', externalId: 'resident-group', title: '常驻群', responsibility: '参与讨论', mode: 'shadow',
  });
  const idleDirect = store.addConversation({
    kind: 'direct', externalId: 'idle-direct', title: '空闲私聊', responsibility: '回答问题', mode: 'shadow',
  });
  const idleGroup = store.addConversation({
    kind: 'group', externalId: 'idle-group', title: '空闲群', responsibility: '参与讨论', mode: 'shadow',
    sessionLifecycle: 'idle',
  });
  assert.equal(shouldStartConversationAtBoot(residentGroup, store.getGroupOnboarding(residentGroup.id)), true);
  assert.equal(shouldStartConversationAtBoot(idleDirect, null), false);
  assert.equal(shouldStartConversationAtBoot(idleGroup, store.getGroupOnboarding(idleGroup.id)), true);

  store.prepareGroupOnboarding(idleGroup.id, 0, 'intro-turn', '已准备', 'idle-intro-uuid');
  assert.equal(shouldStartConversationAtBoot(idleGroup, store.getGroupOnboarding(idleGroup.id)), false);
  store.setConversationMode(idleGroup.id, 'reply');
  const replyGroup = store.getConversation(idleGroup.id)!;
  assert.equal(shouldStartConversationAtBoot(replyGroup, store.getGroupOnboarding(idleGroup.id)), true);
  store.finishGroupOnboardingIntro(idleGroup.id, 'submitted', null);
  assert.equal(shouldStartConversationAtBoot(replyGroup, store.getGroupOnboarding(idleGroup.id)), false);
  store.close();
});

test('idle 计时可被新消息重置，busy 时延迟释放，resident 不建立释放任务', async () => {
  const store = new Store(':memory:');
  const idle = store.addConversation({
    kind: 'direct', externalId: 'idle-timer', title: '计时私聊', responsibility: '回答问题', mode: 'shadow',
  });
  const resident = store.addConversation({
    kind: 'group', externalId: 'resident-timer', title: '常驻群', responsibility: '参与讨论', mode: 'shadow',
  });
  let busy = false;
  let attempts = 0;
  let releases = 0;
  const controller = new ConversationIdleController(async () => {
    attempts += 1;
    if (busy) return 'busy';
    releases += 1;
    return 'released';
  }, 30);
  try {
    controller.touch(resident);
    await delay(45);
    assert.equal(attempts, 0);

    controller.touch(idle);
    await delay(15);
    controller.touch(idle);
    await delay(20);
    assert.equal(attempts, 0);

    busy = true;
    await waitFor(() => attempts === 1);
    assert.equal(releases, 0);
    busy = false;
    await waitFor(() => releases === 1);
    assert.ok(attempts >= 2);
  } finally {
    controller.stop();
    store.close();
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error('等待条件超时');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
