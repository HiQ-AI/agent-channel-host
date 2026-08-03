# 消息转发代理与固定 Session

## 目标

`agent-channel-host` 只负责把 Channel 消息可靠交给固定 runtime session，并把 runtime 的最小决定可靠发回 Channel。Agent 的身份、职责、工具和处理方式由 runtime 自身工作目录及配置决定。

## 边界

- 每个群聊或私聊绑定一个独立 runtime session；不同会话不共享 transcript。
- 普通 turn 只包含本批消息的发送者、时间、内容，不附带会话标识、职责、成员资料、历史摘要或 Host checkpoint。
- 引用和合并转发折叠进“内容”，不增加新的信封字段。
- runtime 只需返回 `{action, replyText}`；`silent` 不发送，`reply` 发送 `replyText`。
- Host 不判断职责、不限制 Agent 使用工具，也不管理 Agent 内部任务。
- Host 不覆盖 runtime 的审批、sandbox、网络或工具配置，只传入 session/cwd/model/结构化输出所需参数。
- 首次绑定群聊时拉取最近消息，以同一最小信封交给该群固定 session。Agent 自主决定静默或回复，不强制自我介绍。

## 可靠性

1. Channel 事件先持久化 inbox，再唤醒对应会话 Worker。
2. 同一会话按顺序批处理；活动 turn 期间到达新消息时，中断旧 turn，释放原 claim 后重新合并判断。
3. 决定、inbox 完成状态和可选 outbox 在一个 SQLite 事务内提交，避免进程在决定后、建 outbox 前退出造成漏回。
4. outbox 发送前再次检查会话模式和最新 sequence，使用稳定 UUID 幂等提交。
5. Host 重启时释放未完成 claim，并恢复有界重试的 inbox/outbox。
6. runtime 协议、cwd 或失败状态不兼容，或重启需要重放 claimed/failed turn、未落盘的首次群历史 turn 时，提升会话 generation 并创建新 provider session，避免恢复受污染 transcript；重置写入审计表。
7. Host 不配置 turn 超时。活动 claim 不按时间过期，由 Conversation 唯一 Worker 与 Host lease 持有；只在新消息抢占、Host 停止、runtime 退出或下次启动 reconciliation 时释放或完成。

## 首次群聊历史

首次群聊处理使用既有 `group_onboarding` 持久状态：

- 拉取最近最多 50 条消息并按时间升序规范化为发送者、时间、内容。
- 无历史消息时直接标记完成。
- Agent 返回 `silent` 时记录本次历史已处理并标记完成。
- Agent 返回 `reply` 时持久化回复；`reply` 模式立即发送，`shadow` 模式保存并等待模式切换后的恢复发送。
- 任何重启都不会重复创建另一条首次历史 turn 或重复发送已提交回复。
