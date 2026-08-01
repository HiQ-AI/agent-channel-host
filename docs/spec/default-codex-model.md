# 默认 Codex 模型配置

## 目标

Host instance 支持设置默认 Codex 模型与推理强度；未显式设置时使用 `gpt-5.6-sol + low`。配置同时覆盖新建 thread、恢复 thread 和每个 turn，且在真正使用前以当前 App Server 模型目录校验，不做静默降级。

## 当前契约

- 官方参考：[Codex App Server](https://developers.openai.com/codex/app-server/) 与 [GPT-5.6 模型指南](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6-sol)。
- `codex-cli 0.145.0` 的 `model/list` 返回模型 ID、默认推理强度和支持的推理强度。
- `thread/start` 与 `thread/resume` 接收 `model`；`turn/start` 接收 `model` 与 `effort`。
- 恢复 thread 时切换模型是 Codex 明确定义的行为：保留原 thread，并在下一轮应用一次模型切换指令。

## 方案

1. 在 instance YAML 的 `runtime` 增加 `codexModel`、`codexEffort`，Zod 默认值保证旧配置兼容。
2. `init --model/--effort` 支持初始化覆盖；`config model` 修改已有 instance，并明确要求重启运行中的 Host。
3. App Server 完成 initialize 后调用 `model/list(includeHidden=true)`。模型不存在或强度不受支持时 fail closed。
4. thread start/resume 显式传 `model`；turn start 每轮显式传 `model` 和 `effort`，避免运行态漂移。

## 边界

- 模型 ID 不做静态白名单，由实时 `model/list` 决定，以适应后续 Codex 模型发布。
- CLI 可接受的推理强度限定为当前 Codex 目录使用的 `low / medium / high / xhigh / max / ultra`；具体模型是否支持仍以实时目录为准。
- 本需求不改变凭据、sandbox、审批策略、thread 生命周期或 subagent 委派规则。
