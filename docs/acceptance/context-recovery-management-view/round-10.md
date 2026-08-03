# Round 10：耗时管理操作进度反馈

## 结论

设置、Channel 策略、群搜索、Instance 创建以及 Instance/Conversation 删除现在会在第一个异步等待前立即显示“处理中”帧，并以 120ms 周期更新 spinner 和已用时。处理期间重复输入被锁定，管理动作仍在同一个 Promise 链中串行执行；完成后自动刷新最新结果，失败后清理进度态并由既有错误路径回到原页面。

进度刷新只使用最近一次成功渲染的稳定文本快照，不调用普通 renderer，也不读取 Instance、Channel 或 SQLite Store，因此不会重新引入删除期间读取已关闭 Store 的竞态。

`matrix.csv` 共 77 项，`round_10=PASS` 77 项，最终 `status=PASS` 77 项。

## 根因与设计

- `runView()` 处理按键时先设置 `inputBusy=true`，随后等待 reducer 完成；周期 repaint 在此期间直接返回，所以配置校验或 Host 重启真实在执行，屏幕却一直停在旧帧。
- 直接放开普通 repaint 是反例：Instance/Conversation 删除可能已经关闭 Store，而 lifecycle 尚未完成；renderer 此时读 Store 会触发竞态。
- `pendingOperation={label,startedAt}` 在调用异步 action 前同步设置；输入循环因此能立即画出首帧。
- 最近稳定帧单独缓存；进度 timer 只裁剪这份字符串并追加 spinner、操作名、耗时和锁定提示。动作完成后清理进度态，再由普通 repaint 读取最新状态。
- “后台”只表示 Node 事件循环可继续绘制进度；配置落盘、Host 重启、创建和删除没有并发化，也不支持中途取消已可能落盘的写操作。

前置方案见 `../../spec/management-operation-progress.md`。

## 自动化验证

执行：

```powershell
npm run verify
```

结果：

- TypeScript build PASS；
- Node tests 73/73 PASS；
- `@hiq-ai/agent-channel-host@0.7.0` pack dry-run PASS，共 75 files；
- 延迟 `afterSettingApplied` 时，handler 完成前已存在“应用 私聊默认模式”进度态；释放 gate 后只执行一次 lifecycle 并清理状态；
- 关闭测试 Store 后连续渲染两帧进度仍成功，且 spinner 与耗时变化，证明进度 renderer 不读取 Store；
- 既有设置、删除即时刷新、Store-close、Channel 管理和退出流程全部回归通过；
- `git diff --check` PASS。

## 真实 Windows TTY

脚本：`scripts/tui-terminal-smoke.mjs`。

隔离状态根：`D:\baibu-agent\scratchpad\agent-channel-operation-progress-tty-20260803-151635`。

脚本将“私聊默认模式”的 Host lifecycle 人为延迟 360ms，并从真实 alternate-screen transcript 断言至少出现两帧进度和输入锁定提示。独立回读 `result.json`：

```json
{
  "ok": true,
  "tty": { "stdin": true, "stdout": true },
  "operationProgressObserved": true,
  "defaultModesObserved": true,
  "immediateDeleteRefreshObserved": true,
  "alternateScreenObserved": true,
  "channelStarted": false
}
```

同一真实 TTY 流程还回归了 Channel 开关、订阅与默认模式、群搜索绑定、Conversation 删除确认/取消、Instance 新增/删除、字段光标编辑、固定窗口和退出二次确认。

## 边界

- 使用隔离状态目录、合成消息与合成 Channel 候选；没有连接 DWS、搜索真实群或发送钉钉消息。
- 没有修改默认用户 Instance、本机已安装 CLI、真实 Windows 计划任务或外部安装目录。
- 本轮没有实现或重新设计 Runtime CLI session 入口；该子目标保持暂停。
