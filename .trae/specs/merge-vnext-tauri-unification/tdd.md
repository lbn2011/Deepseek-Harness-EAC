# TDD 计划 · VNext × Tauri 统一合并

> 纪律：**每个行为单元先写失败测试（RED），确认失败原因正确后再写实现（GREEN），禁止削弱断言变绿**。
> 合并/删除/树级操作类步骤（Task 0-3）不适用 TDD（纯 git 操作与资产取舍），以门禁回归代替；**Task 4 起全部行为改动走 TDD**。
> 测试运行环境：Node ≥ 26（type-stripping 直跑 `.ts`）；Rust 用例 `cargo test`；Linux 用例在 ubuntu 环境（CI job 或本地 WSL）跑。
> 每个行为单元标注 Source: `spec/merge-vnext-tauri-unification AC-<n>`。

## 一、修复移植（Task 4 —— 每项移植前先让测试红）

### T1 并发 dsh web 检测（AC-2）
- Behavior: 已有 dsh web 进程占用端口时，再次启动拒绝 spawn 并给出冲突诊断
- Expected: 模拟端口占用/进程存在 → `startServer` 返回冲突错误而非并发写入
- Test target: `dsh-desktop/test/server-concurrent-guard.test.ts`（新增）
- Production target: `dsh-desktop/lib/server.ts`
- RED 先行：测试引用尚不存在的冲突检测断言 → 失败 → 移植 7f7fa05 语义（main.js +81 行的锁/端口探测逻辑按 ctx 化改写）→ GREEN
- Source: AC-2

### T2 安全模式守卫（AC-2）
- Behavior: `guard/safe-mode.json` active 时，配套插件 patch 行同步停摆
- Expected: 安全模式激活 → sync 后 patch 文件不含新增配套行；退出安全模式 → 恢复同步
- Test target: `dsh-desktop/test/plugin-copy-safe-mode.test.ts`（新增）
- Production target: `dsh-desktop/lib/plugin-copy.ts`（safeModeActive 守卫）
- Source: AC-2

### T3 schemastery 首启依赖（AC-2）
- Behavior: 真实 profile 首启时插件宿主依赖（schemastery）缺失可自愈
- Expected: 模拟依赖缺失的 profile → sync 后依赖存在且插件可加载
- Test target: `dsh-desktop/test/plugin-copy-schemastery.test.ts`（新增）
- Production target: `dsh-desktop/lib/plugin-copy.ts`
- Source: AC-2

### T4 profile 完整性（AC-2）
- Behavior: 插件从内置资源同步到 profile 过程中文件不缺失
- Expected: 源树含入口/依赖文件 → 同步后目标树逐文件齐全（对照 d268fe9 的完整性清单）
- Test target: `dsh-desktop/test/plugin-copy-integrity.test.ts`（新增）
- Production target: `dsh-desktop/lib/plugin-copy.ts`
- Source: AC-2

### T5 可选升级字段兼容（AC-2，三处）
- Behavior: 工具 schema 含可选升级字段时三工具（dsh-tool-*）同款补丁全覆盖
- Expected: patch-deps 重放后三工具 vendored 文件均含可选升级字段；打包链不丢失补丁
- Test target: `dsh-desktop/test/patch-deps-optional-fields.test.ts`（新增）+ 既有 `plugin-updater` 测试扩展
- Production target: `dsh-desktop/plugin-updater.ts`、`dsh-desktop/scripts/patch-deps.ts`
- Source: AC-2

### T6 更新停滞超时（AC-2）
- Behavior: 更新下载停滞 300s 判超时（原 150s）
- Expected: 模拟停滞 151-299s 不超时；≥300s 超时
- Test target: 既有 client-update 测试扩展（`lib/client-update/download` 相关）
- Production target: `dsh-desktop/lib/client-update/*`
- 注：先核对 refactor 现值——已含 300s 则测试直接锁定该行为（防回归），无需改实现
- Source: AC-2

### T7 escalation 豁免（AC-2）
- Behavior: 全访问模式下必填 escalation 字段不再强制
- Expected: full access 工具 schema 调用不含必填 escalation 报错
- Test target: Task 4.7 定位落点后补（预计 plugin-ops/plugins 域）
- Source: AC-2

## 二、模块统一与 sidecar 接管（Task 5-7）

### T8 宿主 ctx 注入契约（AC-3）
- Behavior: lib/ 模块仅通过注入的 HostCtx 获取宿主能力，electron 导入为零
- Expected: `grep -r "from 'electron'" dsh-desktop/lib/ dsh-desktop/shared/` 零命中；全部模块接受 ctx 参数并可被 mock 宿主实例化
- Test target: `dsh-desktop/test/host-ctx-contract.test.ts`（新增：遍历 lib 模块断言无 electron import + 注入断言）
- Production target: `dsh-desktop/lib/host-ctx.ts` + 各模块
- 批次门禁：Task 5/6 每批改造后既有测试（ctx mock 夹具）全绿
- Source: AC-3

### T9 bridge 会话 token 来源校验（AC-12 安全项）
- Behavior: 敏感 IPC 域仅接受主窗 bridge 会话
- Expected: 无 token / 错 token / 非主窗会话调用 `snapshot:restore`、`dsh:file-revert` 等敏感域 → 拒绝（错误码 + 事故日志）；正确 token → 放行
- Test target: `dsh-desktop/test/bridge-session-guard.test.ts`（新增）
- Production target: `tauri-shell/sidecar/server.ts`（会话校验中间层）+ `dsh-desktop/lib/ipc/sender.ts` 语义迁移
- Source: AC-3/AC-12 + 安全专项

