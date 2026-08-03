# Round 6：分层总览、订阅策略与删除生命周期

## 结论

全局总览已收敛为 Instance 索引、跨实例消息汇总和全局告警；Channel、最近消息、Conversation、Runtime 及局部告警统一下钻到 Instance。Channel 可分别配置群聊/私聊 `none/selected/all`，策略只作用于唯一事件流的 durable admission，不新增 receiver。Instance 与 Conversation 删除均需二次确认，并对 attached Host fail closed。

本轮 `matrix.csv` 共 54 项，`round_6=PASS` 54 项，最终 `status=PASS` 54 项。验证只使用隔离状态、合成事件和伪造群搜索；未连接真实 DWS、未发送消息、未安装或删除真实 Windows 计划任务。

## 实现证据

- `src/config.ts`：version 2 配置增加 `channel.subscriptions.groups/directs`，合法值为 `none/selected/all`；旧配置缺字段时保持 `selected/selected`。
- `src/host.ts`：Channel adapter 数量不变；事件在 Host 准入点解析策略。`all` 对未知会话按 `identity.role + shadow + 当前 runtime` 自动建档，显式 disabled 继续拒绝。
- `src/store.ts`：Conversation 可修改 title/enabled；删除事务清理 `conversation:<id>` lease 和主记录，既有外键级联 Session、消息、Decision、Outbox、Worker、Context、Member、onboarding；recovery 文件先移入删除暂存名，事务失败恢复，成功后清除。
- `src/instance.ts`：管理删除先检查 attached 状态，再以短期 host lease 封住“停止后外部 Host 抢占”竞态。View-owned Conversation 执行 stop/delete/restart；Instance 执行 stop、计划任务清理、Store close 和精确目录删除。
- `src/view.ts`：总览不再渲染对象明细表；Instance 增加 RECENT MESSAGES。Channel 页显示独立群聊/私聊策略和两类指定绑定；Conversation 详情支持 `e/s` 修改、`d` 删除；Instance 与 Conversation 使用独立删除确认态。
- `src/service.ts`：Instance 删除只在 Windows 查询到同名用户任务后执行 End/Delete；任务查询权限等未知错误不会伪装成“不存在”。
- `README.md`、`SECURITY.md`、`examples/triss-config.yaml`：同步订阅范围、`all` 的数据边界、分层总览、修改/删除和 provider rollout 保留边界。

## 自动化验证

命令：

```powershell
npm test
npm run verify
git diff --check
```

结果：

- TypeScript build PASS；
- Node tests 64/64 PASS；
- `@hiq-ai/agent-channel-host@0.5.0` pack dry-run PASS，共 72 files；
- Config 兼容、三种订阅策略、group/direct 隔离、all 自动建档和 disabled override PASS；
- attached fail-closed、停止后 host lease 竞态、View-owned stop/delete/restart、Instance 精确目录删除 PASS；
- Conversation 关联表、Worker lease 与 recovery 清理 PASS；
- reducer/renderer 的总览分层、两类绑定、修改、删除确认/取消 PASS；
- 既有 runtime、outbox freshness、compaction recovery、DWS consumer 和 terminal 用例无回归。

## 真实 Windows TTY smoke

脚本：`scripts/tui-terminal-smoke.mjs`。

隔离状态根：`D:\baibu-agent\scratchpad\agent-channel-view-sg3i-20260803-1154`。

独立回读 `result.json`：

```json
{
  "ok": true,
  "tty": { "stdin": true, "stdout": true },
  "observed": [
    "lean-global-overview",
    "instance-detail",
    "channel-detail",
    "channel-toggle",
    "group-subscription",
    "direct-subscription",
    "group-search",
    "group-bind",
    "conversation-detail",
    "delete-confirmation",
    "delete-cancel",
    "instance-settings",
    "cursor-edit",
    "instance-create",
    "global-settings",
    "left-right-navigation",
    "alternate-screen",
    "exit-confirmation",
    "exit-cancel",
    "exit"
  ],
  "subscriptionsObserved": true,
  "deleteConfirmationObserved": true,
  "channelStarted": false
}
```

首帧断言不包含独立的 CHANNELS/CONVERSATIONS/RUNTIMES 标题和具体会话名称；下钻后可见对应对象。群聊与私聊策略均从 selected 切换为 all 并原子回读；删除确认以 Esc 取消，Conversation 保持存在。脚本捕获真实 TTY/raw mode、语义 ANSI、成对 alternate screen 和退出确认/取消。

## 独立 CLI 回读

对同一隔离状态根执行实际 `node dist/src/cli.js view --once`：

- 三个 Instance 的全局快照为 832 UTF-8 bytes；
- 无 ANSI；
- 无独立 CHANNELS、CONVERSATIONS、RUNTIMES 全局段；
- 仍保留 Instance 行的 Channel/Conversation/pending/alert 汇总；
- 未启动 Host 或 Channel。

## 边界

- `all` 自动建档只由合成事件验证；真实 DWS flatten 事件是否稳定携带群标题仍需 SG1 canary。标题缺失时使用外部 ID 的不可逆短摘要，不显示原值。
- 指定私聊仍要求可信 `openDingTalkId`；未发现可验证的按姓名稳定解析契约，因此本轮不伪造私聊搜索。
- Windows 计划任务删除路径只做代码与无副作用 plan 单测；本轮没有安装、查询或删除真实用户任务。
- Host 侧 Conversation 删除不等于删除 Codex 用户目录中的 provider rollout；README 和 SECURITY 已明确保留边界。
