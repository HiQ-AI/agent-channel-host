# 会话职责周期提醒验收报告

Round 1 的 10/10 用例全部通过，状态以 `matrix.csv` 为准。

交付结果：

- Instance identity 只保留本地展示名称；旧 `role/signature` 可读并在规范化保存时移除。
- Conversation 职责允许为空；空值使用 Agent 自身职责。
- 非空职责只在首轮、职责变更后首轮及每 5 个已完成 turn 作为普通上下文提醒；失败/中断不推进周期。
- Codex adapter 不覆盖 `developer_instructions`，职责变更不重建固定 provider session。
- 真实 Codex canary、82/82 tests、0.9.0 pack 和隔离 CLI/TUI 回查通过。

已知边界：周期提醒不是 developer/system 权限边界，也不精确感知 runtime compaction；身份、安全、工具权限等长期规则仍由 Agent runtime 工作目录和原生配置负责。
