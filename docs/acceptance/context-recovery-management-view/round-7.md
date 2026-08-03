# Round 7：删除成功后的即时刷新补正

## 结论

用户看到的画面不是“删除已经完成但列表未刷新”。Instance 删除在查询同名 Windows 计划任务时已失败：`schtasks.exe` 返回 CP936 字节，Node 以 UTF-8 解码后变成乱码，导致“任务不存在”没有被识别，删除 action 未进入数据删除和刷新阶段。

修正本地化输出后，真实 TTY 又捕获到第二个竞态：异步删除已经关闭 Store、但尚未从 `instances` 数组移除时，周期 repaint 可能抢先读取已关闭 Store。现在输入动作执行期间暂停周期刷新；action 完成、列表和选中状态更新后，由输入处理器立即绘制唯一下一帧。

`matrix.csv` 共 58 项，`round_7=PASS` 58 项，最终 `status=PASS` 58 项。

## 根因与修复

- `src/service.ts`：计划任务查询改为读取原始 Buffer。有效 UTF-8 直接解码；否则按 GB18030 解码当前中文 Windows 的 CP936 输出。任务不存在返回 `false`，权限或未知文本仍抛错并 fail closed。
- `src/view.ts`：`inputBusy=true` 时周期 repaint 不进入 Store；删除 action 返回后先更新内存列表、详情、选中项和确认状态，再由输入处理器立即 repaint。
- 删除最后一个 Instance 时选中项移动到剩余的上一个 Instance；删除中间项时保持同索引并选中下一个 Instance；零 Instance 才选中“新增 Instance”。
- `test/service.test.ts`：使用用户现场同型 CP936 字节断言中文可读、无替换字符，并证明 access denied 不会被误判成“不存在”。
- `test/view.test.ts`：Conversation 删除后的当前 render 立即显示空会话列表、成功提示且无确认框；Instance 删除后的当前 render 立即更新 `instances=1`、表格和选中项。

## Windows 查询回读

只读查询不存在的 `agent-channel-host-cursor-edit` 任务：

- `schtasks.exe /Query` exit code 为 1；
- raw bytes 以 UTF-8 解码为乱码；
- 同一 raw bytes 以 GBK/GB18030 解码为“错误: 系统找不到指定的文件。”；
- 编译后直接调用 `removeUserServiceIfInstalled('cursor-edit')` 返回 `false`；没有执行 End/Delete，也没有修改计划任务。

## 自动化验证

执行：

```powershell
npm run verify
```

结果：

- TypeScript build PASS；
- Node tests 65/65 PASS；
- `@hiq-ai/agent-channel-host@0.5.0` pack dry-run PASS，共 72 files；
- 验证前后默认用户状态根的 9 个文件路径、长度和 `LastWriteTimeUtc` 完全一致，`DefaultStateUnchanged=true`。

## 真实 PowerShell TTY

脚本：`scripts/tui-terminal-smoke.mjs`。

隔离状态根：`D:\baibu-agent\scratchpad\agent-channel-delete-refresh-tty-20260803-1245`。

真实 TTY/raw mode 中创建并删除隔离 `created-agent`，结果：

```json
{
  "ok": true,
  "tty": { "stdin": true, "stdout": true },
  "instanceDeleteObserved": true,
  "immediateDeleteRefreshObserved": true,
  "channelStarted": false
}
```

独立断言：

- 删除后的物理目录不存在；
- 同一输入周期下一帧从 `instances=3` 变为 `instances=2`；
- 被删除行和删除确认框均消失；
- 不等待 10 秒周期刷新；
- alternate screen、退出确认、Channel 设置及既有交互继续通过。

## 边界

- 没有删除 `%LOCALAPPDATA%\agent-channel-host` 中的默认用户 Instance，也没有停止真实运行 Host。
- 没有安装、结束或删除真实 Windows 计划任务；只对明确不存在的任务执行只读 Query。
- 没有连接 DWS、发送钉钉消息、部署或发布 npm。
- 当前本地化回归覆盖 UTF-8、英文缺失文本和中文 CP936/GB18030；其他语言无法识别时继续 fail closed，不会把未知权限错误当作任务不存在。
