# Round 3：View 视觉层次与 Settings 分栏

## 结论

交互式 `agent-channel view` 已用克制的语义颜色突出标题、当前选中项、正常/等待/停止/异常状态和告警。ANSI 仅在 TTY 且未设置 `NO_COLOR` 时启用；表格先按纯文本完成宽度、截断和左对齐，再添加颜色，因此不会破坏列宽。

Settings 的 `SETTING │ VALUE │ EFFECT` 三列改用显式竖线和交叉分隔线，列内容保持左对齐。`view --once`、非 TTY 和 `NO_COLOR` 继续输出无 ANSI 的纯文本。

`matrix.csv` 的 26 项最终状态全部 PASS。本轮未连接 DWS、未启动真实 Channel owner、未发送钉钉消息。

## 自动化验证

命令：

```powershell
npm run verify
git diff --check
```

结果：

- TypeScript build 通过；
- Node test 46/46 PASS；
- `npm pack --dry-run` 通过，产物仍为 69 个文件；
- 新增测试覆盖 ANSI 语义颜色、着色前后纯文本等价、`NO_COLOR`、非 TTY、`TERM=dumb`、`view --once` 无 ANSI，以及 Settings 分隔符/左对齐。

## 真实终端 smoke

脚本：`scripts/tui-terminal-smoke.mjs`。

隔离状态根：`D:\baibu-agent\scratchpad\agent-channel-view-polish-20260803-011320`。

独立回读 `result.json`：

```json
{
  "ok": true,
  "tty": { "stdin": true, "stdout": true },
  "observed": [
    "global-overview",
    "instance-detail",
    "conversation-detail",
    "settings",
    "instance-switch",
    "editing",
    "exit"
  ],
  "colorObserved": true,
  "settingsColumnsDelimited": true,
  "channelStarted": false
}
```

smoke 在真实 PowerShell TTY/raw mode 中完成跨 instance 总览、实例/会话下钻、Settings 切换、编辑和退出，并从实际终端 transcript 断言 ANSI 与 `│`/`┼` 分隔符存在。

## 纯文本 CLI smoke

隔离状态根：`D:\baibu-agent\scratchpad\agent-channel-once-20260803-011412`。

初始化合成 instance 后执行实际 `node dist/src/cli.js view --once`，独立断言：

- 输出包含 `once-check`；
- 输出不包含 ESC/ANSI 字符；
- 未启动 Host 或 Channel。

## 边界

- 颜色只属于交互展示层，不进入状态 DTO、日志、管道或机器接口。
- 本轮没有改变 Host 生命周期、Channel/Runtime contract、消息处理或出站逻辑。
- 本轮没有执行真实 DWS 收发，也没有把合成终端输出计为钉钉 E2E。
