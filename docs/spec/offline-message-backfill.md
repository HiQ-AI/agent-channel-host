# 离线消息补拉

## 目标

Host 重新启动后，对每个已启用 Conversation 补全本地最后一条已记录消息至本次启动时刻之间的钉钉消息，覆盖群聊和私聊，并继续复用唯一实时事件流。

## 当前缺口

- `inbound_events` 已保存消息的 `occurred_at` 与 Host 的 `received_at`，但启动流程没有读取它们发起历史查询。
- DWS consumer 使用 `--ephemeral`，只能收到连接建立后的事件。
- 现有 `fetchRecentGroupHistory()` 只服务首次群 onboarding，固定向前读取最近 50 条，不覆盖私聊，也不是启动恢复。
- 历史消息与实时事件的 fingerprint 生成来源不同，仅依赖 fingerprint 不能保证交叠区间去重。

## 方案

1. 先启动唯一 DWS bus 与群聊/私聊 consumer，记录本次启动截止时刻；consumer ready 后再执行历史补拉，避免“先补历史、后连实时”产生新缺口。
2. 每个已启用 Conversation 从本地最大有效 `occurred_at` 开始补拉；没有消息时从 Conversation 创建时间开始。查询起点向前重叠 2 秒，抵消 DWS 秒级时间参数的边界精度。
3. 群聊调用 `chat message list --group ... --direction newer`；私聊调用 `--open-dingtalk-id ...`。每页按返回消息的最大 `createTime` 推进，直到 `hasMore=false`；分页边界不前进时 fail closed。
4. 只准入不晚于启动截止时刻的结果。历史结果转换成与 Conversation binding 一致的 `NormalizedEvent`，按消息发生时间排序后写入 durable inbox。
5. `admitEvent()` 在 fingerprint 去重之外，对同一 Conversation 的非空 `message_id` 再去重，覆盖“实时先到、历史后到”和“历史先入、实时后到”两种交叠顺序。
6. 启动恢复完成前只持久化事件、不启动 Conversation Worker；补拉完成后统一 reconciliation，保证历史与实时消息按本地 sequence 顺序交给 Runtime。
7. 任一 Conversation 的历史读取、结构解析或分页失败均使 Host 启动失败；不允许在缺失补偿的情况下伪装 ready。

## 边界

- 不新增第二个网络接收服务，不用轮询替代实时事件。
- 不维护与 inbox 双写的独立水位表；水位从 durable inbox 推导。
- DWS 历史接口只接受秒级本地时间，因此必须保留重叠窗口并依赖 message ID/fingerprint 幂等。
- DWS 的无时区时间按钉钉中国区 `Asia/Shanghai` 解释和格式化，不依赖 Host 运行机器时区，保证 Windows 与 Linux 行为一致。
- 首次群 onboarding 仍保留最近 50 条引导语义；启动补拉写入普通 durable inbox，不复用或改写 onboarding 状态。

## 验证

- Store：水位选择、无消息回退、同 Conversation message ID 去重、不同 Conversation 不误去重。
- DWS：群聊/私聊参数、分页推进、截止时刻过滤、排序、结构错误和停滞 fail closed。
- Host：实时订阅先建立、补拉完成前不调度、恢复后统一投递、补拉失败不进入 ready。
- 完整执行 `npm run verify` 与 `git diff --check`。
