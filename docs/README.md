# 文档索引（docs/）

> 新成员从 [DEVELOPMENT.md](DEVELOPMENT.md) 开始；发布与热更新操作看 [RELEASE.md](RELEASE.md) 与 [HOT-UPDATE.md](HOT-UPDATE.md)。
> 注：`handovers/` 内的历史文档写作时的路径以当时仓库布局为准（例如 `docs/HANDOVER-*.md` 现已归档至 `docs/handovers/`），不作回改。

## 当前有效文档（动手前必读）

| 文档 | 内容 |
| --- | --- |
| [DEVELOPMENT.md](DEVELOPMENT.md) | 开发指南：三层架构与模块纪律、目录布局、环境准备、构建/测试/冒烟命令、数据目录、桥接契约、排障清单 |
| [RELEASE.md](RELEASE.md) | 发布指南：正式发布（tag → release-tauri → release.json 手动回写）与热更新发布（打包/围栏/原子提交）全流程 |
| [HOT-UPDATE.md](HOT-UPDATE.md) | 组件级热更新系统：组件矩阵、状态机、安全模型、FF1–FF6 适应度函数、运维速查 |
| [hot-update-design-addendum-2026-09-05.md](hot-update-design-addendum-2026-09-05.md) | 热更新 grill 决议与「设计 vs 代码事实」偏差修正（实施基线） |
| [P5-regression-matrix.md](P5-regression-matrix.md) | P5 回归矩阵 |
| [feature-pack-spec.md](feature-pack-spec.md) | feature-pack 打包规格（schemas/feature-pack-pack.json 为其 schema） |
| [vnext-plugin-isolation-architecture.md](vnext-plugin-isolation-architecture.md) | 插件隔离（vnext）架构综述 |

## 架构决策记录（ADR）

| ADR | 主题 |
| --- | --- |
| [adr/0001-logger-library.md](adr/0001-logger-library.md) | 日志库选型 |
| [adr/0002-shell-boundary-and-layering.md](adr/0002-shell-boundary-and-layering.md) | 壳层三层边界（L1 Rust / L2 sidecar / L3 dsh 内核）——全仓分层纪律的根 |
| [adr/0003-plugin-isolation-architecture.md](adr/0003-plugin-isolation-architecture.md) | 插件隔离架构 |

## 历史归档（handovers/，按时间序）

接续开发时值得浏览；其中的「待办/必读」以最新一篇为准，路径按当时布局书写。

- [HANDOVER.md](handovers/HANDOVER.md) — 总交接索引
- [HANDOVER-TS-MIGRATION.md](handovers/HANDOVER-TS-MIGRATION.md) — JS→TS 迁移战略
- [HANDOVER-2026-08-23.md](handovers/HANDOVER-2026-08-23.md) → [R5](handovers/HANDOVER-2026-08-23-R5.md) → [R6](handovers/HANDOVER-2026-08-23-R6.md) → [R7](handovers/HANDOVER-2026-08-23-R7.md)
- [HANDOVER-2026-08-24-R8.md](handovers/HANDOVER-2026-08-24-R8.md) → [R9](handovers/HANDOVER-2026-08-24-R9.md) → [R10](handovers/HANDOVER-2026-08-24-R10.md) → [R11](handovers/HANDOVER-2026-08-24-R11.md)
- [HANDOVER-2026-08-26-R13.md](handovers/HANDOVER-2026-08-26-R13.md)

## 质量报告归档

- [code-review-2026-08-28.md](code-review-2026-08-28.md) — 全仓代码评审（S/M/C 分级 bug 清单，修复见 git log V1.2/V1.3 两轮）
- [bug-report-2026-09-05.md](bug-report-2026-09-05.md) — 2026-09-05 bug 批量报告
- [macos-smoke-report.md](macos-smoke-report.md) — macOS 冒烟报告

## 设计过程材料（superpowers/）

- `specs/` — 专项设计稿（如 macos-desktop-support-design）
- `plans/` — 实施计划（如 macos-desktop-support）

## 资源

- `screenshot-preview.jpg` — README 界面预览；`qq-group-qrcode.jpg` / `wechat-group-qrcode.jpg` — 社区群二维码
- `schemas/feature-pack-pack.json` — feature-pack JSON Schema
