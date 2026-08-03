# 消息转发代理验收计划

## 范围

验证最小消息信封、最小返回契约、首次群聊最近消息、固定 session、并发中断、重启恢复、事务 outbox 和 session generation 重置。

## 方法

1. 单元测试断言 prompt 和 schema 的精确边界。
2. Store/Actor 测试覆盖首次群聊 `silent/reply`、原子 outbox 和重启恢复。
3. fake Codex 验证 new/resume 参数与同 session 约束。
4. 全量 `npm run verify` 后再做隔离真实 Codex canary；不在未授权情况下修改用户级实例数据。
5. 用超过旧阈值的 fake runtime 和真实隔离消息验证 Host 不再读取或执行 turn 超时，claim 在运行期间不按时间过期。
