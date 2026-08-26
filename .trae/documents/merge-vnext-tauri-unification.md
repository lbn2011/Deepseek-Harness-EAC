# 合并方案：refactor/vnext-ts-isolation → main（Tauri 化一步到位）

> 目标终态：**去 Electron、Tauri + WebView2 唯一壳、全面 TS、完整保留 Rust 插件隔离系统与快照管理器、Windows + Linux 双平台同时编译与使用、性能优化、安全加固**。
> 用户已确认：一步到位直接 Tauri 化；Tauri 立即转正为发布线；内核随 main 升 0.1.1-rc.2；资产基线取 main；main 的 lib/desktop/*（14 模块）与 refactor 的 lib/*（37 模块）择优合并；双平台支持纳入本次交付。
> 配套文档：spec/tasks/checklist/tdd 见 `.trae/specs/merge-vnext-tauri-unification/`（AC-1~AC-16 为验收契约，tasks 13 个 Task 为执行分解，tdd 16 个行为单元为测试先行计划）。

---

## 1. 概要

在集成分支 `merge/vnext-tauri` 上完成 `main ← refactor/vnext-ts-isolation` 合并（72 处 git 冲突按 §6 冲突解决表处置、11 项 main 修复按 §7 移植），随后按「模块级择优映射表」（§5）把两套并行模块实现统一为**一套零 electron 依赖的 lib/* 模块层**，sidecar 全量接管，Electron 退役，CI/发布切换 Tauri，最终合并回 main 打 v6.0.0 tag。

**两条支线的重构成果在终态的归宿**：
- refactor 支线 → 全量 TS 代码基座、插件隔离架构（extension-host + Rust supervisor）、快照系统（Rust snapshot）、37 模块结构、性能优化（boot -79.8%）、499 测试 —— **全部保留**
- main 支线 → Tauri 壳 + WebView2、sidecar JSON-RPC 架构、bridge preload 等价层、ctx 依赖注入模式（宿主无关）、NSIS/便携打包链、内核 rc.2、新资产基线、6+ 核心修复 —— **全部保留**（lib/desktop 的 14 个模块实现按 §5 映射表择优并入统一层后删除目录，无一丢弃）

---

## 2. 现状分析

### 2.1 分叉数据

| 项 | 值 |
|---|---|
| 合并基点 | `66bd9a1`（2026-08-19） |
| refactor 独有 | 41 commits（全量 TS 化 37 模块、extension-host 插件隔离、Rust native supervisor/snapshot、boot -79.8%、快照面板、CI 适配 Node26+cargo） |
| main 独有 | 197 commits（Tauri 壳 + sidecar 14 模块、TS Wave0-3、内核 0.1.1-rc.2、picturereader 3.1.0、unified-market、6+ 核心修复、NSIS/便携打包链、版本 5.1.0） |
| **main 演进（2026-08-25 纳入）** | **+15 commits（fe299dd..f04ed56）**：main 侧自行吸收 vnext 的 Phase 1-4 平行版本（TS 化收口/插件隔离/native 构建链/测试 77×.mjs→.ts 转 Node24 直跑，与 refactor 完整版同源不同版本）+ 5 项 main 独有修复（见 §7 追加 12-16）+ G1-G4 发布可用性验证修复 + exit overlay 壳能力 |
| git 冲突 | 72 处：26 content / 20 add-add / 9 modify-delete / 17 rename 类 |
| 语义冲突（git 之外） | main `lib/desktop/*`（14 模块，ctx 注入、宿主无关）与 refactor `lib/*`（37 模块，`import { app } from 'electron'` 直连）为并行实现；sidecar 仅挂 14 模块 |

### 2.2 两套架构

- **refactor（Electron Supervisor + 插件隔离）**：Electron 主进程 = Supervisor，spawn dsh web 核心进程 + 各 SDK 插件独立 Extension Host（Node spawn + Rust Job Object 围栏），恢复中心、快照管理器（Rust 增量备份）、崩溃退避/隔离状态机。499 测试全绿。
- **main（Tauri 壳 + Node sidecar）**：Tauri(Rust) 壳加载 WebView2 指向 dsh web；sidecar（Node，stdio JSON-RPC）挂 lib/desktop 14 模块；bridge.ts 在 WebView2 里按 preload 语义重建 `window.dshDesktop`（回环 WS :19873）；NSIS + 便携包链从未在线上发布过。

### 2.3 双架构能否完整保留 —— 可行性结论与优缺点

**结论：可以完整保留，且合并后形成「分工明确的一体架构」而非两套并行系统**。技术依据（已核实）：
- 双方同为「.ts 就地编译同名 .js（gitignore）」模式 → sidecar `require('client-updater.js')` 等指向 refactor 编译产物，路径零改动
- Rust native（napi）在任意 Node 宿主（Electron 主进程 / sidecar）可加载 → 插件隔离系统迁移零成本
- dsh web 前端由 Node 进程服务，壳无关；客户端插件修复随 main 资产树自动获得

**插件隔离架构（refactor）的优点**：第三方插件崩溃/卡死/依赖冲突被进程围栏隔离，核心 Agent 永不被拖垮；恢复中心可关停/回滚/隔离；快照系统 git 式增量备份；全量 TS + 499 测试。
**缺点**：Supervisor 绑定 Electron 主进程生命周期；Electron 运行时重（~200MB、内存高）。
**Tauri + sidecar 架构（main）的优点**：壳体积/内存大幅下降；WebView2 系统组件；Rust 壳原生性能与安全模型；ctx 注入模式天然宿主无关。
**缺点**：sidecar 仅覆盖 14/37 模块；从未在线上发布；WebView2 版本随用户机器差异。
**合并后互补**：插件隔离系统从 Electron 主进程解耦 → 运行于 sidecar（Node 宿主），围栏能力（Rust Job Object）原样保留；Tauri 壳获得完整功能面与隔离能力；Electron 缺点（体积/内存/绑定）随退役消除。唯一真实成本：37 模块需按 ctx 模式去 electron 化（一次性工程）。

---

## 3. 目标架构（终态）

```
Tauri Shell (Rust + WebView2)                    tauri-shell/src/main.rs
 ├─ 窗口/托盘/单实例/退出策略/导航围栏/自更新
 └─ Node Sidecar (stdio JSON-RPC)                tauri-shell/sidecar/server.ts
      ├─ Core Harness 生命周期（dsh web spawn/守护/重启）
      ├─ 统一模块层 lib/*（37 模块，ctx 注入、零 electron 依赖）
      ├─ Extension Host Manager（插件隔离：spawn + Rust Job Object + 状态机）  ← refactor 全保留
      ├─ Rust native：supervisor（进程围栏）+ snapshot（增量备份+调度）        ← refactor 全保留
      └─ 全部 IPC 域（chrome:*/dsh:*/snapshot:*/rc:*/guard:*/onboard:*）经 bridge 暴露
 WebView2 (dsh web UI + 客户端插件)
  └─ bridge.ts 重建 window.dshDesktop（WS :19873 → sidecar；win.* → Rust 壳本地拦截）  ← main 全保留
