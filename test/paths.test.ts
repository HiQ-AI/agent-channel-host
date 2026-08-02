import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { dataRoot, lockRoot } from '../src/paths.js';

test('新状态根环境变量生效，旧变量单独存在时 fail-fast', () => {
  assert.equal(dataRoot({ AGENT_CHANNEL_HOME: '.agent-channel-state' }), resolve('.agent-channel-state'));
  assert.match(dataRoot({ XDG_STATE_HOME: '/state' }), /agent-channel-host$/);
  assert.match(lockRoot({ XDG_RUNTIME_DIR: '/runtime' }), /agent-channel-host$/);
  assert.throws(
    () => dataRoot({ DINGTALK_CODEX_HOME: '.legacy-state' }),
    /DINGTALK_CODEX_HOME 已重命名为 AGENT_CHANNEL_HOME/,
  );
});
