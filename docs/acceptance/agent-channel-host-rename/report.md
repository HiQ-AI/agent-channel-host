# agent-channel-host 改名验收报告

## 结果

Round 2 的 10/10 用例全部通过，状态以 `matrix.csv` 为准。

项目身份已统一为：

- GitHub：`HiQ-AI/agent-channel-host`
- npm package：`@hiq-ai/agent-channel-host`
- CLI：`agent-channel`
- 状态目录：`agent-channel-host`
- 状态根环境变量：`AGENT_CHANNEL_HOME`
- Windows 任务前缀：`agent-channel-host-`
- App Server client/service：`agent-channel-host` / `Agent Channel Host`

已验证 package、CLI、状态根、服务标识、App Server resume、SQLite/adapter 兼容边界、Windows/Ubuntu CI、GitHub 仓库、PR、`origin` 和本地目录。旧环境变量会明确 fail-fast；旧 GitHub 地址只重定向到新仓库，不形成第二套实现。

## 未覆盖

- 未连接真实 DWS，未向钉钉发送消息。
- 未安装计划任务或部署服务。
- 未发布 npm registry package。
- 未实现第二种 Channel 或第二种 runtime adapter。

详细证据见 `round-1.md` 与 `round-2.md`。
