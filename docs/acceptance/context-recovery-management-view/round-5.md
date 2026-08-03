# Round 5：Channel 群绑定、层级导航与固定终端窗口

## 结论

用户指出的五个可用性缺口已闭环：Channel 开关现在位于可下钻的独立 Channel 页；群组可按关键词搜索并从候选列表绑定；`→` 下钻、`←` 返回；交互 View 使用 alternate screen，不再把刷新帧写入主终端历史；设置、群搜索和 Instance 向导支持移动文本光标和中间编辑。

Round 5 后 `matrix.csv` 共 39 项，`round_5=PASS` 39 项，最终 `status=PASS` 39 项。本轮未连接真实 DWS、未搜索真实群、未启动 Channel owner、未发送消息。

## 根因与实现

- `src/view.ts` 原先只让 Conversation 可选择，Channel toggle 被埋在 Instance 设置长列表；现在 Instance 详情把 Channel 与 Conversation 作为统一的层级选择对象，并新增 Channel 状态、已绑定群和“搜索并绑定群组”页。
- View 通过中立 `searchGroups(instance, query)` action 获取候选；`src/cli.ts` 的 DingTalk composition root 才映射到 DWS，View reducer 不依赖 DWS 字段。
- `src/dws.ts` 新增群搜索投影和去重；只保留 title 与 openConversationId，后者只在内存绑定时使用，不渲染。
- 选择候选复用 `Store.addConversation`，默认职责继承 `identity.role`、模式为 `shadow`、runtime 使用当前 Instance；没有新数据库或第二套 listener。
- 非编辑态 `Enter/→` 下钻或执行、`Esc/←` 返回；Tab 只在顶层切换。编辑态以 code point 保存 cursor，支持左右、Home/End、Backspace/Delete。
- `runView` 进入 `CSI ?1049h` alternate screen 并隐藏光标，`finally` 成对恢复光标和主屏；定时渲染异常也先结束 View，再走恢复路径。`--once` 不进入该生命周期。

交互参考 Claude Code agent view 的主列表、`Enter/→` 进入和 `←` 返回，但业务层级保持 `Instance → Channel → 群组/Conversation`。

## 自动化验证

命令：

```powershell
npm run verify
git diff --check
```

结果：

- TypeScript build PASS；
- Node tests 56/56 PASS；
- npm 0.4.0 pack dry-run PASS，共 72 files，tarball 103.0 kB；
- DWS 合成返回的无效项和重复 openConversationId 被过滤；
- reducer/renderer 覆盖 Channel 下钻/toggle、群搜索/绑定/重复打开、外部 ID 隐藏、左右层级导航和三类文本光标编辑；
- 既有 Host、Store、runtime session、outbox、compaction recovery 与 service 用例无回归；
- CSV 独立回读：39 cases，39 round-5 PASS，39 final PASS，0 non-PASS。

## 真实 Windows TTY smoke

脚本：`scripts/tui-terminal-smoke.mjs`。

隔离状态根：`D:\baibu-agent\scratchpad\agent-channel-view-sg3h-20260803-104816`。

独立回读 `result.json`：

```json
{
  "ok": true,
  "tty": { "stdin": true, "stdout": true },
  "observed": [
    "global-overview",
    "instance-detail",
    "channel-detail",
    "channel-toggle",
    "group-search",
    "group-bind",
    "conversation-detail",
    "instance-settings",
    "cursor-edit",
    "instance-create",
    "global-settings",
    "left-right-navigation",
    "alternate-screen",
    "exit"
  ],
  "channelToggleObserved": true,
  "groupSearchObserved": true,
  "groupBound": true,
  "alternateScreenObserved": true,
  "cursorEditObserved": true,
  "channelStarted": false
}
```

脚本在真实 PowerShell TTY/raw mode 注入合成搜索结果，实际捕获成对 `?1049h/?1049l` 和光标隐藏/恢复序列。字段编辑把 `小小鹏` 通过 Home、Right、中间插入和 End 改为 `小·小鹏` 并原子保存。

## 独立 CLI 回读

对同一隔离状态根执行实际 `node dist/src/cli.js view --once` 和 `conversation list`：

- `view-once.txt` 为 2353 bytes，包含三个 Instance；
- 无 ESC/ANSI，未出现合成 `externalId`；
- 配置文件回读 `name: 小·小鹏`；
- 搜索选择只产生 1 条“合成搜索结果群”绑定；
- 绑定职责为“编辑器需求、方案与 bug 排查答疑”，mode 为 `shadow`。

## 边界

- 自动化和 TTY 都只使用合成群名与合成外部 ID；没有调用真实 `dws chat search`。
- 群绑定只修改隔离 SQLite allowlist，不发送 onboarding 或普通消息。
- 当前实际 Channel adapter 仍只有 DingTalk；View action 和页面层级允许后续 adapter 注入各自搜索实现，但本轮不宣称第二种 Channel 已完成。
- 没有 schema migration、服务安装、部署或 npm 发布。
