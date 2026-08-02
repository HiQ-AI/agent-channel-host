# 压缩恢复与管理型 View 验收报告

## 结果

Round 1 的 17 项用例全部 PASS。`agent-channel-host` 0.4.0 已具备：

- conversation checkpoint 与成员/角色/职责资料分层；
- Codex 新 session 与自动 compaction 后的关键状态恢复，普通 resume 不重复注入；
- 集中、简洁、明确的 Prompt；
- `agent-channel view` 启动或 attach 唯一 Host，默认显示总览，并提供详情和设置 tab；
- `view --once` 保持只读且不启动 Host；`run` 保留为 headless/service 入口。

## 验证摘要

- `npm run verify`：41/41 tests PASS，0.4.0 pack dry-run PASS；
- 真实 Codex：`new → resumed`，同一 provider session 前缀，结构化 `silent`；
- 真实 Windows TTY：总览、设置、编辑、退出 PASS；详情输入状态机 PASS；
- 外部影响：未连接 DWS、未发送消息、未安装服务、未部署。

详细证据见 `round-1.md`，用例状态见 `matrix.csv`。
