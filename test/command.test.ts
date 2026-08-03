import test from 'node:test';
import assert from 'node:assert/strict';
import { commandArgs, execResolved, type ResolvedCommand } from '../src/command.js';

test('Codex npm launcher 由当前 Node 直接执行，不使用 shell shim', () => {
  const nodeScript: ResolvedCommand = { kind: 'node-script', file: 'node.exe', target: 'C:\\Tools\\codex.js' };
  assert.deepEqual(commandArgs(nodeScript, ['exec', '--json']), [
    'C:\\Tools\\codex.js', 'exec', '--json',
  ]);
});

test('命令非零退出保留 stdout/stderr 供上层解析结构化错误', async () => {
  const command: ResolvedCommand = { kind: 'native', file: process.execPath, target: process.execPath };
  const script = "process.stdout.write('{\"source\":\"stdout\"}');"
    + "process.stderr.write('{\"error\":{\"reason\":\"business_error\"}}');process.exit(1)";
  await assert.rejects(
    execResolved(command, ['-e', script], { encoding: 'utf8', windowsHide: true }),
    (error: Error & { stdout?: string; stderr?: string }) => {
      assert.equal(error.stdout, '{"source":"stdout"}');
      assert.equal(error.stderr, '{"error":{"reason":"business_error"}}');
      return true;
    },
  );
});
