# Round 1：压缩恢复与管理型 View

## 结论

`matrix.csv` 的 17 项用例全部 PASS。实现和验证均未连接 DWS、未启动 Channel owner、未发送钉钉消息。

## 自动化验证

命令：

```powershell
npm run verify
git diff --check
```

结果：

- TypeScript build 通过；
- Node test 41/41 PASS；
- `npm pack --dry-run` 通过，产物为 `@hiq-ai/agent-channel-host@0.4.0`，共 69 个文件；
- `git diff --check` 无输出。

覆盖证据：

- Store v1/v2/v3 到 v5 migration、checkpoint 与 batch decision 同事务提交；
- 成员观察/手工资料版本化及相关成员匹配；
- 新 session 恢复 checkpoint、普通 resume 不重复恢复；
- `SessionStart(source=compact)` hook 只返回当前 recovery context；
- 可嵌入 Host 可由 AbortSignal 停止，第二 owner 不覆盖运行状态；
- 总览/详情/设置 renderer、输入状态机、原子配置保存、conversation/member 设置；
- `view --once` 只读，非 TTY 持续模式 fail-fast。

## 真实 Codex canary

隔离状态根：`D:\baibu-agent\scratchpad\agent-channel-context-view-canary-20260802-235657`。

连续两次执行 `agent-channel verify`：

| 轮次 | startupMode | provider session 前缀 | action |
|---|---|---|---|
| 1 | `new` | `019fc331-6c7` | `silent` |
| 2 | `resumed` | `019fc331-6c7` | `silent` |

固定 Codex CLI 0.145.0 成功解析 Host 内联的 compaction hook 配置；两轮精确恢复同一 provider session。`view --once` 随后显示 Host/Channel 均为 stopped，证明 canary 没有启动消息订阅。

## 真实终端 smoke

脚本：`scripts/tui-terminal-smoke.mjs`。

隔离状态根：`D:\baibu-agent\scratchpad\agent-channel-tui-smoke-20260803-000734`。

`result.json` 回读：

```json
{
  "ok": true,
  "tty": { "stdin": true, "stdout": true },
  "observed": ["overview", "settings", "editing", "exit"],
  "channelStarted": false
}
```

详情 Enter/Esc 状态链由同轮新增的 `management view 按键可从总览进入详情并切换设置编辑` 测试独立验证。终端 smoke 使用两个合成 Channel 和两个合成 Runtime，只验证真实 TTY/raw mode/ANSI paint/设置/退出，不连接外部服务。

## 边界

- 未执行真实 DWS 收发；本轮不改变既有钉钉 canary 授权边界。
- 未安装 service，未发布 npm package，未部署 Host。
- Claude/Gemini/Qwen 仍只是 RuntimeAdapter 扩展边界，本轮没有伪装成已实现。
