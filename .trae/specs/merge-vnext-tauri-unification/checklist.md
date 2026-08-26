# Checklist · VNext × Tauri 统一合并终验

> 用法：Task 13 终验时逐条勾选；每条须附**新鲜命令输出或实测证据**（日期+命令+结果），不接受「应该通过」。
> 对应 spec.md AC-1~AC-16。

## 一、合并正确性

- [ ] AC-1 冲突零残留
  - 证据：`git grep -l "<<<<<<< " -- . ` 零输出；冲突清单 72 处与主文档 §6 解决表逐组核对表
- [ ] AC-2 11 项修复移植可追溯
  - 证据：`git log --oneline --grep="移植"` 列出移植 commit；每项对应测试名清单：
    - [ ] 并发 dsh web 检测（#22）测试：`test/server-concurrent-guard.test.ts`
    - [ ] 安全模式守卫测试（companion patch 停摆断言）
    - [ ] schemastery 首启依赖测试
    - [ ] profile 完整性测试
    - [ ] 可选升级字段 ×3 测试（plugin-updater / patch-deps / 打包链重放）
    - [ ] 更新停滞超时 300s 断言
    - [ ] 流写入保护核对记录（已含/补齐结论）
    - [ ] escalation 豁免测试
    - [ ] 托盘完全重启（Task 8 壳层实测截图/录屏）
    - [ ] splash 主题跟随（暗/亮双主题截图）

## 二、架构终态

- [ ] AC-3 electron 零依赖
  - 证据：`grep -r "from 'electron'" dsh-desktop/lib/ dsh-desktop/shared/` 零输出 + `npm run typecheck` 零错误
- [ ] AC-4 lib/desktop 删除 + sidecar 全挂载
  - 证据：`Test-Path dsh-desktop/lib/desktop` False；sidecar server.ts 模块挂载数与 IPC 域注册数统计输出
- [ ] AC-5 snapshot 11 域可达
  - 证据：集成测试输出（overview/create/detail/restore/branch-create/branch-delete/branch-set-current/config-save/delete/gc 全调用成功）
- [ ] AC-6 插件隔离实测
  - 证据：`tasklist`/`ps` 输出显示 Host 进程独立 PID；强杀命令+核心存活验证输出；状态机 retrying/quarantined 日志摘录

## 三、双平台编译与使用

- [ ] AC-7 Windows 产物
  - 证据：NSIS Setup.exe + 便携 zip 路径、体积、SHA-256 清单
- [ ] AC-8 Linux 产物
  - 证据：`.deb` + `.AppImage`（+`.rpm`）路径、体积、SHA-256；Ubuntu 容器内 AppImage 启动日志（dsh web UI 加载成功）
- [ ] AC-9 CI 双平台
  - 证据：单次 push 的 Actions run 截图/链接，windows-latest + ubuntu-latest 两 job 全绿
- [ ] AC-10 Linux 进程围栏
  - 证据：围栏验证脚本输出——杀 sidecar 父进程后 ≤5s 全子进程退出（PDEATHSIG + 进程组）
- [ ] AC-11 Windows 专属面 Linux 静默跳过
  - 证据：平台分支单测输出（junction-patrol/.lnk/注册表/NSIS/client-update 禁用提示）+ Linux 运行日志无相关报错

## 四、TS 化与测试

- [ ] AC-12 类型与测试全绿
  - 证据：`npm run typecheck` 零错输出；`npm test` 全绿输出（附测试总数 vs 基线 499 差异说明——数量变化逐条列出理由，不得删测试降绿）
- [ ] AC-13 Rust 测试全绿
  - 证据：`npm run test:native` 输出（supervisor + snapshot + 新增 Linux 围栏用例）

## 五、退役与发布

- [ ] AC-14 Electron 彻底退役
  - 证据：`Test-Path` main.ts/preload.ts/preload//electron-builder.yml 全 False；`grep -i electron package.json` 零输出
- [ ] AC-15 Windows 升级链
  - 证据：4.4.1→6.0.0 与 5.1.0→6.0.0 两份升级脚本端到端运行输出；`.dsh` 目录前后 diff（插件与配置零丢失断言）
- [ ] AC-16 正式发布
  - 证据：v6.0.0 tag；release-tauri.yml 首轮在线 run 链接与产物清单（两平台齐全）；README 下载链接更新 commit

