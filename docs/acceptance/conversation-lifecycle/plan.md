# 每会话生命周期验收计划

## 范围

- v2 → v3 数据迁移与新会话默认值；
- CLI 新增/修改/展示生命周期；
- resident 启动预热和 idle 消息唤醒；
- 空闲计时重置、忙碌保护、释放和原 thread 恢复；
- README、配置样例和安全边界同步。

## 验证层次

1. Store/CLI 单元与进程测试验证默认值、参数校验、迁移和持久化。
2. Host 生命周期控制器测试验证计时重置、resident 不释放以及 busy 后延迟释放。
3. App Server canary 实际执行 start → stop → resume，回查 thread ID 不变。
4. `npm run verify` 与 GitHub 双平台 CI 验证回归和打包。

不连接真实 DWS，不发送钉钉消息，不执行部署。
