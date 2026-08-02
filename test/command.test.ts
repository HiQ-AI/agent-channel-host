import test from 'node:test';
import assert from 'node:assert/strict';
import { commandArgs, type ResolvedCommand } from '../src/command.js';

test('Codex npm launcher 由当前 Node 直接执行，不使用 shell shim', () => {
  const nodeScript: ResolvedCommand = { kind: 'node-script', file: 'node.exe', target: 'C:\\Tools\\codex.js' };
  assert.deepEqual(commandArgs(nodeScript, ['exec', '--json']), [
    'C:\\Tools\\codex.js', 'exec', '--json',
  ]);
});
