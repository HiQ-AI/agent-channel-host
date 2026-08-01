# Round 1 验收记录

时间：2026-08-01

## 自动化测试

命令：

```powershell
npm run verify
```

结果：退出码 0，TypeScript 构建和 20/20 测试通过，`npm pack --dry-run` 成功且包内 47 个文件。新增覆盖新群/私聊默认策略、v1/v2 → v3 迁移、CLI 添加与修改、resident 启动预热、idle onboarding 预热、计时重置、busy 延迟释放，以及后台 subagent 活跃时 actor 保持忙碌；原有 onboarding、委派、admission、outbox、lease 和 CLI 回归继续通过。

## App Server 原 thread 恢复 canary

命令：

```powershell
node docs/acceptance/conversation-lifecycle/scripts/app-server-resume-canary.mjs <scratch-dir>
```

结果：退出码 0。第一次启动返回 `firstMode=started`；关闭 App Server 进程并新建 session 对象后，第二次返回 `secondMode=resumed`、`sameThreadId=true`，恢复后的固定 thread 又完成一轮严格 silent turn。

独立只读回查 SQLite：conversation 为 `session_lifecycle=idle`、`idle_timeout_minutes=5`，session 仍为 `lifecycle=ready`，保存的 thread 前缀与 canary 返回一致。

## 后台忙碌状态 canary

命令：

```powershell
node docs/acceptance/group-onboarding-delegation/scripts/app-server-delegation-canary.mjs <scratch-dir>
```

结果：退出码 0。主 turn 19106ms 返回时 `backgroundActiveAtMainReturn=true`；worker 在主 turn 返回 30326ms 后落 marker，随后 `backgroundActiveAfterWorker=false`。因此 idle 回收门禁能区分“主会话已返回”和“后台实施已结束”。

## 边界

本轮未连接 DWS、未发送钉钉消息、未安装或重启常驻 service，也未部署。生命周期修改需要重启 Host 后读取数据库新值。
