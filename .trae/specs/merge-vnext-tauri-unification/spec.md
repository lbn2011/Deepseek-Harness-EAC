# VNext × Tauri 统一合并（merge/vnext-tauri）Spec

> Status: ALIGNED
> Source: `.trae/documents/merge-vnext-tauri-unification.md`（合并方案主文档）+ 用户四轮确认
> 本 spec 是合并工程的**需求契约**；tasks.md 为任务分解、checklist.md 为验收清单、tdd.md 为测试先行计划。四者冲突时以本文件 AC 为准。

## Why

`refactor/vnext-ts-isolation`（41 commits：全量 TS、插件隔离架构、Rust supervisor/snapshot、boot -79.8%、499 测试）与 `main`（197 commits：Tauri 壳 + Node sidecar、内核 0.1.1-rc.2、新资产基线、NSIS/便携打包链）是**并行且部分矛盾的两套重构**，git 报告 72 处冲突，更大的语义冲突（`lib/desktop/*` 14 模块 vs `lib/*` 37 模块）在 git 之外。战略方向已定：**去 Electron，Tauri + WebView2 为唯一壳，双平台（Windows + Linux）同时编译与使用**，两条支线的成果全部保留并择优合并。

**2026-08-25 增补**：上游 main 在合并骨架（fe299dd）之后又推进 15 commits（至 f04ed56）——含 main 侧自行吸收 vnext 的 Phase 1-4 平行版本与 5 项 main 独有修复（主文档 §7 第 12-16 项），以第二次 merge（Task 2.5）纳入合并范围：平行版本重叠取 refactor 完整版，main 独有修复行级甄别并入。

## 用户已确认的决策（不再重议）

| # | 决策 |
|---|---|
| D1 | 一步到位 Tauri 化；Tauri 立即转正为唯一发布线；Electron 退役 |
| D2 | 模块择优：实现取 refactor 37 模块，宿主无关模式取 main ctx 注入，main 增量修复全移植 |
| D3 | 资产基线整体取 main（picturereader 3.1.0、unified-market、file-drop-eac 等） |
| D4 | 内核随 main 升 0.1.1-rc.2；失败回退 rc.7 |
| D5 | 全面 TS 化；**快照管理器四层完整保留**；Rust 插件隔离系统完整保留 |
| D6 | **新增：Windows 与 Linux 同时编译、同时可用**（本次交付的一部分，非后续专项） |
| D7 | 性能优化 + 安全加固专项 |

## In scope

- 72 处 git 冲突按主文档 §6 解决表处置（资产树级取 main、根模块取 refactor .ts、配置类合并）
- 11 项 main 侧修复移植进 refactor 对应模块（主文档 §7）
- 37 模块去 electron 化（ctx 注入模式）+ `lib/desktop/*` 删除（增量移植核对完成后）
- sidecar 从 14 模块扩到全量模块与全部 IPC 域（chrome:*/dsh:*/snapshot:*/rc:*/guard:*/onboard:*）
- Tauri 壳能力补齐：托盘（重启 Web 服务/完全重启/退出）、导航围栏、快照面板入口、splash 主题跟随
- Electron 退役：删 main.ts/preload/electron-builder/electron 依赖；CI 与发布切换 Tauri
- **双平台**：main.rs 平台抽象（`#[cfg(windows)]`/`#[cfg(unix)]`）；进程围栏 Linux 等价（PDEATHSIG + 进程组）；node 运行时双平台 vendor；junction-patrol/.lnk/注册表/NSIS 挂 Windows 分支；CI 双平台 matrix（windows-latest + ubuntu-latest）；Linux 打包 deb + AppImage（+rpm 若零成本）
- 性能专项（§8 主文档）与安全专项（bridge token 校验、导航围栏、路径围栏、Job Object、SHA-256 更新校验）
- 升级链：4.4.1→6.0.0 与 5.1.0→6.0.0 验证脚本（Windows NSIS 路径）

## Out of scope

- macOS 支持（无历史交付，不纳入）
- Linux 应用内自更新（**沿用历史约定**：v4.4.0-linux 起 Linux 由系统包管理器升级，不走应用内更新链；client-update 在 Linux 分支禁用）
- pacman 格式（Tauri 不原生支持；如社区需要后续单独补）
- 插件隔离架构的功能扩展（只迁移不增强）；内核 API 升级适配（rc.2 若不兼容则回退，不做改造）
- dsh 内核/官方 bundle 源码修改
- Web UI 前端改造（dsh web 自身壳无关）

## Assumptions

- 双方「.ts 就地编译同名 .js」模式兼容（已核实）；Rust napi 模块可在任意 Node 宿主加载（已核实）
- Linux 目标为 x86_64（历史交付即 x64；arm64 不做）
- Tauri v2 Linux 打包依赖 webkit2gtk-4.1，GitHub ubuntu-latest runner 可 apt 安装
- 内置 node 运行时 Linux 侧 vendored `node` 二进制（fetch-node 适配 linux-x64 下载源），保持「开箱即用、不依赖系统 node」的产品定位
- 版本号 6.0.0（Tauri 转正 + 双平台 + 架构大版本）

## Solution（sketch）

