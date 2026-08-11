# 任务续接入口

## 目标

为外部任务控制面提供持久、幂等且只在下一 turn 投递的续接入口。Host 只负责把控制事件精确送入父 Conversation 的固定 provider session；它不直接恢复或伪造 subagent 关系，父 Agent 收到事件后依据原生任务账本恢复既有子 Agent或创建替代子 Agent。

## 契约

```powershell
agent-channel conversation continue-task `
  --instance <instance> `
  --provider-session-id <full parent thread id> `
  --continuation-id <stable old run id> `
  --text <continuation instruction> `
  [--conversation-id <conversation uuid>] `
  [--delivery next-turn]
```

`Store.admitTaskContinuation` 在单个 `BEGIN IMMEDIATE` 事务中完成：

1. 完整父 provider session 必须唯一映射到一个 enabled Conversation；
2. 若传入 Conversation ID，必须与映射结果一致；
3. fingerprint 固定为 `continuation:<continuationId>`；重复调用回读原 sequence 与 processing state；
4. 幂等键跨 Conversation 或跨 ingress 冲突时 fail closed；
5. 新事件以 `ingress=continuation`、`processing_state=admitted` 写入 SQLite WAL。

运行 Host 每秒只扫描 admitted continuation。空闲 Worker 立即唤醒；活动 turn 中不 signal、不 steer、不重置 quiet window，由当前 drain 收尾后开启下一 turn。成功回执仍走既有 `markBatchForwarded`，因此扫描不会重复唤醒终态事件。

## 边界

- 普通 Channel/View 消息保持既有实时 steer 语义。
- continuation prompt 显式标记为“宿主任务续跑事件”，禁止仅因控制事件向当前渠道回复。
- Host 未运行时 CLI 仍可写入 durable inbox；Host 启动后轮询恢复。
- 本接口不直接 `resume` child thread。父 Agent 必须先尝试恢复已知子 Agent；不可用时创建 replacement，且新子 Agent 以自己的物理 session ID claim 新 Run。
- 不新增表或迁移；既有 ingress 列没有枚举 CHECK，可直接容纳 `continuation`。

## 回滚

回滚前必须确认不存在 admitted continuation。旧 Host 会把该 ingress 当普通 pending 消息恢复，无法保证 next-turn-only，因此不能在有未消费控制事件时降级。
