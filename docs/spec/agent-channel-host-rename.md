# agent-channel-host 重命名方案

## 目标

把独立模块从绑定首发实现的 `dingtalk-codex-host` 重命名为中立的 `agent-channel-host`，使项目名称与已经落地的 `ChannelAdapter → ConversationHost → RuntimeAdapter/AgentSession` 边界一致。

统一标识：

| 类型 | 新值 |
| --- | --- |
| GitHub | `HiQ-AI/agent-channel-host` |
| npm package | `@hiq-ai/agent-channel-host` |
| CLI binary | `agent-channel` |
| 用户状态目录 | `agent-channel-host` |
| 状态根环境变量 | `AGENT_CHANNEL_HOME` |
| Windows 计划任务前缀 | `agent-channel-host-` |
| App Server client/service | `agent-channel-host` / `Agent Channel Host` |

## 选择理由

- `agent-channel-host` 同时表达 Agent 产品与 Channel owner/Host 职责，不绑定消息平台或模型提供方。
- 不采用 `omnichannel-agent-host`：当前只实现 DingTalk adapter，使用 omnichannel 会过度宣称能力。
- 不采用 `channel-runtime-host`：虽然技术准确，但弱化了数字员工和 Agent session 的产品语义。

## 迁移策略

当前 package 尚未发布 npm，Host 也未安装或部署，因此采用一次干净的 0.x breaking rename：

1. 不同时发布旧、新两个 binary，不形成第二套产品入口。
2. 新 CLI 只读取 `AGENT_CHANNEL_HOME` 和新默认目录；检测到仅设置旧环境变量时 fail-fast，提示显式迁移，避免静默创建新状态库。
3. 旧状态目录和旧 Windows 计划任务不自动移动/删除。需要迁移时必须先停止旧 Host，备份 SQLite/WAL，再由用户按 runbook 明确处理。
4. SQLite schema、conversation/session ID、Channel ID `dingtalk`、runtime ID `codex` 和 provider session ID 不因产品改名而变化。
5. 出站幂等 UUID 的 namespace 切换为新产品名。当前无真实发送和部署；若未来已有旧实例，必须连同原 SQLite/outbox 迁移，不允许新旧 Host 并行。

## 验证

- 源码、package、README 和可执行验收脚本不再使用旧产品标识；历史 round 只允许以“原名”形式保留事实。
- `agent-channel --help/init/status/view --once` 使用新状态根实跑。
- 真实 Codex App Server 仍能 start、stop、精确 resume 同一 provider session。
- `npm run verify`、npm tarball 名、Windows/Ubuntu CI、PR、GitHub 仓库、origin URL 和本地目录全部回读新名称。

## 不在本轮范围

- 不实现第二种 Channel 或 runtime adapter。
- 不发布 npm registry package。
- 不安装或迁移 Windows 计划任务。
- 不启动真实 DWS 订阅，不发送钉钉消息。
