# 验收报告

默认 Codex 模型配置已通过 Round 1 全部用例：

- 新旧 instance 默认使用 `gpt-5.6-sol + low`。
- 初始化和后续修改均可设置模型与推理强度，非法强度在写入前拒绝。
- 每个 App Server 会话启动前读取实时 `model/list`，拒绝不存在的模型或不支持的强度。
- 真实 Codex canary 已证明默认组合能够创建 thread、执行 turn、停止后精确恢复同一 thread 并再次执行 turn。
