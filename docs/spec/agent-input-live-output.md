# 真人介入页实时输出

## 目标

移除 Conversation 固定 Codex session 的 rollout JSONL 历史读取。`i` 页面只展示当前 Worker 已通过现有 Codex App Server 连接收到的重点实时事件；Worker 不存在或保温结束后不保留记录。

## 方案

- 复用 Host 已有的 `thread/start` / `thread/resume` 连接，不创建第二个 Codex 进程，也不再次恢复 thread。
- 只收集 `turn/started`、`turn/completed` 以及已完成的 Agent 消息、思考摘要、命令、文件修改、MCP 调用和搜索等重点事件。
- 内存中最多保留 200 项，供当前 Worker 生命周期内进入 `i` 页面查看；不落盘、不读取 rollout。
- 页面明确标注“当前 Worker 实时输出”；没有 Worker 时提示发送消息后启动。

## 验证

- App Server fixture 发出 item 通知后，Session 能返回结构化活动摘要。
- View 能展示当前 Worker 输出及空闲提示，不出现固定 session 或历史记录文案。
- 删除 rollout 解析模块及其测试，执行项目完整 `npm run verify`。
