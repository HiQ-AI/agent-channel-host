# Round 1：最小消息代理与隔离恢复

## 结论

代码、自动化、打包、隔离真实 Codex、合成定点重置和授权测试群真实消息备份的隔离重放均通过。Host 已完全取消 turn 超时，真实消息 turn 运行 268.2 秒后由 Codex 自行完成，没有在旧 180 秒阈值被终止。真实用户级实例当前没有任何 Conversation 或入站消息，目标会话匹配数为 0，因此没有进入真实用户级实例 apply 或群内重放；MFP-012 保持 FAIL。

## PASS 证据

### 自动化与打包

```powershell
npm run verify
```

- 75/75 tests PASS。
- `@hiq-ai/agent-channel-host@0.8.0` pack dry-run PASS。
- tarball 69 files。

覆盖点包括：

- 普通 turn 与首次群历史只含发送者、时间、内容。
- 最小 `silent/reply + replyText` schema。
- Agent 命令/工具 JSONL 不触发 Host 行为审查。
- 首次群历史 `silent` 持久完成且不发送、不重复读取。
- 首次群历史 `reply` 在 shadow 保存、切 reply 后稳定 UUID 发送。
- decision、inbox 完成和可选 outbox 同事务。
- claimed/failed/未落盘历史 turn 的重启 generation reset。
- active turn 中断重合批、outbox freshness 与有界恢复。
- 配置不再暴露 turn 超时；旧字段被忽略，超过旧测试阈值的活动 turn 正常完成。
- 活动 claim 的 `claim_expires_at_ms` 为 `NULL`，不会因运行时长被其他 Worker 重新 claim；遗留 claim 由启动 reconciliation 恢复。
- Codex argv 不再覆盖审批、sandbox、网络或 writable roots；Agent 权限由 runtime 自身配置决定。
- SQLite v8 迁移会丢弃未提交的旧 onboarding 自我介绍草稿，避免新协议继续发送旧行为文案；已提交状态不重放。

### 隔离真实 Codex

```powershell
node docs/acceptance/message-forwarding-proxy/scripts/codex-message-proxy-canary.mjs <empty-D-drive-state>
```

回读：

- runtime：`codex-cli 0.145.0`
- Host 未传入审批、sandbox、网络或 writable roots 覆盖参数。
- 首轮：`startupMode=new`，决定为 `{"action":"silent","replyText":""}`
- 次轮：`startupMode=resumed`
- 完整 provider session ID 相同
- 次轮只依赖同 session transcript，成功回忆首轮随机标记
- 未连接 DWS、未发送钉钉消息

### 定点重置脚本

```powershell
node docs/acceptance/message-forwarding-proxy/scripts/reset-target-message.mjs --check ...
node docs/acceptance/message-forwarding-proxy/scripts/reset-target-message.mjs --apply ... --backup-dir <new-directory>
```

在 D: 合成实例中：

- check 前后 SQLite SHA-256 相同。
- apply 前备份 `state.sqlite3`、WAL、SHM；备份非空。
- 只把目标 sequence 从 completed 恢复为 admitted。
- 只删除目标 decision/outbox。
- session generation 1 → 2，旧 provider mapping 删除并有 reset audit。
- 其他 Conversation/消息不清空。

### 真实消息备份隔离重放

从既有只读备份创建全新的 D: 隔离副本，先执行 `--check`，再执行带独立备份目录的定点 `--apply`，最后运行真实 Codex：

```powershell
node docs/acceptance/message-forwarding-proxy/scripts/isolated-message-replay.mjs <isolated-instance-directory> <conversation-title>
```

回读结果：

- turn 总耗时：268.2 秒，超过旧 180 秒限制后仍继续运行。
- inbox：`completed`，`failure_count=0`，`last_error=NULL`。
- decision：`action=reply`，回复文本非空。
- runtime session：generation=2，lifecycle=ready，provider session 已创建。
- 日志：`WORKER_READY → BATCH_COMPLETED → OUTBOX_SUBMITTED`。
- ChannelAdapter 使用脚本内存 sender；未启动 DWS、未连接钉钉、未真实发送群消息。隔离库中的 `submitted` 只表示内存 sender 已接收。
- 隔离目录：`D:\baibu-agent\scratchpad\sg3o-no-turn-timeout-1785749422232`。

## 未通过项与边界

对真实
`%LOCALAPPDATA%\agent-channel-host\instances\<instance>\state.sqlite3`
执行只读检查：

- schema version：7
- conversations：0
- inbound_events：0
- runtime_sessions：0
- 目标群 title + sequence=1 匹配数：0
- check exit：1
- check 前后 `state.sqlite3` SHA-256 相同

因此当前没有可安全定点重放的真实记录。未执行 C: 写入、未创建真实备份、未启动 Host/DWS、未发送群消息。
