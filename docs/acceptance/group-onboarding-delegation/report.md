# 群 onboarding 与后台委派验收报告

## 结论

`matrix.csv` 的 11 个用例在 round 1 全部通过，代码实现、本机 App Server canary、包检查和文档同步均已完成。

## 已证明

- 群首次启动只读获取最近 50 条消息，整理后交给该群固定主 thread 生成一次介绍；
- `shadow` 不发送，切到 `reply` 并重启后发送已准备介绍；失败以相同 UUID 重试，成功后不再重复；
- v1 已登记群会补建 onboarding 状态；
- 实施类请求必须出现真实子 thread ID，主 thread 直接执行或修改文件会 fail closed；
- 真实 Codex App Server canary 中，主 turn 先返回，后台 worker 约 25.7 秒后完成；
- actor 不等待后台 worker，可继续消费下一条群消息；
- 原有 admission、freshness、lease、CLI 和打包行为无回归。

## 未宣称

- 未执行真实钉钉群历史拉取或介绍发送 E2E；
- DWS 事件流和介绍发送不宣称端到端 exactly-once；
- `submitted` 仍只代表 DWS 调用成功，不代表群成员已读。
