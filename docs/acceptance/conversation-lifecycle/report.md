# 每会话生命周期验收报告

## 结论

`matrix.csv` 的 9 个用例在 round 1 全部通过。群聊和私聊均可独立选择 `resident/idle`；默认群常驻、私聊空闲 5 分钟；释放后可精确恢复原 thread。

## 已证明

- v1/v2 数据升级到 v3 后，群聊和私聊获得正确默认策略；
- CLI 可以在添加时指定策略，也可以修改既有会话策略与超时；
- resident 会话启动预热且没有空闲回收任务；
- idle 计时会被新消息重置，主 turn、队列或后台 worker 活跃时不会释放；
- 本机真实 App Server 在 stop 后以同一 thread ID resume，并能继续执行新 turn；
- 现有群 onboarding 和后台委派功能没有回归。

## 未宣称

- 未验证真实 DWS 消息到达后的 5 分钟墙钟 E2E；计时和唤醒链由控制器测试与 App Server resume canary 分层证明；
- 未重启用户级常驻 service，未部署或合并；
- idle 释放不等于删除 Codex rollout 或会话内容。
