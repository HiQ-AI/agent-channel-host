# Security policy

请通过 GitHub Security Advisory 私下报告安全问题，不要在公开 issue 中粘贴钉钉消息正文、conversation/thread 完整 ID、OAuth/Codex 登录态、token、cookie 或其他凭据。

运行 Host 的操作系统用户可以读取其 instance SQLite 数据。请使用独立的普通用户权限运行，不要以 LocalSystem/root 共享个人 DWS 或 Codex 登录态。

Channel 的 `subscriptions.groups/directs=all` 会把该 DWS 账号可见的未知会话自动登记并持久化首条消息；默认 `selected` 才是最小范围。扩大为 `all` 前应核对账号可见范围、Agent 职责和数据保留要求。即使在 `all` 下，显式 disabled 的 Conversation 仍作为 deny override。

Codex 主 session 每轮使用 `workspace-write`，额外 writable roots 为空、网络访问关闭、审批策略为 `never`。`runtime.cwd` 应指向专用工作目录，不应指向用户主目录、磁盘根目录或混有其他敏感项目的上级目录。宿主会拒绝主 session 直接执行命令或修改文件的实施决定，但这属于运行时门禁，不替代操作系统级目录隔离和最小权限。用户配置中的外部 MCP/skills 仍由 Codex CLI 管理，部署前需独立审计其权限。

每轮 Codex CLI 完成后子进程退出；Worker 的 warm TTL 只释放宿主内对象，不删除 SQLite 中的 provider session ID 或 Codex 本地 rollout。`view` 的 Conversation 删除会清理 Host 自己保存的消息、session 映射、outbox、checkpoint、成员和 recovery 文件，但不会删除 provider CLI 在其用户目录维护的本地 rollout；若保留策略要求物理清除 provider 数据，仍需停止 Host 后按该 provider 的受控流程处理。不能把进程退出、空闲释放或 Host 侧删除等同于 provider 全链路删除。
