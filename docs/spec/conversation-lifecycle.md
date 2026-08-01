# 每会话 Codex 生命周期策略

## 目标

- 群聊和私聊都能独立配置为 `resident`（常驻）或 `idle`（空闲释放）。
- 默认值固定为：群聊 `resident`；私聊 `idle`，空闲 5 分钟。
- `idle` 超时可按会话修改；释放本地 App Server 进程但保留持久 thread ID，新消息精确 `thread/resume` 原会话。
- 主 turn、排队消息或后台 subagent 尚未结束时不释放进程。

## 现有缺口

当前只有私聊使用 instance 级 `runtime.directMessageIdleMinutes=30`，群聊始终在 Host 启动时常驻。定时器从消息提交时开始，超时后直接调用 `actor.stop()`，可能中断仍在运行的主 turn；也无法识别后台 subagent 是否仍在工作。

## 设计

1. SQLite `conversations` 增加 `session_lifecycle` 与 `idle_timeout_minutes`。v2 数据迁移到 v3 时，群聊设为 `resident`，私聊设为 `idle`，统一默认 5 分钟。
2. `conversation add` 支持 `--lifecycle resident|idle` 和 `--idle-minutes N`；未传时按会话类型取默认值。`conversation lifecycle` 可更新既有会话，运行中 Host 重启后生效。
3. Host 启动时预热所有 `resident` 会话。`idle` 群仅在 onboarding 尚需准备/发送时预热，完成后进入空闲计时；其余 `idle` 会话由新消息唤醒。
4. 所有 `idle` 会话在最近一次消息后按自身超时计时。到期时若 actor 正在处理主 turn、队列非空或 App Server 仍有后台子 thread，则短周期复查；真正空闲后关闭 App Server 子进程并保留 `sessions.thread_id`。
5. 新消息先取消旧计时，再通过现有 `ensureActor` 创建 App Server 子进程；`AppServerSession.start()` 读取持久 session 并调用 `thread/resume`，返回 ID 不一致时继续 fail closed。

## 边界

- `idle` 表示释放本机 App Server 运行进程，不删除、归档或 fork Codex thread。
- 生命周期配置修改不热更新，和 `shadow/reply` 一样要求重启 Host，避免运行中 actor 使用陈旧配置。
- 后台 subagent 活跃判断以当前 App Server 通知中的子 thread `started` 与 `turn/completed` 为准；Host 停止时仍会关闭全部进程。
- 不保留旧的 instance 级私聊超时兜底；旧配置中的 `directMessageIdleMinutes` 会被配置解析忽略，会话数据库成为唯一事实来源。
