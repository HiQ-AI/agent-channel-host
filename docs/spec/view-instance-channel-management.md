# TUI Instance 与 Channel 管理方案

## 目标

在现有跨 instance `agent-channel view` 中补齐三项管理能力：

1. 顶层导航只分为 `总览 | 全局设置`；`INSTANCES` 是总览内的下钻入口，每个 instance 从详情继续进入独立设置页，`全局设置` 不混入任何 instance 配置。
2. Instance 设置页按 Channel 条目展示启停状态；首版支持 DingTalk，交互和设置条目不写死为单一 Channel 页面。
3. 总览的 `INSTANCES` 表可启动新增 instance 向导；创建后立即加入当前 TUI，无需退出后再执行 `agent-channel init`。

本轮不实现第二种 Channel adapter，不连接真实 DWS，不改变 conversation/session/runtime 数据模型。

## 当前缺口

- 旧 Settings 直接把 `selectedInstance` 的全部设置铺在一个页面，没有 instance 索引层，零 instance 时只能提示外部运行 `init`；同时它实际承载 instance 配置却命名为 Settings，容易被误认为全局设置。
- `channel` 配置没有启停字段；`runHost` 无条件创建 DWS adapter、取得 profile owner lock 并启动 consumer。
- CLI `init` 的配置写入和 Store 初始化内嵌在 Commander action 中，TUI 无法安全复用。
- `runView` 只接收启动前固定的 instance 数组，不能把新 instance 交给现有 Host 所有权管理。

## 交互设计

### 顶层导航与全局设置

顶层固定为 `总览 | 全局设置`。`总览` 展示并管理其中的 `INSTANCES`；`全局设置` 明确声明作用域为整个 View/Host。当前没有已经收敛的全局可修改契约，因此首版只显示全局管理状态和“暂无可修改项”，不把 instance 配置伪装成全局配置，也不凭空增加未经需求确认的持久化参数。

### 总览内的 INSTANCES 下钻

总览的 `INSTANCES` 区域显示 instance 表，末行固定为“新增 Instance”。

- `↑/↓` 或 `j/k`：选择 instance 或新增项。
- `Enter`：先进入所选 instance 的详情；在新增项上启动向导。
- `s`：只在 instance/conversation 详情中进入该 instance 的独立设置页。
- `a`：在总览直接启动新增向导。
- `Esc`：instance 设置页返回原 instance/conversation 详情，再逐层返回总览。

### Instance 设置页

设置按 `INSTANCE`、`CHANNELS`、`CONVERSATION`、`MEMBERS` 分组。普通字段仍按现有方式编辑；Channel 启停是 toggle，`Enter` 直接切换，不进入文本编辑。

Channel toggle 先使用统一 config schema 校验并原子写入。若 Host 由当前 view 启动，则当前 view 只重启这个 instance，使启停立即生效；若 Host 是 attach 的外部 owner，只保存配置并明确提示需要重启外部 Host，绝不终止不属于当前 view 的进程。

### 新增 Instance 向导

向导依次收集：

1. instance 名称；
2. runtime cwd，默认当前工作目录；
3. Agent 名称，默认 `DingTalk Agent`；
4. 默认角色。

每一步都可 `Esc` 取消。instance 名称复用现有安全名称校验；最终创建复用 CLI `init` 的共享初始化函数和 `writeInitialConfig(..., flag=wx)`，禁止覆盖已有 instance。

TUI 新建 instance 的 DingTalk Channel 默认关闭，避免在用户尚未确认 profile 时立即抢占已有 DWS owner。创建完成后进入该 instance 设置页，用户显式开启 Channel；CLI `init` 保持既有默认开启行为。

## 配置与 Host 生命周期

在现有 `channel` 对象增加 `enabled: boolean`，缺省按 `true` 解析，保证已存在 version 2 配置行为不变。首版仍只有 DingTalk 配置；View 通过 `configuredChannels(config)` 生成 Channel 设置条目，未来增加 adapter 时扩展该统一列表，不复制 DingTalk 专用 Settings 页面。

`runHost` 的行为为：

- `enabled=true`：沿用现有 DWS adapter、profile owner lock、事件准入和受控发送链路。
- `enabled=false`：不创建或启动 DWS adapter、不取得 DWS profile owner lock，Store 记录 `disabled`；Host 的 instance lease、runtime 状态与管理面仍可运行。

停用 Channel 不删除 conversation、session、checkpoint、消息或 outbox。重新启用后仍使用原 conversation/runtime session 映射。

## 共享初始化边界

新增 `instance.ts` 承担 config + Store bootstrap，它是 CLI `init` 与 TUI create 的共同应用层入口；新文件的理由是该逻辑横跨 config、paths 和 Store，不应继续埋在 CLI，也不能让 View 反向依赖 Commander composition root。

初始化结果只包含 config、config path 和 state path，不包含凭据。TUI 打开自己的 observer Store；Host 启动仍由 CLI composition root 的唯一管理器负责。

## 验证

- Config：旧 version 2 缺少 `channel.enabled` 时解析为开启；默认配置为开启。
- Host：关闭 Channel 后不调用 adapter start/stop、不取得 profile owner lock，状态为 `disabled`；重新启用仍走原唯一 owner 路径。
- 初始化：CLI 与 TUI 共用初始化函数，重复名称 fail closed，TUI 默认 Channel 关闭。
- Reducer/renderer：两顶层 tab、全局设置边界、总览 INSTANCES 下钻、独立设置页、返回、toggle、创建向导及零 instance 创建路径。
- 真实 Windows TTY：跨 instance 下钻、进入 instance 设置、关闭 Channel、返回、新增 instance、创建后立即可见、退出。
- 回归：`view --once` 仍只读无 ANSI，Host/Runtime/conversation 既有测试和 pack dry-run 全绿。

## 边界与回滚

- 本轮只实现 DingTalk adapter，不宣称多 Channel 已完成；只固化统一 Channel 设置条目与启停生命周期。
- 不自动停止 attach 的外部 Host，不删除任何 state，不发送消息。
- 回滚代码后，带 `enabled` 的 version 2 YAML 对旧 schema 会因未知键的 Zod 默认 strip 行为被忽略并恢复既有开启行为；若需要保持停用，回滚前应先停止对应外部 Host。
