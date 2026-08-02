# 事件驱动 Worker 与实时视图验收报告

## 结果

Round 1 的 12/12 用例全部通过，状态以 `matrix.csv` 为准。

已验证：

- Channel 事件先 durable admission，再通过进程内 ready signal 唤醒按需 Worker；Worker 不轮询消息表或 Channel。
- 同一 conversation 只有一个 Worker/AgentSession；quiet window 合并 burst，active turn 新消息只 cancel 一次并重组 batch。
- Worker warm TTL 到期释放 provider 进程，但 SQLite 中的固定逻辑 session 和完整 provider session ID 保留；真实 Codex canary 可精确 resume。
- `status` 与 `view` 共用中立状态快照，展示 Host、Channel、消息、conversation、runtime adapter、session/worker 和错误；默认脱敏。
- `ChannelAdapter`、`RuntimeAdapter`、中立 route/session schema 为新增 Channel 与 runtime 保留明确接入点。

## 未覆盖

- 未连接真实 DWS，未向钉钉发送消息。
- 未实现第二种 Channel 或第二种 runtime adapter。
- 未安装、升级或修改本机常驻服务。

详细证据见 `round-1.md`。
