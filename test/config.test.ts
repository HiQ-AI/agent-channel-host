import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { defaultConfig, loadConfig, validateConfig, writeConfig } from '../src/config.js';

test('v2 配置明确拆分 Channel Runtime Scheduling', () => {
  const current = defaultConfig('model-defaults', '.', 'Agent');
  assert.equal(current.version, 2);
  assert.deepEqual(current.identity, { name: 'Agent' });
  assert.deepEqual(current.channel, {
    id: 'dingtalk', enabled: true, profileId: 'default', command: 'dws',
    subscriptions: { groups: 'selected', directs: 'selected' },
    wakeWordEnabled: false,
    wakeWord: 'Agent',
    defaultModes: { groups: 'shadow', directs: 'shadow' },
    selfMessagePollSeconds: 5,
  });
  assert.equal(current.runtime.id, 'codex');
  assert.equal(current.runtime.command, 'codex');
  assert.equal(current.runtime.version, 'codex-cli 0.145.0');
  assert.equal(current.runtime.model, 'gpt-5.6-sol');
  assert.equal(current.runtime.effort, 'low');
  assert.equal('turnTimeoutSeconds' in current.runtime, false);
  assert.equal(current.scheduling.quietWindowMilliseconds, 300);
  assert.equal(current.scheduling.maxBatchMessages, 20);
});

test('既有 v2 配置缺少 Channel 新字段时保持启用且唤醒词模式默认关闭', async () => {
  const root = resolve('.test-config-v2-channel-default');
  const path = resolve(root, 'config.yaml');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  try {
    const legacy = structuredClone(defaultConfig('legacy-v2', '.', 'Agent')) as unknown as {
      channel: Record<string, unknown>;
      identity: Record<string, unknown>;
    };
    legacy.identity.role = '旧默认角色';
    legacy.identity.signature = '- 旧签名';
    delete legacy.channel.enabled;
    delete legacy.channel.subscriptions;
    delete legacy.channel.defaultModes;
    delete legacy.channel.wakeWord;
    delete legacy.channel.wakeWordEnabled;
    await writeFile(path, YAML.stringify(legacy), 'utf8');
    const loaded = await loadConfig('legacy-v2', path);
    assert.deepEqual(loaded.identity, { name: 'Agent' });
    assert.equal(loaded.channel.enabled, true);
    assert.deepEqual(loaded.channel.subscriptions, { groups: 'selected', directs: 'selected' });
    assert.equal(loaded.channel.wakeWordEnabled, false);
    assert.deepEqual(loaded.channel.defaultModes, { groups: 'shadow', directs: 'shadow' });
    assert.equal(loaded.channel.wakeWord, 'Agent');
    await writeConfig(loaded, path);
    const normalized = await readFile(path, 'utf8');
    assert.equal(normalized.includes('role:'), false);
    assert.equal(normalized.includes('signature:'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('唤醒词模式要求 1-32 个字符', () => {
  const config = defaultConfig('wake-word-validation', '.', 'Agent');
  config.channel.wakeWordEnabled = true;
  assert.equal(validateConfig(config).channel.wakeWord, 'Agent');
  assert.throws(() => validateConfig({ ...config, channel: { ...config.channel, wakeWord: ' ' } }));
  assert.throws(() => validateConfig({ ...config, channel: { ...config.channel, wakeWord: 'x'.repeat(33) } }));
});

test('v2 配置不暴露 turn 超时且忽略旧字段', async () => {
  const root = resolve('.test-config-v2-no-turn-timeout');
  const path = resolve(root, 'config.yaml');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  try {
    const legacy = structuredClone(defaultConfig('legacy-turn-timeout', '.', 'Agent')) as unknown as {
      runtime: Record<string, unknown>;
    };
    legacy.runtime.turnTimeoutSeconds = 1;
    await writeFile(path, YAML.stringify(legacy), 'utf8');
    const loaded = await loadConfig('legacy-turn-timeout', path);
    assert.equal('turnTimeoutSeconds' in loaded.runtime, false);
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
