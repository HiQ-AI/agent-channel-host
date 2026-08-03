import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadConfig, writeConfig } from '../src/config.js';

const execFileAsync = promisify(execFile);

test('CLI init 后 status 可独立运行且不输出完整 thread ID', async () => {
  const root = resolve('.test-cli-state');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const cli = join(process.cwd(), 'dist', 'src', 'cli.js');
  const env = { ...process.env, AGENT_CHANNEL_HOME: root };
  try {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
    const version = await execFileAsync(process.execPath, [cli, '--version'], { encoding: 'utf8', env });
    assert.equal(version.stdout.trim(), packageJson.version);
    const help = await execFileAsync(process.execPath, [cli, '--help'], { encoding: 'utf8', env });
    assert.match(help.stdout, /^Usage: agent-channel /);
    assert.doesNotMatch(help.stdout, /dingtalk-codex/);
    const initialized = await execFileAsync(process.execPath, [
      cli, 'init', '--instance', 'test', '--cwd', process.cwd(), '--name', '测试员工', '--role', '测试角色',
    ], { encoding: 'utf8', env });
    assert.equal(JSON.parse(initialized.stdout).ok, true);
    const status = await execFileAsync(process.execPath, [cli, 'status', '--instance', 'test'], { encoding: 'utf8', env });
    const body = JSON.parse(status.stdout);
    assert.equal(body.enabled_conversations, 0);
    assert.deepEqual(body.conversations, []);
    assert.deepEqual(body.runtimes, []);
    assert.doesNotMatch(status.stdout, /threadId"/);

    const modelChanged = await execFileAsync(process.execPath, [
      cli, 'config', 'model', '--instance', 'test', '--model', 'gpt-5.6-terra', '--effort', 'medium',
    ], { encoding: 'utf8', env });
    assert.deepEqual(JSON.parse(modelChanged.stdout), {
      ok: true, instance: 'test', model: 'gpt-5.6-terra', effort: 'medium', restartRequired: true,
    });
    const configText = await readFile(join(root, 'instances', 'test', 'config.yaml'), 'utf8');
    assert.match(configText, /model: gpt-5\.6-terra/);
    assert.match(configText, /effort: medium/);

    await assert.rejects(execFileAsync(process.execPath, [
      cli, 'config', 'model', '--instance', 'test', '--effort', 'light',
    ], { encoding: 'utf8', env }), /--effort 必须是/);

    await execFileAsync(process.execPath, [
      cli, 'init', '--instance', 'custom-model', '--cwd', process.cwd(),
      '--model', 'gpt-5.6-terra', '--effort', 'high',
    ], { encoding: 'utf8', env });
    const customConfig = await readFile(join(root, 'instances', 'custom-model', 'config.yaml'), 'utf8');
    assert.match(customConfig, /model: gpt-5\.6-terra/);
    assert.match(customConfig, /effort: high/);

    const added = await execFileAsync(process.execPath, [
      cli, 'conversation', 'add', '--instance', 'test', '--kind', 'direct', '--title', '测试私聊',
      '--open-dingtalk-id', 'open-test-user',
    ], { encoding: 'utf8', env });
    const addedBody = JSON.parse(added.stdout);
    assert.equal(addedBody.channelId, 'dingtalk');
    assert.equal(addedBody.runtimeId, 'codex');
    assert.equal(addedBody.mode, 'shadow');
    assert.equal(addedBody.workerWarmSeconds, 30);

    const currentConfig = await loadConfig('test', join(root, 'instances', 'test', 'config.yaml'));
    currentConfig.channel.defaultModes.directs = 'reply';
    await writeConfig(currentConfig, join(root, 'instances', 'test', 'config.yaml'));
    const defaultReply = await execFileAsync(process.execPath, [
      cli, 'conversation', 'add', '--instance', 'test', '--kind', 'direct', '--title', '默认回复私聊',
      '--open-dingtalk-id', 'open-default-reply-user',
    ], { encoding: 'utf8', env });
    assert.equal(JSON.parse(defaultReply.stdout).mode, 'reply');

    const changed = await execFileAsync(process.execPath, [
      cli, 'conversation', 'worker', '--instance', 'test', '--id', addedBody.id,
      '--warm-seconds', '9',
    ], { encoding: 'utf8', env });
    const changedBody = JSON.parse(changed.stdout);
    assert.equal(changedBody.workerWarmSeconds, 9);
    assert.equal(changedBody.restartRequired, true);

    const custom = await execFileAsync(process.execPath, [
      cli, 'conversation', 'add', '--instance', 'test', '--kind', 'direct', '--title', '保温私聊',
      '--open-dingtalk-id', 'open-warm-user', '--warm-seconds', '11',
    ], { encoding: 'utf8', env });
    const customBody = JSON.parse(custom.stdout);
    assert.equal(customBody.workerWarmSeconds, 11);

    await assert.rejects(execFileAsync(process.execPath, [
      cli, 'conversation', 'worker', '--instance', 'test', '--id', addedBody.id,
      '--warm-seconds', '-1',
    ], { encoding: 'utf8', env }), /0-2147483 的整数/);

    const viewed = await execFileAsync(process.execPath, [
      cli, 'view', '--once',
    ], { encoding: 'utf8', env });
    assert.match(viewed.stdout, /INSTANCES/);
    assert.match(viewed.stdout, /test/);
    assert.match(viewed.stdout, /custom-model/);
    assert.match(viewed.stdout, /MESSAGES received=0 pending=0/);
    assert.doesNotMatch(viewed.stdout, /^CHANNELS$|^CONVERSATIONS$|^RUNTIMES$/m);
    assert.match(viewed.stdout, /^agent-channel view /);
    assert.doesNotMatch(viewed.stdout, /open-test-user|open-warm-user/);
    await assert.rejects(execFileAsync(process.execPath, [
      cli, 'view', '--interval', '0.2',
    ], { encoding: 'utf8', env }), /持续 view 需要交互式终端/);
    await assert.rejects(execFileAsync(process.execPath, [
      cli, 'view', '--instance', 'test', '--once',
    ], { encoding: 'utf8', env }), /unknown option '--instance'/);

    const emptyRoot = resolve('.test-cli-empty-state');
    await rm(emptyRoot, { recursive: true, force: true });
    await mkdir(emptyRoot, { recursive: true });
    try {
      const empty = await execFileAsync(process.execPath, [cli, 'view', '--once'], {
        encoding: 'utf8', env: { ...process.env, AGENT_CHANNEL_HOME: emptyRoot },
      });
      assert.match(empty.stdout, /instances=0/);
      assert.match(empty.stdout, /尚未初始化 instance/);
      assert.match(empty.stdout, /agent-channel init --instance/);
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
