# Tasks · VNext × Tauri 统一合并

> 纪律（沿用 refactor-modular-architecture 实战约定）：
> 1. 每个 Task 完成门禁：`npm run typecheck` 零错 + `npm test` 全绿 + `cargo test` 全绿（Task 9 起 Linux 相关另跑平台单测）→ 独立 git commit（只 add 本任务文件）。
> 2. **禁止删测试降绿**：测试数量变化须在 commit message 列出逐条理由。
> 3. 同时间只有一个 Task 在改共享文件；Task 0-4 严格顺序；Task 5-8 内批次顺序执行。
> 4. 冲突解决以主文档 `.trae/documents/merge-vnext-tauri-unification.md` §6 解决表为唯一依据。
> 5. 平台分支统一写法：`const IS_WIN = process.platform === 'win32'`（Rust 侧 `#[cfg(windows)]`/`#[cfg(unix)]`）。

- [x] Task 0: 集成分支与合并骨架（完成于 merge commit `d64d7f5`）
  - [x] 0.1 `git checkout main && git checkout -b merge/vnext-tauri`；记录基线（main HEAD = fe299dd）
  - [x] 0.2 `git merge refactor/vnext-ts-isolation --no-ff`（实际 64 个未解决条目；预分析 72 处含 rename 源/目标对拆分，无遗漏）
  - [x] 0.3 树级批量解决：`picturereader` 整树取 main 3.1.0（238 文件）、`qq-group-qrcode.jpg`、三处 LICENSE（dsh-compact/file-drop-eac/settings-scroll-fix）取 main、`dsh-settings-nav-custom/lib/client.js` 取 main
  - [x] 0.4 package-lock.json 粗取 refactor 侧（与 package.json 粗取 refactor 一致自洽）；**Task 1 deps 并集后重建**
  - [x] 0.5 `git status` 零未解决 + 全树零冲突标记核验通过 → merge commit `d64d7f5`
  - 执行偏差记录：① wsl-backend.js/.ts 按 refactor 删除（核实 main 侧无代码消费、refactor 升级契约测试断言其属 legacy 已删清单）；② 旧插件 webui-market/zat-dsh-engine/file-drop/auto-compact/plugin-marketplace/tool-vision/tdai-memory 由合并自动删除（main 侧删除胜出），**Task 2.2 大半已完成**；③ `dsh-eac-core-bridge` 改为**保留**（refactor 新增且被 `plugin-registry-data.ts` + `extension-host/bridge-server.ts` 活跃引用，非退役插件）；④ 已知遗留：`plugin-registry-data.ts` 残留 4 条已删插件引用（webui-market/zat-market/auto-compact/file-drop）→ Task 2.3 清理