### T10 snapshot 域全量可达（AC-5）
- Behavior: snapshot 11 个 IPC 域经 sidecar JSON-RPC 完整暴露
- Expected: 逐域调用返回成功；restore 触发 dsh web 停/重启编排
- Test target: `tauri-shell/sidecar/__tests__/snapshot-rpc.test.ts`（新增集成测试）
- Production target: `tauri-shell/sidecar/server.ts`（挂载）+ `dsh-desktop/lib/snapshot/*`
- Source: AC-5

### T11 sidecar 模块挂载完备性（AC-4）
- Behavior: sidecar 挂载全部统一模块（lib/desktop 删除后无缺口）
- Expected: 挂载清单测试——lib/ 下每个导出模块在 sidecar 注册表中有对应挂载或显式豁免清单
- Test target: `tauri-shell/sidecar/__tests__/mount-coverage.test.ts`（新增）
- Production target: `tauri-shell/sidecar/server.ts`
- Source: AC-4

## 三、平台抽象（Task 9 —— Linux 核心行为）

### T12 Linux 进程围栏（AC-10）
- Behavior: Linux 下父进程（sidecar）死亡 → 全部子进程（Extension Host/dsh web）≤5s 退出
- Expected: 围栏验证脚本：spawn 子进程组 → kill 父 → 轮询 ≤5s 断言全部退出；孤儿数 = 0
- Test target: `native/supervisor/tests/fence_unix.rs`（新增，`#[cfg(unix)]`）+ TS 侧 `dsh-desktop/test/job-fence-platform.test.ts`
- Production target: `native/supervisor/src/`（PDEATHSIG + setpgid）+ `dsh-desktop/lib/extension-host/job-fence.ts`
- 对照语义：Windows Job Object KILL_ON_JOB_CLOSE ↔ Unix PDEATHSIG + 进程组 kill 补偿（父杀子向）
- Source: AC-10

### T13 node 运行时双平台定位（AC-8 前置）
- Behavior: nodeExe() 在双平台返回正确 vendored 路径
- Expected: Windows → `vendor/node/node.exe`（打包后 resources/node/）；Linux → `vendor/node/bin/node`
- Test target: `dsh-desktop/test/proc-node-locate.test.ts`（新增：平台参数化用例）
- Production target: `dsh-desktop/lib/proc.ts` + `dsh-desktop/scripts/fetch-node.ts`
- Source: AC-8

### T14 Windows 专属面平台分支（AC-11）
- Behavior: junction 巡检/.lnk/注册表/NSIS/client-update 在 Linux 静默跳过且不报错
- Expected: 平台注入为 linux 时：`startJunctionWatchdog` no-op；快捷方式维护 no-op；更新入口返回「Linux 由包管理器升级」提示；无 error 级日志
- Test target: `dsh-desktop/test/platform-fallbacks.test.ts`（新增：每专属面一个断言）
- Production target: `lib/watchdog-boot.ts`、`lib/shortcut-maintenance.ts`、`lib/client-update/index.ts`、`lib/update-flow.ts`
- Source: AC-11

## 四、退役与发布（Task 10-11）

### T15 打包产物完备性（AC-7/AC-8）
- Behavior: `tauri build` 双平台产出齐全且哈希就绪
- Expected: Windows: Setup.exe + 便携 zip + SHA-256；Linux: .deb + .AppImage(+.rpm) + SHA-256；产物体积记录入档
- Test target: `scripts/verify-dist-fresh.ts` 扩展（平台参数化）+ CI 步骤断言
- Production target: `tauri-shell/tauri.conf.json`、`scripts/make-release-hashes.ts`、`tauri-shell/stage-resources.mjs`
- Source: AC-7/AC-8

### T16 升级链（AC-15）
- Behavior: 4.4.1/5.1.0 存量用户升级到 6.0.0 后 .dsh 插件与配置零丢失
- Expected: 升级脚本端到端——升级前后 `.dsh/{plugins,profiles,settings}` 内容一致（允许结构迁移差异，逐项 diff 记录）
- Test target: `upgrade-test-441.ts`（改造）+ `upgrade-test-510.ts`（新增）
- Production target: NSIS 升级钩子 + `lib/client-update/apply.ts`
- Source: AC-15

## 五、TDD 执行顺序

```text
Task 4:  T1→T2→T3→T4→T5→T6→T7（每项独立 RED→GREEN→commit）
Task 5:  T8（契约测试先立，批次一改造中持续绿）
Task 6:  T8 续（批次二）；T9 在 sender.ts 迁移时先行
Task 7:  T10→T11（挂载完备性测试驱动 server.ts 扩挂）
Task 9:  T12→T13→T14（Linux 行为全部测试先行）
Task 10: T15 前置（CI 断言先红）
Task 11: T15→T16
```

## 六、既有测试安全网纪律

- 基线 499 个测试语义全程保持；夹具从 Electron mock 改 ctx mock 时**断言逐条等价迁移**
- `.test.mjs` 删除前必须确认 `.ts` 等价覆盖（Task 3.4）
- 任何测试数量下降在 commit message 逐条列出文件+理由；checklist AC-12 终验复核