```

---

## 4. 执行计划（集成分支 merge/vnext-tauri 分阶段提交）

### Phase 0：集成分支与合并骨架
1. `git checkout main && git checkout -b merge/vnext-tauri`
2. `git merge refactor/vnext-ts-isolation --no-ff`（预期 72 处冲突）
3. 按 §6 冲突解决表逐组解决；`package-lock.json` 不手解，合并后 `npm install --package-lock-only` 重建。

### Phase 0B：main 演进吸收（2026-08-25，Task 2.5）
上游 main 已推进 `fe299dd..f04ed56`（15 commits），第二次 `git merge origin/main --no-ff` 纳入。冲突解决原则：
- **Phase 1-4 平行版本重叠文件**（extension-host/supervisor/recovery-center/根模块 .ts/native/CI/scripts/test 转换）：**取 ours（refactor 完整版）**——main 吸收版只覆盖 Phase 1-4 切片且基线更旧（Node24 vs 我们 Node26、平铺根模块 vs 37 模块结构）
- **main 独有新文件**：自动并入（exit-overlay.js、HANDOVER R10/R11 文档、settings-scroll-fix 阈值资产等）
- **main 独有修复**（§7 第 12-16 项）：行级甄别并入 ours 对应文件
- **测试重名甄别**：main 转换版 `.test.ts`（如 `dsh-file-drop-eac-core.test.ts`）与 refactor 原生版（`file-drop-core.test.ts`）同插件双测试文件 → 保留 refactor 版、main 版去重后并入其独有用例
- node_modules 受控补丁（dsh-tool-bash）：merge 后核对 patch 完整性

**执行结果（Task 2.5 完成回写）**：48 处冲突解决（43 批量取 ours + 5 手工合流：ci.yml/.gitignore/recovery-center-preload.js/package.json/tsconfig.json）；main 独有修复全部并入（崩溃对账块/`--no-open`/stage-resources 漏装与 skip-npm/main.rs serve_ws 与 exit overlay/settings-scroll-fix 阈值放宽）；门禁 661/661（基线 562 +99：main .ts 转换激活的休眠 .mjs 用例并入）。三处修正超出预分析：① `assets/recovery.html` Task 0 机械取 main 救援页与 refactor preload 桥错配（渲染器恢复页整体降级）→ 改取 refactor 渲染器恢复页，main 救援页随 Phase 3 sidecar 化回归；② 删 2 个架构淘汰测试文件（rescue-integration 12 例 + bridge-preload-parity 3 例，理由见 tasks.md 2.5e，契约随 Task 7 重建）；③ rescue-agent 归宿修正（见 §5 认知修正）。

### Phase 1：修复移植（冲突解决同时/紧随）
按 §7 修复移植清单，把 main 落在 refactor 已重写文件里的 11 项修复移植进 refactor 对应模块，逐项行级核对。

### Phase 2：模块统一（去 electron 化，最大工程）
按 §5 映射表逐模块实施；以 main `lib/desktop/guard-box.ts` 的 `XxxCtx` 注入模式为模板：
- `lib/state.ts`：electron app 状态 → sidecar 进程状态（mainWindow 概念移除，改 bridge 会话句柄）
- `lib/proc.ts`/`lib/paths.ts`：`app.isPackaged/resourcesPath` → ctx 注入（对齐 main `runtime-paths.ts` 模式）
- `lib/server.ts`/`lib/boot.ts`/`lib/watchdog-boot.ts`：spawn/守护逻辑宿主无关化
- `lib/window.ts`、`lib/ipc/sender.ts`：Electron 专属语义迁移——窗口控制走 Rust 壳 `win.*` 通道；IPC 来源校验（原 `event.sender === mainWindow.webContents`）改为 bridge 会话 token 校验
- `lib/tray.ts` → Tauri 托盘（Phase 3）
- `lib/extension-host/*`（manager/rpc/job-fence/sdk）：state/log 依赖注入化后整体运行于 sidecar
- `lib/snapshot/*`：调度器移入 sidecar；`snapshot:*` IPC 域挂 sidecar JSON-RPC
- **删除 `lib/desktop/*` 14 模块**（§5 映射表每行的 main 增量全部移植核对完成后）
- `tauri-shell/sidecar/server.ts`：从挂 14 模块扩到挂全部统一模块 + 全部 IPC 域（含 §5.1 快照 `snapshot:*` 11 域）
- sidecar 的 `import x = require()` 改标准 import；`ping.js` 按 §5.2 转 `.ts`；tsconfig include 并入 `../tauri-shell/sidecar/**`
- 按 §5.2 完成 TS 化缺口收尾；阶段末 grep 验证 lib/ 层 `from 'electron'` 零残留

### Phase 3：壳层能力补齐（tauri-shell/）
- `sidecar/bridge.ts`：IPC 域覆盖从 main 原面扩展到 refactor 全部 36+ 域（snapshot:*/rc:*/guard:*/onboard:*/chrome:recovery-*/dsh:file-*/balance-prices-* 等），语义对齐 refactor `preload/chrome.ts`
- `src/main.rs`：托盘菜单（重启 Web 服务/完全重启/退出，对齐 11be738）；导航围栏（仅放行 localhost + 白名单，承接 `lib/window.ts` fencing 语义）；快照备份树面板入口（⋯菜单，按 §5.1 保留原面板位置与交互）；splash 主题跟随（16b8ff4 语义）
- 快照面板/恢复中心 UI：经 bridge 拉起（沿用 refactor 全屏面板资产，宿主改为 WebView2）

