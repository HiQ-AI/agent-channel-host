# Security policy

请通过 GitHub Security Advisory 私下报告安全问题，不要在公开 issue 中粘贴钉钉消息正文、conversation/session 完整 ID、OAuth/Codex 登录态、token、cookie 或其他凭据。

Host 只负责把已授权 Channel 消息可靠、逐条地投递到对应 runtime session。它不接收 Agent 的处理决定或 final text，不创建 Channel outbox，也不调用 Channel 发送接口。Agent 是否具备并使用 DWS 或其他 Channel skill/CLI，完全由各 runtime 工作目录、审批、sandbox、网络和工具权限决定，必须独立审计。

Channel 的 `subscriptions.groups/directs=all` 会把该 DWS 账号可见的未知会话自动登记并持久化首条消息；默认 `selected` 才是最小范围。扩大为 `all` 前应核对账号可见范围和数据保留要求。既有 `defaultModes`/Conversation mode 仅为兼容配置与本地展示，不构成 Agent 工具权限或 Host 出站门禁。

每条实时消息和首次群历史消息先写入 SQLite WAL，再按 conversation 固定 session 串行投递。Host 只以 runtime 的 `turn.completed` 生成 `forwarded` 转发凭据；不记录 `completed/processed`，不创建或保留 decision 表，也不证明 Agent 已处理、已回复或业务已完成。Host 启动时恢复被中断的 claim，并重试未达上限的 failed inbox。旧 outbox 仅作迁移遗留数据保留，不会被新运行路径执行。

Host 不设置 turn 超时。活动 claim 不按时间自动释放；新消息在 runtime 确认 turn 已开始后通过原生 steer 引导当前 turn，不抢占也不并发 resume。steer 拒绝或失败时 Worker fail closed，不静默排队到新 turn；Host 停止或 runtime 异常退出时显式收口，异常进程退出后的 claim 由下次启动 reconciliation 释放。

Host 不覆盖 runtime 的 developer/system 指令、审批、sandbox、网络、额外 writable roots 或 MCP/skills。可选 Conversation 职责只作为低频普通上下文提醒，不能提供权限隔离。`runtime.cwd` 必须指向专用工作目录，不应指向用户主目录、磁盘根目录或混有其他敏感项目的上级目录。

Codex App Server 在 Worker 活跃和保温期间持续运行，以提供 `turn/steer`；warm TTL 到期关闭进程，但不删除 SQLite 中的 provider session ID 或 Codex 本地 rollout。View 删除 Conversation 会清理 Host 自己保存的消息和 session 映射，但不会删除 provider 在其用户目录维护的本地 rollout。

Codex Runtime 以非交互后台模式启动：thread start/resume 固定 `approvalPolicy=never` 与 `sandbox=danger-full-access`。部署者必须把 runtime cwd 和 Agent 工具本身作为权限边界审计；Host 不提供审批 UI，也不会把审批转发到 Channel。任何意外 server-initiated 交互请求都会立即失败并终止当前 Worker 进程，消息由 durable inbox 在后续启动时恢复，禁止无限等待。
