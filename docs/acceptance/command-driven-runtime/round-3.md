# Round 3：真实 Codex 中断、恢复与上下文连续性

日期：2026-08-02

## 起因

最终对照 SG3D 时发现 round 1 的真实 Codex canary 只证明了 new/resume，同轮 cancel/timeout 使用 fake CLI 子进程；同时第二轮没有要求回忆第一轮上下文。session ID 相同不能替代真实 termination-recovery 与 context continuity 证据，因此撤回提前完成判断并补测。

## 流程

`codex-command-resume-canary.mjs` 使用一个全新 conversation 和固定 marker，依次执行：

1. `codex exec` 完成 seed turn，把 marker 写入固定 session 上下文；
2. 新建 session 对象并 `codex exec resume <同一 ID>`，确认真实 Codex 子进程 active 后立即调用 `interruptActive()`；
3. 等待该 run 返回 `status=interrupted`，关闭 session 对象；
4. 再建 session 对象并 resume 同一 ID；恢复 turn 的 prompt 不包含 marker 内容，只要求从历史中回忆并放入 `category`；
5. 回查同一 provider session ID、marker 精确命中、SQLite `ready`，并检查没有包含 marker 的 Codex/Node 遗留进程。

全程未启动 DWS、未发送消息。

## 真实 canary

命令：

```powershell
node docs/acceptance/command-driven-runtime/scripts/codex-command-resume-canary.mjs `
  D:\baibu-agent\scratchpad\agent-channel-host-interrupt-canary-20260802
```

结果：退出码 0。

```json
{
  "ok": true,
  "seedStartupMode": "new",
  "interruptStartupMode": "resumed",
  "recoveryStartupMode": "resumed",
  "interruptRequested": true,
  "interruptedStatus": "interrupted",
  "sameProviderSessionId": true,
  "contextRecalled": true,
  "seedAction": "silent",
  "recoveryAction": "silent",
  "runtimeVersion": "codex-cli 0.145.0",
  "model": "gpt-5.6-sol",
  "effort": "low"
}
```

只读回查结果：

```json
{
  "conversationCount": 1,
  "lifecycle": "ready",
  "runtimeId": "codex",
  "fingerprintPrefix": "codex-cli 0.145.0:ex",
  "matchingRuntimeProcesses": 0
}
```

完整 provider session ID 与 marker 不写入验收文档；session 前缀只在本地临时输出中使用。

## 回归

`npm run verify` 再次执行：32/32 测试通过，pack dry-run 通过。round 3 只增强可重复 canary 与验收证据，没有改变 runtime 代码。

最终 PR HEAD 的双平台 CI 在本轮文档提交推送后另行回查；CMD-012 已由 round 2 的代码提交 CI 证明通过，round 3 不提前填写未发生的远端结果。
