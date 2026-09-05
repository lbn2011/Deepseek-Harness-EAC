# 开发指南（DEVELOPMENT.md）

> 面向本仓库贡献者的完整开发参考：三层架构、目录布局、环境准备、构建/测试/冒烟命令、运行时数据目录、桥接契约与排障清单。
> 架构决策的「为什么」见 [docs/adr/](adr/)；发布与热更新操作手册见 [docs/RELEASE.md](RELEASE.md)。

## 1. 架构总览（v5.0+：三层壳边界，ADR 0002）

```
┌──────────────────────────────────────────────────────────┐
│  L1 Rust 壳 (tauri-shell/src/main.rs)                    │
│  · 单实例锁 / 主窗+浮窗 / 托盘 / 退出策略                  │
│  · 壳层 WS 方法本地拦截（win.* / menu 壳动作 / 日志）       │
│  · 壳页 HTTP 路由（/loading /exit /died /update /about /wizard）│
│  · spawn sidecar（stdio JSON-RPC）+ WS 中继 127.0.0.1:19873│
│  · 热更新生命周期：shell.restart-sidecar 重生 + boot-attempts 熔断 │
└──────────────┬───────────────────────────────────────────┘
               │  stdio JSON-RPC（L1 ↔ L2）
               ▼
┌──────────────────────────────────────────────────────────┐
│  L2 Node sidecar (tauri-shell/sidecar/server.ts)          │
│  · 挂载 lib/* 全部模块 + boot-server 服务编排              │
│  · 桥方法面（chrome.init / balance / plugins / rescue /    │
│    client-update / hot-update / onboard.* / menu.action …）│
└──────────────┬───────────────────────────────────────────┘
               │  spawn vendor/node + dsh web --port 0
               ▼
       L3 dsh 内核（@deepseek-ai/dsh，零改动）
       输出 "dsh web: http://127.0.0.1:<port>"
               │  webUrl 经通知回传 L1
               ▼
       主窗导航真实 Web UI（仅本机回环访问）
```

分层纪律（ADR 0002）：

- **L1（Rust）** 只做窗口/托盘/生命周期/导航编排，不写业务逻辑。允许的例外是热更新的生命周期语义（`shell.restart-sidecar` 重生、`boot-attempts` 熔断标记）。
- **L2（sidecar TS / lib TS）** 承载全部业务：更新、救援、插件治理、余额、终端。不 import Electron/Tauri；宿主能力经 `lib/host-ctx.ts` 注入（sidecar 侧由 `server.ts` initHostCtx 装配）。
- **L3（dsh 内核）** 零改动。桌面侧所有对内核的行为都通过 `lib/updater.ts` 的 overlay 机制或插件体系完成。

### 1.1 关键目录

```
Deepseek-Harness-EAC/
├── dsh-desktop/                 # L2 业务树（打包时整树装配进安装树）
│   ├── lib/                     # 模块化业务代码（.ts 源码入库，.js 由 tsc 原地产物、不入库）
│   │   ├── client-update/       #   客户端自更新（release/download/apply/net）
│   │   ├── hot-update/          #   组件级热更新引擎（见 docs/HOT-UPDATE.md）
│   │   ├── update-flow.ts       #   agent / client 双更新流编排
│   │   ├── recovery-center/     #   恢复中心动作分发
│   │   ├── guard.ts             #   插件保护（快照/回滚）
│   │   ├── server.ts / boot.ts  #   dsh web 服务编排
│   │   └── …                    #   其余模块见 server.ts 顶部 load 表
│   ├── assets/                  # 插件(38)/皮肤(10)/图标/壳页 HTML（114MB，随包分发）
│   ├── scripts/                 # 构建与开发辅助脚本
│   ├── test/                    # node --test 单测
│   └── vendor/                  # 内置 node.exe/npm（fetch-runtime 生成，不入库）
├── tauri-shell/                 # L1 Rust 壳 + sidecar 入口
│   ├── src/main.rs              # 壳本体（约 2300 行）
│   ├── sidecar/                 # server.ts（L2 入口）+ bridge.ts（注入浏览器的桥）
│   ├── stage-resources.mjs      # 打包资源装配（→ staged-resources/）
│   └── make-portable.mjs        # 便携 zip 装配
├── scripts/smoke/               # 端到端冒烟脚本（见 §5）
├── updates/                     # 热更新发布目录（hotupdate.json / release.json / packages/）
├── docs/                        # 文档集（见 docs/README.md 索引）
└── .github/workflows/           # ci.yml / release-tauri.yml / updates-check.yml / release-manifest.yml
```

