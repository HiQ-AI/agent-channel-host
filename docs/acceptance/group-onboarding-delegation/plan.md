# 群 onboarding 与后台委派验收计划

## 范围

- SQLite 迁移和崩溃恢复；
- DWS 最近群消息命令及返回投影；
- 首次介绍准备、shadow/reply 门禁和幂等重试；
- App Server 主 thread 的 workspace-write、原生 subagent 证据与主线程禁执行；
- 主 actor 派发后继续消费后续群消息；
- README/配置示例同步。

## 验证层次

1. 单元测试覆盖数据、命令参数、状态机和结构化决定 fail closed。
2. fake session actor 测试证明后台派发回执不会阻塞第二条群消息。
3. `npm test` 覆盖编译和全部自动化测试。
4. `npm run verify` 额外验证 npm 包内容。
5. 本机 Codex App Server canary 证明当前固定版本能在 output schema 下产生真实 `subAgentActivity(kind=started)` 和子 thread ID，主 turn 在 worker 完成前返回；不连接 DWS、不发送群消息。

真实钉钉历史和自我介绍发送需要专用测试群/账号授权，不在无明确会话目标时执行。