### Phase 4：Electron 退役
- 删除：`main.ts`、`preload.ts`/`preload/`、`electron-builder.yml`、`lib/window.ts` Electron 残余、electron 测试夹具
- `package.json`：删 electron/electron-builder 依赖；scripts 收敛为 `build`(tsc) + `build:native` + `test` + tauri 打包链；`version: 6.0.0`
- CI：`ci.yml` 重写为 typecheck + cargo test + node 测试 + `tauri build`（双平台 matrix）；删除 `release.yml`；`release-tauri.yml` 为唯一发布流（补 native 构建步骤与 tag 版本注入，承袭 main 已有 NSIS/便携链）
- Electron 用户升级路径：沿用 main 的 client-update installDir 判定 + NSIS 升级钩子 + `upgrade-test-441.js` 基础，补 5.1.0→6.0.0 升级验证脚本

### Phase 4B：双平台支持（Linux，Task 9/11 落地）
- **历史基线**：v4.4.0-linux 曾交付 deb/rpm/pacman/AppImage（社区贡献），约定「Linux 由系统包管理器升级，不走应用内自更新」——本次沿用该约定
- 进程围栏：Rust `native/supervisor` 加 `#[cfg(unix)]` PR_SET_PDEATHSIG + setpgid 进程组（对照 Windows Job Object 语义：父死子亡、零孤儿）；`job-fence.ts` 走既有 fenceMode 抽象接 Linux 策略
- 壳层抽象：`main.rs` 资源定位/进程 spawn/控制台隐藏抽平台 trait（Windows CREATE_NO_WINDOW ↔ Unix 无操作）；`tauri.conf.json` bundle targets 扩展 deb/AppImage（rpm 零成本则带上）
- node 运行时：`fetch-node.ts` 适配 linux-x64 下载源，vendor 布局 `vendor/node/bin/node`；保持开箱即用不依赖系统 node
- Windows 专属面挂 `IS_WIN` 分支静默跳过：junction 巡检（Linux symlink 无此问题）、`.lnk` 快捷方式、注册表诊断、NSIS 钩子、client-update 应用内更新（Linux 显示包管理器升级提示）
- CI：windows-latest + ubuntu-latest 双 matrix（Linux 装 webkit2gtk-4.1 系统依赖）；产物过滤按 平台×x64
- 明确不做：macOS、Linux 应用内自更新、pacman、arm64

