# Conversation 选择一致性与启动恢复

## 目标

本轮只修正三个已经由实际代码链确认的问题：

1. Instance 详情的 `CONVERSATIONS` 高亮行与 Enter/`→` 打开的详情必须是同一个 Conversation。
2. Host 启动时恢复 durable inbox/outbox 中可安全重试的工作，不能只恢复 `admitted/claimed`。
3. Instance 设置展示并可编辑 `runtime.cwd`，继续经过 version 2 配置 schema 与原子写入。
4. Channel 页的 GROUPS/DIRECTS 行直接复用 Conversation 删除能力。
5. Instance 详情先展示 `CONVERSATIONS`，再展示消息汇总与 `RECENT MESSAGES`。

不连接真实 DWS，不发送钉钉消息，不修改默认用户状态，不增加第二个 receiver。

## 已确认根因

### 1. Conversation 选择使用了两种顺序

`Store.status()` 给表格的数据按 `channel_id,title` 排序，`selectedConversationId()` 却从 `Store.listConversations()` 的 `kind,title` 顺序按相同索引取 ID。跨 Channel 或群/私聊混排时，高亮第 N 行和下钻 ID 因此可能不同。

仅统一 SQL 排序仍不充分：会话标题修改或刷新后排序可能变化，纯数字索引仍会漂移。交互状态必须保留稳定 Conversation ID，并在每次刷新时由 ID 重新求当前行号。

### 2. 启动 reconciliation 没有恢复失败状态

当前 `recoverPendingWork()` 只把 `claimed` 重置为 `admitted`，再选择存在 `admitted` 或未完成 onboarding 的 Conversation。Worker 异常会把批次写成 `failed`；这些消息重启后不会再次调度。已有 `pending/sending/failed` outbox 也不会驱动 Worker，因此“模型决定已完成但发送中断”的回复可能永久停留。

### 3. Runtime cwd 只存在于 schema

`runtime.cwd` 已被 `configSchema`、`init --cwd`、Codex spawn 和 session 兼容性门禁使用，但 `createSettingEntries()` 没有生成对应 Instance setting。

## 设计

### 稳定选择

- `ManagementViewState` 同时保存当前 Conversation 的稳定 ID 和派生行号。
- Instance 切换、Conversation 删除或 ID 不再存在时，选择相邻有效行并同步新 ID。
- 上下移动先在唯一的 `Store.listConversations()` 顺序中移动，再写入稳定 ID。
- Instance 表格按同一 ID 顺序排列 status 行；详情查询只读稳定 ID，不再从另一种排序按索引反查。

### 启动恢复状态机

SQLite schema 升级为 v7：

- `inbound_events.failure_count`：处理失败次数，旧 `failed` 数据迁移为 1。
- `inbound_events.last_error`：保留最近处理错误，成功后清空。
- `outbox.attempt_count`：同一 UUID 的发送尝试次数；旧 `sending/failed/submitted` 数据迁移为 1。

首版固定最多 3 次处理或发送尝试，避免确定性坏消息在每次重启时无限循环。Host 启动在一个事务中：

1. `claimed → admitted`，因为旧 Worker 已不存在，且尚无已提交决定。
2. `failed → admitted`，仅限 `failure_count < 3`；完成、达到上限的失败不重放。
3. `sending/failed outbox → pending`，仅限 `attempt_count < 3`；保留原 outbox ID、入站 ID 与 UUID。
4. 调度含 admitted inbox、pending outbox 或未完成 onboarding 的 enabled Conversation。

Worker 启动后先处理恢复的 outbox，再处理 inbox：

- 发送仍调用现有 freshness gate；已有更新消息时旧回复进入 `suppressed`。
- 可发送时沿用原 UUID，处理“发送成功但本地未落 submitted”的不确定窗口。
- 入站失败发生在 outbox 创建之前，重跑不会复用或生成第二条已成功 outbox。
- `completed` 入站和 `submitted/suppressed` outbox 永不重放。

本轮不增加常态轮询或进程内自动重试。恢复只在 Host 启动 reconciliation 执行；正常新消息仍由 durable admission 后的 ready signal 唤醒。

### Runtime cwd

- Instance 设置增加 `Runtime cwd` 文本条目，使用现有可移动光标编辑器。
- 输入不能为空，交给同一 config schema 校验并原子保存。
- 提示明确：它是 runtime 工作目录；已有 session 的持久 cwd 不一致时继续 fail closed，不静默改写 session 映射或创建新 generation。

### Channel 页删除

- 只有 `channelManagementItems()` 中 `kind=conversation` 的 GROUPS/DIRECTS 行响应 `d`。
- 删除继续使用现有 Conversation 二次确认、View-owned Host 暂停/恢复、SQLite 级联与 recovery 文件清理，不复制第二套动作。
- 成功后保持在原 Channel 页，按剩余 item 数修正光标并立即重绘；五个策略项和“搜索并绑定指定群聊”不响应删除。

### Instance 详情顺序

详情固定按 `CHANNELS → CONVERSATIONS → MESSAGES → RUNTIMES → ALERTS` 排列。该调整只改变呈现顺序；消息汇总、最近消息内容和选择状态仍使用原数据。

## 验证

- 构造 `status()` 与旧 `listConversations()` 顺序相反的跨 Channel 群/私聊，证明高亮、稳定 ID 和详情一致；修改标题触发重新排序后仍保持原 ID。
- 构造 admitted、claimed、失败次数 1/2/3、completed 入站，重开 Store/启动 scheduler 后只处理应恢复项且按 sequence claim。
- 构造 pending、sending、failed、submitted、suppressed outbox，重启后仅恢复安全项；发送沿用原 UUID，较旧回复被 freshness gate 抑制。
- Instance 设置读回当前绝对 cwd，编辑后配置文件原子保存；空值被拒绝。
- Channel 页分别删除一条 group/direct，验证二次确认、级联删除、当前页保持和选择即时刷新；策略项按 `d` 无副作用。
- 断言 `CONVERSATIONS` 标题位于消息汇总和 `RECENT MESSAGES` 之前。
- 执行全部单元/集成测试、pack dry-run、隔离状态真实 PowerShell TTY 和 Round 9 验收。
