# Round 9：会话选择一致性、启动恢复与管理入口补齐

## 结论

Instance 详情现在以稳定 Conversation ID 维护高亮项，刷新、跨 Channel 排序或标题修改后，下钻内容仍与当前选中行一致；页面顺序调整为 `CHANNELS → CONVERSATIONS → MESSAGES → RECENT MESSAGES → RUNTIMES`。

Host 启动时一次性检查未完成工作：释放中断 claim，重新调度 admitted 与未达 3 次上限的 failed inbox，并用原 UUID 恢复未确认 outbox。completed/submitted 和达到上限的失败项不重放；发送前继续执行 mode/enabled 与最新 sequence 门禁。

Instance 设置补充 Runtime cwd；Channel 的 GROUPS/DIRECTS 行可直接进入同一 Conversation 删除确认与生命周期 action。

`matrix.csv` 共 73 项，`round_9=PASS` 73 项，最终 `status=PASS` 73 项。

## 根因与修正

- Instance 表格取 `Store.status()` 的 `channel/title` 排序，下钻却用 `listConversations()` 的 `kind/title` 排序，并以数组下标关联，导致选中项可能漂移。两条查询已统一为 `kind/title/id`，View 额外保存稳定 Conversation ID。
- 旧启动 reconciliation 只将 `claimed` 还原为 `admitted`，没有恢复 failed inbox 与未确认 outbox。SQLite schema v7 增加失败/发送次数和最后错误；恢复次数固定上限为 3。
- Worker 启动后先提交恢复 outbox，沿用已持久化 UUID；随后才处理新 batch。进程若在第 3 次发送中断，重启会将该项明确标为终止 failed，不会永久停在 sending。
- `runtime.cwd` 已存在于配置、启动参数和 session 兼容校验，但 Instance 设置漏列；现已复用同一 schema 原子保存并触发 View-owned Host 重启。
- Channel GROUPS/DIRECTS 原本只支持下钻。现在选中会话按 `d` 使用既有删除 action，attached Host 继续 fail closed。

## 自动化验证

执行：

```powershell
npm run verify
```

结果：

- TypeScript build PASS；
- Node tests 72/72 PASS；
- `@hiq-ai/agent-channel-host@0.7.0` pack dry-run PASS，共 75 files；
- Store 回归覆盖 admitted/claimed/failed/completed inbox、pending/sending/failed/submitted outbox、3 次上限与原 UUID；
- Host 物理关闭并重开 SQLite 后，failed message 在原 Conversation 重新处理；
- View 回归覆盖稳定 ID 下钻、分区顺序、Runtime cwd 校验/原子保存、GROUPS/DIRECTS 删除确认及 attached fail closed；
- `git diff --check` PASS。

## 真实 Windows TTY

脚本：`scripts/tui-terminal-smoke.mjs`。

隔离状态根：`D:\baibu-agent\scratchpad\agent-channel-recovery-tty-20260803-1438`。

结果：

```json
{
  "ok": true,
  "tty": { "stdin": true, "stdout": true },
  "conversationBeforeMessages": true,
  "runtimeCwdObserved": true,
  "channelDeleteActionObserved": true,
  "channelStarted": false
}
```

同一流程回归语义颜色、固定窗口、层级导航、枚举选择、光标编辑、群搜索绑定、Instance 新增/删除、删除即时刷新与退出二次确认。

## 边界

- 使用隔离状态目录、合成消息与合成 Channel 候选；没有连接 DWS、搜索真实群、发送钉钉消息或启动 Channel owner。
- 没有修改默认用户 Instance、本机已安装 CLI、真实 Windows 计划任务或外部安装目录。
- 启动恢复已由本地 SQLite/Host 集成测试验证；未对真实钉钉消息执行失败重放。
