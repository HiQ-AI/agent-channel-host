# 移除 Host 完成语义

## 问题

Host 已不读取 Agent 结果，但 Runtime 返回 `turn/completed` 后仍把同批全部 inbox 写成 `completed`，View 又汇总为 `processed`。这会把“成功转发给 Runtime”误呈现成“Agent 已逐条处理完成”；当一个 turn 包含多条独立消息时，Agent 漏掉其中一条也无法从 Host 状态识别或恢复。

## 目标语义

Host 只维护转发状态：

```text
admitted → claimed → forwarded
                   ↘ failed
```

- `forwarded` 只表示该消息所在批次已由固定 Runtime session 接收，且 Runtime turn 正常结束。
- Host 不记录 `completed/processed`，不创建空 decision，不判断 Agent 是否处理、回复或完成业务任务。
- 批次成功只产生每条消息的转发凭据 `forwarded_turn_id/forwarded_at`；不能据此推断逐条业务结果。
- 首次群历史同样只显示 `loaded/forwarded`，不显示 `judged/completed`。

## 数据迁移

SQLite schema 升至 v12：既有 inbox `completed` 原位迁移为 `forwarded`，从旧 decision 提取可用 turn ID 后删除 decisions 表；onboarding 的 `completed` 迁移为 `forwarded`。`failed` 保持可恢复语义，`admitted/claimed` 保持调度语义。

## 验证

- 多消息同批转发后只得到 `forwarded`，无 decision/action/processed。
- 旧 v11 数据打开后完成无损迁移，旧 `completed` 不再存在。
- 重启只重投 admitted、活动 claimed 和可恢复 failed，不重投 forwarded。
- status、View、README 统一使用 forwarded，且明确它不是业务完成证明。
