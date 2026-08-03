# 命令驱动 Runtime 重构方案

## 目标

将首个 Codex runtime 从 experimental App Server 改为稳定的 `codex exec` / `codex exec resume` 命令驱动适配器，同时保留 Channel、Host、SQLite、按会话串行 Worker 和 `AgentSession` 中立契约。每个群聊/私聊继续持久化独立 provider session ID；本机 provider 进程只在处理一轮消息时存在，结束后退出。

## 三段边界

1. Channel adapter 只负责接收、标准化和发送。首个实现仍为 DingTalk DWS，不新建第二套接收服务。
2. Host 负责 durable inbox/outbox、conversation 与 runtime 映射、同会话单飞、quiet-window 合批、取消旧轮次、恢复和状态视图。
3. Runtime adapter 负责启动自身 CLI、创建或精确恢复 provider session、解析结构化结果、取消活动进程。首个实现为 Codex CLI；未来 Claude Code、Gemini CLI、Qwen CLI 各自实现相同 `RuntimeAdapter / AgentSession` 契约。

## Codex 命令协议

- 新会话：`codex exec --json --output-schema ...`。
- 既有会话：`codex exec resume --json --output-schema ... <providerSessionId>`。
- `thread.started.thread_id` 是唯一 provider session ID；resume 返回不同 ID 时 fail closed，不静默创建第二个 session。
- `item.completed` 中最终 `agent_message.text` 是结构化决定；宿主仍执行二次字段校验、职责/签名/委派证据和出站 freshness 门禁。
- `turn.completed` 才视为成功；`turn.failed`、非法 JSONL、非零退出或超时都失败。
- active turn 有新消息时终止当前 CLI 子进程，旧 claim 释放后与新消息重新合批。命令进程退出不删除 session ID。
- Codex 的固定角色和会话职责通过每次命令的 `developer_instructions` 配置注入；消息正文只出现在普通 prompt 中。

## 状态与恢复

- `AgentSession.start()` 只校验持久映射，不启动常驻 provider 进程。
- 首轮执行收到 `thread.started` 后立即以 `provisioning` 保存 session；结构化轮次完成后标记 `ready`。
- Host 在进程退出或重启后继续用同一个 ID 执行 `exec resume`。已存在但 runtime/version/cwd 不兼容的映射一律拒绝。
- 为兼容既有 SQLite v4 数据，不修改 `runtime_sessions` 表；`protocol_fingerprint` 改为命令协议指纹，历史字段 `bootstrap_turn_id` 保存首个成功 host run ID，不再代表 App Server bootstrap。

## 配置

配置升级为 v2，并明确拆成 `channel`、`runtime`、`scheduling`：

- `channel`：`id/profileId/command/profile`；
- `runtime`：`id/command/version/model/effort/cwd/timeout`；
- `scheduling`：quiet window 与 batch 上限。

当前仅接受 `dingtalk` 与 `codex`，未知 adapter fail closed。项目尚未正式部署，不保留 v1 双路兼容；旧预览 instance 需显式重建或人工迁移配置，SQLite 会话数据继续复用。

## 已知边界

- 命令模式没有 App Server 的实时 `model/list`；`doctor` 校验固定版本及 `exec`/`resume`/JSONL/output-schema 命令面，模型可用性在真实 canary 或首轮执行时由 Codex CLI 验证。
- Worker 的 warm TTL 只保留宿主内 session 对象；Codex 子进程在每轮结束即退出，因此 `view` 在 warm 状态下 PID 为空。
- 后台 subagent 是否能脱离父 `codex exec` 进程长期运行取决于各 runtime 的原生能力。宿主仍校验可观察的真实派发证据，但不以 App Server 私有通知作为通用契约。

## 验证

- 单元测试覆盖命令参数、JSONL 解析、结构化决定、精确 resume、错误/取消和 v2 配置。后续消息代理方案已取消 Host turn 超时，仅保留启动探测和停止进程的操作超时。
- 现有 Store、Host、Worker、view、service 测试全部回归。
- 本机 Codex 0.145.0 连续执行新建与 resume canary，证明同一 provider session ID、严格 silent structured output 和命令退出后恢复。
- 不连接 DWS、不订阅、不发送消息、不安装服务。
