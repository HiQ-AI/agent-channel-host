# 离线消息补拉验收报告

## 结果

Round 1 全部 8 个用例 PASS，状态以 `matrix.csv` 为准。

## 已验证能力

- Host 先建立唯一实时事件流，再补拉每个已启用群聊/私聊至本次连接时刻。
- 水位从 durable inbox 推导；无消息从 Conversation 创建时间开始，起点回退 2 秒。
- 历史与实时交叠按同一 Conversation 的 message ID 或 fingerprint 幂等准入。
- 补拉完成前不启动 Worker；补拉异常使 Host fail closed。
- 完整回归、构建和发布包 dry-run 通过。

## 边界

当前证据证明本地实现和当前 DWS CLI 契约，不等同于真实账号长时间离线后的业务 canary。真实环境仍受账号消息搜索权益与钉钉服务端历史可见范围约束；权限错误会使 Host 启动失败并暴露根因，不会被解释为空消息。