集成分支 `merge/vnext-tauri` 分 13 个 Task 推进：合并骨架（树级冲突解决）→ 修复移植 → 模块统一（两批 ctx 化）→ sidecar 全量接管 + bridge 扩域 → 壳层补齐 → 平台抽象层 → Electron 退役 → 双平台打包链 → 性能安全专项 → 终验合并。每 Task 门禁：typecheck 零错 + node 测试全绿 + cargo test 全绿（禁删测试降绿）。终态架构图见主文档 §3。

## Edge cases & risks

| Category | Notes |
|---|---|
| Boundary conditions | Linux 大小写敏感文件系统 vs Windows 不敏感（插件资产同步）；路径分隔符；`node.exe` vs `node` |
| Failure modes | 内核 rc.2 与 extension-host 不兼容→回退 rc.7；release-tauri.yml 首次线上实跑未知→盯跑首轮；Linux webkit2gtk 版本差异→CI 固定依赖版本 |
| Risks | 37 模块 ctx 化回归风险→分批+全量测试门禁；Linux 围栏 PDEATHSIG 与 Job Object 语义差异（无 KILL_ON_JOB_CLOSE 兜底）→进程组 kill 补偿 |
| Mitigation | 集成分支隔离可整支废弃；每个 Task 独立 commit 可逐个 revert |

## Acceptance criteria

**合并正确性**
- AC-1 `git merge --no-ff refactor/vnext-ts-isolation` 后工作树无冲突标记残留；`git ls-files | wc -l` 与解决表逐组核对无遗漏
- AC-2 main 的 11 项修复（§7 清单）在合并树中有对应代码与测试，`git log --grep` 可追溯移植 commit

**架构终态**
- AC-3 `grep -r "from 'electron'" dsh-desktop/lib/ dsh-desktop/shared/` 零命中（ctx 化完成、typecheck 全绿为机器证明）
- AC-4 `lib/desktop/` 目录不存在且 sidecar `server.ts` 挂载全部统一模块（`grep -c "mount(" server.ts` ≥ 37 对应注册数）
- AC-5 snapshot 11 个 IPC 域经 sidecar JSON-RPC 可达：`bridge` 层调用 `snapshot:overview`/`snapshot:create`/`snapshot:restore` 返回成功（集成测试）
- AC-6 插件隔离实测：安装一个第三方 SDK 插件后，扩展 Host 进程独立存在；强杀该进程核心 Agent 不受影响；Host 崩溃按状态机退避重启

**双平台编译与使用**
- AC-7 Windows：`tauri build` 在 windows runner 产出 NSIS 安装包（Setup.exe）与便携 zip，双产物 SHA-256 齐全
- AC-8 Linux：`tauri build` 在 ubuntu runner 产出 `.deb` 与 `.AppImage`（+`.rpm`），AppImage 在干净 Ubuntu 24.04 容器内可启动并加载 dsh web UI
- AC-9 CI（ci.yml）单次 push 同时跑 windows-latest 与 ubuntu-latest 两个 job，全绿
- AC-10 Linux 下进程围栏生效：杀父进程（sidecar）后扩展 Host 与 dsh web 子进程在 ≤5s 内全部退出（PDEATHSIG + 进程组验证脚本）
- AC-11 Linux 下 junction 巡检/`.lnk` 快捷方式/注册表诊断/NSIS 钩子静默跳过（对应单测断言平台分支），无报错日志

**TS 化与测试**
- AC-12 `npm run typecheck` 零错误；`npm test` 全绿（基线 499，允许夹具改造后数量变化，**不得删测试降绿**——测试数减少须逐个列出理由）
- AC-13 `npm run test:native` cargo test 全绿（supervisor + snapshot，含新增 Linux 围栏用例）

**退役与发布**
- AC-14 树中不存在 main.ts/preload.ts/preload//electron-builder.yml/electron 依赖（`grep -r electron package.json` 零命中）
- AC-15 Windows 升级链实测：4.4.1→6.0.0 与 5.1.0→6.0.0 升级脚本端到端通过（.dsh 插件与配置零丢失）
- AC-16 打 `v6.0.0` tag 触发 release-tauri.yml，两平台产物发布到 GitHub Release，链接写入 README

## Open questions

- OQ-1 rpm 是否随 deb/AppImage 一并产出（Tauri 原生支持，零成本则带上）→ Task 11 时定
- OQ-2 Linux AppImage 是否需要随历史命名规范（Deepseek-Harness-EAC-<ver>-x86_64.AppImage）→ Task 11 时对齐 README

## Core entities (ontology)

| Entity | Type | Key fields | Relationship |
|---|---|---|---|
| Tauri Shell | Rust 进程 | main.rs、托盘、单实例、导航围栏 | spawn → Sidecar |
| Sidecar | Node 进程 | server.ts（stdio JSON-RPC） | 挂载 lib/* 统一模块；拉起 Core Harness 与 Extension Host |
| 统一模块层 | lib/* 37 模块 | ctx 注入、零 electron | 被 Sidecar 与测试双消费 |
| Extension Host | 隔离子进程 | manager/rpc/job-fence/sdk | 受 Rust 围栏（Win: Job Object / Linux: PDEATHSIG+进程组）监管 |
| Snapshot Manager | Rust napi + TS 编排 | native/snapshot、lib/snapshot/* | 经 snapshot:* 域暴露给 WebView2 |
| Bridge | WebView2 注入层 | bridge.ts（WS :19873） | win.* → Rust 壳；其余 → Sidecar |
