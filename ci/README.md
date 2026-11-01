# 启用 GitHub Actions

GitHub 的 REST/Git Data API 在**没有 `workflow` scope** 的令牌下会拒绝写入 `.github/workflows/**`（返回 404）。
因此本仓库把工作流存放在 `ci/release.yml`，启用方式二选一：

1. **网页添加**（无需新令牌）：打开仓库 → Add file → Create new file → 路径填
   `.github/workflows/release.yml` → 把 `ci/release.yml` 内容粘贴进去 → Commit。
2. **带 workflow scope 的令牌**：
   ```bash
   GH_TOKEN=<token with repo+workflow> node scripts/sync-to-github.mjs --owner <owner> --repo <repo>
   ```
   然后 `git mv ci/release.yml .github/workflows/release.yml`（或直接在本地生成后提交）。

启用后：push 到 `main` 会跑语法检查、包清单校验、患者数据泄露检查；打 `v*` tag 且配置 `NPM_TOKEN` 时自动发 npm。
