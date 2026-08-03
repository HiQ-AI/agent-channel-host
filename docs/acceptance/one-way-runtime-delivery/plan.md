# 单向 Runtime 投递验收计划

验证 Host 从“结构化决定 + outbox 发送代理”收敛为“逐条 durable runtime 投递代理”，覆盖实时消息、首次历史、固定 session、新消息排队、失败恢复和零 Host 出站。

不连接真实 DWS，不发送或补偿真实群消息；使用内存 Channel 与 fake Codex 命令完成本地验证。
