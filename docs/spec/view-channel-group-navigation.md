# View Channel 群组管理与层级导航方案

## 目标

补齐跨 Instance `agent-channel view` 的四个可用性缺口：

1. `Instance → Channel` 成为可见且可选择的下钻层级，Channel 页第一项直接启用或停用该 Channel。
2. Channel 页展示已绑定群组，并支持关键词搜索、候选选择和绑定。
3. 非编辑态导航统一为 `↑/↓` 选择、`Enter/→` 下钻或执行、`Esc/←` 返回；`Tab` 只切换顶层“总览 / 全局设置”。编辑态的 `←/→` 用于移动文本光标。
4. 交互式 View 使用终端 alternate screen，刷新帧不进入主终端 scrollback，退出或异常时恢复原终端；`view --once` 保持普通纯文本输出。
5. Instance 设置和其他表格按终端显示宽度布局中文、全角字符与组合字符；退出 View 前显示二次确认，取消后保留当前导航和编辑状态。

本轮只实现现有 DingTalk adapter 的群搜索，不实现第二种 Channel 或 Runtime，不连接真实 DWS，不发送消息，也不新增接收服务。

## 现状与根因

- Channel toggle 已存在，但被放在 Instance 设置长列表的第八项；Instance 详情中的 `CHANNELS` 表没有选择光标，用户无法从视觉层级发现入口。
- `conversation add --kind group` 已能通过 DWS 精确群名解析并写入现有 conversation registry，但 TUI 没有搜索与选择流程。
- 当前 reducer 把 `←/→` 与 `Tab` 一并处理成顶层 tab 切换，破坏层级导航直觉。
- 当前 repaint 只输出 `CSI 2J` 和 home；它清除当前画面但不切换终端缓冲区，因此历史帧仍留在主终端 scrollback。
- 表格的 natural width、truncate 和 pad 都使用 JavaScript `String.length`；中文在 Windows Terminal 通常占 2 列却只计 1，导致 Instance 设置的三列视觉边界错位。
- `q/Ctrl+C` 直接调用 stop；退出会停止 View-owned Host，但用户没有确认或取消机会。

## 参考交互

Claude Code agent view 的公开契约采用单屏主列表、方向键选择、`Enter/→` attach、`←` 返回，并以当前层动作提示降低快捷键记忆成本。本项目只借鉴导航语义与整屏管理方式，不复制其后台 Agent/session 业务模型。

参考：<https://code.claude.com/docs/en/agent-view>

## 信息架构

```text
总览
└─ Instance
   ├─ Channel
   │  ├─ Channel 状态（enabled / disabled）
   │  ├─ 已绑定群组
   │  └─ 搜索并绑定群组
   ├─ Conversation
   │  └─ 会话详情
   └─ Instance 设置

全局设置
```

Instance 详情把 Channel 和 Conversation 都作为可选择对象。进入 Channel 页后，第一行固定为状态 toggle，后续为该 `(channelId, profileId)` 下的群 conversation，末行为“搜索并绑定群组”。

## 群搜索与绑定

### 搜索契约

View 通过 composition root 注入只读 `searchGroups(instance, query)` action。DingTalk 实现调用已有 `dws chat search --query <query> --format json`，只投影：

- `title`
- `openConversationId`（只在内存中用于绑定，不在 View 展示）

空标题、空 ID 和重复 ID 被过滤。测试注入合成候选，不执行本机账号搜索。

### 绑定契约

选择候选后直接复用当前 Instance 的 `Store.addConversation`：

- `kind=group`
- `channelId/profileId` 来自当前 Channel
- `runtimeId` 来自当前 Instance runtime
- `responsibility` 默认继承 `identity.role`
- `mode=shadow`

因此允许列表、固定 runtime session、onboarding、durable inbox 和唯一 Channel owner 都继续走现有路径，不增加 Channel 专用数据库或第二套 listener。已绑定候选不重复插入，选择后直接进入原会话详情。

## 导航状态机

