# 机器人消息最终正文稳定化

## 现状与目标

DWS 个人 IM 接收事件只提供消息快照，不提供卡片更新事件、`isFinal` 或 `flowStatus`。部分机器人先推送“处理中/进行中”占位消息，再原地更新同一 `messageId`；Host 当前会立即持久化首次快照并唤醒 Agent，后续同 ID 消息又会被 inbox 去重。

目标是在不延迟普通消息的前提下，仅对严格匹配的短占位消息做有界回查，取得同一消息 ID 的稳定正文后再进入现有 inbox。回查失败或超时必须回退为最后可取得的内容，不丢消息、不让 Channel fatal。

## 方案

1. DWS adapter 在交给 Host 前识别严格的短占位文案。
2. 使用 `dws chat +messages-mget --msg-ids <messageId> --format json` 按 1、2、4、8 秒间隔回查。
3. 非占位正文连续两次相同即视为稳定；到达上限时使用最后一次非占位正文，否则回退原事件。
4. 每个外部 Conversation 建立独立 Promise 队列，保证占位回查期间同会话后续消息不会越序；不同会话仍可并行。
5. 停止 Channel 时等待已启动的有界回查完成，再释放 owner。

## 边界

- 不新增配置项，不修改 SQLite schema、订阅协议或 Runtime/session 路由。
- 普通人类消息不调用回查接口，也不增加延迟。
- 文案判定保持严格；不能确认是占位时按普通消息即时投递。
- DWS 若未来提供明确最终态字段，应优先改用协议字段并删除文案启发式。

## 验证

- 占位识别的正反例。
- `messages-mget` 返回解析、变化后稳定、超时取最后正文、查询失败回退。
- 同 Conversation 顺序保持，不同 Conversation 不互相阻塞。
- 完整 `npm run verify` 与 package dry-run。
