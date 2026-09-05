# 热更新设计备忘录（2026-09-05 实施基线）

关联：`2026-08-23-hot-update-system-design.md`（主设计，已接受）。本备忘录记录 grill-me 审查决议与「设计 vs 代码事实」偏差修正，**实施以本文为准**。

## 1. grill-me 决议（2026-09-05）

| 决策点 | 决议 |
|---|---|
| 本轮范围 | P1+P2 一起做（引擎 + 发布端 + shell 热更 + 崩溃熔断 + 救援入口；签名/灰度留 P3） |
| 清单与包体宿主 | 全部发布到 **lbn2011/Deepseek-Harness-EAC**（origin）；`DEFAULT_REPOS` 同步切换 |
| release.json 回写 | 独立 **workflow_dispatch 手动脚本**（release-manifest.yml），不用 CI 自动回写 |
| 热更检查调度 | **独立 6h**（与正式更新 12h 解耦），启动后 60s 首检 |
| resources 围栏 | **拆第四组件 `content`**：`assets/plugins/**`、`assets/skins/**` 归 content 组件，走 Release 资产宿主（实测 assets 114MB，git 入库 ≤5MB 前提不容）；代码修复类 resources 包（根模块 + lib/ + scripts/ + assets html/图标）实测 ~1MB，git 入库安全 |
| 冒烟验收 | FF1–FF6 六项**全部自动化**进 hotupdate-smoke.js |

## 2. 代码事实修正（实施依据）

1. **模块落位**：`dsh-desktop/lib/desktop/` 不存在。L2 模块在 `dsh-desktop/lib/` 下平铺/分目录（`lib/client-update/`、`lib/update-flow.ts`）→ 热更引擎落位 **`dsh-desktop/lib/hot-update/`**，镜像 client-update 的拆分风格；tsconfig `lib/**/*.ts` 自动收录（`erasableSyntaxOnly`，禁 enum/namespace）。
2. **版本**：当前 6.0.0（非设计稿的 5.1.0）。
3. **bridge.js**：`include_str!` 在 main.rs L50，属 shell 组件，sidecar/resources/content 包均禁。
4. **sidecar-restart 链路不存在**（主设计的最大偏差）：`boot.restart` 只重启 dsh web 子进程；sidecar 由 Rust `Sidecar::spawn`（main.rs ~L435/L1763）一次拉起、退出才回收。→ 新增 Rust notify 处理 `shell.restart-sidecar`：sidecar 更新文件后主动 exit，Rust 见标记即重生新进程读取新代码（约 60 行，生命周期职责）。
5. **MOUNTED 只是文档性元数据**（shell.info 回显），实际挂载靠显式 `load()`——server.ts 需同时做两件事。
6. **zip 解压**：运行时依赖 `unzipper`（feature-pack.ts L450 已有 `Open.file` 用法），引擎复用；仓库侧 generate.mjs 用零依赖 zip central-directory 解析（zlib inflateRaw）。
7. **exe 交换**：复用 `lib/client-update/apply.ts` 的 detached CMD 脚本模式（等待解锁 → 备份 → copy → 重启 → 自删）；壳侧 `shell.relaunch`/`app.restart()` 已存在。
8. **checkLatest 现状**：`lib/client-update/release.ts` apiEndpoints() 只有 GitHub/Gitee API 轮询，release.json 作为**首选源前置**；版本比较复用 `updater.js` 的 `compareVersions`。
9. **救援入口**：recovery-center 是 switch 分发（`register-sidecar.ts handleRcAction`），新增 `rollback-hot-update` case + sidecar methods 暴露。

## 3. 组件矩阵（v2）

| 组件 | 允许前缀 | 禁止 | 宿主 | 重启级别 |
|---|---|---|---|---|
| `sidecar` | `sidecar/` | bridge.js | git（≤5MB） | sidecar-restart（Rust 重生） |
| `resources` | `dsh-desktop/` | package.json、package-lock.json、vendor/**、node_modules/**、native/**（NODE_MODULE_VERSION 绑定构建）、assets/plugins/**、assets/skins/**、bridge 相关 | git（≤5MB） | sidecar-restart |
| `content` | `dsh-desktop/assets/plugins/`、`dsh-desktop/assets/skins/` | 插件树之外的任何路径 | Release 资产 | sidecar-restart |
| `shell` | 恰好一个 `dsh-eac-shell.exe` | 其他一切 | Release 资产 | app-restart（detached 交换） |

任何包禁绝对路径 / `..` / symlink 条目（zip-slip）。>5MB 的包 generate.mjs 拒绝 git 入库并提示改走 Release 资产。

## 4. 本轮交付物

`updates/{hotupdate.json,release.json,generate.mjs,packages/}`；`dsh-desktop/lib/hot-update/{types,fence,manifest,snapshot,apply,engine,index}.ts`；`lib/client-update/release.ts` 首选源；`sidecar/server.ts` 挂载+6h 调度+`check-hotupdate`；`register-sidecar.ts` 回滚入口；`main.rs` `shell.restart-sidecar` + boot-attempts 熔断；`.github/workflows/{updates-check,release-manifest}.yml`；根目录 `hotupdate-smoke.js`（FF1–FF6）。
