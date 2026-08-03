# Round 2：首次历史可观测性与安全协调

## 自动化结论

- 首次群历史与实时消息分开统计：`history_loaded/history_judged` 均可在状态和 View 中观察，会话表展示判断数与 onboarding 发送状态。
- `completed/submitted/delivered/delivery_unknown` 语义分离，旧的“静默但 submitted”数据在 schema v10 迁移为 completed。
- 显式协调测试覆盖只读 check、已可见时不重发、不可见时备份后单次发送，以及发送后群历史精确回读命中才 delivered。
- 首轮 `npm test` 92/92 PASS；修复钉钉空行折叠的可见正文比较后，定向 4/4 PASS，最终全量结果记录于下方。

## 真实验证

1. 精确停止唯一 Host 及其两个直属 DWS 子进程后，三者均不存在；等待 lease 到期，不改 lease 绕过门禁。
2. `delivery --check` 回读 `historyLoaded=2`、`historyJudged=2`、`visibleMatches=0`，状态仍为 `delivery_unknown`。
3. apply 先以 SQLite `VACUUM INTO` 生成 176128 字节完整备份，再使用新内容绑定 UUID 单次发送；DWS 明确接受，但 5 秒内逐字符回读因钉钉折叠一个空行而暂记 `submitted`，没有冒充 delivered，也没有再次发送。
4. 独立 DWS 列表回读新增 1 条发送者为当前用户、时间为 2026-08-03 21:57:38 的消息；正文与准备回复在 NFKC + 空白规范化后哈希一致。代码只放宽平台空白差异，并增加 submitted 已可见时只升级 delivered 的路径；4/4 定向测试通过。
5. 第二次 apply 在 `visibleMatches=1` 时只备份并标记 `delivered`，`action=already_visible`，未调用发送。重启最新版唯一 Host 后：Host/Channel/Runtime=`running/ready/ready`、alerts=0、history=`2/2`、onboarding=`delivered`、pending inbox/outbox/onboarding 全为 0；进程树为一个 foreground owner 和一个 ephemeral group consumer。
6. Host 运行中再次执行只读 check，仍为 `state=delivered`、`visibleMatches=1`，形成独立群历史回读证据。

最终 `npm run verify`：94/94 tests PASS；`npm pack --dry-run` PASS，共 72 files；`git diff --check` PASS。matrix 的 DIS-009 至 DIS-013 全部转为 PASS。
