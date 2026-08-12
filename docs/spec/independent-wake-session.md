# 独立唤醒会话

## 目标

唤醒词只负责从本人真人消息创建一次性独立任务会话，不把任务写入来源群聊或私聊的固定 Conversation，也不继承两类会话的默认 `shadow/reply` 模式。

## 路由契约

1. 定时补拉只保留当前 DWS 用户本人真人发送的消息；AI 标记消息直接丢弃。
2. 常规群聊/私聊订阅先判断。已准入的消息只进入来源固定 Conversation，不重复创建唤醒会话。
3. 常规订阅未准入且命中唤醒词时，以消息 fingerprint 创建独立 Conversation；一条唤醒消息对应一个 Conversation 和一个 Codex session。
4. 独立 Conversation 标记 `purpose=wake`，来源 transport kind 仅用于保留消息上下文；固定使用 `shadow`，不读取 `channel.defaultModes`。
5. 唤醒会话不参加群聊首次 50 条历史加载，也不成为群聊/私聊本人消息补拉目标。

## 数据与展示

- schema 新增 `conversations.purpose`，既有数据迁移为 `channel`。
- View 将唤醒会话与群聊、私聊分区展示。
- 唤醒会话标题包含来源类型和可读来源名称，不暴露完整 fingerprint。

## 验证

- 本人 AI 消息不会从定时补拉进入 inbox。
- 已订阅来源消息只进入来源 Conversation。
- 未订阅来源的唤醒消息创建独立 Conversation，模式固定且 session 独立。
- 两条不同唤醒消息创建两个不同 Conversation。
- 唤醒会话不触发群历史 onboarding，也不进入普通会话补拉列表。
