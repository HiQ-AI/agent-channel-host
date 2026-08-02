# Round 1：事件驱动 Worker 与实时视图

日期：2026-08-02

## 结论

12/12 用例通过。Host 只在 Channel 事件完成 SQLite durable admission 后收到 ready signal；每个 conversation 单飞 claim，消息 burst 经 quiet window 合并，active turn 的连续新增消息只发出一次 cancel。Worker 空闲后按 warm TTL 释放 provider 进程，后续仍精确 resume 原 provider session。

本轮没有连接真实 DWS、没有订阅或发送钉钉消息、没有安装 Windows 计划任务。

## 自动化证据

执行：

```powershell
npm run verify
```

结果：退出码 0；TypeScript 构建成功；Node Test Runner `27 pass / 0 fail`；`npm pack --dry-run` 成功生成当时原名对应的 `hiq-ai-dingtalk-codex-host-0.2.0.tgz` 清单。

覆盖关系：

- EWV-001、002、003、004：`test/store.test.ts` 的 v3 迁移、事务 claim/release/reconciliation 和跨 Channel 路由用例。
- EWV-005、006、008：`test/host.test.ts` 的 burst 单 turn、active turn 单 cancel、Worker 启动中关闭仍保持单次 stop，以及启动仅恢复 pending work 用例。
- EWV-007：`test/host.test.ts` 的 warm TTL 释放，以及下方真实 Codex resume canary。
- EWV-009、010：`test/view.test.ts` 的中立快照、视图分区及默认脱敏用例。
- EWV-011：`test/cli.test.ts` 的 `view --once` 和非 TTY 持续模式门禁用例。
- EWV-012：完整 `npm run verify`。

## 真实 Codex resume canary

隔离状态目录：`D:\baibu-agent\scratchpad\dingtalk-codex-host-event-workers-view-resume-20260802`（当时项目原名）。

执行：

```powershell
npm run build
node docs/acceptance/conversation-lifecycle/scripts/app-server-resume-canary.mjs `
  D:\baibu-agent\scratchpad\dingtalk-codex-host-event-workers-view-resume-20260802
```

结果：

```json
{
  "ok": true,
  "firstMode": "started",
  "secondMode": "resumed",
  "sameThreadId": true
}
```

canary 在第二个 App Server 进程中恢复同一完整 thread ID，并在恢复后完成一轮 `silent` 结构化决策。文档仅记录布尔结论，不保存完整 provider session ID。

## CLI view canary

使用当时的隔离变量 `DINGTALK_CODEX_HOME` 实跑 `init → add synthetic direct → view --once`。输出同时包含：

- `Host stopped`；
- `CHANNELS` 中的 `dingtalk/default/stopped`；
- `MESSAGES` 计数；
- 合成私聊 conversation 的 `shadow/stopped/codex`；
- `RUNTIMES` 中的 `Codex App Server / gpt-5.6-sol`；
- `SESSIONS / WORKERS` 中的 `unprovisioned`。

默认输出未包含消息正文、完整 external ID 或完整 provider session ID。

## 边界反证

- 核心 contract 和持久化 schema 已中立化，但本轮只实现了 `DwsChannelAdapter` 与 `CodexRuntimeAdapter` 两个首发适配器；尚不能据此声称已支持 Slack、Teams、Claude Code、Gemini CLI 或 Qwen CLI。
- 本轮证明了 Host/Worker/session 的离线行为与真实 Codex resume，不等于真实钉钉账号的端到端业务验收。
