# Round 8：会话默认模式、姓名展示与决策错误隔离

## 结论

Channel 的准入范围和新 Conversation 的发言模式已经拆开：群聊、私聊各自拥有 `none/selected/all` 订阅范围和 `shadow/reply` 默认模式。默认模式只用于之后自动建档或 CLI 未显式指定 mode 的新 Conversation，不改写已有 Conversation。

用户现场的 `实施类决策必须真实派发后台 subagent` 是误报：目标 Codex turn 已完成 `spawn_agent`，但工具完成记录只有调用标识/任务名、没有 child thread ID；旧校验只认 thread ID。现在成功完成的派发调用本身就是证据，thread ID 仅作为 runtime 可选关联信息。即使某一 Conversation 的决策仍不合法，也只将该 batch 标为 failed 并禁止出站，不再终止共享 Channel owner。

`matrix.csv` 共 67 项，`round_8=PASS` 67 项，最终 `status=PASS` 67 项。

## 行为修正

- `config.yaml` 新增 `channel.defaultModes.groups/directs`，旧 version 2 配置缺省时均为 `shadow`。
- `all` 自动建档、群搜索绑定和 `conversation add` 省略 `--mode` 时分别读取群聊/私聊默认模式；已有 Conversation mode 保持不变。
- Channel 页显示“群聊默认模式”和“私聊默认模式”，Enter 在固定候选中选择；Conversation mode 和 runtime effort 同样不进入文本编辑。
- 群聊优先使用事件群名；私聊优先使用人员姓名。无姓名时使用不泄露原始 ID 的稳定摘要，不再显示“未命名私聊”。既有匿名私聊若成员表已经有姓名，View 只读派生显示姓名，不修改原始标题；手工标题不被覆盖。
- Codex JSONL collector 只记录 `item.completed + collab_tool_call + spawn_agent + status=completed` 的调用证据；`status=failed` 不计入，child thread ID 可缺省。该判据与固定版本 Codex 0.145.0 的 [exec JSONL 类型定义](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/exec/src/exec_events.rs) 一致。
- 决策校验失败保持 fail-closed：当前 batch 记 failed、无 outbox；Worker 保持可用，后续消息仍由同一 Channel 处理。

## 自动化验证

执行：

```powershell
npm run verify
```

结果：

- TypeScript build PASS；
- Node tests 68/68 PASS；
- `@hiq-ai/agent-channel-host@0.6.0` pack dry-run PASS，共 75 files；
- CLI 隔离用例证明省略 `--mode` 时从 `shadow` 默认切换到已配置的私聊 `reply` 默认；
- JSONL 回归证明成功 `spawn_agent` 可无 child thread ID、失败调用不会冒充成功，`wait` 会被识别并拒绝实施类即时回执；
- 调度器回归证明首轮决策失败时 Host fatal 回调为 0，第二条消息仍在同一 runtime session 完成；
- 姓名回归证明 status、Conversation 详情和 Channel DIRECTS 均显示已持久化姓名，同时数据库中的生成标题未被 View 改写；
- `git diff --check` PASS。

## 真实 PowerShell TTY

脚本：`scripts/tui-terminal-smoke.mjs`。

隔离状态根：`D:\baibu-agent\scratchpad\agent-channel-default-modes-tty-20260803134357`。

真实 TTY/raw mode 结果：

```json
{
  "ok": true,
  "tty": { "stdin": true, "stdout": true },
  "subscriptionsObserved": true,
  "defaultModesObserved": true,
  "groupBound": true,
  "channelStarted": false
}
```

同一流程还回归了语义颜色、固定窗口、左右下钻/返回、光标编辑、Instance 新增/删除、删除即时刷新和退出二次确认。

## 边界

- 使用隔离状态目录和合成 Channel 候选；没有连接 DWS、搜索真实群、发送钉钉消息或启动真实 Channel owner。
- 没有修改默认用户 Instance、真实 Windows 计划任务或外部安装目录。
- 没有部署、发布 npm 或执行真实消息重试；既有 failed batch 仍保留为失败证据，不自动重放。
