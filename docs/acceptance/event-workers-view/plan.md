# 事件驱动 Worker 与实时视图验收计划

## 范围

- SQLite v3 → v4 路由/session/claim/Channel/Worker 状态迁移；
- durable admission 后 ready signal、conversation 单飞、quiet-window batch、active turn 单次 cancel、warm TTL 和启动 reconciliation；
- ChannelAdapter/RuntimeAdapter 中立边界；
- `status` 中立 JSON snapshot 与 `view --once`/TTY 刷新；
- README、CLI help、配置和打包内容同步。

## 验证层次

1. Store 单元测试验证 claim/release/complete、过期 claim 恢复、跨 channel 路由和 snapshot 脱敏。
2. Worker/scheduler 测试验证信号去重、无轮询、burst 单 turn、active turn 单次 cancel、warm 释放和重启 reconciliation。
3. CLI 进程测试验证 `view --once`、非 TTY 门禁、参数校验和不输出完整 session/conversation ID。
4. `npm run verify` 验证构建、全量测试和 npm pack；必要时用隔离状态目录实跑 `init → add direct → view --once`。

本轮不连接真实 DWS、不发送钉钉消息、不安装或修改 Windows 计划任务。
