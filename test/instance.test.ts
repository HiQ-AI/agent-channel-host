import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { initializeInstance } from '../src/instance.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';

test('共享初始化入口支持 TUI 安全创建 disabled Channel 并拒绝覆盖', async () => {
  const root = resolve('.test-instance-initialize');
  const env = { ...process.env, AGENT_CHANNEL_HOME: root };
  await rm(root, { recursive: true, force: true });
  try {
    const initialized = await initializeInstance({
      instance: 'created-from-tui',
      cwd: '.',
      name: 'TUI Agent',
      role: '测试角色',
      channelEnabled: false,
    }, env);
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
      instance: 'created-from-tui', cwd: '.', name: 'Duplicate', role: 'role',
    }, env), /配置已存在/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