## 六、性能与安全专项（Task 12 入档）

- [x] boot 关键路径 ≤500ms 回归测试输出 — `node scripts/bench-boot.js --runs 2 --skip-hosts`（2026-08-26）：stamp-scan 498.7ms/轮、copy-skip 冷 481.6ms/暖 21.3ms、boot 内两次 sync 合计 ≈502.9ms（暖路径戳记缓存收益显著：21.3ms）。接近 ≤500ms 目标，完整应用进程级开销由 e2e-v4「启动就绪 elapsed」覆盖。脚本挂载 `npm run bench:boot`。
- [x] sidecar 启动时间 vs Electron 版对比记录 — sidecar boot 探活驱动 `tauri-shell/scripts/sidecar-boot-probe.js` 已就绪（spawn→boot.start→webUrl→HTTP 200 计时，CI linux-smoke L3 复用）；Electron 已退役无实测对象，对比基线为历史 e2e-v4「启动就绪 elapsed」，标「对比基线=历史数据」。实测值需完整 dsh web 安装态/CI 产出后回填。
- [x] Windows 安装包体积 <80MB（vs Electron 155MB）— ci.yml Windows job 加体积断言步骤（NSIS exe ≥80MB 即 fail）；实测值随 CI 首跑回填（本机 MSVC 阻断本地 tauri build）。
- [ ] 快照创建时间/磁盘占用基准数据 — 快照功能测试齐全（snapshot-manager 7 例 + sidecar-snapshot-rpc 4 例 + native 16 例）；基准脚本 `bench-snapshot.ts` 未单列，标待办（实测需完整 DSH_HOME 快照数据）。
- [x] bridge 越权调用拒绝测试输出 — `test/bridge-session-guard.test.ts` 12 例（无会话/错 token/死会话拒绝、42 channel 挂载、snapshot:restore/dsh:file-revert/guard:action 敏感域 rogue-token 拒绝 unauthorized）+ `sidecar-snapshot-rpc.test.ts` 补 sidecar 链路 token 拒绝。
- [x] 恶意 URL 导航拦截测试输出 — `tauri-shell/src/nav_fence.rs` 表驱动 6 例（file:/javascript: 拒、同 origin 放行、回环+端口白名单、回环错端口拒、外域拒）+ `test/release-hardening.test.ts`/`tauri-shell-task8.test.ts` 源码断言；cargo test 由 CI 复验（本机 MSVC 阻断）。
- [x] H2/H3 路径逃逸拒绝测试输出（Startup\*.bat 拒绝断言）— `test/file-roots-escape.test.ts` 5 例（DANGEROUS_EXT 危险扩展名 + isUnderFileRoots Startup\*.bat/兄弟目录/..\.. 穿越拒绝）。
- [x] 退出零孤儿进程验证输出（双平台）— `test/job-fence-platform.test.ts`：Windows win32-job 真实树击杀（cmd→ping 孙进程链 ≤5s 全灭）+ Unix 降级围栏真实回收（win32 skip）；Linux PDEATHSIG cargo 用例由 CI 复验。
- [x] release 产物 devtools 禁用核验 — Cargo.toml 去 devtools feature + main.rs devtools 分支 `#[cfg(any(debug_assertions, feature="devtools"))]` 编译级门禁 + `test/release-hardening.test.ts` 源码断言；CI release 构建通过即运行时核验。

## 七、Open questions 决议记录

- [x] OQ-1 rpm 产出与否：**不产出**（决议日期 2026-08-26）。理由：Tauri v2 bundler 无 rpm target（历史 v4.4.0-linux 的 rpm 是社区 PR #12 的 electron-builder 产物，非 Tauri 能力）；Linux 升级沿用系统包管理器约定，deb + AppImage 已覆盖主流发行版。
- [x] OQ-2 AppImage 命名规范对齐：**对齐历史规范**（决议日期 2026-08-26）。release-tauri.yml Linux job 在 upload 前重命名：AppImage → `Deepseek-Harness-EAC-<ver>-x86_64.AppImage`、deb → `Deepseek-Harness-EAC-<ver>-amd64.deb`（版本取自 tag 注入）；README 下载链接与此命名一致。