### Phase 5：性能与安全专项（详见 §8）
按 §8 的具体措施逐项实施与度量。

### Phase 6：验证与合并
见 §9。全绿后 `git checkout main && git merge merge/vnext-tauri --no-ff` 推送，打 `v6.0.0` tag 触发 release-tauri.yml。

---

## 5. 模块级择优映射表（14 vs 37，逐模块取舍）

> 取舍原则：**实现取 refactor**（全量 TS、类型严格、注释完备、测试覆盖、性能优化），**模式取 main**（ctx 依赖注入、宿主无关），**main 侧增量修复全部移植**。main 侧无对应物的模块 = refactor 独有，全保留。

| # | main `lib/desktop/*`（14） | refactor 对应物 | 择优结果 | 需移植的 main 增量 |
|---|---|---|---|---|
| 1 | boot-server.ts | lib/boot.ts + lib/server.ts | refactor（拆分更细、守护启动/救援预修复链完整） | 7f7fa05 并发 web 检测 |
| 2 | client-update.ts | lib/client-update/*（apply/download/index/net/release/types 六模块） | refactor（模块化 + 类型完整） | 55c55e6 已移植的代理链/缓存破坏基础上，核对 0d69c79 超时 300s |
| 3 | companion-sync.ts | lib/plugin-copy.ts | refactor（单遍走树 + 戳记缓存，boot -79.8% 关键） | 4bc3ac1 安全模式守卫、a1569b3 schemastery、d268fe9 profile 完整性 |
| 4 | file-roots.ts | lib/paths.ts（fileRoots/H2H3 围栏段） | refactor | 无 |
| 5 | guard-box.ts | lib/plugin-guard/*（ctx/heal/scan） | refactor（三模块拆分） | 无 |
| 6 | junction-patrol.ts | lib/watchdog-boot.ts（startJunctionWatchdog + repairJunctions） | refactor | 无 |
| 7 | market.ts | lib/market-modules.ts + lib/market-ops.ts | refactor | unified-market 资产适配（随资产基线取 main） |
| 8 | plugin-ops.ts | lib/plugins.ts + lib/plugin-manager-core.ts | refactor | 18b0fd4 escalation 豁免（落点核实后） |
| 9 | proc.ts | lib/proc.ts | refactor | 无 |
| 10 | profile.ts | lib/paths.ts（desktopProfile 段） | refactor | 无 |
| 11 | runtime-patches.ts | scripts/patch-deps.ts（+ lib/session-heal.ts） | refactor + main 补丁 | 9d068c2/406914e/3f12d05 可选升级字段三连 |
| 12 | runtime-paths.ts | lib/proc.ts / lib/paths.ts（APP_ROOT 概念） | **模式取 main**（ctx 注入），实现并入 refactor | 无 |
| 13 | shortcuts.ts | lib/shortcuts.ts + lib/shortcut-maintenance.ts | refactor（ec42a9f 已移植去重修复） | 核对补齐 |
| 14 | static-preview.ts | lib/preview.ts | refactor | 无 |

**refactor 独有 23 模块（全保留，仅需 ctx 化）**：balance-ui、bridge、extension-host/*（manager/rpc/job-fence/sdk）、guard、ipc、log、logger、migration、onboarding、plugin-registry-data、recovery-center、renderer-recovery、run-state、session-heal、snapshot/*、state、supervisor/*（registry/installer/state-machine）、terminal、tray、update-flow、window、watchdog-boot（部分与上表重叠按功能归并）。

**main 侧根级模块归宿**：client-updater.js/updater.js/plugin-guard.js → 删 .js，refactor .ts 为源，sidecar require 编译产物；main.js → 删（main.ts 为源，Phase 4 随 Electron 退役）；logger.js/preload.js/renderer-recovery.js → refactor 已有同名 .ts；~~rescue-agent.js → Phase 1 核对 refactor `lib/recovery-center/*` 等价覆盖后删除~~ **认知修正（Phase 0B 执行期）**：main 演进（f04ed56）已在 `tauri-shell/sidecar/rescue-integration.ts`+`server.ts`+`bridge.ts` 建成完整 sidecar 救援链（rescue.\*/safe-mode 域，rescue-agent.js 为其活跃依赖）→ **保留**，Electron 侧接线测试随架构淘汰删除（Task 7 sidecar 接管时重建契约）；extract-css.mjs → 若 tauri 打包链需要则保留（或随 Phase 2 转 .ts）。

### 5.1 快照管理器完整保留方案（用户明确要求）