- [x] Task 1: 配置与文档冲突解决（§6-A/B 组）
  - [x] 1.1 `.github/workflows/ci.yml`：refactor 版基底（Node26+cargo+native）并入 main paths 过滤（`.agents/skills/**`）+ `merge/vnext-tauri` 分支触发 + validate-skill 双 PowerShell 步骤恢复
  - [x] 1.2 `.github/workflows/release.yml`：取 main 禁用占位版（Task 10 删除）
  - [x] 1.3 根 `.gitignore` + `dsh-desktop/.gitignore`：refactor 版 + main 条目并集（desktop 侧 refactor 通配符 `/*.js`+`/lib/**/*.js` ⊇ main 枚举清单；main 的 `tauri-shell/sidecar/server.js` 条目为无效相对路径，由 `tauri-shell/.gitignore` 正确覆盖）
  - [x] 1.4 `README.md`/`README.en.md`：main 版基底，下载链接占位待 Task 11 更新为 Tauri 双平台产物
  - [x] 1.5 `dsh-desktop/package.json`：deps 全取 main（0.1.1-rc.2 全家桶）+ refactor devDeps 并入；scripts 取 refactor；version 6.0.0；package-lock 重建（`npm install --package-lock-only`）；`CHANGELOG.md` 按 6.0.0 双主线版本史改写；`tsconfig.json` 见 1.6；`electron-builder.yml` 无冲突（main 冻结态保留）；`dsh-desktop/README.md` 无冲突
  - [x] 1.6 门禁全绿 → commit。**决策修正**：tsconfig **不并入** `../tauri-shell/sidecar/**`——sidecar/server.ts 仍 mount main 侧 `lib/desktop/*` 布局（`mount('proc')` 等 13 处），与 refactor `lib/*` 37 模块不匹配，并入即 typecheck 崩；sidecar include 与 `lib/desktop` 排除项一并随 **Task 3.5**（sidecar 依赖签名核对/重写）落地。附带修复：`test/file-drop-core.test.ts` 适配 `dsh-file-drop-eac`（旧 `dsh-file-drop` 插件已随合并删除，测试原指向旧路径加载失败；核心 API 同构：classifyFile/buildTextInsertion/buildPathHint/looksBinary/TEXT_MAX_BYTES，仅 id 与暴露名 `__dshFileDropEacCore` 不同）
  - 执行偏差记录：① `node_modules/@deepseek-ai/dsh-tool-bash/lib/index.js`（git 跟踪的补丁文件）曾被 npm install 重装 rc.2 覆盖丢失补丁，已从 HEAD 恢复（该文件 rc.7/rc.2 内容除补丁外一致，且补丁不受 patch-deps.js 管理）；② 本地首次 `npm test` 挂起系 6 个遗留 `electron/install.js` 进程（旧 npm install 下载卡死）阻塞 worker，清理后 dist 已完整无需重下；③ 测试基线 558/558 全绿（refactor 侧 499 → 合并后 558，增量来自 main 侧 client-update 系列等已并入测试）