- 顶层总览：`↑/↓` 选择 Instance；`Enter/→` 下钻；`a` 新增；`Tab` 切到全局设置。
- Instance：`↑/↓` 在 Channel 与 Conversation 间移动；`Enter/→` 下钻；`s` 打开 Instance 设置；`Esc/←` 返回总览。
- Channel：`↑/↓` 选择状态、已绑定群组或新增项；`Enter/→` 切换/下钻/开始搜索；`Esc/←` 返回 Instance。
- 搜索输入：Enter 执行搜索；`Esc/←` 返回 Channel。
- 搜索结果：`↑/↓` 选择；`Enter/→` 绑定或打开已绑定会话；`Esc/←` 返回搜索输入。
- Conversation：`s` 打开 Instance 设置；`Esc/←` 返回来源 Channel 或 Instance。
- Instance 设置：`↑/↓` 选择；`Enter/→` 编辑或切换；`Esc/←` 返回。
- 全局设置：`Esc/←` 返回总览；`Tab` 也只在顶层切换。

每个页面底部只显示当前层真实可用动作。`Enter` 保留为键盘兼容入口，方向键是主要层级语义。

字段设置、Instance 新增向导和群搜索输入共用一套单行编辑行为：`←/→` 移动光标，Home/End 跳到首尾，Backspace 删除光标前字符，Delete 删除光标后字符，Enter 提交，Esc 取消或返回。光标位置由 reducer 显式保存，刷新不得把它重置到行尾。

表格布局使用终端 display width：ASCII/半角字符宽 1，中文、全角和常见 emoji 宽 2，组合标记和 variation selector 宽 0；截断后的省略号也计入目标宽度。列宽计算、truncate 与 pad 必须使用同一函数，避免只修其中一层后仍漂移。

`q` 或 `Ctrl+C` 在非确认态只打开退出确认；确认层明确说明会停止 View-owned Host、attached Host 不受影响。再次按 `q`、`Ctrl+C` 或 Enter 才退出，`Esc/←` 取消并回到原页面；打开确认不得清空正在编辑的值或群搜索草稿。

## 终端生命周期

交互式 `runView` 在启用 raw mode 后写入：

- `CSI ?1049h`：进入 alternate screen；
- `CSI ?25l`：隐藏光标。

每次刷新只在 alternate screen 内 home + clear。`finally` 无论正常退出、SIGINT/SIGTERM 或渲染异常，都先恢复光标，再用 `CSI ?1049l` 返回主屏。`view --once` 不写这些控制序列。

## 验证

- DWS parser：合成搜索返回投影、去重、非法项过滤；精确搜索继续要求唯一匹配。
- Reducer：Channel 可选择下钻、toggle、群搜索、候选选择、重复绑定、左右键逐层返回；三类文本输入支持中间插入、移动和前后删除。
- Store：新群写入现有 registry，职责继承 Agent 角色、默认 shadow、Channel/runtime 映射正确。
- Renderer：Channel 页、已绑定群、搜索页、底部动作栏和选中态可见，不显示外部群 ID。
- TTY：真实 Windows pseudo console 观察 alternate-screen enter/exit、`→/←`、Channel toggle、合成搜索/绑定、退出恢复。
- Layout/exit：中文 Instance 设置表各列 display width 对齐；真实 TTY 第一次退出键出现确认且 View 仍存活，第二次确认后才退出，取消确认保持原页面。
- 回归：`view --once` 无 ANSI/alternate-screen；`npm run verify` 和 pack dry-run 全绿。

## 边界与回滚

- 群搜索是只读 DWS 调用；绑定只写本地 allowlist，不自动发送介绍或消息。
- Channel disabled 时仍允许配置群组，但事件消费保持关闭；重新启用后复用原 registry。
- attach 的外部 Host 仍不会被 View 停止；Channel 开关只保存并提示重启。
- 回滚本轮代码不会破坏既有 config 或 SQLite schema，因为不新增持久化字段或表。
