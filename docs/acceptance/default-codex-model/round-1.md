# Round 1

## 自动化

- `npm test`：22/22 PASS。
- 覆盖默认值、旧配置缺字段补默认值、`init` 自定义、`config model` 修改与非法强度、实时模型目录校验。

## 真实 App Server

执行：

```powershell
$modelRoot = Join-Path $env:LOCALAPPDATA 'dingtalk-codex-host\model-canary'
node docs/acceptance/default-codex-model/scripts/default-model-canary.mjs $modelRoot
```

结果：

- 模型 `gpt-5.6-sol`，推理强度 `low`。
- 第一次 `startupMode=started`，完成 silent bootstrap 和 silent canary turn。
- 第二次 `startupMode=resumed`，thread ID 前缀与第一次一致，完成新的 silent canary turn。
- 脚本退出码 0，并在 finally 删除临时 instance；未连接 DWS、未发送钉钉消息。

## 后台委派回归

使用默认 `gpt-5.6-sol + low` 单独复跑委派 canary，退出码 0。主 turn 在 21968ms 返回，worker 在此后 26648ms 写入 12 字节 `WORKER_DONE`，随后后台忙碌状态释放。首次把 cwd 放在 `%LOCALAPPDATA%` 时 Windows sandbox helper 返回 `setup refresh had errors`；canary 已改为仓库内 `.test-*` 工作目录并独立复跑，确认是测试目录约束而非模型或委派逻辑回归。