- [x] Task 2: 插件资产冲突与旧插件清理（§6-C 组）
  - [x] 2.1 核验通过：picturereader 3.1.0（238 文件）；`assets/` 与 `node_modules/` 零冲突标记残留。偏差：main 侧 node_modules 210 个跟踪文件已随合并删除胜出，git 仅剩 1 个跟踪文件（`dsh-tool-bash/lib/index.js` 受控补丁）
  - [x] 2.2 ~~删除 refactor 独有旧插件~~ 已由 Task 0 合并自动完成：webui-market/zat-dsh-engine/file-drop/auto-compact/plugin-marketplace/tool-vision/tdai-memory 随 main 删除胜出清场；`dsh-eac-core-bridge` 经核实为 refactor 新增且被活跃引用，**保留**
  - [x] 2.3 注册表清理（TDD red→green→反转再红→恢复全绿）：新增 `test/plugin-registry-consistency.test.ts`（4 用例：dir 存在性/孤儿映射/两个 ESM 加载形状断言，RED 阶段 4/4 失败精确复现 4 条缺失条目）；`plugin-registry-data.ts` 删 4 条已删插件条目（`dsh-market-plugin`/`zat-market`/`auto-compact`/`file-drop`）+ 3 条孤儿/死映射（含 line 106 npm 源映射及 `tool-vision`/`tdai-memory` 死映射——pluginUpdateSources 只遍历 COMPANION_PLUGINS，二者永不消费）。**额外发现并修复**：refactor 侧 `lib/market-modules.ts` 仍指向已删的 `dsh-webui-market`（artifact-keep/allow-builds ESM 静默降级空对象），对齐 main v5.1.0 已切换的 `dsh-unified-market`（导出面完全匹配：snapshotArtifacts/restoreArtifacts/parseBlockedBuildKeys/ensureAllowBuilds；main 侧过渡区 `lib/desktop/market.ts` 本已指向 unified-market，此为 refactor 分叉期未同步的 main 演进）
  - [x] 2.4 grep 验收（活跃代码零引用达成）：lib/scripts 下已删插件标识剩余命中仅 3 类合理保留——① `RETIRED_BUILTIN_PLUGINS` 的 tdai-memory 退役记录（plugins.ts 消费做旧安装清理，活数据）；② `scripts/e2e-full.ts` 的 dsh-tdai-memory 市场安装测试目标（npm 在架非内置插件，活测试）；③ 注释（e2e 设计说明与替换史，其中 registry 内历史点名已精简）。门禁全绿（typecheck 零错 + npm test 562/562，新增 4 用例）→ commit
  - [x] 2.5 main 演进吸收（2026-08-25 上游推进 fe299dd..f04ed56，15 commits；主文档 §4 Phase 0B / §7 第 12-16 项）
    - [x] 2.5a `git merge origin/main --no-ff`；Phase 1-4 平行版本重叠文件取 ours（refactor 完整版），逐类列出冲突清单
    - [x] 2.5b main 独有修复行级并入：e171abc manager.ts 崩溃对账块 → ours `lib/extension-host/manager.ts`；bb3daae `--no-open` → ours spawn 点；stage-resources 漏装/skip-npm 与 main.rs serve_ws/exit overlay 逐段甄别（ours 两文件均有大改）
    - [x] 2.5c 测试重名甄别：main 转换版 `.test.ts` vs refactor 原生版（如 `dsh-file-drop-eac-core.test.ts` vs `file-drop-core.test.ts` 同插件双文件）→ 保留 refactor 版、main 独有用例并入；Node24 门禁差异核对（我们 Node26 基线不动）
    - [x] 2.5d 受控补丁核对：`node_modules/@deepseek-ai/dsh-tool-bash/lib/index.js` patch 完整性（merge 动 node_modules 时）
    - [x] 2.5e 门禁全绿（typecheck 零错 + npm test 661/661，基线 562 → +99：main .ts 转换激活的休眠 .mjs 用例并入）→ merge commit + tasks 回写
      - 测试处置（禁删测试纪律，逐条理由）：删 `rescue-integration.test.ts`（12 例：10 例断言 Electron main.js rescue:*/preload 桥接线——refactor 架构该接线不存在（由 lib/boot.ts 多级失败链替代），同一功能在 Tauri 终态由 sidecar/rescue-integration.ts 承担（f04ed56），接线契约测试由 Task 7 重建；2 例断言 main 救援页 recovery.html 内容——页面已切换为 refactor 渲染器恢复页，见下）；删 `bridge-preload-parity.test.ts`（3 例：断言 main preload.js `const dshDesktop =` 面 ↔ sidecar/bridge.ts 键集一致——合并树 preload 已是 refactor 薄壳（preload/api.ts 暴露面），sidecar 尚未接管（Task 3.5/7），契约测试随 Task 7.2 语义对齐时重建）
      - 架构错配修正（Task 0 遗留，本任务发现）：`assets/recovery.html` Task 0 曾机械取 main 救援页（要求 bridge.rescue.*，refactor preload 不暴露 → 渲染器恢复页整体降级「无法连接桌面客户端桥接」）→ 改取 refactor 渲染器恢复页（window.dshDesktop.recovery.{getState,reload,restart,exportLogs}，与活跃 preload/api.ts、renderer-recovery 机器匹配）；main 救援页随 Task 7/8 sidecar 化回归。`assets/recovery-center-preload.js` merge 曾取 main Tauri WS 版 → 还原 ours Electron contextBridge 版（活跃 lib/recovery-center/register.ts 消费；Tauri WS 版由 main.rs init script 消费，Phase 3 壳接管时切回）
      - 适配修复：`electron-builder.yml` files 补 `- compact-preset-migrate.js`（lib/desktop/companion-sync.ts 启动 require，漏装破坏 dsh-compact 托管 preset 迁移）；`test/onboarding-selection.test.ts` 样本注册表对齐合并后现实（删 dsh-market-plugin/zat-market 退役条目、compact 入核心；相关断言与 fixture 同步改写，测试意图不变）
      - 关键认知修正：**rescue-agent 不再按主文档 §7 前言「Phase 1 核对等价覆盖后删除」处理**——main 演进（f04ed56）已在 tauri-shell/sidecar/rescue-integration.ts + server.ts + bridge.ts 建成完整 sidecar 救援链（rescue.*/safe-mode 域），rescue-agent.js 是其活跃依赖，**保留**；Task 4 执行时据此调整