### 1.2 模块加载纪律（L2）

- sidecar `server.ts` 经 `load('<name>')` 显式加载 `lib/` 模块；`MOUNTED` 数组只是 shell.info 回显的文档性元数据，**不驱动加载**——新模块两处都要登记。
- lib 内模块互相引用用相对导入 + `.js` 后缀（`module: nodenext`）；`tsconfig.json` 的 `lib/**/*.ts` 自动收录新目录，`erasableSyntaxOnly` 开启（**禁 enum/namespace/参数属性**）。
- 面向 legacy 调用方的门面：根级 `client-updater.js` / `updater.js` 等 re-export `lib/` 实现，保持 `require('./client-updater.js')` 的调用方零改动。

## 2. 环境准备

- **Node.js** ≥ 20（开发机本机运行 sidecar/tsc/测试）。
- **Rust** stable（rustup + MSVC；Linux 需 `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf`）。
- 首次准备：

```powershell
cd dsh-desktop
npm ci
npm run fetch-runtime            # 内置 node.exe + npm CLI（vendor/，不入库）
npm run build                    # tsc 全量编译（.ts → 原地 .js）
```

> 本仓库 TS 源码入库、编译产物 `.js` 不入库（`dsh-desktop/.gitignore`）；克隆后必须先 `npm run build`，sidecar 才有 `server.js` 可跑。

## 3. 常用命令

```powershell
# dsh-desktop/ 下
npm run build                    # tsc 全量编译
npm run typecheck                # tsc --noEmit（CI 同款）
npm test                         # node --test test/*.test.mjs（pretest 含 typecheck）
npm run tauri:stage              # 装配打包资源 → tauri-shell/staged-resources/
npm run tauri:build              # stage + cargo tauri build（NSIS/deb/AppImage）

# tauri-shell/ 下
node make-portable.mjs --out target/release/portable   # 便携 zip
node stage-resources.mjs --target=win32 [--skip-npm]   # 单独装配
cargo clippy --all-targets -- -D warnings              # CI 门禁同款

# 仓库根
node scripts/smoke/<name>.js     # 端到端冒烟（见 §5）
node updates/generate.mjs --check                      # 热更清单一致性校验
```

## 4. 运行时数据目录

