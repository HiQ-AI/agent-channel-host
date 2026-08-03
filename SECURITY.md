# Security policy

请通过 GitHub Security Advisory 私下报告安全问题，不要在公开 issue 中粘贴钉钉消息正文、conversation/session 完整 ID、OAuth/Codex 登录态、token、cookie 或其他凭据。

Host 只负责把已授权 Channel 消息可靠、逐条地投递到对应 runtime session。它不接收 Agent 的处理决定或 final text，不创建 Channel outbox，也不调用 Channel 发送接口。Agent 是否具备并使用 DWS 或其他 Channel skill/CLI，完全由各 runtime 工作目录、审批、sandbox、网络和工具权限决定，必须独立审计。

Channel 的 `subscriptions.groups/directs=all` 会把该 DWS 账号可见的未知会话自动登记并持久化首条消息；默认 `selected` 才是最小范围。扩大为 `all` 前应核对账号可见范围和数据保留要求。既有 `defaultModes`/Conversation mode 仅为兼容配置与本地展示，不构成 Agent 工具权限或 Host 出站门禁。

每条实时消息和首次群历史消息先写入 SQLite WAL，再按 conversation 固定 session 串行投递。Host 只以 runtime 的 `turn.completed` 作为本次投递完成凭据；这不证明 Agent 已处理、已回复或业务已完成。Host 启动时恢复被中断的 claim，并重试未达上限的 failed inbox。旧数据库中的 decision、outbox 和 onboarding 发送字段仅作迁移遗留数据保留，不会被新运行路径执行。

Host 不设置 turn 超时。活动 claim 不按时间自动释放；新消息只排队，不抢占当前 turn。Host 停止或 runtime 异常退出时显式收口，异常进程退出后的 claim 由下次启动 reconciliation 释放。

Host 不覆盖 runtime 的 developer/system 指令、审批、sandbox、网络、额外 writable roots 或 MCP/skills。可选 Conversation 职责只作为低频普通上下文提醒，不能提供权限隔离。`runtime.cwd` 必须指向专用工作目录，不应指向用户主目录、磁盘根目录或混有其他敏感项目的上级目录。

每轮 Codex CLI 完成后子进程退出；Worker 的 warm TTL 只释放宿主内对象，不删除 SQLite 中的 provider session ID 或 Codex 本地 rollout。View 删除 Conversation 会清理 Host 自己保存的消息和 session 映射，但不会删除 provider CLI 在其用户目录维护的本地 rollout。