- [x] Task 3: 根模块与测试冲突解决（§6-D/E/F 组）
  - [x] 3.1 删 .js 侧：`main.js`/`client-updater.js`/`updater.js`/`plugin-guard.js`/`wsl-backend.js`（refactor .ts 为唯一源）
  - [x] 3.2 add/add 根模块 .ts（balance/builtin-collision/bundle-integrity/error-detail/koffi-preflight/patch-row-heal/plugin-manager-state/session-watcher/profile-module-heal）：取 refactor 版
  - [x] 3.3 content 类（plugin-updater/preset-sync/preload/chrome/stable-port/watchdog/session-encoding-heal/scripts 六个/test 四个）：refactor 版基底
  - [x] 3.4 删 `.test.mjs` 两处（client-updater-apply/recovery-integration）：先确认 refactor .ts 等价覆盖，不足则先补测试再删
  - [x] 3.5 sidecar 依赖签名核对：`resolveRepos`/balance API/updater API/plugin-updater API 逐一对齐（refactor 导出面 ⊇ main 消费面）→ 门禁全绿 → commit
    - 完成记录：`client-updater.ts` 门面已含 `resolveRepos`（lib/client-update/index.ts:21）；balance 7 成员/updater 6 成员/onboarding 6 成员/plugin-updater 全量消费逐一核对覆盖。**吸收 main 侧 plugin-copy.ts 4 项增量**（平行版本重叠，main vnext-absorb Phase 3 语义）：`COPY_STAMP` 导出 + `pluginCopyEntries`（旧 companion-sync 导出面兼容）+ `pluginCopyIsComplete`/`invalidatePluginCompleteCache`（companion-copy-integrity 契约：源戳记一致但目标文件缺失必须重拷，判定按 dest+mtime+stamp 进程内缓存）+ `copyPluginPackage` 跳过判定升级为「内容未变且目标完整」。sidecar `onboardingLogic` 类型断言精确化（CORE/RECOMMENDED_PLUGIN_IDS 为 Set 非 string[]，main 侧本就是 Set，运行时无碍）。过渡链路落地：`lib/state.ts`+`initVNextState`、`lib/log.ts`+`setLogSink`、`lib/recovery-center/register-sidecar.ts`（sidecar 恢复中心动作分发，剥离 Electron 依赖）、`tsconfig.transition.json`（erasableSyntaxOnly:false 编译 lib/desktop 过渡层）、stage-resources.mjs 清单同步。门禁：typecheck 主配置+过渡配置零错误，npm test 661/661（上游 main 合并后 558→661）。

- [x] Task 4: main 修复移植（11 项，§7 清单；每项先写失败测试再移植——见 tdd.md T1-T11）
  - [x] 4.1 `lib/server.ts` ← 7f7fa05 并发 dsh web 检测（fix #22，main.js +81 行语义）（`lib/server-lock.ts` + `test/server-lock.test.ts` 8 用例）
  - [x] 4.2 `lib/plugin-copy.ts` ← 4bc3ac1 安全模式守卫（safeModeActive + patch 行停摆）
  - [x] 4.3 `lib/plugin-copy.ts` ← a1569b3 schemastery 首启依赖（`test/plugin-host-deps.test.ts`）
  - [x] 4.4 `lib/plugin-copy.ts` ← d268fe9 profile 完整性（tauri 侧 stage-resources 随 main 树自动保留）
  - [x] 4.5 `plugin-updater.ts` + `scripts/patch-deps.ts` ← 9d068c2/406914e/3f12d05 可选升级字段三连
  - [x] 4.6 `lib/client-update/*` ← 0d69c79 停滞超时 300s（核对 refactor 现值）
  - [x] 4.7 核对项：2dd37bd 流写入保护（server.ts dsh-web.log + boot.ts desktop.log 均经 `createStreamWriteGuard`；guard 改具名导出 + 打包清单补录）、16b8ff4 splash（assets/loading.html prefers-color-scheme 已随 main 树并入）、18b0fd4 escalation 豁免（已在 4.5 完成）
  - [x] 4.8 11be738 托盘完全重启 → 已移植 `lib/tray.ts`（`test/tray-menu.test.ts` 3 用例）+ 记入 Task 8.1 清单 → 门禁全绿（typecheck 0 错 + 672 测试全过）→ commit

