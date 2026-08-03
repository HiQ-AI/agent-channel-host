# Security policy

请通过 GitHub Security Advisory 私下报告安全问题，不要在公开 issue 中粘贴钉钉消息正文、conversation/thread 完整 ID、OAuth/Codex 登录态、token、cookie 或其他凭据。

运行 Host 的操作系统用户可以读取其 instance SQLite 数据。请使用独立的普通用户权限运行，不要以 LocalSystem/root 共享个人 DWS 或 Codex 登录态。

Channel 的 `subscriptions.groups/directs=all` 会把该 DWS 账号可见的未知会话自动登记并持久化首条消息；默认 `selected` 才是最小范围。扩大为 `all` 前应核对账号可见范围、Agent 职责和数据保留要求。`defaultModes.groups/directs=reply` 还会允许对应的新 Conversation 通过出站门禁，风险高于默认 `shadow`；它仍不强制 Agent 回复。两类默认模式只影响之后的新 Conversation，显式 disabled 仍作为 deny override。

Host 不覆盖 Codex session 的审批、sandbox、网络、额外 writable roots 或外部 MCP/skills；这些权限由 runtime 工作目录和用户级配置决定。`runtime.cwd` 应指向专用工作目录，不应指向用户主目录、磁盘根目录或混有其他敏感项目的上级目录。View 修改 cwd 会触发 Host 重启；若已有 provider session 的 cwd 不一致，Host 会提升 generation 后创建新 session。部署前必须独立审计 runtime 配置，不能把 Host 的消息门禁误当成工具权限隔离。

Runtime 返回不是精确的 `{action, replyText}` 最小结构时，当前 batch 保持 fail-closed 且不产生 outbox，但错误隔离在对应 Conversation，不应终止共享 Channel owner。Host 只接收可选的 Conversation 职责，并在首轮、职责变更后首轮及每 5 个已完成 turn 作为普通上下文提醒；它不接收实施、委派或权限字段，也不把职责提醒当成 developer/system 权限边界，避免消息代理替 Agent 做行为判断。

Host 启动时会一次性恢复被中断的 claim，并重试未达 3 次上限的 failed inbox/outbox。outbox 沿用原 UUID，发送前再次检查 Conversation 是否仍允许回复以及对应入站 sequence 是否仍是最新；已完成、已提交和达到上限的记录不会自动重放。该机制降低进程中断造成的漏处理风险，但不把 DWS 易失 event bus 提升为端到端 exactly-once。

Host 不设置 turn 超时。活动 claim 不按时间自动释放，而由 Conversation 唯一 Worker 和 Host lease 隔离；新消息抢占、Host 停止或 runtime 退出时显式收口，异常进程退出后由下次启动 reconciliation 释放。部署方应监控长期无输出的 runtime turn，并通过停止 Host 或发送新消息触发受控中断，不能依赖时间阈值自动杀进程。

每轮 Codex CLI 完成后子进程退出；Worker 的 warm TTL 只释放宿主内对象，不删除 SQLite 中的 provider session ID 或 Codex 本地 rollout。`view` 的 Conversation 删除会清理 Host 自己保存的消息、session 映射、outbox、旧 checkpoint 和成员资料，但不会删除 provider CLI 在其用户目录维护的本地 rollout；若保留策略要求物理清除 provider 数据，仍需停止 Host 后按该 provider 的受控流程处理。不能把进程退出、空闲释放或 Host 侧删除等同于 provider 全链路删除。
