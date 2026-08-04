# Round 1：DWS 重复 UUID 与 ALERTS 脱敏

## 结论

8/8 通过。重复 UUID 现在记为 `delivery_unknown`，不会换 UUID 或自动重试，也不冒充 submitted/delivered。真实误记状态已在完整备份后精确纠正；新版唯一 Host 重启后未重新发送，Channel/runtime ready，View 保留单行 `delivery_unknown: duplicate_uuid` 告警且不展示群消息正文、目标 ID 或 UUID。

## 自动化与打包

```powershell
npm run verify
```

- 89/89 tests PASS。
- `@hiq-ai/agent-channel-host@0.9.1` pack dry-run PASS，共 69 files。
- DWS 测试覆盖结构化非零退出、重复 UUID 进入发送结果不明终态和其他业务错误 fail-closed。
- 命令层测试以真实非零 Node 子进程证明回调 stdout/stderr 会保留给上层结构化解析。
- View 测试覆盖 72 列窗口内的遗留错误单行摘要与敏感内容反向断言。

## 真实边界

- DWS 确认 UUID 重复只能证明幂等键已登记；没有消息回读证据时不能宣称 submitted 或 delivered。
- `--check` 只读确认 Host lease 已停止、目标唯一且原状态为误记的 `submitted`，执行前后数据库 SHA-256 相同。
- apply 前完整备份 SQLite/WAL/SHM；apply 后独立只读回查目标为 `delivery_unknown:duplicate_uuid`，history count 仍为 2，turn、reply、UUID 均保留。
- 新版唯一 Host 启动后 `host/channel/runtime=running/ready/ready`，pending inbox/outbox/onboarding 均为 0，submitted=0；一个 foreground bus 和一个群消息 consumer 存活。
- `view --once` 显示一个精简 onboarding 告警。该告警是需要人工核实的真实终态，不应清零。