- [x] Task 5: 模块统一批次一——sidecar 消费面 ctx 化（12 模块）
  - [x] 5.1 建立 `lib/host-ctx.ts`（模板＝guard-box XxxCtx 单例注入 + runtime-paths 防御性缺省）：HostCtx 接口 isPackaged/resourcesPath/appVersion/log/exitProcess/requestQuit/notify/copyToClipboard/getPath/setPath/removeAppMenu/showMessageBox/shortcuts（.lnk 能力，缺省 undefined→调用方跳过维护）；未注入＝开发态缺省（GUI 能力静默/无头兜底按 cancelId 应答，绝不抛错）
  - [x] 5.2 改造 12 模块：原 electron 面 6 模块全部去 electron 依赖——`proc.ts`（nodeExe/npmCli 资源根）、`server.ts`（isPackaged 判定/剪贴板/requestQuit）、`boot.ts`（getPath/setPath/appVersion/removeAppMenu/fatal 无主窗消息框/exitProcess）、`watchdog-boot.ts`+`plugins.ts`（Notification→notify，onClick 语义保持）、`shortcuts.ts`（getPath + shell.read/writeShortcutLink→shortcuts 注入，宿主无能力整体跳过）；已中立 6 模块（paths/plugin-copy/plugin-manager-core/market-modules/market-ops/preview）核对确认本就零 electron 引用
  - [x] 5.3 双宿主注入适配：`main.ts` 装配段 initHostCtx（Electron 面：app/Notification/clipboard/dialog/Menu/shell 直映射；组合根是 electron import 的合法装配点）；`tauri-shell/sidecar/server.ts` 装配段 initHostCtx（打包态＝DSH_RESOURCE_ROOT 或 sidecar 旁 dsh-desktop 布局判定；消息框/通知 stderr 无头兜底；剪贴板/.lnk 复用既有 PowerShell 实现；requestQuit→`shell.quit-for-update` 壳层 ExitRequested 有界收口，不在 sidecar 直接 process.exit）
  - [x] 5.4 测试与打包面：`test/host-ctx.test.ts` 11 用例（缺省语义×5/注入生效/reset 清理/12 模块零 electron 门禁/原 electron 面 6 模块 hostCtx 化断言/双宿主接线/打包清单）；既有夹具（plugin-host-deps 等）经 require 链自动兼容无需改造；electron-builder.yml files 与 stage-resources.mjs LIB_VNEXT 各补录 `lib/host-ctx.js`（bundled-files 闭包防呆 + 手工清单双覆盖）→ 门禁：typecheck 主配置+过渡配置零错误、npm test 686/686（基线 675 +11；watchdog-behavior 一次 `null!==0` 为测试内注释记载的既有竞态，隔离与重跑均全过）→ commit

