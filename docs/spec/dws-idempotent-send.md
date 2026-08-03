# DWS 幂等发送终态修复

## 症状与根因

Host 使用稳定 UUID 重试发送。DWS 已登记该 UUID 时以非零退出返回结构化 JSON，错误正文包含 `Request is repeated with uuid`。旧实现让 `execFile` 的原始异常直接上抛，因此同时产生两个问题：

1. 已被服务端登记的幂等请求被误记为 `failed`，重启后持续用同一 UUID 重试；但重复错误本身也不能证明本轮内容已经成功提交；
2. 原始异常包含完整 `--text`、目标 ID、UUID 和 JSON，进入 SQLite 与 TUI ALERTS 后泄露正文并破坏固定窗口布局。

## 修复

- `execResolved` 在非零退出时保留回调取得的 stdout/stderr；`runDwsJson` 再从中读取完整结构化 JSON，转换成不含命令参数和消息正文的 `DwsCommandError`。
- 仅当结构化错误同时满足 `reason=business_error`、`server_error_code=1001` 且消息明确为同 UUID 重复时，`DwsSender` 抛出专用的发送结果不明错误。
- Host 保存 `delivery_unknown` 并保留告警；该状态不自动重试。只有 DWS 本次明确成功才保存 `submitted`。UUID 保持不变，不追加第二次发送。
- onboarding UUID 同时绑定会话身份和实际回复文本，重新建档后若 Agent 产生不同回复，不会与历史回复共用一个只绑定群身份的 UUID。
- 其他 DWS 错误继续 fail-closed。
- TUI ALERTS 对遗留原始异常做单行摘要和终端宽度截断，使旧数据库在 reconciliation 前也不展示正文或撑破窗口。

## 验证

- 单元测试覆盖非零退出 JSON、重复 UUID、其他业务错误和遗留长 ALERTS。
- 全量执行 `npm run verify`。
- 真实 Instance 只在唯一 Host 停止后将误记状态精确纠正为 `delivery_unknown`；不得启动第二个 Host。重启后回查 onboarding 不被自动重试、告警保留、Channel/session ready，并且不据此声称 submitted 或 delivered。

## 显式协调与首次历史可观测性

- 首次历史不伪装成实时 `inbound_events`；状态快照单独统计 `history_loaded/history_judged`，会话行展示 onboarding 状态。
- 生命周期拆分为 `completed`（已判断且静默）、`submitted`（DWS 明确接受调用）、`delivered`（群历史精确回读命中）和 `delivery_unknown`（结果不明、禁止自动重试）。
- `delivery --check` 只读打开 SQLite，并在仅规范化 Unicode 兼容形式和平台空白折叠后匹配已准备回复；不迁移数据库、不改状态、不发送。
- `delivery --apply` 要求 Host lease 已停止、显式 `--yes` 与备份目录。它在备份前回查一次，备份后再核对状态；已可见则只标记 delivered，仍不可见才生成绑定上一 UUID、目标和正文的新 UUID，单次发送并再次回读。
- apply 的任何发送异常都回到 `delivery_unknown`；DWS 明确成功但有界回读暂未可见时保留 `submitted`，不得冒充 delivered。
