# 真人介入控制台

> 状态：历史执行记录展示已移除；当前行为以 README 的真人介入输入页说明为准。本文件保留为原始方案快照。

## 目标

将 Conversation 详情按 `i` 打开的页面从一次性多行编辑器改为真人介入控制台：进入即显示固定 Codex session 的历史执行记录，停留期间持续刷新；上方展示关键执行过程，下方保留多行输入框，发送后不退出，允许继续介入当前活动 turn。

## 现状与根因

- `src/view.ts` 当前复用通用 `editing` 面板，页面只渲染输入内容；发送成功后将 `state.editing` 设为 `null`，立即返回 Conversation 详情。
- `CodexAppServerSession` 只消费 `turn/started` 和 `turn/completed`，其他 reasoning、正文和工具通知不进入 View。
- 固定 provider session 的完整既有记录已经由 Codex 写入 `~/.codex/sessions/**/rollout-*.jsonl`。ScrumWS 已验证该记录可稳定映射 `user_message`、`agent_message`、`agent_reasoning`、工具调用和工具结果；Claude Code Session 的展示也采用正文直显、思考弱化、工具与结果配对的层次。

## 方案

1. 新增只读 Codex transcript 适配器：按 Store 中的完整 provider session ID 定位最新 rollout，使用文件大小和 mtime 缓存解析结果。
2. 只保留对真人有用的 settled 事件：用户内容、Agent 正文、reasoning 摘要，以及已配对的工具调用/结果。忽略 token、delta、协议握手、usage 等噪声；长内容有界截断。
3. `i` 页面采用上下布局：上方为时间线视口，下方为始终可编辑的输入框。`PageUp/PageDown` 浏览历史，`Enter` 发送，`Shift+Enter` 换行，`Esc` 返回详情。
4. 发送成功后清空输入但保持页面打开。View 原有定时刷新会按 rollout revision 读取新增 settled 事件；若消息进入活动 turn，现有 `turn/steer` 路径不变。

## 边界与取舍

- 不在 Host 中新增第二份 transcript 数据库：Codex rollout 是既有历史事实源，避免双写和迁移；适配器隔离 provider-specific 解析。
- 不展示逐 token delta 或完整工具输出，避免页面抖动和信息淹没；只展示关键摘要，必要内容保留有界正文。
- 尚未创建 provider session、rollout 暂未落盘或运行时不是 Codex 时显示明确空态，不伪造历史。
- 本次不改变 Conversation、Worker、固定 session、消息 inbox 和 steer 语义。

## 验证

- parser fixture 覆盖历史正文、reasoning、工具调用/结果配对、未知/非法行忽略和内容截断。
- View 测试覆盖进入即展示历史、上下布局、PageUp/PageDown、发送后留页并清空输入、Shift+Enter 换行及 Esc 返回。
- 完整执行 `npm run verify` 和 `git diff --check`。
