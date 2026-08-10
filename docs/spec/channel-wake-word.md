# Channel 唤醒词订阅模式

## 目标

群聊订阅和私聊订阅在 `none/selected/all` 之外新增 `wake-word`。选择该模式后，只有当前 DWS profile 本人真人发送、且正文以 Channel 配置的唤醒词开头的消息，才进入对应 Conversation 的 inbox 并唤醒固定 Codex session。

## 行为契约

- `none`、`selected`、`all` 保持现有行为。
- `wake-word` 仍启动对应群聊或私聊的共享 DWS consumer。
- 实时订阅、启动离线补拉、5 秒本人消息补拉共用同一过滤函数，不能互相绕过。
- 匹配同时要求发送者名称等于当前 DWS profile 用户名、消息没有 AI 标记，且消息正文从第一个字符开始匹配唤醒词；不忽略正文前导空白。
- 匹配后从交给 Agent 的正文中移除唤醒词，并移除紧随其后的空白或 `:：,，、` 分隔符。
- 去除后为空的消息不准入，不启动 Worker。
- `wake-word` 对未知会话采用 `all` 的建档语义；已禁用 Conversation 仍拒绝准入。
- 唤醒词是 Channel 配置项，长度 1–32，既有配置缺失时固化为加载时的 `identity.name`；新配置显式写入初始化时的 Agent 名称。

## 数据与调用流

1. `DwsChannelAdapter.start` 解析当前 profile 用户名。
2. 实时、backfill、self poll 得到 `NormalizedEvent` 后调用统一唤醒词策略。
3. 普通订阅模式原样返回事件；`wake-word` 不匹配返回 `null`；匹配返回保留原 fingerprint/messageId、仅替换 content 的事件。
4. Host 只看到准入后的事件，沿用 Conversation 解析、inbox 去重、Worker signal 与固定 session resume。

## View 与配置

- Channel 页面群聊/私聊订阅枚举显示 `wake-word`。
- Channel 页面新增“唤醒词”文本设置；保存后重启该 Instance Host，使实时 consumer、补拉和 View 显示使用同一配置快照。
- README、示例配置和 CHANGELOG 同步说明。

## 验证

- 配置兼容：新配置默认、旧配置回填、空值和超长值拒绝。
- 纯函数：本人前缀匹配、他人消息、前导空格、空指令、群聊/私聊分别受各自模式控制。
- DWS 三入口：实时、backfill、self poll 均应用同一策略；`wake-word` 仍订阅对应事件 key。
- Host：匹配事件可按 `all` 建档，非匹配事件不会进入 Host。
- View：枚举可切换到 `wake-word`，唤醒词可编辑、持久化并触发 Host 重启。
- 全量 `npm run verify`。
