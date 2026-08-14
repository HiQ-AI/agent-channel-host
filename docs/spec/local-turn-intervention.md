# 本机 Conversation 人工消息

## 目标

Agent Channel Host 托管实例级共享 Codex App Server，并让每个 Conversation Worker 通过独立 WebSocket 连接持有自己的 session。Host 提供 SQLite 消息邮箱：活动 turn 时由 Worker 执行 `turn/steer`，空闲时在固定原 thread 上执行 `turn/start`，并回写实际 turn ID。Agent Studio 等正式调用方只面向 Host，不直接管理 App Server 或 thread 生命周期。

不改变消息 inbox、Actor drain、Worker lease 或固定 thread 映射，不引入 Redis或外部事件总线。共享 App Server 只监听 `127.0.0.1`，Host 等待 `/readyz` 后才开始投递。

## 与 Issue #59/#61 的关系

Issue #59 提供 Host 级共享 WebSocket App Server；Issue #61 在其上收口正式人工消息入口。Host 启动一个回环 App Server，各 Conversation 使用独立连接，endpoint、instance ID 和 PID写入 Runtime 状态并展示在 View。邮箱 `requestId` 映射为 Codex `clientUserMessageId`；活动 turn 快照过时不能降级到新 turn，空闲请求只能在 expected thread 上启动。

## 外部契约

```powershell
agent-channel conversation intervention-state `
  --instance <instance> --id <conversation-id>

agent-channel conversation message `
  --instance <instance> --id <conversation-id> `
  --request-id <caller-stable-id> `
  --expected-thread-id <full-thread-id> `
  [--expected-turn-id <turn-id>] `
  --text <instruction> [--ttl-seconds 60]

agent-channel conversation intervention-result `
  --instance <instance> --request-id <caller-stable-id>
```

`intervention-state` 仅由显式本机命令输出完整 thread/turn ID；既有 `status/view` 继续只展示前缀。`message` 只写本机 state SQLite，不直接连接 App Server。活动状态提交 `expectedTurnId`，空闲状态不提交；相同 `requestId` 与相同业务 payload 重试回读首次记录，相同 ID 携带不同 payload 时 fail closed。

## 状态模型

### Target

每个 Conversation 一条 `runtime_intervention_targets`：

- `thread_id`：当前 Worker session 的完整 provider session ID；
- `turn_id`：当前活动 turn，没有时为 null；
- `canSteer`：存在活动 turn 且 session 支持 steer；
- `canStartTurn`：Worker 已持有固定 thread 且 session 支持启动 turn；
- `canSend`：上述任一路径可用；不可用时给出稳定 `reasonCode`；
- `worker_id`、`updated_at`：用于辨别状态来源和新鲜度。

Worker 启动、Host 邮箱 tick、turn 收尾和 Worker 停止时刷新该状态。外部状态只作为提交前快照，真正安全边界仍是领取后的 expected ID 校验。

### Mailbox

`runtime_interventions` 使用调用方 `request_id` 作为主键，状态为：

- `pending`：等待目标 Conversation Worker 领取；
- `claimed`：已由该 Worker 原子领取；
- `succeeded`：App Server 确认 steer 或创建新 turn，结果携带实际 turn ID；
- `rejected`：thread/turn 不匹配、不支持 steer、调用失败或上次 claimed 结果未知；
- `expired`：领取前已超过 `expires_at`。

终态不可再次修改。过期 `claimed` 不盲目重放，而是回写 `rejected/outcome_unknown`。`turn/start` 和 `turn/steer` 都携带 `clientUserMessageId=requestId`，但当前 Codex 协议只声明该字段、未承诺可供 Host 在崩溃后查询幂等结果，因此不能把未知结果伪装成安全重试。

## 调用流

1. Worker 发布当前 thread/turn/capability。
2. 外部调用方读取状态并提交带 expected IDs 的指令。
3. Host 的单一短周期 tick 遍历自己持有的 Worker；每个 Worker 只领取自己 Conversation 的最早 pending 指令。
4. Worker 在 turn 操作串行区再次比较当前 thread/turn；thread 不一致直接拒绝。
5. 当前有活动 turn 时必须携带且匹配 `expectedTurnId`，调用 `session.steer()`；当前空闲时请求不得携带旧 turn ID，调用 `session.startTurn()`。
6. App Server 确认 accepted/created turn ID 后回写 `steered` 或 `started`；新 turn 的完成在 Worker 后台继续观察，不阻塞调用方取得 turn ID。

## 并发与边界

- Channel 新消息、人工 steer 与人工 start 共用 Worker 内 turn 操作队列，避免竞态创建两个 turn。
- 邮箱不创建 Worker；只有已启动、持有 lease 且绑定有效 thread 的 Worker 可消费。空闲人工 turn 执行期间到达的 Channel 消息仍 steer 到该 turn 并按原 inbox 语义结算。
- Conversation lease 继续保证同一 Conversation 只有一个 Worker；邮箱 claim 额外绑定 worker ID。
- 指令按普通外部人工输入处理，不作为 system/developer instruction，也不授予审批或更高权限。
- 默认 TTL 60 秒，允许 1–3600 秒；schema migration 新增邮箱表、共享 App Server 发布字段与空闲启动能力，并升级到 user_version 18。

## 验证

- 状态：分别暴露 `canSteer/canStartTurn/canSend/reasonCode`，完成后 turn 清空但仍可 start。
- 安全：expected thread/turn 不匹配均 rejected，不能落入下一 turn。
- 幂等：同 payload 重试回读同一实际 turn ID；冲突 payload 拒绝；终态不回退。
- 崩溃窗口：超时 claimed 转 rejected/outcome_unknown，不二次 steer。
- 并发：普通消息 steer 与人工 steer 串行调用同一 session。
- 回归：现有实时消息、continuation next-turn、Worker warm/lease 和固定 session 均保持。

## 回滚

回滚前确认不存在 `pending/claimed` 指令。旧版本不会读取新增表；保留表不影响既有 schema。若仍有非终态指令，先等待或将其终结，禁止在未确认是否已 steer 的情况下通过旧 Host 重试。
