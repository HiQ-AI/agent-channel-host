import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultConfig, loadConfig } from '../src/config.js';

test('新旧配置都得到 gpt-5.6-sol low 默认值', async () => {
  const current = defaultConfig('model-defaults', '.', 'Agent', 'role');
  assert.equal(current.runtime.codexModel, 'gpt-5.6-sol');
  assert.equal(current.runtime.codexEffort, 'low');
  assert.equal(current.runtime.quietWindowMilliseconds, 300);
  assert.equal(current.runtime.maxBatchMessages, 20);

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
  startupTimeoutSeconds: 120
  turnTimeoutSeconds: 180
protocol:
  codexVersion: codex-cli 0.145.0
  schemaSha256: 1f66700d1cc3de4a5004e5614a6098878b405c7e7c5f8c9be97fc900d0ad6c68
`.trimStart(), 'utf8');
    const legacy = await loadConfig('legacy', path);
    assert.equal(legacy.runtime.codexModel, 'gpt-5.6-sol');
    assert.equal(legacy.runtime.codexEffort, 'low');
    assert.equal(legacy.runtime.quietWindowMilliseconds, 300);
    assert.equal(legacy.runtime.maxBatchMessages, 20);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