快照管理器（refactor 独有，commit 9efbace/ee0785c）**四层全部保留**，仅宿主从 Electron 主进程迁到 sidecar：

| 层 | 文件 | 保留方式 |
|---|---|---|
| Rust 引擎 | `native/snapshot/`（SHA-256 内容寻址去重、mtime+size 索引缓存、快照树分支、恢复前安全快照、默认排除 skills/sessions/.agent-presets/memories/node_modules） | 原样保留；napi 模块在 sidecar（Node 宿主）加载方式与 Electron 完全一致，零改动 |
| TS 编排 | `lib/snapshot/{manager,scheduler,native,paths}.ts` | 原样保留；scheduler 常驻 sidecar（定时/每日模式照旧）；restore 时停/重启 dsh web 服务的链路对接 sidecar 的 server 管理器 |
| IPC 域 | `snapshot:*` 11 个方法（overview/create/detail/restore/branch-create/branch-delete/branch-set-current/config-save/delete/gc） | 全量挂到 sidecar JSON-RPC，经 bridge 暴露给 WebView2 |
| UI 面板 | 全屏备份树面板（⋯ 菜单入口，位于「重启 Web 服务」与「重新加载」之间） | 保留全部面板资产与交互；Phase 3 在 Tauri 壳菜单中重建入口，面板经 bridge 拉起 |
| 备份存储 | `.dsh-snapshots` 目录（与 .dsh 同级） | 存储格式/位置不变，升级用户历史快照直接可用 |

对应测试（Rust 16 例 + TS snapshot 测试）全部保留，纳入每阶段门禁。

### 5.2 全面 TS 化覆盖清单（用户明确要求）

| 现状 | 处置 |
|---|---|
| refactor 的 dsh-desktop 已全 TS（根模块/scripts/测试均 .ts） | 基线即达 |
| `tauri-shell/sidecar/ping.js` | 转 `.ts`（并入 sidecar tsconfig 编译范围） |
| main 根级 smoke 脚本（boot-smoke/gui-smoke/rescue-smoke/update-smoke/upgrade-test-441.js） | 转 `.ts` 并纳入编译（P5 回归矩阵引用同步更新） |
| `scripts/koffi-preflight.cjs` | **刻意保留 CJS**（koffi 原生绑定预载要求，勿改） |
| `scripts/build-icon.ps1`/`seed-builder-cache.ps1` | 保留（构建辅助，非运行时代码） |
| main 根级 .js（logger/main/client-updater/plugin-guard/plugin-updater/preload/renderer-recovery/rescue-agent 等） | 随 §6-D 冲突解决删除，由 refactor .ts 替代 |
| `assets/agent-presets/**/*.mjs` | **保留不动**（随包分发的 dsh agent 预设产品资产，非构建代码） |
| Electron 退役后剩余 .ts 中 electron 依赖 | Phase 2 ctx 化后 grep 验证 `from 'electron'` 零残留，typecheck 即为全面 TS 化的机器证明 |

---

## 6. 72 处 git 冲突解决表

### A. 根目录（6 处）
| 文件 | 冲突类型 | 解决方案 |
|---|---|---|
| `.github/workflows/ci.yml` | add/add | Phase 1 取 refactor 版为基底（Node26+cargo+native 步骤）并入 main paths 过滤（`.agents/skills/**`）；Phase 4 重写为 Tauri-only |
| `.github/workflows/release.yml` | add/add | 取 main 禁用版占位；Phase 4 删除（发布唯一走 release-tauri.yml） |
| `.gitignore` | content | refactor 重写版为基底，并入 main 侧条目（smoke 产物、`.agents/` 等） |
| `README.md` | content | main 版为基底（版本化下载链接/交流群/协作者/CHANGELOG 4.4.1–4.6.0），改 Tauri-only 说明 + VNext 架构文档链接 + 下载链接指向 Tauri 产物 |
| `README.en.md` | content | 同 README.md 英文版 |
| `docs/qq-group-qrcode.jpg` | add/add(二进制) | 取 main 版（c040068 更新） |

### B. dsh-desktop 配置/文档（7 处）
| 文件 | 类型 | 解决方案 |
|---|---|---|
| `dsh-desktop/.gitignore` | content | refactor 版 + main 补充条目 |
| `dsh-desktop/CHANGELOG.md` | content | 双方合并：refactor 5.0.0 段 + main 5.1.0 段 + 新增 6.0.0 段（Tauri 转正/插件隔离/快照） |
| `dsh-desktop/README.md` | content | refactor 版为基底（VNext 开发文档），并入 main 增量 |
| `dsh-desktop/electron-builder.yml` | content | Phase 1 取 refactor 版（过渡期可构建）；Phase 4 删除 |
| `dsh-desktop/package.json` | content | deps 全取 main（0.1.1-rc.2 全家桶）+ refactor 独有 devDeps 并入（napi/cargo 工具链）；scripts 取 refactor 并扩展 tauri；version 6.0.0；Phase 4 删 electron 依赖 |
| `dsh-desktop/package-lock.json` | content | 不手解：`npm install --package-lock-only` 重建 |
| `dsh-desktop/tsconfig.json` | add/add | 统一 refactor 的 nodenext/strict 配置；include 合并：`lib/**`、`shared/**`、`scripts/**`、`*.ts`、`types-*.d.ts`、`../tauri-shell/sidecar/**` |