| 目录 | 内容 |
| --- | --- |
| `%APPDATA%\Deepseek Harness EAC\`（Win）/ `~/.config/deepseek-harness-eac`（XDG） | settings.json、`updates/`（整包待装）、`backups/`（四目录备份）、`hotupdate/`（热更状态机：state.json / staging / backups / logs） |
| `~/.dsh`（`DSH_HOME`） | 会话、API Key、`profiles/web-desktop`（桌面 profile：cordis.patch.yml、guard 快照、safe-mode.json） |
| 安装树 | `dsh-eac-shell.exe` + `sidecar/` + `dsh-desktop/`（业务树）+ `hotupdate-baseline.json`（热更基线） |

冒烟脚本一律使用仓库内临时 `DSH_HOME`（`tmp-p2boot/`、`tmp-hotupdate-smoke/` 等，均已 gitignore），不污染真实用户数据。

## 5. 端到端冒烟（scripts/smoke/）

| 脚本 | 覆盖 | 前置 |
| --- | --- | --- |
| `update-smoke.js` | 客户端自更新链路：资产选择（Tauri 便携 zip）→ 下载 → `buildTauriPortableApplyScript` 目录树交换实跑（mock 发布源） | 无（node 级） |
| `hotupdate-smoke.js` | 组件级热更新 FF1–FF6：篡改中止、版本围栏、强杀×3 逐字节恢复、壳存活、基线协调、熔断回滚 + generate.mjs 围栏校验 | `npm run build` |
| `boot-smoke.js` | sidecar stdio JSON-RPC：boot.start → webUrl → HTTP 探活 → 优雅关停 | `fetch-runtime` + `build` |
| `gui-smoke.js` | 真实壳 18 项：桥注入/玻璃栏/窗口控制/浮窗隔离/退出策略/零孤儿 | `cargo build`（debug exe） |
| `rescue-smoke.js` | 救援链：/died 重启 → 安全模式 → 快照恢复 | release exe（`DSH_SMOKE_EXE`） |
| `ui-verify-smoke.js` | 安装态 UI 回归（5.1.1 G3 修复包） | release exe |
| `upgrade-test-441.js` / `-510.js` | NSIS 升级路径端到端（Electron→Tauri / Tauri→Tauri） | 两个版本的 setup.exe |
| `verify-shim-fix.cjs` | 历史一次性修复验证（存档） | — |

约定：任何 bug 修复若涉及冒烟可覆盖的行为面，应同步扩展对应冒烟断言（回归看护，参考 update-smoke 对 Tauri 便携自更新的看护）。

## 6. CI（.github/workflows/）

| workflow | 触发 | 内容 |
| --- | --- | --- |
| `ci.yml` | push/PR | typecheck、单测、native 模块 clippy+test、tauri-shell clippy（`-D warnings`）+ cargo test、Linux/Windows 冒烟 |
| `release-tauri.yml` | tag `v*` / 手动 | 双平台构建 + NSIS/portable/AppImage/deb + SHA256SUMS + Release 上传 |
| `updates-check.yml` | `updates/**` 变更 | `generate.mjs --check`（清单-包体一致性、围栏、≤5MB） |
| `release-manifest.yml` | 手动 | 从 Release 资产生成 release.json 并回写 main |

注意：clippy/test 步骤会先创建 `staged-resources/` 占位（目录 + `WebView2Loader.dll`、`hotupdate-baseline.json` 文件占位），因为 tauri-build 对 resources 映射做严格存在性校验；真实文件由 `tauri:stage` 在构建步骤装配。

## 7. 桥接契约速查（L1↔L2↔页面）

- **L1 ↔ L2**：行分隔 JSON-RPC over stdio。方法面在 `server.ts` 的 `methods` 表；L2 → L1 通知经 `notify()`（`shell.relaunch` / `shell.quit-for-update` / `shell.restart-sidecar` / `boot.web-ready` / `boot.server-died` / `client-update.show|hide|progress` 等），Rust 侧 `handle_sidecar_notify` 分发。
- **页面 ↔ 壳**：`bridge.ts` 注入 `window.dshDesktop`，WS 127.0.0.1:19873；首个 `chrome:init` 绑定主会话 token（BUG-B-008）。
- **更新进度**：`client-update.progress` 带 `channel`（client / agent / force / hotupdate），/update 页按 channel 渲染。

## 8. 排障清单

| 症状 | 处置 |
| --- | --- |
| sidecar 启动即 MODULE_NOT_FOUND | 先 `npm run build`（.js 产物不入库）；检查 `lib/` 新模块是否漏进 `server.ts` 的 load 表 |
| tauri build 报 resource path doesn't exist | `npm run tauri:stage`；或 clippy/test 场景确认占位步骤含全部文件映射（见 §6） |
| 下载/更新卡住 | 看 `%APPDATA%\Deepseek Harness EAC\updates\apply-update.log`；热更看 `hotupdate/logs/hotupdate.log` |
| 启动循环（壳反复拉起） | 热更熔断：`<userData>/hotupdate/boot-attempts` ≥3 自动换回 `.hu-bak`；手动恢复 = 删除 exe 同级 `.hu-broken` 并把 `.hu-bak` 改名回 exe |
| NSIS makensis mmap error | 杀软放大触发，重跑即可 |
| 本地 cargo link.exe 0xc0000139 | VS BuildTools 环境损坏（DLL 入口点找不到），与仓库无关；用 CI 或修复工具链 |
