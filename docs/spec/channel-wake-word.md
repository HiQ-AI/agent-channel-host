# Channel 唤醒词订阅模式

## 目标

Channel 在群聊、私聊的 `none/selected/all` 订阅策略之外新增独立唤醒词模式开关。开启后，唤醒词模式作为常规订阅未准入消息的兜底，同时覆盖所有群聊和私聊。

## 行为契约

- `none`、`selected`、`all` 保持现有行为。
- 唤醒词模式开启时同时启动群聊和私聊共享 DWS consumer。
- 常规订阅优先：已准入消息保留原文并只处理一次，不套用唤醒词。
- 常规订阅未准入时，匹配唤醒词的本人真人消息才兜底准入。
- 实时订阅、启动离线补拉、5 秒本人消息补拉共用同一过滤函数，不能互相绕过。
- 资料页自聊不依赖个人事件：模式开启后每轮按当前 profile `userId` 查询一次自聊历史，使用 Channel/profile 独立持久化水位；发现对应 Conversation 后从普通本人消息扫描列表排除，避免重复查询。
- 匹配同时要求发送者名称等于当前 DWS profile 用户名、消息没有 AI 标记，且消息正文从第一个字符开始匹配唤醒词；不忽略正文前导空白。
- 匹配后从交给 Agent 的正文中移除唤醒词，并移除紧随其后的空白或 `:：,，、` 分隔符。
- 去除后为空的消息不准入，不启动 Worker。
- 唤醒词兜底对未知会话采用 `all` 的建档语义；已禁用 Conversation 仍拒绝准入。
- 唤醒词是 Channel 配置项，长度 1–32，既有配置缺失时固化为加载时的 `identity.name`；新配置显式写入初始化时的 Agent 名称。

## 数据与调用流

1. `DwsChannelAdapter.start` 解析当前 profile 用户名。
2. 实时、backfill、self poll 得到 `NormalizedEvent` 后调用统一唤醒词策略。
3. DWS 为匹配消息附加去除唤醒词后的指令；Host 先判断常规订阅，仅在未准入时采用该指令兜底。
4. Host 只看到准入后的事件，沿用 Conversation 解析、inbox 去重、Worker signal 与固定 session resume。

## View 与配置

- Channel 页面新增唤醒词模式开关，并保留独立的唤醒词编辑项。
- Channel 页面新增“唤醒词”文本设置；保存后重启该 Instance Host，使实时 consumer、补拉和 View 显示使用同一配置快照。
- README、示例配置和 CHANGELOG 同步说明。

## 验证

- 配置兼容：新配置默认、旧配置回填、空值和超长值拒绝。
- 纯函数：本人前缀匹配、他人消息、前导空格、空指令、群聊/私聊分别受各自模式控制。
- DWS 三入口：实时、backfill、self poll 均应用相同识别规则；开关开启时订阅两类事件 key。
- Host：匹配事件可按 `all` 建档，非匹配事件不会进入 Host。
- View：模式可开关，唤醒词可编辑、持久化并触发 Host 重启。
- 全量 `npm run verify`。
