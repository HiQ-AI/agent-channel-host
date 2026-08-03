import test from 'node:test';
import assert from 'node:assert/strict';
import { isWindowsTaskMissingFailure, windowsCommandFailureDetail, windowsServicePlan } from '../src/service.js';

test('用户级常驻任务只启动唯一 run 命令，不携带凭据', () => {
  const plan = windowsServicePlan('triss', 'D:\\tool\\cli.js', 'C:\\node\\node.exe');
  assert.equal(plan.taskName, 'agent-channel-host-triss');
  assert.match(plan.launcher, /run --instance "triss"/);
  assert.doesNotMatch(plan.launcher, /token|secret|password/i);
  assert.ok(plan.createArgs.includes('ONLOGON'));
  assert.ok(plan.createArgs.includes('LIMITED'));
});

test('Windows 本地化任务不存在错误按原始字节解码，不把 CP936 输出显示成乱码', () => {
  const failure = Object.assign(new Error('Command failed: schtasks.exe /Query'), {
    stderr: Buffer.from('b4edcef33a20cfb5cdb3d5d2b2bbb5bdd6b8b6a8b5c4cec4bcfea1a30d0d0a', 'hex'),
  });
  const detail = windowsCommandFailureDetail(failure);
  assert.match(detail, /系统找不到指定的文件/);
  assert.doesNotMatch(detail, /�/);
  assert.equal(isWindowsTaskMissingFailure(failure), true);
  assert.equal(isWindowsTaskMissingFailure(Object.assign(new Error('Access is denied'), {
    stderr: Buffer.from('Access is denied', 'utf8'),
  })), false);
});
