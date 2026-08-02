# 命令驱动 Runtime 验收报告

日期：2026-08-02

## 结论

`matrix.csv` 的 CMD-001～CMD-012 全部通过。`agent-channel-host` 默认 runtime 已从 Codex App Server 重构为 Codex CLI command driver，同时保留每个 conversation 独立、可恢复的 provider session 和事件驱动 Host/Worker 边界。

## 已验收能力

- 配置 v2 将 `channel / runtime / scheduling` 分段，首个 adapter 明确为 DingTalk DWS 与 Codex CLI。
- 新 Codex session 使用 `codex exec --json --output-schema`，后续使用显式 provider session ID 的 `codex exec resume`。
- provider ID、runtime/version/cwd 不一致时 fail closed；新 session 以 `provisioning → ready` 持久化，命令进程退出不删除映射。
- JSONL、structured decision、主 session 实施证据、异常退出、timeout 和 cancel 均有自动化测试。
- active turn 被新消息取消后，既有 Host 逻辑释放旧 claim 并重新合批；正常路径不轮询 DWS 或 SQLite。
- `doctor / verify / status / view` 和 npm package/README/SECURITY 已使用命令 runtime 语义。
- 本机真实 Codex adapter canary 和最终用户 CLI canary 都证明 `new → resumed` 使用同一 provider session，结构化结果为严格 `silent`。
- `npm run verify` 本地 32/32 通过，pack dry-run 通过；GitHub Actions run `30748888122` 的 Windows/Ubuntu job 均成功。

## 未包含

- 未启动 DWS owner/consumer，未做真实群消息入站或出站，因此钉钉 E2E 仍属于总目标 SG1。
- 未安装常驻服务、未发布 npm、未部署生产。
- 未实现 Claude Code、Gemini CLI、Qwen CLI 或第二种 Channel；只保留中立 contract 与配置边界。
- 命令模式不提供 App Server 的实时模型目录；模型/强度由真实 verify 或首轮运行验证。
- 后台 subagent 跨父 CLI 进程的存活能力属于具体 runtime 能力，不在公共 Host 契约中承诺。

## 证据索引

- 本地实现、32/32 测试、pack、真实 adapter/CLI canary：`round-1.md`
- 提交、PR 与双平台 CI：`round-2.md`
- 前置方案与边界：`plan.md`、`../../spec/command-driven-runtime.md`
