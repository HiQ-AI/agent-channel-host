# Round 1：本地产品标识迁移

日期：2026-08-02

## 结论

REN-001～009 通过，REN-010 等待提交推送、双平台 CI、GitHub 仓库和本地目录改名后验证。本轮没有连接真实 DWS、发送钉钉消息、安装计划任务或发布 npm registry package。

## 自动化回归与 package

执行：

```powershell
npm run verify
git diff --check
```

结果：退出码 0；package 为 `@hiq-ai/agent-channel-host@0.2.0`；TypeScript 构建成功；Node Test Runner `tests 28 / pass 28`；`npm pack --dry-run` 生成 `hiq-ai-agent-channel-host-0.2.0.tgz`，清单含 59 个文件。

覆盖内容包括：

- `AGENT_CHANNEL_HOME` 解析与旧 `DINGTALK_CODEX_HOME` fail-fast；
- `agent-channel` help 和 view 标头；
- Windows 任务名 `agent-channel-host-<instance>` 且 launcher 不含凭据；
- 原有事件驱动 Worker、SQLite v1-v4 迁移、DingTalk/Codex adapter ID、session/outbox 和 view 脱敏回归。

## CLI 隔离实跑

状态根：`D:\baibu-agent\scratchpad\agent-channel-host-rename-cli-20260802`。

使用新环境变量实跑 `--help → init → add synthetic direct → status → view --once`，观察到：

- usage 与 view 标头均为 `agent-channel`；
- config/state 路径位于 `agent-channel-host-rename-cli-20260802`；
- Channel 保持 `dingtalk/default`，runtime 保持 `codex / Codex App Server / gpt-5.6-sol`；
- 默认不输出完整 external ID、消息正文或 provider session ID。

只设置旧环境变量后执行 `status`，进程以退出码 1 返回明确迁移提示，没有创建新状态库。

## 真实 Codex resume

隔离目录：`D:\baibu-agent\scratchpad\agent-channel-host-rename-resume-20260802`。

`app-server-resume-canary.mjs` 实际启动两个 Codex App Server 进程，结果为：

```json
{
  "ok": true,
  "firstMode": "started",
  "secondMode": "resumed",
  "sameThreadId": true
}
```

这证明产品/client/service identity 改名没有改变 provider session 的精确恢复语义。完整 thread ID 未写入文档。

## 旧标识边界

旧名称只允许出现在以下语境：

- `src/product.ts` 与 `test/paths.test.ts` 的 fail-fast 迁移检测；
- README 和本次 rename spec 的“原名/旧变量”迁移说明；
- 已完成 round 中对当时实际命令、tarball 和临时目录的历史记录。

当前 package、CLI、默认目录、计划任务、App Server identity、view、可复用脚本和非历史产品契约均使用新名称。

## 待下一轮

- 提交并推送当前 PR；
- 回查 Windows/Ubuntu CI；
- 原位重命名 GitHub 仓库并更新 origin；
- 在无运行进程的前提下重命名本地检出目录；
- 回查 PR、redirect、远端 URL、本地目录和旧产品标识残留。
