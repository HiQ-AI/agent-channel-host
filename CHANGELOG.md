# Changelog

本项目的显著变化记录在此文件中，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

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

[Unreleased]: https://github.com/HiQ-AI/agent-channel-host/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/HiQ-AI/agent-channel-host/releases/tag/v1.0.0
