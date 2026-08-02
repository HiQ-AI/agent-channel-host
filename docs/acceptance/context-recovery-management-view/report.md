# 压缩恢复与管理型 View 验收报告

## 结果

Round 2 后的 22 项用例全部 PASS。`agent-channel-host` 0.4.0 已具备：

- conversation checkpoint 与成员/角色/职责资料分层；
- Codex 新 session 与自动 compaction 后的关键状态恢复，普通 resume 不重复注入；
- 集中、简洁、明确的 Prompt；
- `agent-channel view` 不接受 `--instance`，作为所有已初始化 instance 的上层入口，逐 instance 启动或 attach Host；
- 默认聚合 instance/Channel/消息/conversation/runtime，支持按 instance 下钻详情，并在设置 tab 切换目标 instance；
- 零 instance 显示初始化引导；`view --once` 保持只读且不启动 Host；`run --instance` 保留为单 instance headless/service 入口。

## 验证摘要

- `npm run verify`：43/43 tests PASS，0.4.0 pack dry-run PASS；
- 真实 Codex：`new → resumed`，同一 provider session 前缀，结构化 `silent`；
- 隔离 CLI：两个 instance 的 bare `view --once` 聚合输出和无 `--instance` help PASS；
- 真实 Windows TTY：跨 instance 总览、实例/会话下钻、设置切换、编辑、退出 PASS；
- 外部影响：未连接 DWS、未发送消息、未安装服务、未部署。

详细证据见 `round-1.md`、`round-2.md`，用例状态见 `matrix.csv`。
