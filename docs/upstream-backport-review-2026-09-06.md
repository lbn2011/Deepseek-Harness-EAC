# 上游修复回迁评估清单（2026-09-06）

> 背景：`746483c` 以上游 zouyuxuan122/main（5.4.0 线，124 提交）为源做了 `-X ours` 策略合并——非冲突新增（插件/std 清单/台账/文档）自动并入，双方都改过的文件保留我方 6.0 实现。
> 本清单枚举**因冲突取我方而未进入代码的上游修复提交**（共 47 个，按 `git log 671e87e..upsterm/main` 逐提交与当前 HEAD 逐文件内容比对得出）。
> 使用方式：逐项评估 → 若我方确有对应缺口，从上游 cherry-pick 或手工移植；若我方修复轮（V1.2/V1.3）已覆盖同类问题，勾销即可。
> 注：「覆盖 N/M」= 该提交触碰 M 个文件，其中 N 个在当前 HEAD 与上游内容不同（不必然全是损失：我方架构分岔也计入）。

## 高价值候选（疑似我方真实缺口）

> **2026-09-06 补记**：合并后 CI 暴露上游 main.rs 与我方 main.rs（含热更新
> L1 改动）语义互斥（12 处断伤），已整体恢复我方 main.rs。下列 Rust 侧条目
> 因此**仍未采纳**，需按条人工移植（对应上游提交见 §上文提交号）。

| 上游提交 | 内容 | 触碰面 | 评估要点 |
| --- | --- | --- | --- |
| `1a05c17` | installer：MessageBox /SD 必须紧跟文本（makensis Usage） | installer-hooks.nsh | 我方 installer-hooks.nsh 若有 MessageBox 带 /SD 需核对参数顺序 |
| `f5948cc` | installer：弹窗去 MB_ICONQUESTION（钩子文件零管道符契约） | 同上 | 同上 |
| `2f31629` | stage 回填 fs-ext 原生构建；ui-verify 预置 onboarding 确认 | stage-resources.mjs / ui-verify-smoke | 检查我方 stage 是否处理 fs-ext；ui-verify 的 onboarding 预置可减手工步骤 |
| `bbe7952` | release：预取 Windows WebView2 依赖 | release-tauri.yml | 我方 workflow 若未预取，首装依赖下载慢 |
| `ea5c013` / `0572df9` | release：补齐 Windows 内核依赖准备 | 同上 | 同上 |
| `7a4dc65` | shell：视口失同步自愈（全屏黑屏条带/侧栏图标栏消失根治，5.3.4） | main.rs / bridge | 我方 main.rs 是否已有同款自愈；用户可感知的显示 bug |
| `9c5c23c` | shell：标题栏 logo 缺图退避重试（首启白方块） | main.rs / bridge | 同上 |
| `05ddcba` | shell：任务栏 Big 图标 WM_SETICON + 主窗首启尺寸自适应 | main.rs | 图标/尺寸体验项 |
| `b0a593a` | boot：补回 --no-open（启动弹浏览器回归） | boot-server | 我方 boot-server 若同构需核对 |
| `12a1652` / `25a8ccc` / `5d89422` | boot：凭据版本兼容 / 反向迁移删除（升级卡死元凶）/ 凭据库写读自愈 | boot-server / 凭据自愈 | 我方 H-002 已移植凭据自愈（c7566fa），逐条比对覆盖面 |
| `646b899` | Windows 菜单外链打开（ShellExecuteW）+ 日志导出 ZIP 化 + 中文/空格路径回归 | main.rs / sidecar | 检查我方菜单外链与导出实现 |

## 批次大扫除（上游独立修复轮，与我方 V1.2/V1.3 平行，需按题比对）

| 上游提交 | 内容 | 覆盖/总数 |
| --- | --- | --- |
| `deb89cb` | 5.3.5 全库大扫除：壳韧性14 + 安全围栏5 + 更新器/原子写8 + 插件资产8 + 打包链9（含 P0 配对挂死：boot.start 应答提前 + 备份清理异步延迟30s） | 29/47 |
| `693b803` | 5.3.5 复审接续：P0 lnk 批量异步 + WS 握手 peek 截断 + 安全围栏4 + 壳恢复链4 + 插件3 | 8/22 |
| `ef089a8` / `e8cc1b2` | 5.3.3 批次一/二：高危8 + 快照链接线 + 功能bug约30 + 性能10 + 死功能接线 | 38/45、38/46 |
| `bd550cc` | 5.3.1 全库精简 + 十二处真 bug 根治 + 内核版本钉防漂移 | 26/28 |
| `d2ab2e2` | ci：packaged 启动与 companion 生命周期稳定化 | 8/16 |