- [x] Task 6: 模块统一批次二——Electron 专属面 ctx 化（其余模块）
  - [x] 6.1 `lib/state.ts`：mainWindow 概念移除 → bridge 会话句柄；`lib/ipc/sender.ts` 来源校验改 bridge 会话 token
  - [x] 6.2 `lib/window.ts` 窗口控制语义 → Rust 壳 `win.*` 通道对接层；`lib/tray.ts` 托盘语义 → 事件桥接（实现留 Task 8）
  - [x] 6.3 `lib/extension-host/*`（manager/rpc/job-fence/sdk）+ `lib/supervisor/*` + `lib/snapshot/*`：state/log 注入化，调度器常驻化
  - [x] 6.4 `lib/recovery-center/*`、`lib/renderer-recovery/*`、`lib/update-flow.ts`、`lib/onboarding.ts`、`lib/migration.ts`、`lib/balance-ui.ts`、`lib/session-heal.ts` 等其余模块
  - [ ] 6.5 删除 `lib/desktop/*` 14 模块（前置：Task 4 移植清单全部勾选 + §5 映射表逐行核对）→ 门禁全绿 + `grep -r "from 'electron'" lib/ shared/` 零命中 → commit
  - 完成记录（2026-08-25，commit 见 tasks 回写）：分三波推进——Wave 1（IPC 传输面收口 + window.ts 去 electron：42 channel 全部经注入 `IpcSurface` 挂载、来源校验改 `BridgeSession` token 比对、`showBox`→`hostCtx().showMessageBox`、createWindow/reloadMainWindow 薄委托 `HostWindows`、attachEditContextMenu/guardFloatWebContents 迁组合根侧）；Wave 2（tray.ts 托盘菜单规格化 `buildTrayMenuSpec`/`executeTrayAction` 事件桥接、onboarding/balance-ui/run-state/update-flow/bridge/migration/recovery-center/register 全部去 electron，恢复中心窗口→`windows.openRecoveryCenter` + `rcSession` token 校验）；Wave 3（新建顶层 `host-electron/{ipc,windows,tray}.ts`：electronIpcSurface（token＝String(webContents.id)）+ HostWindows 全量实现（主窗/浮窗/向导/恢复中心/更新进度窗/renderer-recovery 挂载，自 git HEAD 原实现移植）+ HostTray（buildTrayMenuSpec→Menu 映射 + executeTrayAction 转发）；main.ts 装配 initHostCtx(windows/tray/relaunch/shell 面) + setDefaultIpcSurface；tsconfig include 与 electron-builder.yml files 同步补录）。门禁：typecheck 主配置+过渡配置零错误、npm test 699/699（基线 686 +13：`test/bridge-session-guard.test.ts` 新增 12 例——sender token 语义 5 + IpcSurface 挂载/越权拒绝 5 + 批次二零 electron 门禁 2；`test/context-menu.test.ts` Wave 1 曾临时弱化为 2 例迁移完成度断言，收口时恢复四场景原强度并拆出 lib 侧委托面独立 1 例，2→3）、`grep "from 'electron'" lib/ shared/` 零命中（`lib/client-update/net.ts:31` 的 require 惰性探测为既定例外：纯 Node 单测路径运行时探测回落，非编译期依赖）。测试适配（禁删纪律，意图不变）：`test/tray-menu.test.ts` 3 例由源码断言改行为测试（mock hostCtx 记录 relaunch/requestQuit，11be738 完全重启两档区分语义逐项断言）；`test/context-menu.test.ts` 3 例断言迁 host-electron/windows.ts 落点（四类场景菜单模板+主窗/浮窗挂接原强度恢复）；`test/recovery-integration.test.ts` 1 断言改 `attachWindowToRecovery(win, kind)` 宿主挂接面；`test/recovery-center.test.ts` IPC 断言改 `rc:action` + fromRecoverySession。
  - 执行偏差记录：**6.5 的 lib/desktop 删除并入 Task 7.1 执行**——sidecar `server.ts` 现仍 mount 14 个 `lib/desktop/*` 模块（mount('proc') 等），先删必崩 Tauri 侧；删除须与 Task 7.1「sidecar 挂载全部统一模块（≥37）」同一变更落地（届时一并收口 tsconfig.transition.json 排除项与 stage-resources.mjs 过渡链路）。§5 映射表逐行核对已完成（14 行全部有统一层对应物，main 增量移植在 Task 4 清账）。

- [x] Task 7: sidecar 全量接管 + bridge 扩域（补提交 `0ff143c`）
  - [x] 7.1 `tauri-shell/sidecar/server.ts`：挂载全部统一模块（≥37）+ 全部 IPC 域注册表（chrome:*/dsh:*/snapshot:* 11 域/rc:*/guard:*/onboard:*）
  - [x] 7.2 `sidecar/bridge.ts`：IPC 域覆盖 36+ 域，语义对齐 `preload/chrome.ts`（invoke/send 双语义保留）
  - [x] 7.3 `ping.js` → `ping.ts`；sidecar `import x = require()` 改标准 import；tsconfig 编译范围收口
  - [x] 7.4 snapshot 域集成测试（overview/create/restore 真实调用）；越权会话拒绝测试（见 tdd.md T14）→ Node/TS/native 门禁全绿；Tauri `cargo test` 被本机 MSVC `link.exe` 0xc0000139 环境故障阻断，**标 CI 复验（Task 13.4）** → 补提交完成

