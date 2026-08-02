# 上下文恢复与管理型 View

## 目标

本轮同时解决两个已确认缺口：

1. Runtime session 允许自动压缩，但压缩后必须恢复当前会话的重要工作状态；群成员、角色和职责等资料不长期塞入 transcript，而由 Host 独立维护并按需提供。
2. `agent-channel view` 从只读快照升级为默认前台入口：启动 Host，先显示跨 Channel、conversation、runtime 的总览，再进入单会话详情或设置 tab。

首版仍只实现 DingTalk DWS + Codex CLI，不启动第二个 Channel owner，不把 Codex hook 写入 Host 公共契约。

## 当前差距

- `runHost()` 独占前台直到收到进程信号，不能由 TUI 启动和停止；Host JSONL 日志会破坏 ANSI 界面。
- `view` 只定时渲染一个全量文本页面，没有 tab、选择状态、详情或配置写入。
- 每轮 Codex command 都恢复固定 provider session，但业务状态只存在 transcript；自动 compaction 后没有 Host 管理的恢复输入。
- `conversations.responsibility` 是稳定配置，成员资料只散落在入站消息 sender 字段中，没有独立版本和角色/边界字段。
- Prompt 分散在 `decision.ts` 与 `actor.ts`，说明性文本偏长，缺少统一结构。

## 状态分层

### Runtime transcript

保存自然讨论过程，由 runtime 自己 resume 和 compaction。正常 turn 不重复注入完整历史或完整 checkpoint。

### Conversation checkpoint

Host 在 SQLite 中保存每个 conversation 的短小、版本化恢复状态：

- 当前主题；
- 仍有效的事实；
- 已形成的决定；
- 承诺；
- 未决问题；
- 覆盖到的最新入站 sequence。

Runtime 的结构化输出增加 `contextUpdate`。无长期状态变化时为 `null`；有变化时返回完整有效 checkpoint，由 Host 与 batch decision 在同一 SQLite 事务提交。Host 不接受自由文本覆盖数据库其他字段。

### Conversation members

Host 独立维护成员资料。入站消息按 `senderId` 自动更新观察到的名称；组织角色、会话角色和职责边界由受控配置更新。每条记录带版本和更新时间。

普通 batch 只附加本批发送者，以及正文明确提到的已知成员；不注入完整群成员表。原始消息仍是最终可追溯来源。

### Policy

Agent 身份、默认角色、conversation responsibility、mode 和工具/发送门禁仍由 Host 掌握。Prompt 只表达决策所需内容；发送权限继续由 Host 在模型外校验。

## Compaction 恢复

RuntimeAdapter 负责把 Host recovery context 映射到自己的机制。公共 `AgentSession` 不暴露 Codex event 名称。

Codex 首版使用官方 `SessionStart` hook，matcher 为 `source=compact`：

1. Host 在每个 turn 启动前原子发布当前 conversation 的 recovery context 文件。
2. Codex command 只为该进程配置受 Host 控制的 bundled hook，并显式启用已审查 hook。
3. 自动或手动 compaction 后，hook 在下一次 model request 前读取 recovery 文件，并以额外 developer context 注入。
4. 新建 provider session 或显式新 generation 时，Host 也把 checkpoint 附加到首个 turn；普通 `resume` 不附加。
5. recovery 文件不包含 token、完整成员表或原始消息，只包含 identity/policy 版本与 checkpoint。

无法提供可靠 compaction event 的后续 RuntimeAdapter 必须声明能力缺失，采用其官方等价机制或在 session 重建时恢复；不得伪装成已支持。

## Prompt 规范

Prompt 统一由一个模块生成，固定顺序为：

1. 身份；
2. 当前 conversation 职责；
3. 决策规则；
4. 权限边界；
5. 当前输入；
6. 输出要求。

每条指令只表达一个动作，使用明确动词，不写背景叙事，不重复规则，不使用“尽量、酌情、视情况”等模糊措辞。`contextUpdate` 只在长期状态改变时返回；变更时必须给出完整有效 checkpoint。

## `view` 生命周期

### 默认交互模式

`agent-channel view --instance <name>`：

1. 先验证交互式终端并打开状态库。
2. Host lease 未运行时，在当前进程内启动唯一 Host；TUI 立即显示 `starting`，不等待 DWS 完全 ready。
3. Host lease 已运行时只 attach 到现有状态，不启动第二个 owner。
4. TUI 吞掉 Host 结构化日志，转为状态/notice，不向 stdout 穿插 JSONL。
5. 用户退出时：只停止本次 view 启动的 Host；attach 模式只退出界面。

`--once` 保持机器可用的只读快照语义，不启动 Host。

### 交互

- 默认 tab：`总览`；相邻 tab：`设置`。
- `Tab` 或左右方向键切换 tab。
- 总览用上下方向键选择 conversation，`Enter` 打开详情，`Esc` 返回。
- 设置 tab 用上下方向键选择可编辑项，`Enter` 开始/保存，`Esc` 取消。
- `q` 或 `Ctrl+C` 退出。

总览必须覆盖全部 Channel、消息计数、conversation、runtime adapter、session/Worker 和告警，不以单群为入口。详情仅显示当前选中 conversation 的脱敏状态、checkpoint 版本、成员数量和最近消息；正文仍需 `--show-content` 显式开启。

### 设置

首版支持：

- Agent 名称、默认角色、签名；
- runtime model、reasoning effort；
- quiet window、batch 上限；
- 当前 conversation 的 responsibility、mode、Worker warm TTL；
- 已观察成员的组织角色、会话角色、职责边界。

配置先通过同一 Zod schema 校验，再原子写入 `config.yaml`。conversation/member 字段通过 Store 的受限方法写入。当前 view 自己启动的 Host 在后续 turn 读取新值；attach 到外部 Host 时，文件级配置明确显示“重启后生效”。

发言前重新读取 conversation 的 enabled/mode，Codex 每轮从 Store 读取当前 responsibility，避免 warm Worker 使用陈旧边界。

## 验收边界

- 自动测试不得连接真实 DWS 或发送消息。
- fake Channel/Runtime 验证 Host 可嵌入启动和停止、不会重复 owner。
- direct hook canary 验证 `source=compact` 输出当前 recovery version；真实 Codex verify 至少证明 hook 配置可被固定版本解析。
- TUI 使用纯状态 reducer 和 renderer 测试 tab、选择、详情、编辑、校验及脱敏；真实交互终端做一次本地启动/退出 smoke。
- README 必须以 `view` 为首选前台入口，保留 `run` 供 headless service 使用。
