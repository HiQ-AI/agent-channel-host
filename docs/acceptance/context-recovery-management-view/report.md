# 压缩恢复与管理型 View 验收报告

## 结果

Round 9 后的 73 项用例全部 PASS。`agent-channel-host` 0.7.0 已具备：

- conversation checkpoint 与成员/角色/职责资料分层；
- Codex 新 session 与自动 compaction 后的关键状态恢复，普通 resume 不重复注入；
- 集中、简洁、明确的 Prompt；
- `agent-channel view` 不接受 `--instance`，作为所有已初始化 instance 的上层入口，逐 instance 启动或 attach Host；
- 顶层只保留“总览 / 全局设置”；总览的 INSTANCES 表可下钻详情及各自独立设置，全局设置不混入 instance 配置；
- 全局总览只保留 Instance 索引、跨实例消息汇总和全局告警；Channel、Conversation、消息、Runtime 和局部告警统一在 Instance 详情展示，且 Conversation 固定在 Messages 上方；
- Instance 详情可选择并下钻 Channel；Channel 页第一项直接启停，DingTalk 禁用时不启动 adapter 或获取 owner；
- Channel 页分别管理群聊/私聊的 `none/selected/all` 准入策略和 `shadow/reply` 新会话默认模式；`all` 仍只使用唯一事件流，显式 disabled 仍拒绝；
- Channel 页显示已绑定群组，可按关键词搜索 adapter 候选并写入现有 conversation registry；默认继承 Agent 角色并使用群聊默认模式，不增加第二套 listener；
- Channel 页同时显示指定私聊；新增私聊继续使用稳定 `openDingTalkId` 登记，事件或成员资料有人员姓名时显示姓名，不按姓名猜测 ID；
- Conversation 以稳定 ID 维护选择，排序或标题刷新不改变下钻目标；详情可修改 title/enabled/职责/mode/warm TTL/成员资料，并以二次确认执行全级联删除；mode、runtime effort 和 Channel 固定枚举使用选择式交互；
- Channel 的 GROUPS/DIRECTS 行可直接发起同一 Conversation 删除确认与生命周期 action；
- Instance 设置可修改并校验 Runtime cwd；已有 session cwd 不一致时 resume fail closed；
- Host 启动一次性恢复未完成及未达 3 次上限的 failed inbox/outbox，outbox 沿用原 UUID 并保留 freshness 门禁；完成、已提交和终止失败项不重放；
- INSTANCES 和 Instance 详情支持二次确认删除 Instance；attached Host fail closed，View-owned Host 先停止，删除过程持有管理 lease 防止外部抢占；
- 删除 action 执行期间暂停周期 repaint；成功后在同一输入周期立即更新顶部计数、实例/会话列表、消息汇总、告警、选中项和确认状态，不读取已关闭 Store；
- 中文 Windows 的 CP936 计划任务“不存在”输出可正确识别，权限或未知查询错误继续 fail closed；
- 总览可直接新增 Instance，复用 CLI init 的共享初始化入口并以 Channel disabled 作为安全默认；
- 零 instance 显示初始化引导；`view --once` 保持只读且不启动 Host；`run --instance` 保留为单 instance headless/service 入口。
- 交互式 TTY 以语义颜色突出选中项和运行状态，`NO_COLOR`、非 TTY 与 `view --once` 保持纯文本；
- Instance 设置三列使用显式竖线分隔，并按终端显示宽度对齐中文、全角、emoji 与组合字符。
- 非编辑态 `Enter/→` 下钻、`Esc/←` 返回、Tab 只切顶层；编辑态支持左右、Home/End、Backspace/Delete；
- 交互 View 使用 alternate screen 固定刷新并在退出/信号/渲染错误时恢复主屏，`view --once` 不进入该终端生命周期。
- `q/Ctrl+C` 先进入退出确认，明确 View-owned Host 影响；再次确认才退出，取消后保留导航和编辑状态。
- Codex 成功完成的 `spawn_agent` 调用即构成真实派发证据，child thread ID 仅为可选关联信息；单 Conversation 决策失败不会终止共享 Channel owner。

## 验证摘要

- `npm run verify`：72/72 tests PASS，0.7.0 的 75-file pack dry-run PASS；
- 真实 Codex：`new → resumed`，同一 provider session 前缀，结构化 `silent`；
- 隔离 CLI：两个 instance 的 bare `view --once` 聚合输出和无 `--instance` help PASS；
- 真实 Windows TTY：精简总览、Instance 对象详情与分区顺序、Runtime cwd、Channel 删除入口/toggle、群聊/私聊订阅及默认模式、合成群搜索与绑定、Conversation 删除确认/取消、隔离 Instance 物理删除与同周期即时刷新、字段光标编辑、TUI 新增、独立全局设置、退出确认/取消、alternate-screen 恢复和退出 PASS；
- 隔离 CLI：`view --once` 输出不含 ANSI PASS；
- 外部影响：未连接 DWS、未发送消息、未安装服务、未部署。

详细证据见 `round-1.md` 至 `round-9.md`，用例状态见 `matrix.csv`。
