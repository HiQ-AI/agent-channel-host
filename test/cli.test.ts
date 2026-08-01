import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('CLI init 后 status 可独立运行且不输出完整 thread ID', async () => {
  const root = resolve('.test-cli-state');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const cli = join(process.cwd(), 'dist', 'src', 'cli.js');
  const env = { ...process.env, DINGTALK_CODEX_HOME: root };
  try {
    const initialized = await execFileAsync(process.execPath, [
      cli, 'init', '--instance', 'test', '--cwd', process.cwd(), '--name', '测试员工', '--role', '测试角色',
    ], { encoding: 'utf8', env });
    assert.equal(JSON.parse(initialized.stdout).ok, true);
    const status = await execFileAsync(process.execPath, [cli, 'status', '--instance', 'test'], { encoding: 'utf8', env });
    const body = JSON.parse(status.stdout);
    assert.equal(body.enabled_conversations, 0);
    assert.deepEqual(body.sessions, []);
    assert.doesNotMatch(status.stdout, /threadId"/);

    const modelChanged = await execFileAsync(process.execPath, [
      cli, 'config', 'model', '--instance', 'test', '--model', 'gpt-5.6-terra', '--effort', 'medium',
    ], { encoding: 'utf8', env });
    assert.deepEqual(JSON.parse(modelChanged.stdout), {
      ok: true, instance: 'test', model: 'gpt-5.6-terra', effort: 'medium', restartRequired: true,
    });
    const configText = await readFile(join(root, 'instances', 'test', 'config.yaml'), 'utf8');
    assert.match(configText, /codexModel: gpt-5\.6-terra/);
    assert.match(configText, /codexEffort: medium/);

    await assert.rejects(execFileAsync(process.execPath, [
      cli, 'config', 'model', '--instance', 'test', '--effort', 'light',
    ], { encoding: 'utf8', env }), /--effort 必须是/);

    await execFileAsync(process.execPath, [
      cli, 'init', '--instance', 'custom-model', '--cwd', process.cwd(),
      '--model', 'gpt-5.6-terra', '--effort', 'high',
    ], { encoding: 'utf8', env });
    const customConfig = await readFile(join(root, 'instances', 'custom-model', 'config.yaml'), 'utf8');
    assert.match(customConfig, /codexModel: gpt-5\.6-terra/);
    assert.match(customConfig, /codexEffort: high/);

    const added = await execFileAsync(process.execPath, [
      cli, 'conversation', 'add', '--instance', 'test', '--kind', 'direct', '--title', '测试私聊',
      '--open-dingtalk-id', 'open-test-user',
    ], { encoding: 'utf8', env });
    const addedBody = JSON.parse(added.stdout);
    assert.equal(addedBody.sessionLifecycle, 'idle');
    assert.equal(addedBody.idleTimeoutMinutes, 5);

    const changed = await execFileAsync(process.execPath, [
      cli, 'conversation', 'lifecycle', '--instance', 'test', '--id', addedBody.id,
      '--lifecycle', 'resident', '--idle-minutes', '9',
    ], { encoding: 'utf8', env });
    const changedBody = JSON.parse(changed.stdout);
    assert.equal(changedBody.sessionLifecycle, 'resident');
    assert.equal(changedBody.idleTimeoutMinutes, 9);
    assert.equal(changedBody.restartRequired, true);

    const custom = await execFileAsync(process.execPath, [
      cli, 'conversation', 'add', '--instance', 'test', '--kind', 'direct', '--title', '常驻私聊',
      '--open-dingtalk-id', 'open-resident-user', '--lifecycle', 'resident', '--idle-minutes', '11',
    ], { encoding: 'utf8', env });
    const customBody = JSON.parse(custom.stdout);
    assert.equal(customBody.sessionLifecycle, 'resident');
    assert.equal(customBody.idleTimeoutMinutes, 11);

    await assert.rejects(execFileAsync(process.execPath, [
      cli, 'conversation', 'lifecycle', '--instance', 'test', '--id', addedBody.id,
      '--lifecycle', 'idle', '--idle-minutes', '0',
    ], { encoding: 'utf8', env }), /1-35791 的正整数/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
