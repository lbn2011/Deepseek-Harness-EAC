# 发布指南（RELEASE.md）

> 正式发布（整包）与热更新（组件级增量）的操作手册。命令与机制细节见 [docs/DEVELOPMENT.md](DEVELOPMENT.md) 与 [docs/HOT-UPDATE.md](HOT-UPDATE.md)。

## 1. 正式发布（整包）

发布源：**lbn2011/Deepseek-Harness-EAC**（grill 决议 2026-09-05；清单、热更包、Releases 全量走本仓库）。

### 1.1 流程

1. **版本对齐**：`dsh-desktop/package.json` 与 `tauri-shell/tauri.conf.json` 的 `version` 同步（`release-tauri.yml` 也会在构建期注入 tag 版本）。
2. **推 tag 触发构建**：
   ```bash
   git tag v6.1.0 && git push origin v6.1.0
   ```
   `release-tauri.yml`（push tags `v*`）在 Windows/Ubuntu 双平台构建，产出：
   - Windows：`*-setup.exe`（NSIS）+ `*-portable.zip` + `SHA256SUMS.txt`
   - Linux：`.deb` + `.AppImage`
3. **构建成功后回写 release.json**（手动，grill 决议：独立 workflow_dispatch，不做 CI 自动回写）：
   - GitHub 仓库页 → Actions → **release-manifest** → Run workflow → 填 `tag`（如 `v6.1.0`）、可选 `version`/`notes`。
   - 该 workflow：下载 SHA256SUMS.txt → `generate.mjs --release` 生成清单 → 从 Release API 回填资产 size → **commit 回 main**。
   - **发布完成判据 = release.json 落库 main**（客户端拉 raw 即生效）。
4. 校验：`https://raw.githubusercontent.com/lbn2011/Deepseek-Harness-EAC/main/updates/release.json` 出现新版本即发布完成。

### 1.2 release.json 消费语义（客户端）

- `checkLatest` 首选 release.json（raw → gh.geekertao.top 代理 → Gitee raw 三源），失败或 schema 不识别降级 GitHub/Gitee Releases API 轮询。
- **清单是单一事实源**：版本 ≤ 当前即"已是最新"，不再轮询 API——因此**每次正式发布后必须回写 release.json**，否则客户端看不到新版本。
- `DSH_DESKTOP_RELEASE_API` 环境变量设置时，静态清单被跳过（自定义镜像完全接管，冒烟 mock 同理）。

## 2. 热更新发布（git push 即发布）

热更适用于：sidecar（`sidecar/*.js`）、resources（`dsh-desktop/` 根模块 + `lib/` + `scripts/` + assets 下 html/图标）、content（`assets/plugins/**` + `assets/skins/**`）、shell（`dsh-eac-shell.exe`）。围栏与组件矩阵见 [docs/HOT-UPDATE.md](HOT-UPDATE.md)。

### 2.1 打包

```bash
# 包命名（强约定，generate.mjs 靠文件名取 seq/组件/版本）
#   dsh-eac-hu-<seq 4位>-<sidecar|resources|content|shell>-<版本>.zip
# zip 根布局：
#   hu-manifest.json          # 包内清单（seq/component/version/appVersionRange/restartLevel/files[]）
#   sidecar/server.js         # replace 条目：zip 内文件 ↔ files[].mode=replace 一一对应
updates/packages/dsh-eac-hu-0001-sidecar-6.0.0-hu1.zip
```

`files[]` 条目：`{ path, sha256, size, mode: replace|delete }`；`delete` 幂等（目标不存在容忍）；多余文件拒绝应用（防夹带）。

### 2.2 生成清单与校验

```bash
node updates/generate.mjs --hotupdate     # 扫描 packages/ → 重写 hotupdate.json（latestSeq、包级 sha256）
node updates/generate.mjs --check         # 一致性 + 围栏 + git 宿主包 ≤5MB（CI updates-check.yml 同款）
```

围栏由 generate.mjs（发布端）与客户端 staging 复查**双重校验**，违规示例：sidecar 包含 `bridge.js`（编译进 exe，禁）、resources 包含 `package.json`/`node_modules/`/`native/`（须走正式更新）、content 越出 `assets/plugins|skins`、任何 `..`/绝对路径/符号链接。

### 2.3 发布

```bash
git add updates/packages/updates/… updates/hotupdate.json
git commit -m "hotupdate(hu0001): sidecar 修复浮窗失联"   # 包 + 清单原子提交
git push origin main                                     # push 即全量推送，无召回
```

- **误发布无召回**（R1）：push 前跑 `--check`；紧急止损 = 再发一个更高 seq 的修正包。
- 超过 5MB 的包（通常只有 content/shell）不入 git：包放 GitHub Release 资产，hotupdate.json 里写绝对 URL，客户端照常下载校验。
- 变更组件间接口契约（如 sidecar 调 resources 新方法）时，**同一 entry 必须同时携带受影响组件**（同发原则）。

### 2.4 版本围栏与熔断

- `appVersionRange: {min, max}`：仅命中区间内的客户端版本可应用；修 bug 引入新依赖时用 min 排除旧壳。
- 客户端验证失败连续 3 次 → 自动回滚 + seq 进 `blockedSeqs` 永不重试（FF6）；Rust boot-attempts 熔断兜底 shell 组件的启动循环。

## 3. 发布后检查清单

- [ ] release.json 已回写且 raw URL 可访问，`version`/`downloads[].sha256` 正确
- [ ] 真机启动 → 关于页版本号正确
- [ ] 客户端自更新：旧版本客户端收到新版本提示并完成升级
- [ ] 热更（如有）：`node updates/generate.mjs --check` 绿；手动 `check-hotupdate` 菜单触发应用；重启后 sidecar 日志无 MODULE_NOT_FOUND
- [ ] 恢复中心 →「回滚最近热更新」可用（P2 验收项）
