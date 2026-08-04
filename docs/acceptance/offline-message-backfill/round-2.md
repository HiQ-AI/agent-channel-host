# Round 2

## 触发原因

PR #28 首轮 GitHub Actions 的 Ubuntu job 在 100 个测试中失败 2 个；Windows job 因 matrix fail-fast 被取消，未执行项目测试。

## 根因

DWS 的 `yyyy-MM-dd HH:mm:ss` 不含时区。实现与旧 SQLite 水位解析依赖运行机器本地时区：Windows 开发机为 Asia/Shanghai 时通过，Ubuntu runner 以 UTC 解释后偏移 8 小时，导致水位错误和补拉结果被截止时刻过滤。

## 修复

- DWS 时间格式化固定使用 `Intl.DateTimeFormat(..., timeZone: 'Asia/Shanghai')`。
- 无时区 DWS 时间与旧 SQLite `occurred_at` 固定追加 `+08:00` 解析；已有 ISO/显式 offset 保持原值。
- 原首次群历史测试改用带 `+08:00` 的绝对测试时刻，避免 fixture 随 runner 时区变化。

## 证据

- `$env:TZ='UTC'; npm run verify`：100/100 tests PASS，`npm pack --dry-run` PASS、68 files；在本机强制 UTC 后复现 CI 时区并验证修复。
- `git diff --check`：PASS。
- 首轮失败 Actions run：`30890133641`，Ubuntu 失败断言分别为水位偏移 8 小时与补拉事件被全部过滤。
