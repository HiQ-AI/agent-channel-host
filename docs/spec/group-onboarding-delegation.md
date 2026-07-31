# 群首次入场与后台实施委派方案

## 目标

1. 授权群首次由 Host 启动时，先读取最近消息形成上下文，再由固定主会话生成一次自我介绍。
2. 固定主会话持续负责群内沟通、需求澄清和进度汇总；需要具体实施时必须派发 Codex 原生后台 subagent，主会话不得自己执行，派发后立即结束当前 turn，继续处理后续群消息。

## 当前实现与根因

- `AppServerSession.provision()` 把新 thread bootstrap 固定校验为严格 `silent`，没有群 onboarding 状态，也没有历史消息读取。
- `ConversationActor.start()` 只启动固定 session，未区分首次启动与恢复。
- 主 thread 的 `thread/start`、`thread/resume` 和 `turn/start` 均使用 `readOnly`，Codex subagent 又继承父会话沙箱，所以当前即使通过提示要求派 worker，worker 也无法实施。
- 决策 schema 只有 `silent/reply/escalate`，宿主无法区分讨论与实施，也无法证明主会话真实调用了 `spawn_agent`。

## 设计

### 1. 群 onboarding

触发点是“群 conversation 第一次由 Host 启动”，不是每次 Host 重启，也不是每条消息到达。

流程：

1. `Store` 为每个群 conversation 维护唯一 onboarding 记录；历史已有群在迁移时补为 `pending`。
2. actor 启动时若 onboarding 尚未准备，调用 DWS：
   `chat message list --group <id> --time <当前本地时间> --direction older --limit 50 --format json`。
3. 只把消息正文、发送者、时间、引用/转发等讨论上下文投影给模型，不把完整 conversation ID、message ID 等标识写入 prompt；总上下文设硬上限。
4. 启动或精确恢复固定主 thread，在该 thread 上运行一次 onboarding turn。该 turn 必须生成带签名的 `reply` 自我介绍，且不得派 subagent。
5. 在发送前持久化介绍正文与确定性 UUID。`shadow` 模式只完成历史理解和介绍准备，不发送；切到 `reply` 并重启 Host 后发送同一条介绍。
6. 发送成功标记 `submitted`。发送失败保留错误并以同一 UUID 重试；DWS 24 小时 UUID 去重降低“发送成功但本地未落状态”造成的重复风险，但不宣称端到端 exactly-once。

历史读取失败时不创建介绍、不猜上下文，Host fail closed；下次启动重新读取。

### 2. 主会话与 subagent 分工

主 thread 仍是一群一固定 thread，负责：

- 理解群历史和当前讨论；
- 澄清目标、边界和验收；
- 对实施请求派发后台 worker；
- 立即在群内确认已接手，不等待 worker 完成；
- 在后续消息中继续参与讨论，并按子线程结果汇总进展。

实现请求的宿主验收条件：

1. 结构化决定声明 `workType=implementation`、`delegation=started`；
2. 同一主 turn 必须有运行时真实派发证据：当前固定 Codex CLI 0.145.0 以 `subAgentActivity(kind=started, agentThreadId=...)` 上报；宿主同时兼容 `collabAgentToolCall` / `receiverThreadIds` 形态；
3. 同一主 turn 不得出现主 thread 的 `commandExecution` 或 `fileChange`；
4. 主 turn 在派发后直接返回群回执，不调用 `wait_agent` 等待实施结果。

为让 worker 能实施，主 thread 和其继承权限的 subagent 使用 `workspaceWrite` + `approvalPolicy=never`。主 thread 不直接实施由 developer instructions 和上述 item 证据双重约束；违反时本轮决策 fail closed，不发送群回执。

讨论、问答、闲聊仍可直接 `silent/reply/escalate`，不得伪造 `delegation=started`。

### 3. 数据模型

新增 `group_onboarding`：

- `conversation_id`：群 conversation 主键；
- `state`：`pending/prepared/sending/submitted/failed`；
- `history_count/history_loaded_at`：历史读取证据；
- `intro_turn_id/intro_text/intro_uuid`：固定 thread 上生成的介绍及幂等键；
- `error/created_at/updated_at`：恢复与诊断。

`decisions` 增加 `work_type/delegation/subagent_thread_id`，用于证明实施请求是否真实派发。

### 4. 并发和恢复

- 启动顺序保持“全部授权群 actor ready 后再启动 DWS 事件 owner”，因此 onboarding 与实时消息不会交叉乱序。
- 主 actor 只等待主 turn；后台 worker 不占 actor drain，后续群消息可立即开新主 turn。
- 新消息只中断主 thread 的 active turn，不把后台 worker 当作群消息处理 turn。
- Host 重启精确恢复原主 thread；onboarding 以 SQLite 状态恢复，不新建第二条主 thread。

## 不做

- 不拉取全部历史或无限翻页；首版固定最近 50 条。
- 不在 `conversation add` 命令里直接发送，避免 CLI 配置动作绕过 Host owner、session 和 outbox。
- 不把普通群消息直接建成外部 A2A Task；实施工作仍由固定主 thread 使用 Codex 原生 subagent 派发。
- 不宣称 DWS 事件流或介绍发送端到端 exactly-once。

## 验收

详细用例及每轮状态以 `docs/acceptance/group-onboarding-delegation/matrix.csv` 为准。
