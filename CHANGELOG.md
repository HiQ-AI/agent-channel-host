# Changelog

本项目的显著变化记录在此文件中，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### Changed

- Conversation 的 `i` 真人介入页移除固定 Codex session 的历史读取和执行记录渲染，仅保留可持续发送、追加引导的多行输入框。
- 将职责周期提醒(turn)默认间隔由 5 次调整为 15 次（0–99 可配置，0 关闭周期提醒）。
- 调整 `Worker` 默认保温时间为 5 分钟（300 秒）；未显式设置的会话将按新默认值初始化。
- 对 DWS 机器人短占位消息按 `messageId` 有界回查稳定正文，避免 Agent 只收到“处理中/进行中”等中间状态。
- Conversation 详情头部不再重复展开完整会话职责，职责仍在下方设置表中展示和编辑。

### Added

- Conversation 详情页新增本地消息输入，可将本人在 View 中输入的多行内容直接投递给该会话的固定 Agent session，无需经过钉钉消息订阅。

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

[Unreleased]: https://github.com/HiQ-AI/agent-channel-host/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/HiQ-AI/agent-channel-host/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/HiQ-AI/agent-channel-host/releases/tag/v1.0.0
