import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { dataRoot, discoverInstances, lockRoot } from '../src/paths.js';

test('新状态根环境变量生效，旧变量单独存在时 fail-fast', () => {
  assert.equal(dataRoot({ AGENT_CHANNEL_HOME: '.agent-channel-state' }), resolve('.agent-channel-state'));
  assert.match(dataRoot({ XDG_STATE_HOME: '/state' }), /agent-channel-host$/);
  assert.match(lockRoot({ XDG_RUNTIME_DIR: '/runtime' }), /agent-channel-host$/);
  assert.throws(
    () => dataRoot({ DINGTALK_CODEX_HOME: '.legacy-state' }),
    /DINGTALK_CODEX_HOME 已重命名为 AGENT_CHANNEL_HOME/,
  );
});

test('instance discovery 只返回具有 config.yaml 的安全目录并稳定排序', async () => {
  const root = resolve('.test-instance-discovery');
  await rm(root, { recursive: true, force: true });
  try {
    await mkdir(join(root, 'instances', 'z-agent'), { recursive: true });
    await mkdir(join(root, 'instances', 'a-agent'), { recursive: true });
    await mkdir(join(root, 'instances', 'incomplete'), { recursive: true });
    await writeFile(join(root, 'instances', 'z-agent', 'config.yaml'), 'version: 2\n');
    await writeFile(join(root, 'instances', 'a-agent', 'config.yaml'), 'version: 2\n');
    assert.deepEqual(await discoverInstances({ AGENT_CHANNEL_HOME: root }), ['a-agent', 'z-agent']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.deepEqual(await discoverInstances({ AGENT_CHANNEL_HOME: root }), []);
});
