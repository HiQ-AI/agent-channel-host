# 单向 Runtime 消息投递

## 目标

Host 只可靠地把已授权 Channel 消息逐条送入对应 conversation 的固定 runtime session。Host 不接收 Agent 的处理决定或回复文本，不判断是否处理，不调用 Channel 发送能力。

## 唯一路径

```text
Channel event
  → SQLite durable admission
  → conversation 单 writer claim 当前可用批次
  → RuntimeAdapter.deliver(批次内各消息的发送者、时间、内容)
  → runtime turn.completed
  → inbox completed
```

- 每条消息一个 runtime turn，不合批。
- 新消息在当前 turn 活动时等待 runtime 的 `turn/started` 确认后，通过 RuntimeAdapter `steer` 立即追加，不触发取消、不新建 turn；steer 失败则 Worker fail closed，不允许静默排队。
- `turn.completed` 仅是 runtime 投递完成凭据，不表示 Agent 已处理或回复。
- runtime final text、工具调用和回复行为均不进入 Host 协议。
- 首次群历史先逐条写入 `ingress=history` 的 durable inbox，再合成一次首次引导投递；每条消息仍保留独立 durable 状态。
- Host 重启只恢复未完成/可重试 inbox，不恢复或发送旧 outbox。

## Runtime 契约

```ts
interface AgentSession {
  start(): Promise<unknown>;
  deliver(prompt: string): Promise<{ turnId: string; status: 'completed' | 'interrupted' }>;
  interruptActive(): Promise<boolean>; // 仅 Host 停止时使用
  stop(): Promise<void>;
}
```

Codex adapter 使用 App Server `thread/start|resume`、`turn/start|steer`，校验固定 session ID、steer 返回同一活动 turn ID 和 `turn/completed`；不传 `outputSchema`，也不解析 `agentMessage`。

## 兼容边界

旧 SQLite decision/outbox/onboarding 发送字段保留用于读取既有数据库和级联删除，但新运行路径不写入出站意图、不恢复 outbox、不提供 Host 发送协调命令。后续独立 schema 清理应另做迁移，不与本次行为收敛混在一起。
