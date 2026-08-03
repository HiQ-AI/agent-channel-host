# 事件驱动按需 Worker 与实时视图

## 目标

1. 只让 Channel owner 常驻。消息完成 SQLite durable admission 后发出 conversation ready signal；provider Worker 按需创建、恢复固定逻辑 session，并在 warm TTL 到期且无工作时退出。
2. 同一 conversation 只能有一个 Worker claim/运行。连续消息在 quiet window 内合并为一个结构化 batch；active turn 期间只请求一次 cancel，取消完成后把原 batch 与新增消息重新合并。
3. Host 重启时对持久化 pending/claimed work 做一次 reconciliation，不依赖 Worker 轮询消息源或 SQLite。
4. 新增 `agent-channel view`。默认像 `top` 一样持续刷新，`q`/`Ctrl+C` 退出；`--once` 输出稳定快照，便于脚本和验收。
5. 首版仍只实现 DingTalk + Codex，但 Host scheduler、持久状态 DTO 和 view 只依赖中立的 Channel/runtime 契约。

## 当前根因

- Host 启动时根据 `resident/idle` 预热 actor，群默认长期持有 App Server 子进程；这与按需 Worker 目标冲突。
- `ConversationActor` 的待处理队列仅存在内存。事件虽已写入 `inbound_events`，重启后没有 claim/reconciliation 路径。
- Store 的 session 类型和 `status()` 直接暴露 Codex thread 字段，也没有 Channel connection、Worker 状态、pending message 或最近错误。
- 现有 `status` 只输出一次 JSON 累计值，无法作为运行管理界面。

## 分层契约

```text
ChannelAdapter
  start(onEvent, onFatal) / stop / send
  descriptor: channelId, profileId, label
          │ normalized event
          ▼
ConversationHost
  allowlist → durable admission → ReadyQueue → lease/claim
  freshness / outbox / reconciliation / status snapshot
          │ claimed batch
          ▼
RuntimeAdapter
  verify / createSession
  descriptor: runtimeId, label, model
          │
          ▼
AgentSession
  start/resume / runDecision / cancel / stop / health
```

`DwsChannelAdapter` 与 `CodexRuntimeAdapter` 是首版 composition root 的两个实现。核心调度器不得读取 DWS event key、Codex thread ID、App Server method 或模型专属通知。

## 状态与迁移

SQLite 升级到 v4：

- `conversations` 增加 `channel_id/channel_profile_id/runtime_id/worker_warm_seconds`，路由键升级为 `(channel, profile, kind, external_id)`；旧记录迁移为 `dingtalk/default/codex`。
- 用中立的 `runtime_sessions` 取代旧 `sessions` 读写：`runtime_id/provider_session_id/generation/protocol_fingerprint/lifecycle/runtime_cwd`。Codex adapter 自己解释 provider session 和 fingerprint。
- `inbound_events` 增加 `claim_owner/claim_expires_at_ms/claimed_at`。正常状态为 `admitted → claimed → completed|failed`；当前消息代理方案不设置 turn 超时，`claim_expires_at_ms` 保留为历史列但新 claim 写 `NULL`，只在显式中断或启动 reconciliation 时回到 `admitted`。
- `runtime_workers` 保存 starting/running/warm/stopped/error、PID、claim 范围、最近 signal/error 和时间戳，供另一个 CLI 进程读取。
- `channel_connections` 保存 channel/profile、starting/ready/stopped/error、Host PID、连接时间、最后事件和错误。

完整 session ID、完整外部 conversation ID 和消息正文不进入默认 view；只展示前缀、计数、状态和时间。`--show-content` 才在当前用户本地终端显示截断正文预览。

## 事件驱动状态机

```text
event callback
  └─ transaction: dedupe + sequence + inbox admitted
       └─ after commit: ReadyQueue.signal(conversationId)
            ├─ no worker: lease → create worker → start/resume session
            └─ active worker: mark newer input; cancel active turn once

worker
  └─ resettable quiet timer
       └─ transaction: claim admitted seq range
            ├─ completed: record all inputs; decision belongs to batch tail
            ├─ interrupted: release claim; combine old + new input
            └─ failed: record error; fail closed
       └─ inbox empty → warm timer → stop process → release lease
```

ReadyQueue 对同一 conversation 去重；多个 signal 只表示“状态可能更新”，真实待处理范围始终由 SQLite claim 决定。事务提交后、ready signal 前崩溃时，启动 reconciliation 会释放所有遗留 claimed 并重新 signal 所有 admitted conversation。可选 safety sweep 不是本轮正常路径。

## burst 与出站

- quiet window 默认 300 ms，单 batch 默认最多 20 条；每条消息仍保留 sender/time/message/fingerprint/sequence。
- batch prompt 明确列出每条消息，不把拼接文本伪装成一条消息。
- 一次 batch 只运行一个模型 turn。前 N-1 条记录为同一 batch 的已观察输入，最终结构化决定关联 batch tail。
- active turn 被新消息取消时，旧 claim 全部释放；旧输出不得进入 outbox。
- outbox 继续以 batch tail sequence 做双重 freshness gate；发送仍由 ChannelAdapter 完成，runtime final text 永不直发。

## Worker 生命周期

- 所有 conversation 都是按需 Worker；删除 `resident/idle` 产品语义。
- 每个 conversation 配置 `workerWarmSeconds`，默认 30 秒；`0` 表示处理完立即释放。
- session mapping 不随 Worker 释放而删除。下一次 activation 必须恢复同一 `provider_session_id + generation`；不兼容或恢复失败时 fail closed。
- background subagent 尚未结束时 Worker 保持 warm；Host 停止时显式结束所有本地 provider 进程。
- pending group onboarding 是一种持久工作。Host 启动 reconciliation 可唤醒对应 Worker，但不会为所有普通群预热。

## `view` 交互

默认界面分为五段：

1. Host：instance、PID/lease、运行时长、最后刷新、错误。
2. Channels：channel/profile、connection 状态、最后事件、错误。
3. Messages：received/pending/claimed/processed/failed、outbox，以及最近消息元数据。
4. Conversations：标题、kind、mode、pending、latest sequence、Worker 状态、warm 剩余时间。
5. Runtimes：runtime/model、recoverable sessions、active workers、provider session 前缀、PID、当前 claim。

命令：

```text
agent-channel view --instance <name> [--interval <seconds>] [--once] [--show-content]
```

- TTY 默认 ANSI 原位刷新，`q`/`Ctrl+C` 退出；非 TTY 必须显式 `--once`，防止管道永久挂住。
- `--once` 输出人类可读快照，不替代现有机器可读 `status` JSON；两者读取同一个中立 snapshot DTO。
- 窄终端优先截断列而不是换行破坏表格；状态使用文字，不只依赖颜色。

## 不做

- 本轮不实现 Slack/Teams/邮件等第二个 ChannelAdapter，也不实现 Claude/Gemini/Qwen RuntimeAdapter。
- 不启动真实 DWS 订阅、不发送钉钉消息、不改 Windows service。
- 不在 view 中提供删除、重放、切换 reply 或 cancel 等写操作；本轮 view 只读。
- 不增加 Web UI、HTTP 状态服务或第二套接收服务。
