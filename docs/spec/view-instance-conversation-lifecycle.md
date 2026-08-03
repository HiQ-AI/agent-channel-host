# Instance/Conversation 生命周期、Channel 订阅策略与分层总览

## 1. 背景与目标

当前 `view` 已形成 `总览 → Instance → Channel/Conversation` 的层级，但全局总览仍重复渲染全部 Channel、消息、Conversation 和 Runtime 明细。Instance 和 Conversation 只有新增、修改或启停，没有完整删除入口；Channel 的 conversation registry 只能表达“指定会话”，不能显式表达不订阅或订阅全部群聊/私聊。

本轮目标：

1. 全局总览只回答“有哪些 Instance、整体是否健康、是否有待处理消息或告警”。
2. Channel、Conversation、Runtime、最近消息及其管理动作统一下钻到 Instance。
3. Instance 和 Conversation 支持带二次确认的安全删除。
4. 每个 Instance 的每个 Channel 分别配置群聊、私聊的 `none / selected / all` 准入策略。
5. 保持一个 Channel owner 和现有共享事件流，不增加第二套接收服务或每会话 consumer。

本轮不实现第二种 Channel/runtime adapter，不连接真实 DWS，不发送消息，不删除用户真实 Instance 或 Conversation。

## 2. 当前实现事实

### 2.1 事件入口

`DwsEventOwner` 启动一个前台 bus，再从同一 bus 启动群聊和私聊两个 all-events consumer。`runHost()` 标准化事件后，用 `(channelId, profileId, kind, externalId)` 查询已启用 Conversation；未命中即在写入正文前拒绝。

因此订阅范围的正确控制点是 Host 的 durable admission，而不是 DWS consumer 数量：

- transport 层继续只维持唯一 Channel owner；
- policy 层决定事件是否准入，以及未知 Conversation 是否建档；
- registry 层保存指定会话和显式禁用覆盖。

### 2.2 删除状态

SQLite 中 Session、消息、Decision、Outbox、Worker、Context、Member 和群 onboarding 均通过外键关联 Conversation，并配置 `ON DELETE CASCADE`。但以下状态不在该级联内：

- `host_lease` 中的 `conversation:<id>` Worker lease；
- Instance 目录下 `recovery/<conversationId>.json`；
- 运行中 Host 的 scheduler、Worker、timer 和打开的 SQLite 连接；
- Instance 的 `run-host.cmd`、日志和可能存在的 Windows 用户级计划任务。

### 2.3 当前总览重复

全局总览包含 INSTANCES、CHANNELS、消息汇总与最近消息、CONVERSATIONS、RUNTIMES、ALERTS。Instance 详情已经包含 Channel、消息汇总、Conversation、Runtime 和 Alerts；最近消息只缺少 Instance 级列表。

## 3. 方案

### 3.1 信息架构

全局总览保留：

- INSTANCES：名称、Agent、Host 状态、owner 形态、Channel 数、Conversation 数、pending 数和 alert 数；
- 跨 Instance 的 MESSAGES 汇总计数；
- 带 Instance 前缀的全局 ALERTS；
- 新增和删除 Instance 的入口。

全局总览移除：

- Channel 明细表；
- 最近消息逐条列表；
- Conversation 明细表；
- Runtime 明细表；
- Host PID 等仅对单 Instance 排障有意义的字段。

Instance 详情保留 Channel、Conversation、Runtime、Alerts，并新增该 Instance 的 RECENT MESSAGES 表。Conversation 详情继续展示单会话消息、Session、Worker、Checkpoint 和成员。

### 3.2 Channel 订阅策略

在 `channel` 配置内新增：

```yaml
subscriptions:
  groups: selected
  directs: selected
```

两个字段均使用枚举：

- `none`：拒绝该 kind 的全部事件，即使 registry 中存在已启用 Conversation；
- `selected`：只准入 registry 中已启用的 Conversation；
- `all`：已存在且启用的 Conversation 正常准入；已存在但显式 disabled 的 Conversation 仍拒绝；完全未知的 Conversation 先按默认策略建档，再准入首条事件。

自动建档固定使用：

- `responsibility = identity.role`；
- `mode = shadow`；
- `runtimeId = instance.runtime.id`；
- title 优先使用标准化事件中的会话名称；缺失时使用 kind 与外部 ID 的不可逆短摘要，不显示原始外部 ID。

旧 `version: 2` 配置缺少 `subscriptions` 时由 schema 默认补成 `selected/selected`，保持当前 fail-closed 行为。写入任一策略后原子持久化完整配置，并按 Channel 开关相同规则处理 Host 重启：View-owned Host 即时重启，attached Host 只落盘并提示外部重启。

