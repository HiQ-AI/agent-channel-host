# 本机活动 Turn 人工介入

## 目标

Agent Channel Host 持有 Conversation 对应 Codex App Server session，外部进程不能绕过 Host 直接操作该 thread。本改动在现有 Worker 上增加本机 SQLite 指令邮箱：Host 发布当前完整 `threadId`、`turnId` 和可介入状态；外部调用方按该状态提交带 `expectedThreadId`、`expectedTurnId` 的幂等指令；持有 session 的 Worker 领取并调用既有 `session.steer()`，再回写终态。

不改变消息 inbox、Actor drain、Worker lease、session 生命周期或 App Server 进程所有权，不引入 Redis、HTTP 服务或第二个 App Server 客户端。

## 与 Issue #59 的关系

Issue #59 证明 Codex 0.146.0 的 `turn/steer` 使用 `threadId`、`expectedTurnId`、`input` 和可选 `clientUserMessageId`，并要求错误 turn 不能进入下一轮。但其“Host 级共享 WebSocket App Server + Agent Studio 临时直连”方案与当前约束不同：最终 steer 必须由持有目标 session 的 Host 执行。因此本方案保留现有每 Conversation 的 stdio App Server，不实施共享 WebSocket/readyz/外部直连；邮箱 `requestId` 映射为 `clientUserMessageId`，由原 Worker 调用 steer。

## 外部契约

```powershell
agent-channel conversation intervention-state `
  --instance <instance> --id <conversation-id>

agent-channel conversation intervene `
  --instance <instance> --id <conversation-id> `
  --request-id <caller-stable-id> `
  --expected-thread-id <full-thread-id> `
  --expected-turn-id <turn-id> `
  --text <instruction> [--ttl-seconds 60]

agent-channel conversation intervention-result `
  --instance <instance> --request-id <caller-stable-id>
```

`intervention-state` 仅由显式本机命令输出完整 thread/turn ID；既有 `status/view` 继续只展示前缀。`intervene` 只写本机 state SQLite，不直接连接 App Server。相同 `requestId` 与相同 conversation/thread/turn/text 重试回读首次记录（首次 TTL 生效）；相同 ID 携带不同业务 payload 时 fail closed。

## 状态模型

### Target

每个 Conversation 一条 `runtime_intervention_targets`：

- `thread_id`：当前 Worker session 的完整 provider session ID；
- `turn_id`：当前活动 turn，没有时为 null；
- `can_intervene`：仅 App Server session 已启动、支持 active steer 且 turn 活动时为 true；
- `worker_id`、`updated_at`：用于辨别状态来源和新鲜度。

Worker 启动、Host 邮箱 tick、turn 收尾和 Worker 停止时刷新该状态。外部状态只作为提交前快照，真正安全边界仍是领取后的 expected ID 校验。

### Mailbox

`runtime_interventions` 使用调用方 `request_id` 作为主键，状态为：

- `pending`：等待目标 Conversation Worker 领取；
- `claimed`：已由该 Worker 原子领取；
- `succeeded`：App Server 确认 steer 到 expected turn；
- `rejected`：thread/turn 不匹配、不支持 steer、调用失败或上次 claimed 结果未知；
- `expired`：领取前已超过 `expires_at`。

终态不可再次修改。过期 `claimed` 不重试 steer，而是回写 `rejected/outcome_unknown`，避免 Host 在“App Server 已接受但结果尚未落库”窗口崩溃后重复注入。

## 调用流

1. Worker 发布当前 thread/turn/capability。
2. 外部调用方读取状态并提交带 expected IDs 的指令。
3. Host 的单一短周期 tick 遍历自己持有的 Worker；每个 Worker 只领取自己 Conversation 的最早 pending 指令。
4. Worker 在 steer 串行区内再次比较当前 thread/turn；不一致直接 rejected。
5. Worker 调用 `session.steer(prompt, expectedTurnId, requestId)`；App Server adapter 在发请求前再次比较 active turn，把 expected ID 原样传给 `turn/steer`，并把幂等 request ID 作为 `clientUserMessageId`。
6. accepted turn ID 必须等于 expected ID才回写 succeeded，否则 rejected。

## 并发与边界

- Channel 新消息 steer 与人工 steer 共用 Worker 内串行队列，避免并发写同一 active turn。
- 邮箱不唤醒空闲 Worker，也不创建新 turn；没有活动 turn 的请求会被拒绝，不降级为 next-turn。
- Conversation lease 继续保证同一 Conversation 只有一个 Worker；邮箱 claim 额外绑定 worker ID。
- 指令按普通外部人工输入处理，不作为 system/developer instruction，也不授予审批或更高权限。
- 默认 TTL 60 秒，允许 1–3600 秒；首次 schema migration 新增两张表并升级 user_version。

## 验证

- 状态：活动 turn 暴露完整 thread/turn 且 canIntervene=true，完成后 turn 清空。
- 安全：expected thread/turn 不匹配均 rejected，不能落入下一 turn。
- 幂等：同 payload 重试回读；冲突 payload 拒绝；终态不回退。
- 崩溃窗口：超时 claimed 转 rejected/outcome_unknown，不二次 steer。
- 并发：普通消息 steer 与人工 steer 串行调用同一 session。
- 回归：现有实时消息、continuation next-turn、Worker warm/lease 和固定 session 均保持。

## 回滚

回滚前确认不存在 `pending/claimed` 指令。旧版本不会读取新增表；保留表不影响既有 schema。若仍有非终态指令，先等待或将其终结，禁止在未确认是否已 steer 的情况下通过旧 Host 重试。
