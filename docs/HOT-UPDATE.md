# 组件级热更新系统（HOT-UPDATE.md）

> 用户手册级综述。设计全文与决策记录见：`2026-08-23 热更新系统设计（主设计，已接受）` 与 [docs/hot-update-design-addendum-2026-09-05.md](hot-update-design-addendum-2026-09-05.md)（grill 决议 + 代码事实修正，**实施以 addendum 为准**）。发布操作见 [docs/RELEASE.md](RELEASE.md)。

## 1. 是什么

不重装、不下载整包即可更新四类组件，并与现有「整包自更新 + guard 快照 + 四目录备份」机制共存：

| 组件 | 允许前缀 | 禁止 | 宿主 | 重启级别 |
| --- | --- | --- | --- | --- |
| `sidecar` | `sidecar/` | bridge.js（编译进 exe） | git（≤5MB） | sidecar-restart |
| `resources` | `dsh-desktop/` | package.json、package-lock.json、.npmrc、vendor/**、node_modules/**、native/**、assets/plugins/**、assets/skins/** | git（≤5MB） | sidecar-restart |
| `content` | `dsh-desktop/assets/plugins/`、`assets/skins/` | 越出插件/皮肤树 | Release 资产 | sidecar-restart |
| `shell` | 恰好一个 `dsh-eac-shell.exe` | 其他一切 | Release 资产 | app-restart（detached 交换） |

任何包禁绝对路径 / `..` / 反斜杠路径 / 符号链接（zip-slip 防护）。发布端（`updates/generate.mjs`）与客户端（`lib/hot-update/fence.ts` staging 复查）双重校验。

## 2. 客户端运行时

- **引擎**：`dsh-desktop/lib/hot-update/`（L2，无 Tauri/Electron import），由 `sidecar/server.ts` 装配 `createHotUpdate(ctx)`；状态机目录 `<userData>/hotupdate/`（Rust 经 `DSH_USER_DATA` 注入，与熔断标记同根）。
- **调度**：启动后 90s 首检 + 独立 6h 周期（与正式更新 12h 解耦）。清单源：raw.githubusercontent → gh.geekertao.top 代理 → Gitee raw；冒烟可用 `DSH_HOTUPDATE_MANIFEST_URL` 覆盖。
- **同意语义**：自动检查只广播 `hotupdate.available`（**不动安装树**）；托盘菜单「检查热更新」（`check-hotupdate`）视为用户同意，直接走完整状态机。
- **状态机**（每次转移先落盘 `state.json` 再行动）：

```
IDLE → RESOLVED → DOWNLOADED → STAGED → SNAPSHOTTED → APPLYING → APPLIED
     → RESTART →（重启后 boot.start 成功=验证通过）→ 提交（IDLE，备份保留 14 天）
失败 → 回滚快照 → blockedSeqs 记录该 seq → IDLE
崩溃恢复：IDLE..SNAPSHOTTED 丢弃现场；APPLYING/APPLIED 从快照恢复；
         RESTART 等待本轮 boot 验证（onBootSuccess 提交 / onBootFailure 计数）
```

- **双层校验**：包级 sha256（清单声明）+ 逐文件 sha256（包内 hu-manifest 声明），任一不匹配即中止且保留现版本。
- **重启实现**：
  - `sidecar-restart`：sidecar 交换文件后有界退出（先关停 dsh web），Rust 收到 `shell.restart-sidecar` 通知 → 等退出（30s 超时强杀）→ 重生新进程读新代码 → 重发 boot.start。
  - `app-restart`（shell）：detached CMD 脚本（等 exe 解锁 → 备份 `.hu-bak` → 覆盖 → 重启 → 自删），壳经 `shell.quit-for-update` 退出。

## 3. 安全模型

| 层 | 措施 |
| --- | --- |
| 传输 | 全程 HTTPS；代理（gh.geekertao.top）只改前缀，完整性靠 sha256 强校验 |
| 完整性 | 包级 + 文件级双层 sha256 |
| 路径 | 组件白名单围栏 + zip-slip 防护，发布端/客户端双校验 |
| 真实性 | v1 信任根 = GitHub push 权限；清单 `signature` 字段已预留（v1.1 起 ed25519） |
| 版本围栏 | `appVersionRange` + `blockedSeqs` 防跨版本误刷与死循环重试 |

## 4. 适应度函数（hotupdate-smoke.js 全自动化看护）

| # | 不变量 | 验证方式 |
| --- | --- | --- |
| FF1 | 篡改必中止 | 包级 / 文件级 sha256 各一例，现版本继续运行 |
| FF2 | 版本围栏 | `min=9.9.9` entry 永不进入 RESOLVED |
| FF3 | 任意时刻可恢复 | 子进程在 APPLYING（部分交换）/APPLIED/RESTART 三阶段 SIGKILL×3，安装树逐字节恢复（或 RESTART 交换内容保留并提交） |
| FF4 | 壳存活 | sidecar/resources 热更期间守望进程不退出、exe 未动 |
| FF5 | 基线协调 | 安装树 `hotupdate-baseline.json`（打包期由 stage-resources.mjs 写入，baselineSeq=构建时 latestSeq）> state.appliedSeq → 状态重置、staging/backups 清空 |
| FF6 | 熔断 | 连续 3 次验证失败 → 自动回滚 + blockedSeqs + 再重启；Rust 侧 boot-attempts 兜底 shell 启动循环 |

## 5. 运维速查

```bash
node scripts/smoke/hotupdate-smoke.js   # 引擎全链路冒烟
node updates/generate.mjs --hotupdate   # 扫描 packages/ 重新生成清单
node updates/generate.mjs --check       # 一致性/围栏/大小校验
```

| 症状 | 处置 |
| --- | --- |
| 热更后启动循环 | 熔断自动换回 `.hu-bak`；手动 = 删 exe 同级 `.hu-broken`、`.hu-bak` 改名回 exe |
| 想手动回滚最近热更 | 恢复中心 →「回滚最近热更新」（`rc.action: rollback-hot-update`） |
| 某个 seq 永不生效 | 已入 `blockedSeqs`（state.json），发更高 seq 的修正包 |
| 热更日志 | `<userData>/hotupdate/logs/hotupdate.log` |
