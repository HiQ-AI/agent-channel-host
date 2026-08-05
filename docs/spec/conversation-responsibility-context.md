# 会话职责上下文方案

## 目标

1. Instance 只保留本地展示用的 Agent 名称；删除默认角色和回复签名。
2. Conversation 可独立配置职责；未配置表示沿用 Agent 在 runtime 工作目录中的自身定位。
3. 普通消息输入继续只有发送者、时间、内容，不把职责混入消息信封或历史消息。
4. 会话职责以低频、可预测的周期提醒降低压缩遗忘风险，不在每个 turn 重复。
5. 公共契约不绑定 Codex 的压缩事件或 developer/system 指令配置。

## 当前事实

- `identity.name/role/signature` 都位于 version 2 配置；`role` 只被自动建档、群搜索绑定和 CLI 缺省职责使用，`signature` 已不参与出站。
- `conversations.responsibility` 已持久化并带 `policy_version`，但当前明确只作本地备注。
- 普通 turn 的 prompt 已收窄为发送者、时间、内容和最小 `silent/reply` 返回约定。
- 各 CLI 的压缩事件、hook 信任和 developer/system 指令覆盖能力不同，不能作为公共正确性基础。

## 选择

采用“短职责周期提醒，大资料外置查询”。

### Instance 配置

```yaml
identity:
  name: 小小鹏
```

- `identity.name` 只用于 TUI、状态和日志标签，不进入 runtime prompt。
- 旧 version 2 文件中的 `identity.role/signature` 由 schema 忽略；下一次原子保存时自然移除，不保留双路读取。
- `init` 与 TUI 新建 Instance 不再询问默认角色。

### Conversation 配置

- `responsibility` 继续由 Conversation 持久化；允许空字符串。
- 空值表示没有 Host 侧职责覆盖，Agent 只使用 runtime 工作目录中的自身角色。
- CLI 显式传 `--responsibility`、TUI 编辑或平台配置非空值时，下一次 runtime 调用立即使用最新值。
- 自动建档和群搜索绑定不再继承 Instance 角色，初始职责为空，用户可在 Conversation 详情中配置。
- `policy_version` 继续在职责变化时递增，用于状态、审计和测试，不进入普通消息。

### Runtime 契约

`RuntimeAdapter.createSession()` 获得 Conversation；每次执行前由 adapter 重新读取当前 Conversation，而不是使用 Worker 启动时的旧副本。非空职责使用以下简短提醒：

```text
# 会话职责提醒
<Conversation responsibility>
```

提醒只在以下时机置于本轮消息之前：

1. 当前 Worker/Runtime session 对象的首个 turn；
2. Conversation 职责相对上次成功注入发生变化后的首个 turn；
3. 上次成功注入后每满 15 个已完成 turn。

其余 turn 仍只包含新增消息和最小返回约定。Host/Worker 重启后内存计数归零，因此恢复固定 provider session 的首个 turn 会再次注入；失败或被新消息中断的 turn 不推进周期，重试仍会带上原提醒。该方案不安装 hook，不覆盖用户的 `developer_instructions`，也不要求 RuntimeAdapter 暴露压缩事件。

反证边界：Host 无法获知所有 runtime 的准确压缩时刻，所以不能保证“压缩后的紧接一轮”一定已有职责；最坏会在 14 个不带提醒的已完成 turn 后再次注入。用户接受以这个简单、跨 runtime 的周期策略替代精确 compaction hook。

### 外置资料

群成员、组织角色、成员职责边界、历史事实和其他可能膨胀的数据不进入固定前缀。它们继续存于 Host/Agent 可查询的数据源，由 Agent 在确有需要时通过受控工具读取；数据变更只更新源数据，不向 transcript 广播全文。

## 失败边界

- Conversation 职责只影响 Agent 判断，不改变 Channel 准入、mode、freshness 或发送门禁。
- 会话职责提醒与 Channel 消息一样会进入 transcript，不能宣称具备 developer/system 层级；Agent 自身的安全与权限边界仍必须由 runtime 工作目录管理。
- 职责更新不重建 provider session；下一次调用使用新值。正在执行的 turn 继续使用启动时快照，新消息抢占后自然使用新值。
- 不向用户的 runtime cwd 写 hook，不修改 Codex 用户级配置，不使用 hook trust bypass。
- 本轮不重启真实 DWS owner、不发送钉钉消息。

## 验证

1. 旧配置可读取，规范化结果只有 `identity.name`，再次保存后 role/signature 消失。
2. `init --help`、TUI 新建和 Instance 设置均没有默认角色/回复签名。
3. 自动建档、群搜索绑定和省略 `--responsibility` 的 CLI Conversation 职责为空。
4. 普通消息 prompt 不含 Agent 名称、职责或签名。
5. 首轮、职责变更后首轮和第 16/31/... 轮含一份职责提醒；中间 turn 不含；失败/中断不推进周期；空职责始终不含。
6. 多次 resume 保持同一 provider session，周期中间的消息 prompt 不含职责正文。
7. TUI/CLI、全量测试、pack、README/SECURITY 和隔离状态验证通过。
