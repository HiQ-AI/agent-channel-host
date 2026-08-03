# TUI 耗时管理操作进度反馈

## 问题

`runView()` 收到按键后把 `inputBusy=true`，随后等待 `handleManagementViewInput()` 完成；周期 `repaint()` 在 `inputBusy` 期间直接返回。设置保存会先原子写配置，再由 `afterSettingApplied` 停止/启动目标 Host。这个过程真实在执行，但屏幕一直停在操作前的旧帧，因此修改“私聊默认模式”等字段时看起来像页面卡死。

不能简单在等待期间继续调用原 `render()`：Instance/Conversation 删除的 lifecycle 可能关闭 Store 并删除状态目录。此前已经出现周期刷新在 Store 关闭窗口读取数据库的竞态。耗时反馈必须与实时 Store 读取解耦。

## 目标

- 设置、Channel 策略、群搜索、Instance 创建与 Instance/Conversation 删除在第一个异步等待前立即显示“处理中”。
- 进度符号持续变化，并显示操作名称、耗时和“完成后自动刷新”。
- 操作期间忽略重复输入，配置写入与 Host 生命周期继续串行；不并发执行第二次设置、重启或删除。
- 成功后显示正常结果，失败后回到原页面并显示错误。
- 进度刷新不读取 Store，不连接 DWS，不改变 Channel/runtime 契约。

## 设计

`ManagementViewState` 增加单一 `pendingOperation`：

```text
{ label, startedAt }
```

所有可能等待外部动作的入口通过同一个 helper 设置和清理该状态。helper 在调用 Promise 前同步设置状态，因此输入循环调用 handler 后、真正等待期间即可立即画出第一帧。

`runView()` 保存最近一次成功渲染的稳定文本帧。操作进行中时，不调用普通 `render()`，而是从这份文本快照裁剪出当前终端高度，在底部覆盖：

- spinner；
- `处理中：<操作>`；
- 已耗时；
- 输入锁定与完成后自动刷新的提示。

独立的短周期 timer 只重绘这份字符串快照和进度栏，不访问 Instance、Store、Channel 或 Host。操作完成后清理进度状态，再由原 repaint 路径读取最新状态并绘制结果。

“后台异步”只表示 Node 事件循环继续刷新 UI；管理动作本身仍是单 writer 串行 Promise。首版不提供取消：配置可能已经原子落盘且 Host 正在重启，中途取消会制造“UI 取消但状态已变”的歧义。

## 操作范围

- Instance/Conversation 自由文本、toggle 与 enum setting；
- Channel enabled、群聊/私聊订阅、群聊/私聊默认模式；
- DWS 群搜索；
- Instance 创建和启动；
- Instance/Conversation 二次确认后的删除。

纯导航、文本光标编辑、枚举浏览和确认框本身不显示进度。

## 验证

- 延迟 `afterSettingApplied`，证明 handler Promise 未完成时 `pendingOperation` 已存在，完成/失败后清理且 notice 正确。
- 用已经关闭的 Store 构造稳定帧后持续渲染进度，证明 progress renderer 不访问 Store。
- 重复输入由 `inputBusy` 拒绝，延迟 action 只调用一次。
- 真实 Windows TTY 修改“私聊默认模式”时观察至少两个不同 spinner 帧，随后自动回到 Channel 页面并显示成功结果。
- 删除进度使用快照渲染，既有删除即时刷新和 Store-close 竞态用例继续通过。
