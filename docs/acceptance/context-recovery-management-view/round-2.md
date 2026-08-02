# Round 2：跨 instance 上层 View

## 结论

`agent-channel view` 已从单 instance 控制台修正为全部已初始化 instance 的上层管理入口。命令不接受 `--instance`；零 instance 显示初始化引导，单/多 instance 均进入同一聚合总览。每个 instance 独立判断启动或 attach，退出只终止本次 view 启动的 Host。

`matrix.csv` 的 22 项最终状态全部 PASS。本轮未连接 DWS、未启动真实 Channel owner、未发送钉钉消息。

## 自动化验证

命令：

```powershell
npm run verify
git diff --check
```

结果：

- TypeScript build 通过；
- Node test 43/43 PASS；
- `npm pack --dry-run` 通过；
- `git diff --check` 无输出。

新增覆盖：

- instance registry 只发现含 `config.yaml` 的安全目录，结果稳定排序；
- `agent-channel view --once` 聚合两个 instance，输出 instance、Channel、消息、conversation 和 runtime；
- 空状态正常输出 `init` 引导；
- `view --instance <name>` 作为错误命令被 Commander 拒绝；
- 总览按 instance 下钻，再进入 conversation 详情；
- 设置 tab 使用 `[` / `]` 明确切换目标 instance 后再编辑；
- 非 TTY 持续模式在启动 Host 前 fail-fast。

## 隔离 CLI smoke

隔离状态根：`D:\baibu-agent\scratchpad\agent-channel-global-view-20260803-003729`。

初始化 `triss` 与 `xiaoxiaopeng` 两个合成 instance 后，直接执行：

```powershell
agent-channel view --once
agent-channel view --help
```

只读输出显示 `instances=2`，两条 instance 行及其 Channel/Runtime；`OWNER=readonly`。help 的 Usage 为 `agent-channel view [options]`，选项中不存在 `--instance`。

## 真实终端 smoke

脚本：`scripts/tui-terminal-smoke.mjs`。

隔离状态根：`D:\baibu-agent\scratchpad\agent-channel-global-tui-20260803-003747`。

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
  "channelStarted": false
}
```

smoke 使用两个合成 instance、两个 Channel 和两个 Runtime，只验证真实 TTY/raw mode/ANSI paint、跨 instance 总览、下钻、设置切换、编辑与退出，不连接外部服务。

## 边界

- 本轮没有执行真实 DWS 收发，也没有把本地合成输出计为钉钉 E2E。
- 多 instance 若配置为同一 DWS profile，既有 profile owner lock 仍会拒绝第二个 owner；View 只聚合并呈现该错误，不绕过唯一接收 owner 约束。
- `run --instance <name>`、`status --instance <name>` 和 Windows service 仍是单 instance 的 headless/机器接口。
