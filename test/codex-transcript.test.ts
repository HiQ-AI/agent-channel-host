import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCodexRollout, readCodexTranscript } from '../src/codex-transcript.js';

const SID = '11111111-2222-4333-8444-555555555555';

test('Codex rollout 只提取真人关注的正文、思考摘要和配对工具步骤', () => {
  const rows = [
    { timestamp: '2026-08-07T01:00:00.000Z', type: 'session_meta', payload: { id: SID } },
    { timestamp: '2026-08-07T01:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: '检查当前实现' } },
    { timestamp: '2026-08-07T01:00:02.000Z', type: 'event_msg', payload: { type: 'agent_reasoning', text: '先读取关键文件' } },
    { timestamp: '2026-08-07T01:00:03.000Z', type: 'response_item', payload: {
      type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: JSON.stringify({ command: 'rg -n TODO src' }),
    } },
    { timestamp: '2026-08-07T01:00:04.000Z', type: 'response_item', payload: {
      type: 'function_call_output', call_id: 'call-1', output: 'src/a.ts:10:TODO\n第二行细节',
    } },
    { timestamp: '2026-08-07T01:00:05.000Z', type: 'event_msg', payload: { type: 'agent_message', message: '已定位关键位置' } },
    { timestamp: '2026-08-07T01:00:06.000Z', type: 'event_msg', payload: { type: 'token_count', total: 100 } },
  ];
  const parsed = parseCodexRollout(`非法半行\n${rows.map((row) => JSON.stringify(row)).join('\n')}`);
  assert.deepEqual(parsed.map((entry) => entry.kind), ['user', 'reasoning', 'tool', 'assistant']);
  assert.equal(parsed[2]?.label, 'exec_command');
  assert.equal(parsed[2]?.content, 'rg -n TODO src');
  assert.match(parsed[2]?.result ?? '', /src\/a\.ts:10:TODO/);
  assert.equal(parsed.some((entry) => entry.content.includes('token_count')), false);
});

test('按固定 session ID 定位 rollout，并按 revision 读取既有历史', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-channel-transcript-'));
  const codexHome = join(root, '.codex');
  const directory = join(codexHome, 'sessions', '2026', '08', '07');
  const oldDirectory = join(codexHome, 'sessions', '2026', '08', '06');
  mkdirSync(directory, { recursive: true });
  mkdirSync(oldDirectory, { recursive: true });
  const file = join(directory, `rollout-2026-08-07T09-00-00-${SID}.jsonl`);
  const oldFile = join(oldDirectory, `rollout-2026-08-06T09-00-00-${SID}.jsonl`);
  try {
    writeFileSync(oldFile, JSON.stringify({
      timestamp: '2026-08-06T01:00:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: '旧记录' },
    }));
    writeFileSync(file, JSON.stringify({
      timestamp: '2026-08-07T01:00:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: '历史结论' },
    }));
    utimesSync(oldFile, new Date('2026-08-06T01:00:00.000Z'), new Date('2026-08-06T01:00:00.000Z'));
    utimesSync(file, new Date('2026-08-07T01:00:00.000Z'), new Date('2026-08-07T01:00:00.000Z'));
    const first = readCodexTranscript(SID, { CODEX_HOME: codexHome }, root);
    assert.equal(first.state, 'ready');
    assert.equal(first.sessionIdPrefix, SID.slice(0, 12));
    assert.equal(first.entries[0]?.content, '历史结论');
    assert.ok(first.revision);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
