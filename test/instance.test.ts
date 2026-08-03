import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  deleteConversationWithLifecycle, deleteInstanceData, deleteInstanceWithLifecycle, initializeInstance,
} from '../src/instance.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { discoverInstances } from '../src/paths.js';

test('共享初始化入口支持 TUI 安全创建 disabled Channel 并拒绝覆盖', async () => {
  const root = resolve('.test-instance-initialize');
  const env = { ...process.env, AGENT_CHANNEL_HOME: root };
  await rm(root, { recursive: true, force: true });
  try {
    const initialized = await initializeInstance({
      instance: 'created-from-tui',
      cwd: '.',
      name: 'TUI Agent',
      channelEnabled: false,
    }, env);
    assert.deepEqual(initialized.config.identity, { name: 'TUI Agent' });
    assert.equal(initialized.config.channel.enabled, false);
    assert.match(await readFile(initialized.configFile, 'utf8'), /enabled: false/);
    assert.equal((await loadConfig('created-from-tui', initialized.configFile)).channel.enabled, false);
    const store = new Store(initialized.stateFile);
    try {
      assert.equal((store.status().channels as Array<{ state: string }>)[0]?.state, 'disabled');
      assert.equal((store.status().runtimeAdapters as Array<{ state: string }>)[0]?.state, 'stopped');
    } finally {
      store.close();
    }
    await assert.rejects(initializeInstance({
      instance: 'created-from-tui', cwd: '.', name: 'Duplicate',
    }, env), /配置已存在/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Instance 删除只移除经过校验的目标目录', async () => {
  const root = resolve('.test-instance-delete');
  const env = { ...process.env, AGENT_CHANNEL_HOME: root };
  await rm(root, { recursive: true, force: true });
  try {
    await initializeInstance({ instance: 'delete-me', cwd: '.', name: 'Delete' }, env);
    await initializeInstance({ instance: 'keep-me', cwd: '.', name: 'Keep' }, env);
    const removed = await deleteInstanceData('delete-me', env);
    assert.match(removed, /instances[\\/]delete-me$/);
    assert.deepEqual(await discoverInstances(env), ['keep-me']);
    await assert.rejects(deleteInstanceData('delete-me', env), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('删除生命周期对 attached fail closed，并为 View-owned Conversation 执行 stop/delete/restart', async () => {
  const attachedStore = new Store(':memory:');
  const attached = { name: 'attached', store: attachedStore, hostOwnership: 'attached' as const };
  const events: string[] = [];
  try {
    await assert.rejects(deleteConversationWithLifecycle(
      attached, 'missing', async () => { events.push('stop'); }, () => { events.push('start'); },
    ), /外部 Host.*停止外部 Host/);
    await assert.rejects(deleteInstanceWithLifecycle(
      attached, async () => { events.push('stop'); }, async () => { events.push('service'); },
      async () => { events.push('data'); },
    ), /外部 Host.*停止外部 Host/);
    assert.equal(events.length, 0);
  } finally {
    attachedStore.close();
  }

  const racedStore = new Store(':memory:');
  const raced = { name: 'raced', store: racedStore, hostOwnership: 'readonly' as const };
  racedStore.acquireLease('host', 'external-race', Date.now(), 60_000);
  try {
    await assert.rejects(deleteInstanceWithLifecycle(
      raced, async () => undefined, async () => undefined, async () => undefined,
    ), /Host 已重新运行.*拒绝删除/);
  } finally {
    racedStore.close();
  }

  const viewStore = new Store(':memory:');
  const conversation = viewStore.addConversation({
    kind: 'direct', externalId: 'managed-delete', title: 'Managed', responsibility: 'role', mode: 'shadow',
  });
  const managed = { name: 'managed', store: viewStore, hostOwnership: 'view' as const };
  try {
    await deleteConversationWithLifecycle(
      managed, conversation.id, async () => { events.push('stop'); }, () => { events.push('start'); },
    );
    assert.deepEqual(events, ['stop', 'start']);
    assert.equal(viewStore.getConversation(conversation.id), null);
  } finally {
    viewStore.close();
  }

  const deleteStore = new Store(':memory:');
  const deletable = { name: 'delete-lifecycle', store: deleteStore, hostOwnership: 'view' as const };
  await deleteInstanceWithLifecycle(
    deletable,
    async () => { events.push('instance-stop'); },
    async () => { events.push('service'); },
    async () => {
      events.push('data');
      assert.throws(() => deleteStore.status(), /database is not open/i);
    },
  );
  assert.deepEqual(events.slice(-3), ['instance-stop', 'service', 'data']);
});
