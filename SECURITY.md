# Security policy

请通过 GitHub Security Advisory 私下报告安全问题，不要在公开 issue 中粘贴钉钉消息正文、conversation/thread 完整 ID、OAuth/Codex 登录态、token、cookie 或其他凭据。

运行 Host 的操作系统用户可以读取其 instance SQLite 数据。请使用独立的普通用户权限运行，不要以 LocalSystem/root 共享个人 DWS 或 Codex 登录态。

Codex 主 session 每轮使用 `workspace-write`，额外 writable roots 为空、网络访问关闭、审批策略为 `never`。`runtime.cwd` 应指向专用工作目录，不应指向用户主目录、磁盘根目录或混有其他敏感项目的上级目录。宿主会拒绝主 session 直接执行命令或修改文件的实施决定，但这属于运行时门禁，不替代操作系统级目录隔离和最小权限。用户配置中的外部 MCP/skills 仍由 Codex CLI 管理，部署前需独立审计其权限。

每轮 Codex CLI 完成后子进程退出；Worker 的 warm TTL 只释放宿主内对象，不删除 SQLite 中的 provider session ID 或 Codex 本地 rollout。若持久会话内容需要按数据保留策略清理，应停止 Host 后另行执行明确的清理流程，不能把进程退出或空闲释放视为数据删除。
