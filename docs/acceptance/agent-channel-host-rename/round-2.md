# Round 2：远端与本地仓库改名回查

日期：2026-08-02

## 结论

REN-001～010 全部通过。GitHub 仓库、PR、`origin` 和本地检出目录已统一为 `agent-channel-host`；旧 GitHub 仓库地址由 GitHub 重定向到新仓库，不存在第二套仓库。

本轮没有合并 PR、发布 npm package、连接真实 DWS、发送钉钉消息、安装计划任务或部署服务。

## 远端提交与 CI

- 产品改名提交：`020ed84 refactor: 将项目重命名为 agent-channel-host`。
- PR：`https://github.com/HiQ-AI/agent-channel-host/pull/2`，状态 `OPEN`，合并状态 `CLEAN`。
- GitHub Actions run `30747256702`：`verify (windows-latest)` 与 `verify (ubuntu-latest)` 均为 `SUCCESS`。
- 两个 job 都在提交 `020ed84` 上执行 `npm ci` 与 `npm run verify`，验证 package、构建、28 项测试和 pack 清单。

## GitHub 仓库回查

仓库改名后通过 `gh repo view` 回读：

```text
nameWithOwner: HiQ-AI/agent-channel-host
url: https://github.com/HiQ-AI/agent-channel-host
defaultBranch: main
visibility: PUBLIC
description: Event-driven Channel host for isolated, resumable agent runtime conversations
```

使用旧路径 `repos/HiQ-AI/dingtalk-codex-host` 回读时，GitHub 返回的 `full_name` 与 `html_url` 均为新仓库，证明旧 URL 是重定向入口而不是并存仓库。

## 本地仓库回查

- 原目录 `D:\baibu-agent\dingtalk-codex-host` 不存在。
- 新目录 `D:\baibu-agent\agent-channel-host` 存在。
- `origin` 的 fetch/push URL 均为 `https://github.com/HiQ-AI/agent-channel-host.git`。
- 当前分支仍为 `feature/event-workers-view`，跟踪同名远端分支。

## 状态边界

这次改名只统一项目身份；首版 adapter 仍是 DingTalk DWS 与 Codex App Server。真实非 `@` 群消息 canary、服务安装和第二种 Channel/runtime adapter 仍属于后续里程碑。
