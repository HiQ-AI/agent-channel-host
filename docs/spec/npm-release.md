# npm 发布流程

## 发布目标

- 公开包：`@zzusp/agent-channel-host`
- Registry：`https://registry.npmjs.org/`
- CLI：`agent-channel`
- 发布源：已合并并通过 CI 的最新 `main`

## 首次配置

在 GitHub 仓库中创建 `NPM_PUBLISH` Environment，并在该 Environment 中配置 npm automation token：

- Secret 名称：`NPM_PUBLISH_TOKEN`
- npm token 必须有 `@zzusp` scope 下公开包的发布权限

密钥只保存在 GitHub Environment，不写入仓库、npm 配置或命令行历史。

## 发布步骤

从最新 `main` 执行：

```powershell
git switch main
git pull --ff-only origin main
npm ci
npm run verify
npm version 1.0.0 -m "chore(release): v%s"
git push origin main --follow-tags
```

`v*` 标签会触发 `.github/workflows/release.yml`。流水线先校验标签与 `package.json` 版本一致，再运行完整验证、发布 npm 包并创建 GitHub Release。

首次版本已是 `1.0.0` 时，不重复执行 `npm version 1.0.0`；在对应提交上创建带注释标签后推送：

```powershell
git tag -a v1.0.0 -m "chore(release): v1.0.0"
git push origin v1.0.0
```

## 发布后回读

```powershell
npm view @zzusp/agent-channel-host@1.0.0 name version dist.tarball --json
npx --yes @zzusp/agent-channel-host@1.0.0 --version
gh release view v1.0.0 --repo HiQ-AI/agent-channel-host
```

三项均成功才算发布完成；GitHub Actions 成功回执本身不替代 npm Registry 与 CLI 的独立回读。
