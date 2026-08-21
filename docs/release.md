# 发布流程

本项目通过 **Git 标签** 触发发布：只有推送 `v*` 标签才会进入 CI 打包流程（构建 Docker 镜像并创建 GitHub Release），普通分支推送、PR 不会触发。

## 版本号规范

- 遵循语义化版本：`v<主版本>.<次版本>.<修订号>`，如 `v3.6.1`。
- 标签必须是不带预发布/构建元数据后缀的稳定版本（`vX.Y.Z`）。
- **标签必须与 `package.json` 的 `version` 完全一致**（`v` 前缀 + 版本号），否则 CI 的 `Validate release tag` 步骤（`scripts/verify-release-tag.mjs`）会失败，发布中止。

## 发布步骤

1. 确认要发布的内容已全部提交到 `main`，且本地 `pnpm test`、`pnpm run typecheck`、`pnpm run build` 通过。
2. 修改 `package.json` 的 `version` 为新版本号。
3. 提交发布 commit（沿用仓库惯例，消息为 `发布 vX.Y.Z`）：

   ```bash
   git add package.json
   git commit -m "发布 vX.Y.Z"
   ```

4. 打标签并推送（标签必须打在发布 commit 上）：

   ```bash
   git tag vX.Y.Z
   git push github main
   git push github vX.Y.Z
   ```

5. 推送标签后 GitHub Actions 自动执行 `.github/workflows/docker-publish.yml`：
   - **verify**：校验标签与 `package.json` 版本一致 → 安装依赖 → 测试 → 类型检查 → 构建。
   - **docker**：`linux/amd64` 与 `linux/arm64` 两个架构**并行**构建（matrix，每个架构一个 job），单架构镜像按 digest 推送到 GHCR。
   - **merge**：将全部架构的 digest 合并为多架构 manifest，打上 `X.Y.Z`、`X.Y`、`latest` 三个标签推送到 GHCR（`ghcr.io/<owner>/<repo>`）。
   - **release**：基于标签自动创建 GitHub Release（自动生成更新日志）。

## 注意事项

- 标签推送后不可复用：如需重新发布同一版本，先删除远程标签与 GitHub Release 再重新推送（`git push github :refs/tags/vX.Y.Z`），但更推荐直接发修订号递增的新版本。
- 镜像发布到 GHCR，首次发布需在 GitHub 仓库的 Packages 设置中确认镜像可见性（public/private）。
- 若 CI 在 verify 阶段失败，修复后递增版本号重新走发布流程，不要移动已有标签。
