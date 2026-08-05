import test from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE_NAME, updateGlobalPackage } from '../src/update.js';

test('更新命令固定安装官方 latest 包并回读更新后 CLI 版本', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const result = await updateGlobalPackage(async (command, args) => {
    calls.push({ command, args });
    return args[0] === 'list'
      ? JSON.stringify({ dependencies: { [PACKAGE_NAME]: { version: '1.2.3' } } })
      : 'updated';
  });
  assert.deepEqual(calls, [
    { command: 'npm', args: ['install', '--global', `${PACKAGE_NAME}@latest`] },
    { command: 'npm', args: ['list', '--global', PACKAGE_NAME, '--depth=0', '--json'] },
  ]);
  assert.equal(result.installedVersion, '1.2.3');
  assert.equal(result.ok, true);
  assert.equal(result.restartRequired, true);
});

test('npm 更新失败时不伪造成功或继续版本回读', async () => {
  let calls = 0;
  await assert.rejects(updateGlobalPackage(async () => {
    calls += 1;
    throw new Error('npm update failed');
  }), /npm update failed/);
  assert.equal(calls, 1);
});
