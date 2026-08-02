import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsServicePlan } from '../src/service.js';

test('用户级常驻任务只启动唯一 run 命令，不携带凭据', () => {
  const plan = windowsServicePlan('triss', 'D:\\tool\\cli.js', 'C:\\node\\node.exe');
  assert.equal(plan.taskName, 'agent-channel-host-triss');
  assert.match(plan.launcher, /run --instance "triss"/);
  assert.doesNotMatch(plan.launcher, /token|secret|password/i);
  assert.ok(plan.createArgs.includes('ONLOGON'));
  assert.ok(plan.createArgs.includes('LIMITED'));
});