- [x] Task 8: Tauri 壳能力补齐（tauri-shell/）（补提交 `184cc71`）
  - [x] 8.1 `src/main.rs` 托盘菜单：重启 Web 服务 / 完全重启 / 退出（对齐 11be738 + refactor 托盘项）
    - 完成记录：托盘新增「完全重启」，紧随「重启 Web 服务」，动作走 `app.restart()`；退出仍走有界退出链。
  - [x] 8.2 导航围栏：仅放行 localhost dsh web + 白名单（承接 `lib/window.ts` isAllowedWebUrl 语义）
  - [x] 8.3 快照备份树面板入口（⋯ 菜单位置对齐 refactor：重启 Web 服务与重新加载之间）；面板经 bridge 拉起
  - [x] 8.4 splash 主题跟随系统（16b8ff4 语义）；恢复中心三入口在 Tauri 壳可达性核对
  - [x] 8.5 壳层手动 smoke：本机 `cargo check`/`tauri dev` 被 VS Build Tools 18 的 `link.exe`/`lib.exe` 0xc0000139 阻断，且无既有壳产物可启动；已完成可行替代门禁：Task 8 定向契约 4/4、typecheck、npm test、boot-smoke（sidecar→dsh web HTTP 200）全绿，GUI smoke 明确因 `target/debug/dsh-eac-shell.exe` 不存在而未执行；**真实托盘/导航/快照面板 smoke 标 CI 复验（Task 13.4 产物下载后本地实测 + CI 双平台构建）**。已补提交。

- [x] Task 9: 平台抽象层（Linux 支持核心）（补提交 `9e40a63`）
  - [x] 9.1 `job-fence.ts` 围栏策略：Linux 原生 PDEATHSIG + 独立进程组，降级模式按进程组回收；dsh web 同步建立 Unix 独立进程组
  - [x] 9.2 `main.rs` 平台抽象：资源定位/进程 spawn/隐藏控制台由 Platform trait 收口；Windows CREATE_NO_WINDOW / Unix no-op；targets 含 nsis/deb/AppImage
  - [x] 9.3 node 运行时双平台：`scripts/fetch-node.ts` 支持 linux-x64；Windows `vendor/node/node.exe` / Linux `vendor/node/bin/node`
  - [x] 9.4 Windows 专属面挂分支：junction/.lnk/client-update 等在 Linux 静默降级或提示包管理器升级，并有平台分支测试
  - [x] 9.5 Linux 真实行为测试已落地（父死信号/进程组/主孙进程回收），当前 Windows 门禁 724 项中 722 通过、2 个 Unix 用例按平台跳过；本机 MSVC `link.exe` 0xc0000139 且无 Linux/WSL/Docker 环境，**Linux native cargo test 与 ≤5s 零孤儿验证标 CI 复验（Task 13.4 + 11.3 linux-smoke job）**。已补提交。

- [x] Task 10: Electron 退役（补提交 `09d0937`）
  - [x] 10.1 删除：`main.ts`、`preload.ts`/`preload/`、`electron-builder.yml`、`build/installer.nsh`、electron 测试夹具（改造为 sidecar 夹具，数量不减）
  - [x] 10.2 `package.json`：删 electron/electron-builder devDeps；scripts 收敛 build/typecheck/test/test:native/build:native/clippy:native + tauri 打包链
  - [x] 10.3 CI：`ci.yml` 重写为 typecheck + cargo test + node 测试 + `tauri build`（双平台 matrix：windows-latest + ubuntu-latest）；删 `release.yml`
  - [x] 10.4 `release-tauri.yml`：补 native 构建（cargo + napi）与 tag 版本注入步骤；双平台 matrix；产物过滤按平台（承袭项目约束：Windows/Linux × x64）
  - [x] 10.5 grep 终检：`grep -ri electron package.json dsh-desktop/lib tauri-shell` 零命中已达成；已审计 Task 9 的 724 项到 Task 10 的 711 项降幅，将仍适用于 Tauri 的 installer/recovery 等价断言迁入现有测试，当前 typecheck、clippy:native、test:native、Node 测试（723 通过、2 个 Unix 用例按平台跳过）、Task 10 定向测试与 workflow YAML lint 全绿；Tauri `cargo test` 仍被本机 VS Build Tools 18 `link.exe` 0xc0000139 环境故障阻断，**标 CI 复验（Task 13.4）**。已补提交（统一门禁：typecheck 0 错 + npm test 723 过/2 Unix 跳过 + test:native + clippy:native 全绿；patch-row-heal 一次失败为本机 safe-delete shim 环境伪失败，隔离复验 25/25）。

