# DWS 幂等发送终态修复

## 症状与根因

Host 使用稳定 UUID 重试发送。DWS 已登记该 UUID 时以非零退出返回结构化 JSON，错误正文包含 `Request is repeated with uuid`。旧实现让 `execFile` 的原始异常直接上抛，因此同时产生两个问题：

1. 已被服务端登记的幂等请求被误记为 `failed`，重启后持续用同一 UUID 重试；
2. 原始异常包含完整 `--text`、目标 ID、UUID 和 JSON，进入 SQLite 与 TUI ALERTS 后泄露正文并破坏固定窗口布局。

## 修复

- `execResolved` 在非零退出时保留回调取得的 stdout/stderr；`runDwsJson` 再从中读取完整结构化 JSON，转换成不含命令参数和消息正文的 `DwsCommandError`。
- 仅当结构化错误同时满足 `reason=business_error`、`server_error_code=1001` 且消息明确为同 UUID 重复时，`DwsSender` 将调用视为幂等成功。
- Host 继续保存 `submitted`，不把该状态表述为 delivered、已读或业务接受；UUID 保持不变，不追加第二次发送。
- 其他 DWS 错误继续 fail-closed。
- TUI ALERTS 对遗留原始异常做单行摘要和终端宽度截断，使旧数据库在 reconciliation 前也不展示正文或撑破窗口。

## 验证

- 单元测试覆盖非零退出 JSON、重复 UUID、其他业务错误和遗留长 ALERTS。
- 全量执行 `npm run verify`。
- 真实 Instance 只在唯一 View 重启后用原 UUID reconciliation；不得启动第二个 Host。回查 onboarding=`submitted`、alert 清零和 Channel/session ready，但不据此声称 delivered。
