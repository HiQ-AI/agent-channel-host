# 验收报告

任务续接入口已通过原子准入、幂等冲突、next-turn-only、外部 IPC 自动唤醒、终态回读与全量回归验证。Host 的职责止于唤醒父 Conversation；子 Agent 恢复与新 Run claim 仍由父 Agent 和原生任务账本完成。
