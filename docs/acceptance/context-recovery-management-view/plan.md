# 压缩恢复与管理型 View 验收计划

## 范围

验证 versioned conversation checkpoint、成员资料按需注入、Codex compaction hook、简洁 Prompt，以及 `view` 启动 Host 后的总览/Instance/Channel/Conversation/设置流程。

不连接真实 DWS，不发送钉钉消息，不安装 Windows service，不实现第二种 Channel 或 Runtime。

## 方法

1. Store migration 与事务测试。
2. Prompt、recovery publisher 与 hook 进程测试。
3. fake Runtime/Channel 下的 Worker、配置即时读取与 Host lifecycle 测试。
4. TUI reducer、renderer、设置校验与 CLI `--once` 测试。
5. `npm run verify`、隔离 instance CLI smoke、真实 Codex `verify`。
6. Channel 群搜索使用注入的合成候选验证，不连接真实 DWS；真实 Windows TTY 覆盖 `→/←` 层级导航、Channel toggle、群绑定、字段光标编辑和 alternate-screen 恢复。

状态以 `matrix.csv` 为准，证据写入新增的 `round-N.md`；全绿后才生成 `report.md`。
