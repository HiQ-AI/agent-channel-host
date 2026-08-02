# 命令驱动 Runtime 验收计划

## 范围

把当前 Codex App Server adapter 替换为 Codex CLI command adapter，并验证每个 conversation 的独立 session 可在一次性进程之间精确恢复。DingTalk Channel 数据面、Store 和调度器不新建第二套实现。

## 验收方法

1. 代码级测试覆盖配置、命令构造、JSONL 事件、生命周期、取消和 fail-closed。
2. 全量 `npm test` 与 `npm pack --dry-run` 回归。
3. 在 `D:\baibu-agent` 内使用隔离状态目录实跑两次 Codex CLI canary，不连接 DWS。
4. 搜索当前产品文档和源码，确认运行路径不再依赖 App Server；历史验收记录保留原事实，不改写历史。
5. 推送现有 feature branch、更新 PR，并回查 GitHub Actions。
