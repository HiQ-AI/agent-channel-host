# 压缩恢复与管理型 View 验收报告

## 结果

Round 5 后的 39 项用例全部 PASS。`agent-channel-host` 0.4.0 已具备：

- conversation checkpoint 与成员/角色/职责资料分层；
- Codex 新 session 与自动 compaction 后的关键状态恢复，普通 resume 不重复注入；
- 集中、简洁、明确的 Prompt；
- `agent-channel view` 不接受 `--instance`，作为所有已初始化 instance 的上层入口，逐 instance 启动或 attach Host；
- 顶层只保留“总览 / 全局设置”；总览的 INSTANCES 表可下钻详情及各自独立设置，全局设置不混入 instance 配置；
- Instance 详情可选择并下钻 Channel；Channel 页第一项直接启停，DingTalk 禁用时不启动 adapter 或获取 owner；
- Channel 页显示已绑定群组，可按关键词搜索合成/真实 adapter 候选并写入现有 conversation registry；默认继承 Agent 角色且使用 shadow，不增加第二套 listener；
- 总览可直接新增 Instance，复用 CLI init 的共享初始化入口并以 Channel disabled 作为安全默认；
- 零 instance 显示初始化引导；`view --once` 保持只读且不启动 Host；`run --instance` 保留为单 instance headless/service 入口。
- 交互式 TTY 以语义颜色突出选中项和运行状态，`NO_COLOR`、非 TTY 与 `view --once` 保持纯文本；
- Instance 设置三列使用显式竖线分隔并统一左对齐。
- 非编辑态 `Enter/→` 下钻、`Esc/←` 返回、Tab 只切顶层；编辑态支持左右、Home/End、Backspace/Delete；
- 交互 View 使用 alternate screen 固定刷新并在退出/信号/渲染错误时恢复主屏，`view --once` 不进入该终端生命周期。

## 验证摘要

- `npm run verify`：56/56 tests PASS，0.4.0 的 72-file pack dry-run PASS；
- 真实 Codex：`new → resumed`，同一 provider session 前缀，结构化 `silent`；
- 隔离 CLI：两个 instance 的 bare `view --once` 聚合输出和无 `--instance` help PASS；
- 真实 Windows TTY：跨 Instance 总览、Channel/会话下钻、Channel toggle、合成群搜索与绑定、字段光标编辑、TUI 新增、独立全局设置、alternate-screen 恢复和退出 PASS；
- 隔离 CLI：`view --once` 输出不含 ANSI PASS；
- 外部影响：未连接 DWS、未发送消息、未安装服务、未部署。

详细证据见 `round-1.md` 至 `round-5.md`，用例状态见 `matrix.csv`。