这些批次与我方 bug 修复轮大量同题（锁竞态/原子写/WS 握手/恢复链），但**实现不同**——建议以「题」为单位对照我方 `docs/bug-report-2026-09-05.md` 与两轮修复提交（`c7566fa`、`d841ca4`）确认覆盖，缺题再移植。

## 插件资产更新（✅ 已采纳 —— 2026-09-06 二次决议）

> **二次 grill 决议（2026-09-06）**：插件与更新方向以上游为主。`assets/plugins`
> 整树已切到 upsterm/main（47 目录，含上游退役的 dsh-stt / settings-nav-custom /
> tool-vision / file-drop，均已登记 RETIRED_BUILTIN_PLUGINS 由启动链清理老
> profile 残留）；注册表三表（COMPANION_PLUGINS / RETIRED / 更新源）与上游
> companion-sync 对齐；随包测试改用上游版本并以「采纳上游行为」修订我方契约
> 断言（scope.load 名单、titlebar 兼容选择器哈希、better-sidebar lazy-chunks
> 断言移除、nav-custom 相关断言移除）。computer-user-approval.test.ts 上游
> 自身即失败（上游插件已移除 requestApproval 参数、测试未跟上），未采纳。

| 上游提交 | 内容 | 状态 |
| --- | --- | --- |
| `ede6812` | 内置插件更新：picturereader 3.3.1、computer-user 0.3.6 | ✅ 已采纳（整树切上游） |
| `be5c5ad` | picturereader 3.3.2 图片桥 | ✅ 已采纳 |
| `204f38a` / `a707951` | 内置 dsh-raw-html 托管版 + 5.1 启动修复 | ✅ 已采纳 |
| `f45f25b` | 5.2.0：手机控制替换为内置喵丝滑 + 手机桥重写为完整 Web UI 反向代理 | ✅ 已采纳 |
| `0dbe628` / `3da4275` / `eb994d7` / `5d90853` | better-sidebar 系列：文件预览恢复 / 全新安装默认展开 / 宿主侧栏宽度保留 / 子代理实时行 | ✅ 已采纳 |
| `ef0aa46` / `bd7d0d1` / `a996d91` / `9cebe13` / `9432209` / `28b00d8` | 电脑操作设置保存、人设卡组合、双滚动条根治、透明裁切、模型图片输入开关、设置弹窗宽度/拖拽 | ✅ 已采纳（随插件树） |
| `d2ab2e2` | extension-host：并发重启定时器去重 + started 转移被拒即终止 Host + notify 隔离 | ✅ 已采纳（自动并入，语义完好） |

**遗留注意**：上游 dsh-eac-core-bridge 新版调用 `ctx.effect`（Core Bridge
cordis 组件新能力），上游 sdk/index.ts 已一并采纳提供该能力。

## CI/构建（对我方 CI 有参考价值）

| 上游提交 | 内容 |
| --- | --- |
| `616eb07` | Windows 首次编译兼容性提升（2/6） |
| `1f88791` | Linux 发布包启动链修复（4/5） |
| `0b8e16f` / `21e050b` | Linux inline CSS / bundle 构建机路径清理 |
| `4316029` / `5f5d1a1` / `e4b4247` / `3f6eed2` | vendored 内核 tarball、schemastery 固定 3.18.1、fetch-kernel 缓存/路径 |
| `b500889` | runtime-paths 支持注入 appRoot（测试确定化） |
| `099e86e` | 台账校验步骤路径（Windows working-directory 双重路径） |

## 明确不回迁

- 内核 0.1.2/0.1.3 升级系列（`0255148`、`03d5d21` 等）：我方 6.0 钉在 0.1.1-rc.2 且有 upgrade-test 断言；内核升级应作为独立变更单独评估（peer 兼容性见上游 `4f62c02` 台账结论：adapter-dsh 硬性排除 0.1.3）。
- 5.4 单安装器双形态（`49a5254`）：我方构建链未采用，README 亦未宣传。
- 全库瘦身/冻结壳退场（`8fd36b9`）：与我方结构决策相反（我方保留门面与历史归档），不采纳。

## 跟踪

- [ ] 高价值候选逐项核对（installer ×2 / stage / release 预取 / main.rs 体验项 ×3 / boot 凭据 ×3 / 菜单外链）
- [ ] 上游批次大扫除按题对照我方修复清单
- [x] 内置插件版本升级（picturereader 3.3.2 / computer-user 0.3.6 / raw-html / better-sidebar 系列）——2026-09-06 整树对齐上游完成
- [ ] CI 参考项按需采纳
