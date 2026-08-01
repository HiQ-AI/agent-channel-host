# Round 1 验收记录

时间：2026-08-01

## 自动化测试与包检查

命令：

```powershell
npm test
npm run verify
```

结果：两次执行均退出码 0；16/16 测试通过。覆盖最近 50 条群历史参数与顺序、介绍 shadow/reply 状态机、发送失败同 UUID 重试、v1 迁移、实施决定证据门禁、主 thread 禁止直接实施、actor 在后台工作期间继续处理后续消息，以及原有 admission/outbox/lease/CLI 回归。`npm pack --dry-run` 成功，产物共 47 个文件。

## 真实 App Server 后台委派 canary

命令：

```powershell
node docs/acceptance/group-onboarding-delegation/scripts/app-server-delegation-canary.mjs
```

结果：最新 HEAD 以默认 `gpt-5.6-sol + low` 复跑退出码 0。固定 Codex CLI 0.145.0 的主 turn 返回真实 `subAgentActivity(kind=started)` 子 thread ID；主 turn 用时 21968ms，后台 worker 在主 turn 返回 26648ms 后才写入 `WORKER_DONE`。因此本轮同时证明了真实派发和“不等待 worker 完成”。

独立只读回查：marker 文件为 12 字节，内容为 `WORKER_DONE`。

## 文档与边界

README 已说明首次进群流程、shadow 到 reply 的发送时机、主会话和后台 subagent 的职责分工、运行时写权限及 canary 命令；SECURITY 已说明 `runtime.cwd` 的最小权限要求。

本轮未连接真实钉钉测试群，也未发送自我介绍。真实 DWS 收发需要明确的专用测试群和账号授权，不把单元测试或 mock 冒充真实钉钉 E2E。
