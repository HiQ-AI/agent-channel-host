# Round 1：本地实现与验证

日期：2026-08-02

## 结论

CMD-001 至 CMD-011 通过。默认 Codex runtime 已从 App Server 改为一次性 `codex exec` / `codex exec resume` 命令进程；每个 conversation 的 provider session ID 仍独立持久化，命令退出后可精确恢复。未连接 DWS、未订阅或发送消息、未安装服务。

CMD-012 仍为 PENDING，等待提交、更新 PR #2 和 Windows/Ubuntu CI 回查。

## 代码与配置证据

- `src/codex-command.ts`：固定版本和命令面 probe、argv 生成、JSONL collector、`provisioning → ready`、精确 resume、structured decision、cancel/timeout/exit handling。
- `src/codex-runtime.ts`：中立 `RuntimeAdapter` 的首个实现改为 `CodexCommandSession`。
- `src/app-server.ts` 与 `src/protocol.ts` 已删除；不再生成或 pin experimental App Server schema。
- `src/config.ts` 与 `examples/triss-config.yaml`：配置升级为 v2，拆分 `channel / runtime / scheduling`；v1 明确 fail closed。
- `src/cli.ts`、`src/host.ts`、`README.md`、`SECURITY.md`：doctor/verify/status/view、运行说明和安全边界均采用 Codex CLI 语义。
- `schemas/decision-output.schema.json` 随 npm package 发布，runtime 不依赖 acceptance 目录。

## 自动化测试

命令：

```powershell
npm run verify
```

结果：退出码 0；32/32 测试通过，`npm pack --dry-run` 通过，tarball 为 `@hiq-ai/agent-channel-host@0.3.0`，包含 `dist/src/codex-command.*` 与 `schemas/decision-output.schema.json`，不包含已删除的 App Server 源码。

新增子进程级测试覆盖：

- 新命令完成后进程退出，第二个 session 对象以同一 provider ID resume；
- active command 被终止后返回 `interrupted`；
- 非零退出携带 stderr tail 并 fail closed；
- turn timeout 终止子进程；
- 非法 JSONL、resume ID 不一致、主 session 命令/文件证据和不合规决定均 fail closed。

## 真实 Codex adapter canary

命令：

```powershell
node docs/acceptance/command-driven-runtime/scripts/codex-command-resume-canary.mjs `
  D:\baibu-agent\scratchpad\agent-channel-host-command-canary-20260802
```

结果：退出码 0。

```json
{
  "ok": true,
  "firstStartupMode": "new",
  "secondStartupMode": "resumed",
  "sameProviderSessionId": true,
  "firstAction": "silent",
  "secondAction": "silent",
  "runtimeVersion": "codex-cli 0.145.0",
  "model": "gpt-5.6-sol",
  "effort": "low"
}
```

独立只读回查 SQLite：`conversationCount=1`、`lifecycle=ready`、`runtimeId=codex`，session 前缀与 canary 输出一致，协议指纹前缀为 `codex-cli 0.145.0:ex`。文档不记录完整 provider session ID。

## 最终用户 CLI canary

在独立 `AGENT_CHANNEL_HOME` 下实际执行：

```powershell
agent-channel init --instance cli-canary --cwd D:\baibu-agent --name Canary --role '只执行离线验证'
agent-channel conversation add --instance cli-canary --kind direct --title 'Offline canary' --open-dingtalk-id 'offline-canary-user'
agent-channel verify --instance cli-canary --id '<conversation UUID>'
agent-channel verify --instance cli-canary --id '<conversation UUID>'
agent-channel status --instance cli-canary
agent-channel view --instance cli-canary --once
```

结果：两次 verify 分别返回 `startupMode=new`、`startupMode=resumed`，provider session 前缀一致，两轮 action 均为 `silent`。`status/view` 显示 `Codex CLI / gpt-5.6-sol`、session `ready`、进程 PID 为空，并且未输出完整 provider session ID。落盘配置为 `version: 2`，包含独立的 `channel/runtime/scheduling` 三段。

## 边界与未完成项

- 本轮没有调用 `agent-channel run`，因此没有启动 DWS owner/consumer，也没有真实群入站或出站。
- 命令模式没有实时 `model/list`；doctor 校验 CLI 命令面，模型/强度由真实 verify 或首轮执行验证。
- Claude Code、Gemini CLI、Qwen CLI 只有中立扩展契约，没有实现或宣称 canary 通过。
- 后台 subagent 跨父 CLI 生命周期能力取决于具体 runtime，不沿用 App Server 私有通知作公共保证。
- PR 与双平台 CI 尚未验证，矩阵 CMD-012 保持 PENDING。