### C. 插件资产（约 25 处，基线整体取 main）
| 冲突 | 解决方案 |
|---|---|
| `assets/plugins/picturereader/*` 全部 add-add（README/client.js/package.json/src/*，3.0.6 vs 3.1.0）+ node_modules 210 文件 + 4 处 LICENSE rename 类 | 树级解决：`git checkout main -- dsh-desktop/assets/plugins/picturereader`（main 3.1.0 整目录为准，refactor 3.0.6 树作废） |
| `dsh-compact/LICENSE`、`dsh-file-drop-eac/LICENSE`（modify/delete + rename/delete） | 取 main（资产保留即取 main 版） |
| `dsh-settings-nav-custom/lib/client.js`（content） | 取 main |
| refactor 独有旧插件 `dsh-webui-market`、`zat-dsh-engine`、`dsh-file-drop`、`dsh-auto-compact`、`dsh-tool-vision`、`dsh-tdai-memory` | 删除（main 已由 unified-market/dsh-compact/file-drop-eac/picturereader 替代或退役）；删除前核对 `builtin-plugins.json` 与插件注册表无残留引用（重点：`dsh-eac-core-bridge` 是否被 extension-host SDK 引用）——**执行结果（d64d7f5）**：7 个旧插件随 main 删除胜出自动清场；`dsh-eac-core-bridge` 经核实为 refactor 新增且被 `plugin-registry-data.ts`/`extension-host/bridge-server.ts` 活跃引用，**保留**；`plugin-registry-data.ts` 残留 4 条已删插件引用由 Task 2.3 清理 |

### D. 根模块 .js→.ts（约 20 处）
| 文件 | 类型 | 解决方案 |
|---|---|---|
| `main.js`、`client-updater.js`、`updater.js`、`plugin-guard.js` | modify/delete | 删除 .js（refactor .ts 为唯一源）；Phase 4 再删 main.ts 后入口收敛 sidecar |
| `balance.ts`、`builtin-collision.ts`、`bundle-integrity.ts`、`error-detail.ts`、`koffi-preflight.ts`、`patch-row-heal.ts`、`plugin-manager-state.ts`、`session-watcher.ts`、`profile-module-heal.ts` | rename/delete + add/add | 取 refactor .ts 版；Phase 2 核对 sidecar 消费导出签名（`resolveRepos`/balance API/updater API/plugin-updater API）逐一对齐 |
| `wsl-backend.js`/`wsl-backend.ts` | rename/delete + modify/delete | 取 refactor .ts |
| `plugin-updater.ts`、`preset-sync.ts` | content | refactor 版 + 移植 main 可选升级字段修复 |
| `preload/chrome.ts` | content | Phase 1 取 refactor；Phase 3 由 bridge.ts 全量替代后删除 |
| `stable-port.ts`、`watchdog.ts`、`session-encoding-heal.ts` | content | refactor 版 + main 增量核对 |

### E. scripts/（5 处 content）
`after-pack.ts`/`check-syntax.ts`/`e2e-full.ts`/`onboarding.ts`/`patch-deps.ts`/`plugin-manager-patch.ts`：refactor 版为基底，移植 main 修复（patch-deps 锚点补丁 3f12d05、e2e 资源完整性加固 d268fe9）。

### F. test/（6 处）
| 文件 | 类型 | 解决方案 |
|---|---|---|
| `better-sidebar-bundle.test.ts`、`patch-row-heal.test.ts`、`plugin-manager-toggle.test.ts`、`update-mirror-chain.test.ts` | content | refactor 版 + main 增量（ec42a9f 已移植部分核对补齐） |
| `client-updater-apply.test.mjs`、`recovery-integration.test.mjs` | modify/delete | 删除；确认 refactor 对应 .ts 测试等价覆盖（不足则补） |
| `file-drop-core.test.mjs→.ts` | rename/delete | 取 refactor .ts |

---

## 7. main 修复移植清单（11 项）

| # | 修复（commit） | main 落点 | 移植目标 |
|---|---|---|---|
| 1 | 7f7fa05 并发 dsh web 检测（fix #22） | main.js +81 行 | `lib/server.ts`（spawn 前锁/端口探测） |
| 2 | 4bc3ac1 安全模式守卫 | lib/desktop/companion-sync.ts | `lib/plugin-copy.ts`（safeModeActive 守卫 + patch 行停摆） |
| 3 | a1569b3 schemastery 首启依赖 | lib/desktop/companion-sync.ts | `lib/plugin-copy.ts` |
| 4 | d268fe9 profile 完整性 + Tauri 资源校验 | lib/desktop/companion-sync.ts + tauri-shell/stage-resources.mjs | 前者→`lib/plugin-copy.ts`；后者随 main 树保留 |
| 5 | 9d068c2 + 406914e + 3f12d05 可选升级字段三连 | plugin-updater / patch-deps / tauri 打包链 | `plugin-updater.ts` + `scripts/patch-deps.ts`；tauri 侧随 main 树 |
| 6 | 0d69c79 更新停滞超时 150s→300s | updater.js | `lib/client-update/*`（核对 refactor 现值，未含则改） |
| 7 | 11be738 托盘「完全重启」 | main.js +1 行 | ✅ Task 4.8 已移植 `lib/tray.ts`（`test/tray-menu.test.ts` 守护：位置/三步语义/与退出两档区分）；Tauri 侧记 Task 8.1（现 `main.rs` 托盘仅 show/recovery/restart/feedback/quit，缺完全重启项；`app.restart()` 语义已有先例：recovery.restart handler） |
| 8 | 16b8ff4 splash 主题跟随系统 | assets/loading.html | 资产取 main 自动获得；Tauri splash 核对 |
| 9 | 2dd37bd 流写入保护（#137） | stream-write-guard | refactor 已有对应物，核对含修复 |
| 10 | 18b0fd4 全访问时豁免必填 escalation（PR #199） | Phase 1 定位（插件 schema 或核心） | 落点核实后移植 |
| 11 | 客户端插件类修复（9593672 bash 折叠、a825fda 侧边栏换行、5ca8c5a offpeak、432f89a 皮肤禁用等） | 插件资产 | 随 main 资产树自动获得，无需移植 |
| 12 | e171abc G1-G4 发布可用性修复：extension-host/manager 残留 running 态崩溃对账（上次会话异常终止后状态机拒绝 running→starting，插件永不拉起） | lib/extension-host/manager.ts（main 吸收版） | `lib/extension-host/manager.ts`（ours）：startPlugin 对账块行级并入 |
| 13 | e171abc 同 commit：stage-resources 漏装 plugin-copy.js/shared/protocol.js（安装态 sidecar MODULE_NOT_FOUND 100% 复现）；main.rs 恢复中心直开模式缺 serve_ws（rc.* 全失效白屏） | stage-resources.mjs + main.rs | 随 Phase 0B merge 核对（两文件 ours 也有大改，逐段甄别） |
| 14 | bb3daae boot `--no-open`（dsh-web-app openBrowser 默认 true，就绪即开系统浏览器，日志实锤 50 次）+ stage-resources `--skip-npm` 死代码修复（先 rmSync 后 existsSync 必假） | lib/desktop/boot-server.ts + main.js + stage-resources.mjs | ours 对应 spawn 点（lib/server.ts / lib/boot.ts）补 --no-open；skip-npm 修复随 merge 甄别 |
| 15 | d6481c3 退出弹窗 overlay 注入（不新建窗口、不替换页面；win.close-dialog / win.hide-and-close-dialog 壳方法） | tauri-shell/src/main.rs + exit-overlay.js（新文件） | Phase 3 壳层能力；exit-overlay.js 自动并入，main.rs 两版手工合流 |
| 16 | f04ed56 settings-scroll-fix 检测阈值放宽（子串匹配+尺寸门槛降低+NAV 加权）+ 98fdabf NSIS 开头 ping→原生 Sleep 2000 + bzip2 压缩 | 插件资产 + installer.nsh | 随 main 资产树自动获得（merge 无冲突自动并入） |

---

## 8. 性能与安全专项（Phase 5 具体措施）

### 性能
| 措施 | 来源 | 度量 |
|---|---|---|
| 冷启动扫描缓存 + 单遍走树（已实现，保留并适配 sidecar） | refactor | boot 关键路径 ≤500ms 基线回归测试 |
| sidecar 模块单遍加载（预构建 require 图，避免启动期重复 IO） | 新增 | sidecar 启动时间对比 Electron 版记录 |
| Tauri 壳替代 Electron | main 方向 | 安装包体积（NSIS 目标 <80MB vs Electron 155MB）、常驻内存对比记录 |
| Rust snapshot 增量备份（SHA-256 内容寻址去重） | refactor | 快照创建时间/磁盘占用基准测试保留 |
| Rust Job Object 进程围栏（替代轮询回收） | refactor | 退出后零孤儿进程验证 |

### 安全
| 措施 | 来源 | 验证 |
|---|---|---|
| bridge 会话 token 来源校验（替代 `ipc/sender.ts` webContents 校验，敏感域仅接受主窗会话） | 语义迁移 | 越权调用测试（非主窗会话调敏感域必须拒绝） |
| WebView2 导航围栏（仅放行 localhost dsh web + 白名单，防任意跳转） | 语义迁移（原 lib/window.ts fencing） | 恶意 URL 拦截测试 |
| H2/H3 路径围栏（fileRoots/DANGEROUS_EXT：文件还原/打开仅限会话 cwd 内） | refactor 保留 | 路径逃逸测试（Startup\*.bat 类必须拒绝） |
| Win32 Job Object 进程围栏（崩溃无孤儿、KILL_ON_JOB_CLOSE 兜底） | refactor 保留 | 进程树击杀测试 |
| release 禁 devtools / 生产构建隐藏控制台 | main（windows_subsystem） | 打包产物核验 |
| 快照恢复前自动安全快照（回滚链可再回滚） | refactor 保留 | 恢复中断测试 |
| 更新包 SHA-256 校验 + 代理链证书支持 | refactor（lib/client-update/net.ts） | 已有测试保留 |

---

## 9. 验证步骤（每阶段门禁 + 终验）

**每阶段**：`npm run typecheck` 全绿、`npm test` 全绿、`cargo test` 全绿（native 模块）。

**终验（Phase 6）**：
1. `npm run typecheck && npm run build`（tsc 就地产出全量 .js）
2. `npm run test:native`（Rust supervisor/snapshot 全部用例）
3. `npm test`（全量 TS 测试，基线 499，Electron 夹具改造后数量允许合理变化，**不允许删测试降绿**）
4. `cargo build` + `tauri build` 产出 NSIS 安装包与便携 zip；本机安装实测：首装、托盘、快照面板、插件隔离（装一个第三方插件验证 Host 进程独立 + Job Object 围栏）、dsh web 启动、升级链（4.4.1→6.0.0 与 5.1.0→6.0.0）
5. 性能/安全专项 §8 各度量项记录入档
6. 推送 `merge/vnext-tauri` 跑 CI 全绿后合并 main，打 `v6.0.0` tag 触发 release-tauri.yml，在线盯跑首轮（main 备注：该 workflow 从未线上实跑）

---

## 10. 假设与决策

| 决策 | 内容 |
|---|---|
| D1 | 终态无 Electron：main.ts/preload/electron-builder 全删，唯一壳 = Tauri+WebView2（用户确认） |
| D2 | 模块统一：实现取 refactor 37 模块，宿主无关模式取 main ctx 注入，main 增量修复全移植（§5 映射表，用户确认「择优合并」） |
| D3 | 资产基线整体取 main：picturereader 3.1.0、unified-market、file-drop-eac、computer-user、dsh-compact、webui-prompt-optimizer；refactor 独有旧插件删除（用户确认） |
| D4 | 内核 0.1.1-rc.2（用户确认）；extension-host SDK 协议为自有 `shared/protocol.ts`，理论不受影响，终验实测兜底；失败则单独回退 rc.7（仅 package.json/lock 一处） |
| D5 | 版本号 6.0.0（Tauri 转正 + 双平台 + 架构大版本）；如需保守可改 5.2.0 |
| D6 | 执行方式：集成分支 `merge/vnext-tauri` 分阶段提交（每阶段可验证），最终 --no-ff 合并 main ——「一步到位」指终态，不指单笔巨型提交 |
| D7 | main 的 `lib/desktop/*` 在 Phase 2 末删除（§5 映射表每行 main 增量移植核对完成后），不留双实现 |
| D8 | push 走 gh-proxy.org（github.com:443 直连不稳定的已知环境问题，用已存 PAT） |
| D9 | 双平台（Windows + Linux x64）同批交付：Linux 打包 deb + AppImage（+rpm 零成本则带上）；Linux 升级走系统包管理器（沿用 v4.4.0-linux 历史约定，不做应用内自更新）；macOS/pacman/arm64 不做 |
| D10 | 文档体系：本方案为总纲；需求契约（AC-1~16）在 `.trae/specs/merge-vnext-tauri-unification/spec.md`，执行分解在 tasks.md，验收在 checklist.md，测试先行在 tdd.md |

## 11. 风险与回退

| 风险 | 缓解 |
|---|---|
| 37 模块 ctx 化工作量最大、易引入回归 | 按 §5 映射表分批改造（先 sidecar 消费面，后 Electron 专属面）；每批跑全量测试 |
| 499 测试中 Electron 依赖用例需改造 | Phase 2 逐夹具改造为 ctx 注入 mock；禁止删测试降绿 |
| 内核 rc.2 与 extension-host 不兼容 | 终验插件隔离实测；失败回退 rc.7（D4） |
| release-tauri.yml 首次线上实跑未知 | 盯跑首轮，NSIS 时长/缓存行为重点核对（main 注释已列检查点） |
| Electron 存量用户升级到 Tauri 包 | main 已有 NSIS 升级钩子 + installDir 判定 + upgrade-test-441 基础；补 5.1.0→6.0.0 脚本 |
| 合并中途失败 | 集成分支隔离，main 不受影响；可整分支废弃重来 |