- [x] Task 11: 双平台打包链与升级路径（提交 7bfdbf1 / 6381645 / 5b06da9）
  - [x] 11.1 Windows：`tauri build` 产出 NSIS Setup.exe + 便携 zip + SHA-256（make-release-hashes 扩五类扩展名 + 多目录聚合；verify-dist-fresh 补 zip + --platform；release-tauri.yml dist 汇总 + 哈希 + 新鲜度校验）
  - [x] 11.2 Linux：产出 `.deb` + `.AppImage`；OQ-1 不产 rpm（Tauri v2 无此 target）、OQ-2 AppImage/deb 重命名对齐历史规范（release-tauri.yml rename 步骤）
  - [x] 11.3 Linux 冒烟：ci.yml 新增 linux-smoke job（docker ubuntu:24.04 内 AppImage --appimage-extract + deb dpkg -i/-r + vendored node 直启 sidecar 探活）
  - [x] 11.4 升级链脚本：upgrade-test-441.js 参数化（4.4.1→6.0.0）+ 新增 upgrade-test-510.js（5.1.0→6.0.0）
  - [x] 11.5 README 下载链接更新为 v6.0.0 双平台产物 → commit

- [x] Task 12: 性能与安全专项（主文档 §8）
  - [x] 12.1 性能度量入档：boot 实测 ≈502.9ms（stamp-scan 498.7ms + copy-skip 冷 481.6/暖 21.3ms，bench:boot 脚本挂载）；sidecar 探活驱动 sidecar-boot-probe.js；包体积 ci.yml 断言 <80MB；快照基准标待办
  - [x] 12.2 安全测试落地：bridge token 越权（12 例）；导航围栏 nav_fence.rs 表驱动 6 例；H2/H3 路径逃逸 5 例；Windows Job Object 树击杀 + Unix 降级围栏；release 禁 devtools（Cargo.toml 去 feature + cfg 门禁）
  - [x] 12.3 checklist.md 第六节九项回写 → commit

- [ ] Task 13: 终验与合并
  - [ ] 13.1 全量终验：AC-1~AC-16 逐条过（checklist.md 全勾）
  - [ ] 13.2 插件隔离实测（AC-6）：装第三方 SDK 插件 → Host 独立进程 → 强杀验证 → 状态机退避
  - [ ] 13.3 升级链实测（AC-15）：4.4.1→6.0.0 与 5.1.0→6.0.0 端到端
  - [ ] 13.4 push `merge/vnext-tauri`（走 gh-proxy.org）跑 CI 双平台全绿
  - [ ] 13.5 `git checkout main && git merge merge/vnext-tauri --no-ff` 推送；打 `v6.0.0` tag；在线盯跑 release-tauri.yml 首轮（重点：NSIS 时长/缓存行为/双平台产物齐全）
  - 执行偏差记录：① 上游 main 第三次演进（23 commits，含其独立 Linux 实现 #219 + 壳层能力 clipboard/files.open/HTML5 拖拽/通知）以合并提交 `fceca62` 吸收——Linux 核心取我方（Rust PDEATHSIG 围栏），吸收上游 HTML5 拖拽修复与 dsh-authorization 依赖；上游 sidecar fileDropSave 处理器（在已删 lib/desktop/plugin-ops.ts）标待办；② 删 9 个上游死架构测试（lib/desktop/*、unzipper、files.authorize-open 等）+ 回退 3 个共享测试，理由见 `fceca62` 提交说明
