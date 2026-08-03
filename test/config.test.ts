import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { defaultConfig, loadConfig } from '../src/config.js';

test('v2 配置明确拆分 Channel Runtime Scheduling', () => {
  const current = defaultConfig('model-defaults', '.', 'Agent', 'role');
  assert.equal(current.version, 2);
  assert.deepEqual(current.channel, {
    id: 'dingtalk', enabled: true, profileId: 'default', command: 'dws',
    subscriptions: { groups: 'selected', directs: 'selected' },
    defaultModes: { groups: 'shadow', directs: 'shadow' },
  });
  assert.equal(current.runtime.id, 'codex');
  assert.equal(current.runtime.command, 'codex');
  assert.equal(current.runtime.version, 'codex-cli 0.145.0');
  assert.equal(current.runtime.model, 'gpt-5.6-sol');
  assert.equal(current.runtime.effort, 'low');
  assert.equal(current.scheduling.quietWindowMilliseconds, 300);
  assert.equal(current.scheduling.maxBatchMessages, 20);
});

test('既有 v2 配置缺少 Channel 新字段时保持启用并默认 selected', async () => {
  const root = resolve('.test-config-v2-channel-default');
  const path = resolve(root, 'config.yaml');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  try {
    const legacy = structuredClone(defaultConfig('legacy-v2', '.', 'Agent', 'role')) as unknown as {
      channel: Record<string, unknown>;
    };
    delete legacy.channel.enabled;
    delete legacy.channel.subscriptions;
    delete legacy.channel.defaultModes;
    await writeFile(path, YAML.stringify(legacy), 'utf8');
    const loaded = await loadConfig('legacy-v2', path);
    assert.equal(loaded.channel.enabled, true);
    assert.deepEqual(loaded.channel.subscriptions, { groups: 'selected', directs: 'selected' });
    assert.deepEqual(loaded.channel.defaultModes, { groups: 'shadow', directs: 'shadow' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v1 App Server 配置 fail closed，不静默迁移', async () => {
  const root = resolve('.test-config-state');
  const path = resolve(root, 'legacy.yaml');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  try {
    await writeFile(path, `
version: 1
instance: legacy
identity:
  name: Agent
  role: role
  signature: '- Agent代回'
runtime:
  cwd: .
  dwsCommand: dws
  codexCommand: codex
protocol:
  codexVersion: codex-cli 0.145.0
  schemaSha256: 1f66700d1cc3de4a5004e5614a6098878b405c7e7c5f8c9be97fc900d0ad6c68
`.trimStart(), 'utf8');
    await assert.rejects(loadConfig('legacy', path), /version=1.*显式迁移为 version=2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
