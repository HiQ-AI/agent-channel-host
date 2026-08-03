# Round 4：Instance 下钻、Channel 启停与 TUI 新增

## 结论

顶层导航已收敛为 `总览 | 全局设置`。`INSTANCES` 是总览内的管理表：选择后先进入 Instance 详情，再按 `s` 进入该 Instance 的设置；Instance 设置不再伪装成全局设置。总览的末行和快捷键 `a` 都可启动新增向导。

每个 Instance 设置页从统一 Channel 配置列表生成启停项。当前 DingTalk 支持 `enabled/disabled` 原子持久化；禁用后 Host 不创建 DWS adapter，也不获取 DWS profile owner。TUI 创建复用 CLI `init` 的共享入口，并默认禁用 DingTalk，防止未确认 profile 时抢占既有 owner。

Round 4 后 `matrix.csv` 的 32 项全部 PASS。本轮未连接 DWS、未启动真实 Channel owner、未发送钉钉消息。

## 自动化验证

命令：

```powershell
npm run verify
git diff --check
```

结果：

- TypeScript build 通过；
- Node test 52/52 PASS；
- `npm pack --dry-run` 通过，产物包含 72 个文件；
- 既有 version 2 YAML 缺少 `channel.enabled` 时仍解析为 `true`；
- SQLite v5 → v6 迁移保留旧 Channel 状态并允许 `disabled`；
- disabled Host 实跑确认 Channel `start/stop=0`、owner `acquire/release=0`；
- 共享初始化入口实跑确认 config、SQLite 状态和重复创建 fail closed；
- reducer/renderer 覆盖总览下钻、独立全局设置、Channel toggle、原子落盘和 TUI 创建。

实现过程中回归曾直接暴露旧 `channel_connections.state` CHECK 不接受 `disabled`；没有绕过该错误，而是新增 v6 表迁移和旧记录保留测试后重新全量验证。

## 真实 Windows TTY smoke

脚本：`scripts/tui-terminal-smoke.mjs`。

隔离状态根：`D:\baibu-agent\scratchpad\agent-channel-instance-settings-20260803-095545`。

独立回读 `result.json`：

```json
{
  "ok": true,
  "tty": { "stdin": true, "stdout": true },
  "observed": [
    "global-overview",
    "instance-detail",
    "conversation-detail",
    "instances-index",
    "instance-settings",
    "instance-create",
    "channel-toggle",
    "global-settings",
    "exit"
  ],
  "colorObserved": true,
  "settingsColumnsDelimited": true,
  "instanceCreated": true,
  "channelToggleObserved": true,
  "globalSettingsSeparated": true,
  "channelStarted": false
}
```

真实 PowerShell TTY/raw mode 完成两个既有 Instance 的下钻、Instance 设置、TUI 创建 `created-agent`、在新 Instance 设置中启用 DingTalk、切换独立全局设置页和退出。该脚本注入的是合成生命周期回执，不运行 Host 或 Channel。

## 独立落盘与纯文本回读

对同一隔离状态根执行实际 `node dist/src/cli.js view --once` 并回读文件：

- `instances/` 下存在 3 个 Instance；
- `created-agent/config.yaml` 为 512 bytes，最终 `enabled: true`，证明先按安全默认创建再经 TUI toggle 持久化；
- `view --once` 同时展示三个 Instance，且不含 ESC/ANSI；
- `result.json` 为 474 bytes。

## 边界

- 当前真正注册的 Channel 仍只有 DingTalk；View 从统一列表渲染，未来 adapter 不复制专用页面。
- 全局设置当前没有已确认的持久化参数，因此只展示真实跨 Instance 管理状态和“暂无可修改项”，没有凭空增加配置。
- View 只会重启自己启动的目标 Instance Host；attached 外部 Host 只保存配置并明确提示重启，不越权停止。
- 本轮没有真实 DWS 收发、真实 Channel owner、服务安装或部署。
