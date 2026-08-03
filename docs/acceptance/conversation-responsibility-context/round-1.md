# Round 1：会话职责周期提醒

## 结论

10/10 用例通过。Instance 已删除默认角色和回复签名，Agent 名称只用于本地展示；Conversation 职责改为首轮、变更后首轮及每 5 个已完成 turn 的短提醒。其他 turn 仍只转发新增消息。实现不安装 compaction hook，不覆盖 runtime 的 developer/system 指令，也不连接 DWS。

## 自动化与打包

```powershell
npm run verify
```

- 82/82 tests PASS。
- `@hiq-ai/agent-channel-host@0.9.0` pack dry-run PASS。
- tarball 69 files。
- 周期用例验证提醒出现在第 1、6 turn；第 2-5 turn 不含职责；职责变更后的下一 turn 立即提醒；失败不推进计数；空职责不提醒。
- CLI 隔离回查：`--version=0.9.0`，`init --help` 不含 `--role`，规范化 `config.yaml` 不含 `role/signature`，`view --once` 显示 Instance 与本地 Agent 名称。

## 真实 Codex canary

```powershell
node docs/acceptance/conversation-responsibility-context/scripts/codex-responsibility-reminder-canary.mjs <empty-state-directory>
```

回读：

- runtime `codex-cli 0.145.0`，`gpt-5.6-sol / low`；
- 52 秒完成 3 个真实 turn；
- 首轮新建 provider session 并注入职责提醒；
- 第二轮不重复职责提醒，仍由同一 session 按既有职责返回预期结果；
- 修改 Conversation 职责后，下一轮立即按新职责返回预期结果；
- 三轮 provider session ID 一致，职责变更没有创建新 session；
- 未启动 DWS consumer，未发送钉钉消息。

## 隔离边界

- 验证状态只写入 `D:\baibu-agent\scratchpad\`。
- 既有 PID 18132 Host 与其唯一 foreground/ephemeral DWS 消费链在验证后仍存活；本轮未停止、重启或发送消息。
- 精确 compaction 时刻对不同 runtime 不可统一观察。本方案明确接受最多 4 个不带提醒的已完成 turn 后再次提醒，不声称压缩后的紧接一轮必然已恢复职责。
