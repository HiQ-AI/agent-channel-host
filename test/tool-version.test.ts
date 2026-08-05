import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMinimumToolVersion } from '../src/tool-version.js';

test('Node.js、DWS 和 Codex 均允许高于最低要求的版本', () => {
  assert.doesNotThrow(() => assertMinimumToolVersion('Node.js', 'v22.13.0', 'v23.0.0'));
  assert.doesNotThrow(() => assertMinimumToolVersion('DWS', 'dws v1.0.55', 'dws version v1.1.0 (build)'));
  assert.doesNotThrow(() => assertMinimumToolVersion('Codex', 'codex-cli 0.145.0', 'codex-cli 0.146.0'));
});

test('低于最低要求或无法识别的工具版本会明确失败', () => {
  assert.throws(
    () => assertMinimumToolVersion('Codex', 'codex-cli 0.145.0', 'codex-cli 0.144.9'),
    /Codex 版本过低：最低要求 codex-cli 0\.145\.0，实际 codex-cli 0\.144\.9/,
  );
  assert.throws(() => assertMinimumToolVersion('DWS', 'dws v1.0.55', 'unknown'), /版本格式无法识别/);
  assert.throws(() => assertMinimumToolVersion('Node.js', 'v22.13.0', 'v22.13.0-rc.1'), /版本过低/);
});
