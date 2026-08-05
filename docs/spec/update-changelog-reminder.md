# 更新命令、变更日志与会话提醒间隔

## 目标

1. 提供 `agent-channel update`，通过当前环境的 npm 将 `@zzusp/agent-channel-host` 更新到 registry 最新版本，并以 npm 全局安装清单中的版本回读作为完成证据。
2. 在仓库根维护 Keep a Changelog 风格的 `CHANGELOG.md`，后续用户可直接查看未发布与已发布变化。
3. Conversation 持久化职责提醒间隔：默认 15，范围 0–99；0 只关闭按已完成 turn 数量触发的周期提醒，首轮及职责文本变化后的提醒仍保留。

## 现状与根因

- CLI 没有自更新入口，README 只能让用户手工执行全局 npm 安装。
- 仓库没有 CHANGELOG，发布版本与行为变化缺少面向用户的连续记录。
- 两个 Codex Runtime 都把周期常量硬编码为 15，Conversation 表没有可配置字段，View 和 CLI 也无法修改。

## 实现

- 新增自更新模块，固定更新当前 npm 包名，不接受任意包名或拼接 shell 字符串；依次执行 npm 全局安装和 `npm list --global` 版本回读，任一步失败即命令失败。
- 新增 `CHANGELOG.md`，建立 `Unreleased` 区段并记录本轮与近期尚未发版的重要行为变化。
- SQLite schema 升级到 v13，为 `conversations` 增加 `responsibility_reminder_interval INTEGER NOT NULL DEFAULT 15 CHECK(0..99)`；旧库迁移后自动取 15。
- Conversation 类型、创建入口、状态输出、View 设置与 CLI 管理命令贯通该字段。
- Runtime 每次 deliver 从 Store 读取当前 Conversation；职责非空时，首轮/职责变化仍提醒，只有 interval > 0 才累计并判断周期阈值。

## 验证

- 版本更新：注入假执行器验证固定 npm 参数、安装后版本回读和失败传播；真实环境只执行 npm registry 只读查询，不在测试中修改全局安装。
- 数据：新 Conversation 默认 15，0/99 可写，越界拒绝；v12 数据库迁移后为 15。
- Runtime：默认 15 保持原行为，间隔 2 提前提醒，0 不做周期提醒但职责变化仍提醒。
- View/CLI：设置项范围与输出字段回归；完整 `npm test` 和 `npm pack --dry-run`。

## 边界与取舍

- `update` 只支持 npm 全局安装形态；源码检出不执行 git pull。
- 不自动重启正在运行的独立 Host/service；更新命令完成后，当前 CLI 进程退出，后续新进程使用新版本。
- 提醒计数仍是 Worker 内运行态，Worker 重启后的首个 turn 会重新提醒；本轮不新增持久化计数器。