Channel 页面按顺序显示：

1. Channel 启用/停用；
2. 群聊订阅策略；
3. 私聊订阅策略；
4. 指定群聊列表与搜索绑定入口；
5. 指定私聊列表。

群搜索继续使用当前只读 DWS 搜索。私聊不能按姓名猜测 `openDingTalkId`，本轮在页面展示已登记的指定私聊，新增仍使用现有 `conversation add --open-dingtalk-id`；后续只有在 DWS 提供经验证的人员搜索到稳定 ID 契约后才增加 TUI 搜索。

### 3.3 Conversation 修改与删除

Conversation 详情动作：

- `e` 或 `s`：进入当前 Conversation 对应的设置；
- `d`：打开删除确认；
- `←/Esc`：返回 Instance。

设置增加显示名称和 enabled；已有职责、mode、warm TTL、成员资料继续保留。Channel/runtime binding 不允许在原 Conversation 上热切换。

确认删除时：

1. attached Host 存活时拒绝，提示先停止外部 Host；
2. View-owned Host 先完整停止目标 Instance；
3. 删除 `conversation:<id>` lease 和 Conversation 主记录；数据库外键级联清理 Session、消息、Decision、Outbox、Worker、Context、Member、onboarding；
4. 删除对应 recovery 文件；
5. 原先由 View 管理的 Instance 重新启动 Host；
6. 清理 UI 选择并返回 Instance 详情。

删除不保留 provider session 映射，避免以后以同名绑定误恢复已删除会话。

### 3.4 Instance 删除

全局 INSTANCES 选中真实 Instance 后按 `d` 打开二次确认。确认文本明确会删除配置、SQLite/WAL、recovery、日志和本地 session 映射。

删除顺序：

1. attached Host 存活时拒绝；
2. 若是 View-owned Host，先停止并等待退出；
3. Windows 下查询并移除同名当前用户计划任务；任务不存在视为正常；
4. 关闭 View 持有的 Store；
5. 只对 `instanceDir(safeName(instance))` 执行递归删除；
6. 从 View 列表移除并规范化选择。

不得对数据根、instances 根或模糊匹配路径执行递归删除。

### 3.5 交互确认

删除确认与退出确认使用不同状态：

- 第一次 `d` 只展示目标与影响，不改变数据；
- `Enter` 或再次 `d` 执行；
- `Esc/←` 取消；
- 确认期间其他按键不触发导航或编辑。

## 4. 未采用方案与反证

1. 每个选定群聊启动独立 DWS consumer：当前 DWS 已通过共享 bus 提供 all-events 流；增加 consumer 会形成多 owner/重复接收风险，且不能表达 `all` 的动态会话。
2. 在全局总览继续展示全部对象并仅增加折叠：对象数量随群聊和消息增长，终端没有稳定折叠状态；Instance 详情已有同类表，重复信息会让用户误判操作作用域。
3. attached Host 存活时直接改 SQLite 或删除目录：外部 scheduler 仍持有 Conversation、timer 和连接，可能继续写已删除状态；Windows 也会因打开的 SQLite 文件导致部分删除。
4. `all` 模式覆盖显式 disabled：这会让用户无法阻断单个异常或敏感会话；因此 disabled 是 `all` 的 deny override。
5. 用群名/成员姓名作为绑定主键：名称可重复、可变化；registry 继续只使用 Channel 提供的稳定外部 ID，View 不显示原值。

## 5. 验证计划

- Config：旧配置默认 `selected/selected`；非法枚举拒绝；原子保存回读。
- Store：修改 title/enabled；删除后全部关联表、lease 和 recovery 文件消失。
- Host：`none`、`selected`、`all`；all 自动建档首条事件；disabled override；群/私聊互不影响；仍只有一个 Channel adapter。
- View reducer：总览删除 Instance、Conversation 详情修改/删除、确认取消、attached fail-closed、选择恢复。
- Renderer：全局总览不再出现对象明细；Instance 详情包含 Channel、Conversation、Runtime、最近消息；Channel 页面显示两类策略与两类绑定。
- CLI composition：View-owned Host 的 stop/delete/restart，Instance 目录精确删除；计划任务不存在不报错。
- 实跑：`npm run verify`、隔离 `AGENT_CHANNEL_HOME` CLI、伪造 Channel 事件和真实 PowerShell TTY；不连接真实 DWS、不发送消息。

