# Changelog

本项目的显著变化记录在此文件中，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### Added

- 新增 Host 持有 session 的 Conversation 人工消息邮箱：状态区分 `canSteer/canStartTurn/canSend`，活动时安全 `turn/steer`，空闲时在固定原 thread 上 `turn/start`；两条路径共用 request ID 幂等、TTL、expected ID 校验和明确终态，并返回实际 turn ID。
- Codex Runtime 改为每个 Host 实例托管一个回环 WebSocket App Server；全部 Conversation 使用独立连接共享同一进程，并在 `status/view` 发布 `ws://127.0.0.1:<port>`、App Server instance ID 和 PID，供本机诊断和 Host 管理连接生命周期。
- 新增 durable 任务续接入口 `conversation continue-task`：按完整父 provider session 原子准入，支持稳定 continuation ID 幂等重试，并固定在当前活动 turn 之后另开下一 turn，避免任务控制事件误入 `steer`。
- Channel 新增独立唤醒词模式开关，作为群聊与私聊常规订阅策略未准入时的统一兜底；已订阅消息保持原逻辑且不会重复处理，兜底仅接收本人以唤醒词开头的真人消息。
- 唤醒词模式支持钉钉资料页自聊窗口：每轮按当前 DWS profile 的 `userId` 查询一次自聊历史，命中后自动建立固定私聊 Conversation，并使用独立持久化水位及 inbox 去重。

### Fixed

- 修复群聊消息信封机械要求把 `<@ID>` 占位符写入可见正文的问题；现在明确使用可见的 `@姓名`，并将 `openDingTalkId` 单独传给 DWS 结构化 @ 参数，避免群内显示纯文本占位符。

## [1.2.1] - 2026-08-10

### Fixed

- 修复新消息到达时活动 turn 恰好结束、`steer` 失败后 Worker 被永久封死的问题；未引导成功的消息会保留在 inbox，并自动补送到下一 turn。

## [1.2.0] - 2026-08-10

### Changed

- 移除 Host 启动时为 Codex 桌面端自动预建、恢复和命名全部会话的逻辑；固定 session 改回仅在消息触发 Worker 时创建或恢复。
- 群聊实时消息向 Agent 提供发送者 ID，并明确要求使用 Channel 的实际 `@` 能力，避免回复中的 `@姓名` 只是纯文字。
- Conversation 的 `i` 真人介入页移除固定 Codex session 的历史读取和执行记录渲染，仅保留可持续发送、追加引导的多行输入框。
- 将职责周期提醒(turn)默认间隔由 5 次调整为 15 次（0–99 可配置，0 关闭周期提醒）。
- 调整 `Worker` 默认保温时间为 5 分钟（300 秒）；未显式设置的会话将按新默认值初始化。
- 对 DWS 机器人短占位消息按 `messageId` 有界回查稳定正文，避免 Agent 只收到“处理中/进行中”等中间状态。
- Conversation 详情头部不再重复展开完整会话职责，职责仍在下方设置表中展示和编辑。

### Added

- Conversation 详情页新增本地消息输入，可将本人在 View 中输入的多行内容直接投递给该会话的固定 Agent session，无需经过钉钉消息订阅。
- 群聊和私聊实时订阅之外新增本人消息定时补拉：每轮串行扫描已启用会话，并给实时订阅预留 5 秒优先准入窗口；历史结果只保留当前用户发送的消息，按消息 ID 去重后直接写入原会话 inbox。扫描水位按会话持久化，失败不推进，整轮完成后再等待 5 秒，避免查询重叠。

### Fixed

- 修复 Agent 回复群消息时缺少发送者 `openDingTalkId` 与 DWS 结构化 @ 指引、只能输出 `@姓名` 纯文字的问题。
- 修复会话职责等多行编辑内容含显式换行时，光标落在较短行末尾后继续按上下键会卡在原行的问题，并兼容 LF 与 CRLF 换行。

## [1.1.0] - 2026-08-05

### Added

- 新增 `agent-channel update`，可通过 npm 更新到 registry 最新版本并回读安装版本。
- Conversation 新增职责周期提醒间隔，范围 0–99，默认 5；0 表示关闭按 turn 数量触发的周期提醒。
- 新增本变更日志，后续发布持续维护版本区段。

### Changed

- Node.js、DWS 与 Codex CLI 使用最低版本门禁，高于基线的版本不再被误拒绝。
- 新绑定或重新启用群聊会立即加载最近 50 条消息，无需等待群内新消息。

### Fixed

- Conversation 在 Codex 版本、协议、cwd 或 Host 恢复变化后仍固定恢复原 provider session，不再自动轮换。
- Host 启动后会补拉离线期间的群聊和私聊消息。

## [1.0.0] - 2026-08-04

### Added

- 首次发布 `@zzusp/agent-channel-host`，提供 DingTalk DWS Channel、每会话固定 Codex session、持久化 inbox、按需 Worker 和交互式管理 View。

[Unreleased]: https://github.com/HiQ-AI/agent-channel-host/compare/v1.2.1...HEAD
[1.2.1]: https://github.com/HiQ-AI/agent-channel-host/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/HiQ-AI/agent-channel-host/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/HiQ-AI/agent-channel-host/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/HiQ-AI/agent-channel-host/releases/tag/v1.0.0
