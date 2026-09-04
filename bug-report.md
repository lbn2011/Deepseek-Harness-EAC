# Deepseek-Harness-EAC 全项目 Bug 排查报告

- 文件编号: TCC-QE-BUG-20260829
- 版本: V1.3（V1.2 → 2026-09-05 第二轮批量修复 **57 条 ✅**，累计 **79 条已修复 ✅ / 1 条部分修复 🔶**；修复条目见各标题后缀与「修复汇总」；分叉关系：本地领先 123 / 落后上游 32，G=本地回归、H=未合并上游修复）

## 修复汇总（2026-09-05，第二轮，57 条）

✅ S 级（3）：D-001 进程锁 TOCTOU 竞态（wx 排他创建）、E-001 更新合并写流 error 监听过晚、D-006 预览服务无 Host 校验/任意路径读（Host 白名单 + isUnderFileRoots 围栏）。  
✅ M 级（13）：B-001 /died URL 编码、B-009 壳/sidecar files.open 契约错位、B-012 快照详情竞态、B-013 export-logs 跨平台、C-011 scoped 主包第二副本、C-014 更新日志流无 error 监听、D-004 removePlugin 缺 await、D-005 installPack 失败不回滚、D-007 更新防重入滞后置位、D-008 watchdog execSync 冻结事件循环、D-010 taskkill 无 POSIX 分支、E-002 SDK shell.exec 失败误判成功、G-102 客户端更新 installDir 错目录。  
✅ C 级（41）：A 区 14（boot/gui/rescue/shim/upgrade 探活超时与孤儿检查恒真、make-portable 参数与流式哈希、S4 卸载 MSYS 坑）、B 区 3（B-006 pending 泄漏、B-015 桥队列重放、B-021 encode_back 编码不全）、C 区 5（C-001 孤儿文件、C-002/C-004 原子写、C-007/C-009 res error 监听）、D 区 4（D-011 run-state 原子写、D-012 插件拷贝残留、D-013 [::1]、D-014 图片粘贴解码前不限长）、F 区 15（e2e 系临时目录/进程泄漏、demo-rescue 误杀真实实例、验证脚本死断言、测试死断言）。  

## 修复汇总（2026-08-30，第一轮，22 条）

✅ S 级（5）：B-010 手机桥静态 cookie 认证绕过、E-003 诊断打包回调 throw 崩主进程、F-011 快照 id 目录穿越、G-001 WebView2Loader.dll 不进安装包、H-002 凭据版式自愈缺失（移植上游最终形态）。  
✅ M 级（13）：B-002 sidecar 兜底 kill 死代码、B-004 overlay 选择器越界、B-008 IPC 冒号通道全失效（含会话 token 注入配套）、G-002 文件拖入保存失效、G-003 窗口状态单位混用、G-101 导出日志断点、G-103 通知开关状态双源、G-104 预览流错误未捕获、G-105 托盘菜单被焦点顶掉、G-106 /died 重建窗无桥注入、C-008 风险分级 fail-open、B-011 配对 TTL 边界失效。  
✅ C 级（4）：B-005 overlay 监听器泄漏、C-012 更新后版本号读旧值、C-013 settings.json 非原子写、G-004 window-state.json 非原子写。  
🔶 部分（1）：G-006（① init 脚本尾行已加 typeof 守卫；② additional_browser_args 待实机验证）。





验证（2026-09-05 第二轮）：tsc 全量类型检查+编译通过；16 个受影响测试文件全绿（server-lock 8、host-ctx 11、rescue-zip-command 3、watchdog-behavior 3、stable-port 9、logger-redact 60、diagnostics-zip 2、supervisor-phase1 6、balance-prices-core 8、builtin-collision 10、feature-pack 14、plugin-updater 26、preset-sync 13、shortcut-maintenance 12、snapshot-manager 7、sidecar-snapshot-rpc 4，共 191 通过 / 0 失败）；Rust 改动（B-001/B-006/B-009/B-021）因本机 VS BuildTools link.exe 损坏仅经 rustfmt + 读码核对，待工具链修复后补 cargo check。

验证（2026-08-30 第一轮）：tsc 全量类型检查+编译通过；sidecar stdio 冒烟实证 chrome:init / dsh:plugin-list / snapshot:overview 三通道返回真实数据（B-008 修复前一律 method not found）；cargo check（tauri-shell）与 cargo test（native/snapshot）见提交说明。

- 编制: 资深质量工程师 / 代码审计
- 日期: 2026-08-29
- 排查方式: 6 个并行审计代理逐文件审查，发现即实时写入片段文件，本报告为汇总合并版
- 排查范围: 根目录脚本、dsh-desktop 第一方源码(.ts 为准，同名 .js 为 tsc 编译产物)、tauri-shell(Rust + sidecar + 构建脚本)、scripts/test/native。已排除 node_modules / target / 编译产物
- 分级: S=严重(崩溃/数据损坏/安全)，M=一般(功能错误/边界失效)，C=建议(健壮性/可维护性)

## 统计总览

| 分区     | 范围                           | 条目数     | 确认     | 待复查    |
| ------ | ---------------------------- | ------- | ------ | ------ |
| A      | 根目录脚本 + tauri 构建脚本           | 21      | 14     | 7      |
| B      | tauri-shell Rust + sidecar   | 21      | 16     | 5      |
| C      | dsh-desktop 根级模块             | 14      | 10     | 4      |
| D      | dsh-desktop/lib 顶层           | 14      | 10     | 4      |
| E      | dsh-desktop/lib 子目录 + shared | 5       | 3      | 2      |
| F      | scripts / test / native      | 19      | 17     | 2      |
| G      | 上游对比回归(tauri-shell+lib 链路)   | 12      | 10     | 2      |
| H      | 未合并上游修复(落后 32 提交)            | 7       | 0      | 7      |
| **合计** |                              | **113** | **80** | **33** |

## S 级（严重）速览

| 编号        | 位置                                            | 问题                                                                        | 状态        |
| --------- | --------------------------------------------- | ------------------------------------------------------------------------- | --------- |
| BUG-B-010 | tauri-shell/sidecar/phone-bridge.ts:274       | `dsh_mobile=1` 静态 cookie，LAN 内任何人可绕过配对调用 session.prompt;disconnect 不失效    | ✅ 已修复     |
| BUG-D-001 | dsh-desktop/lib/server-lock.ts:36-59          | 锁文件 check-then-act 竞态：`writeFileSync` 无 `wx` 排他标志，两实例可并发写 DSH_HOME        | ✅ 已修复     |
| BUG-E-001 | dsh-desktop/lib/client-update/download.ts:269 | concatFiles 写流 error 监听挂接过晚，合并分片出错 → 未捕获异常打挂主进程且留截断文件                     | ✅ 已修复     |
| BUG-E-003 | dsh-desktop/lib/logger/diagnostics.ts:61      | `archive.on('error', e => { throw e })` 事件回调里 throw → 诊断打包出错即崩溃主进程        | ✅ 已修复     |
| BUG-F-011 | dsh-desktop/native/snapshot/store.rs:97       | snapshot_id 无校验拼路径，`../` 穿越可删除/读取存储目录外任意 .json                            | ✅ 已修复     |
| BUG-G-001 | tauri-shell/tauri.windows.conf.json（已删除）      | Windows 专属 conf 被删 → WebView2Loader.dll 不进安装包，安装版启动即 0xC0000135（A-017 坐实） | ✅ 已修复     |
| BUG-A-017 | （并入 BUG-G-001）                                | 原疑点已由 G-001 坐实：上游靠 tauri.windows.conf.json 兜底，本地把兜底删了                     | ✅ 已修复     |
| BUG-D-006 | dsh-desktop/lib/preview.ts:56                 | 预览服务无 Host 校验/token、任意绝对路径可读，DNS rebinding 泄密面                            | ✅ 已修复     |
| BUG-H-002 | 上游提交 25a8ccc+5d89422（未合并）                     | 凭据库反向迁移=升级后启动卡死元凶 / 写读不对称=启动必死；本地是否等效自愈待对照                                | ✅ 已修复（移植） |
|           |                                               |                                                                           |           |

## 系统性模式（建议批量修复）

1. **http.get timeout 语义误用**(A 区 5 处文件）：仅 socket 级超时，探活/轮询循环可卡死。
2. **进程断言恒真**(A 区 3 处）:DSH_HOME 经 env 传递却用 CommandLine 匹配做零孤儿检查。
3. **e2e 清理失效**(F 区 4 处）:`setTimeout` 清理 + 立即 `process.exit`，临时目录与子进程泄漏。
4. **非原子写配置/状态文件**(C/D 区多处）:settings.json、settings.yaml、run-state.json、profile package.json 直写，崩中途即损坏。
5. **错误监听缺失导致未捕获异常**(C/E 区多处）:http res 无 'error' 监听、WriteStream 无 'error' 监听、事件回调内 throw。
6. **测试假覆盖**(F 区）:`|| true` 死断言、条件断言、恒真三元表达式。

## 重点 M 级速览

- BUG-B-008: sidecar server.ts 从未注册 IPC surface，全部冒号通道(chrome:init、dsh:*、snapshot:*）静默失效
- BUG-B-002: main.rs:1983 `Arc::into_inner` 恒为 None,sidecar 兜底 kill 是死代码 → 孤儿进程
- BUG-C-008: rescue-agent.ts 非法 risk 默认归 'low'，风险分级 fail-open,AI 建议可被自动执行
- BUG-C-010/011: plugin-updater GitHub 源 URL 编码疑恒 404 + scoped 主包第二副本
- BUG-C-012/013: updater.ts require 缓存报旧版本 + settings.json 非原子写
- BUG-D-004/005: feature-pack 漏 await + installPack 失败不回滚留孤儿插件
- BUG-D-008: watchdog-boot 主进程 execSync 跑 PowerShell，事件循环冻结最长 12s
- BUG-F-012: native snapshot store.rs `&hash[..2]` 多字节 UTF-8 panic，跨 FFI abort

## 本轮（G/H 区）症状结论速览

- **托盘菜单打不开** → BUG-G-105：tray-icon 默认 `menu_on_left_click:true` 与左键 Click 处理器的 `set_focus()` 互搏，菜单被焦点抢夺瞬关；修复=`.menu_on_left_click(false)`（上游同缺陷，非回归）。
- **窗口菜单入口按钮消失** → BUG-G-106：/died 重建窗没挂 initialization_script，retry 成功导航 webUrl 后桥永失，玻璃栏/菜单按钮全灭且窗口无法拖动关闭（上游同缺，真实缺陷，一行修复）。
- **窗口有问题** → BUG-G-001（安装版 0xC0000135，S 级）、BUG-G-003（窗口状态恢复单位混用，高 DPI/多屏错位）、BUG-H-002（升级后启动卡死元凶未合并，待对照）。
- **菜单功能静默失效** → BUG-B-008（冒号通道未注册）+ BUG-G-101（导出日志第二断点）+ BUG-G-002（file-drop.save 被删）+ BUG-G-103（通知开关状态双源）。
- **同步策略警示**：本地领先 123 / 落后上游 32 且双向大改（手机桥、窗口策略、凭据库），上游 32 提交中含 2 个 S 级启动修复（H-002）与 1 个打包级修复集（5.3.1），建议优先安排一次选择性合并。

---

## 详细条目（按分区合并，与排查片段文件同步）

# A区:根目录脚本与tauri构建脚本 排查片段

### BUG-A-001（✅ 已修复 2026-09-05：boot-smoke 子进程 stdin 挂 error 监听 + exit fail-fast，干净 FAIL 收场）

- 文件: boot-smoke.js:41,54
- 问题: 向已退出的 sidecar 写 stdin 时触发 EPIPE，因 child.stdin 无 'error' 监听，产生 uncaughtException，冒烟脚本以崩溃栈而非干净 FAIL 信息收场
- 成因: spawn stdio 为 pipe，Node 在管道断裂写时会向流发 'error' 事件；两处 child.stdin.write（boot.start 发送、探活后的 shutdown）均未捕获，且 child 'exit' 只打印不 fail-fast，子进程早死后脚本既不退出也无防护地写管道
- 严重度: C
- 状态: 确认

### BUG-A-002（✅ 已修复 2026-09-05：boot-smoke 探活 req 挂 timeout 事件并 destroy，对端挂起不再干等 300s）

- 文件: boot-smoke.js:37
- 问题: http.get 设了 timeout:5000 但只监听 'error'；Node 的 timeout 选项仅是 socket.setTimeout，超时触发的是 request 'timeout' 事件且不会自动中止请求——若对端接受连接后挂起，探活回调永不触发，只能干等 300s 总超时
- 成因: Node http.request 的 timeout 不等于请求级超时，需监听 'timeout' 并 req.destroy()；'error' 仅覆盖连接失败场景
- 严重度: C
- 状态: 确认

### BUG-A-003（✅ 已修复 2026-09-05：「零孤儿进程」检查改为自跟踪 spawn 的 PID 树（Get-CimInstance 递归），删除恒空 CommandLine 匹配）

- 文件: gui-smoke.js:75
- 问题: "零孤儿进程"硬门槛形同虚设、恒真通过：PowerShell 用 CommandLine -match 'tmp-p2boot' 过滤 node.exe，但 DSH_HOME 是经 env 传入（第 87 行），tmp-p2boot 不出现在任何命令行参数里，过滤结果恒为空字符串
- 成因: 混淆了环境变量与命令行参数；sidecar/dsh web 的命令行只含 node + server 脚本路径（tauri-shell\sidecar...），不含 tmp-p2boot，应改为过滤 CIM ExecutablePath/CommandLine 中可匹配的标识或按 DSH_HOME 对应 PID 树校验
- 严重度: M
- 状态: 确认

### BUG-A-004（✅ 已修复 2026-09-05：gui-smoke httpGetJson 挂 timeout+destroy，Promise 必 settle）

- 文件: gui-smoke.js:17-21
- 问题: httpGetJson 同 BUG-A-002：timeout:4000 只设置 socket 超时且未监听 'timeout'/'abort'；CDP 端点若 accept 后不响应，Promise 永不 settle，waitForTarget 的 while 循环被 await 卡死，180s 上限失效
- 成因: 与 BUG-A-002 相同的 Node http timeout 语义误用；重试循环的错误边界依赖 Promise 能拒绝，挂起场景下连重试都不会发生
- 严重度: C
- 状态: 确认

### BUG-A-005（✅ 已修复 2026-09-05：「桥注入就绪」轮询结果真实带出断言，替换恒真 true）

- 文件: rescue-smoke.js:125-130
- 问题: 「桥注入就绪」检查恒真：while 循环轮询 60s 等 window.dshDesktop.\_call，但循环自然耗尽后不置任何标志，第 130 行 check('桥注入就绪', true) 无条件报通过——桥未注入时该断言照样 PASS，且后续 waitAlive 会因 call 全失败而误报"服务不存活"
- 成因: 循环结果变量 ok 未被带出使用，break 后没有把"是否等到"记录下来，属明显的断言遗漏
- 严重度: M
- 状态: 确认

### BUG-A-006（✅ 已修复 2026-09-05：孤儿清理改为对自 spawn 根 PID taskkill /T /F，替换恒空命令行匹配）

- 文件: rescue-smoke.js:189
- 问题: finally 阶段清理孤儿进程用 CommandLine -match 'rescue-home' 过滤 node.exe，与 BUG-A-003 同根因：DSH_HOME 走 env 不进命令行，匹配恒为空，清理逻辑恒为空转，崩溃路径下 node 孤儿进程残留
- 成因: 同 BUG-A-003，环境变量与命令行参数混淆
- 严重度: C
- 状态: 确认

### BUG-A-007

- 文件: ui-verify-smoke.js:87,127,149,162,179
- 问题: 断言硬编码 CSS-module 哈希类名（.wSkVaW_root/.pXSMma_root/.uV2eYG_card/\_7KE1Ra_root/\_root_15u5s 等）与脆弱结构选择器 div:nth-child(2)；前端任何重编译导致哈希变化即全链路 FAIL，且报错信息不指向真实回归
- 成因: 选择器取的是构建产物哈希而非语义属性（data-testid 等）；若仓库锁定特定前端构建产物则属可接受权衡
- 严重度: M
- 状态: 待复查（需确认前端产物是否随仓库锁定）

### BUG-A-008（✅ 已修复 2026-09-05：ps() 失败返回 null，断言 null 即 FAIL 报「进程查询失败」，消除 Number('')===0 假阳性）

- 文件: upgrade-test-441.js:84
- 问题: 「旧/新进程无残留运行冲突」检查存在假阳性：ps() 在 PowerShell 整体失败时 catch 返回 e.stdout（通常为 ''），而 Number('') === 0 恰好等于期望值——进程查询工具链坏掉时该断言照样 PASS
- 成因: ps() 吞掉所有执行错误并返回空串，调用方未区分"查询成功返回 0"与"查询失败返回空"；Number('') 为 0 的 JS 特性放大了该缺陷
- 严重度: C
- 状态: 确认

### BUG-A-009（✅ 已修复 2026-09-05：同 A-008：ps() null 分流消除假阳性）

- 文件: upgrade-test-510.js:82
- 问题: 与 BUG-A-008 完全同型：ps() 失败返回 '' 时 Number('') === 0，「无进程残留」断言假阳性
- 成因: 同一 ps()/check 模式复制；此外 ps() 本身静默吞错（catch 返回 stdout）是所有 registry/进程断言的系统性弱点
- 严重度: C
- 状态: 确认

### BUG-A-010（✅ 已修复 2026-09-05：listOrphans 改 PID 树跟踪；CDP_PORT 9334→9336 消除与 ui-verify-smoke 的端口冲突）

- 文件: verify-shim-fix.cjs:72-80,14
- 问题: 两处：① listOrphans 与 BUG-A-003 同根因（CommandLine -match 'tmp-p2boot'，DSH_HOME 走 env 不进命令行），「零孤儿进程」恒真通过；② CDP_PORT=9334 与 ui-verify-smoke.js:16 完全相同，两者若在同一 CI 流水线并行/紧邻执行会因 WebView2 调试端口冲突相互踩塌
- 成因: ① 环境变量与命令行混淆的复制粘贴；② 端口硬编码且跨脚本未做分配协调（gui-smoke=9333、ui-verify=9334、rescue=9335、shim 又是 9334）
- 严重度: M
- 状态: 确认（端口冲突项以 CI 并行为前提，序号①无条件成立）

### BUG-A-011

- 文件: tauri-shell/stage-resources.mjs:367-376
- 问题: 定位 WebView2Loader.dll 时 readdirSync 返回顺序未排序（仅对 bucket 目录做了 sort().reverse()，webview2-com-sys-* 版本子目录未排序），存在多个 webview2-com-sys 版本时取到哪个版本取决于文件系统枚举顺序，非确定性
- 成因: 内层 for (const dir of subdirs) 命中即返回，未按版本号排序取最新；多数场景 ABI 兼容故风险有限，但属非确定性装配
- 严重度: C
- 状态: 待复查（loader ABI 历史稳定，实际影响低）

### BUG-A-012

- 文件: tauri-shell/stage-resources.mjs:328-332
- 问题: vendored 回填只检查源文件存在性，不检查目标包是否仍在 staged 生产 node_modules 中；若 @deepseek-ai/dsh-tool-bash 哪天移出生产依赖或被裁剪（linux 分支的 prune 可能先删目录），cpSync 因目标父目录缺失抛 ENOENT，打包直接中断且报错与真实原因脱节
- 成因: 目标路径未做 existsSync 守护；linux 分支 pruneLinuxPayloads/pruneMuslPackages 在该回填之前执行，目录结构可能已被改变
- 严重度: C
- 状态: 待复查（当前依赖树中该包确在生产依赖内则不会触发）

### BUG-A-013

- 文件: tauri-shell/stage-platform-prune.mjs:41
- 问题: darwin 裁剪硬编码只保留 darwin-arm64 prebuilds；若 macOS 构建目标为 x86_64 或 universal（tauri.macos.conf.json 若配 universal-apple-darwin），darwin-x64 的 .node 预编译产物已被删，且 isMachO 只认 64 位 thin 魔数（FAT/universal 二进制会被误删，注释亦承认）
- 成因: 裁剪规则与 mac 构建 target 未联动（target 参数只有平台没有 arch）；universal 场景下 node-pty 等原生模块将缺失或回退到 build/Release 兜底
- 严重度: M
- 状态: 待复查（取决于 tauri.macos.conf.json 的 target 配置）

### BUG-A-014（✅ 已修复 2026-09-05：make-portable --out 缺参入口校验，打印用法 exit(2)）

- 文件: tauri-shell/make-portable.mjs:26
- 问题: --out 缺参数时 process.argv[outArg+1] 为 undefined，path.resolve(undefined) 抛 TypeError，报错信息无指引
- 成因: 命令行参数解析未校验取值存在性（边界条件）
- 严重度: C
- 状态: 确认

### BUG-A-015（✅ 已修复 2026-09-05：SHA256 改 createReadStream 流式哈希，500MB 产物不再全量读入内存）

- 文件: tauri-shell/make-portable.mjs:74-76
- 问题: 计算 SHA256 用 readFileSync 一次性把约 500MB 的 zip 全量读入内存再 hash.update；大产物下内存峰值翻倍，低内存 CI runner 上有 OOM 风险
- 成因: 未使用流式哈希（fs.createReadStream + pipeline）
- 严重度: C
- 状态: 确认

### BUG-A-016

- 文件: tauri-shell/audit-linux-bundle.mjs:58
- 问题: 审计要求 Linux 运行时位于 dsh-desktop/vendor/node/node，但 stage-resources.mjs:274-278 的注释与 chmod 操作都指向 vendor/node/bin/node（官方 tarball 布局）——两处对同一产物的路径约定不一致，必有一方失效：要么审计对合法 bundle 恒报 "required Linux payload is missing"，要么实际包布局与 chmod 目标不符
- 成因: 硬编码路径在装配脚本与审计脚本间漂移，无共享常量
- 严重度: M
- 状态: 待复查（需对照 fetch-node 生成的真实 vendor/node 布局确认哪边写错）

### BUG-A-017

- 文件: tauri-shell/tauri.conf.json:23-26 对照 stage-resources.mjs:381-384
- 问题: stage-resources.mjs 把 WebView2Loader.dll 装配到 staged-resources/ 根目录并强调"必须与壳 exe 同级，否则启动即 0xC0000135"，但 tauri.conf.json 的 resources 映射只收 staged-resources/sidecar/ 与 staged-resources/dsh-desktop/ 两个子目录——staged 根下的 WebView2Loader.dll 不在映射内，疑似不会进入安装包，装配脚本的努力被配置静默丢弃
- 成因: 资源映射表与装配脚本的产物落点未对齐（装配落在 staged 根，映射只收两个子目录）
- 严重度: S
- 状态: 待复查（若 tauri-bundler 对 NSIS 自动附带 WebView2Loader.dll 则实际无害，需确认 bundler 行为）

### BUG-A-018（✅ 已修复 2026-09-05：S4 卸载与 S1 同构走 PowerShell Start-Process -Wait，规避 MSYS 参数转换坑）

- 文件: tauri-shell/scripts/windows-smoke.sh:73
- 问题: S4 卸载直接 `"$UNINSTALL" /S` 从 Git Bash 调起——而本脚本 20-22 行注释明确指出 MSYS 参数转换会改写 /S 导致安装器进不了静默模式、无头会话挂起，S1 因此改用 PowerShell Start-Process；S4 却裸用同一危险写法，卸载器收到的参数可能被转成 "S:" 之类而打开 GUI，CI 无头会话挂起（|| true 只兜退出码，兜不住挂起）
- 成因: 同一脚本内对同一已知坑采用了不一致的防护（安装走 Start-Process，卸载裸调）
- 严重度: M
- 状态: 确认

### BUG-A-019

- 文件: tauri-shell/scripts/windows-smoke.sh:31,71 及 linux-smoke.sh:21,35,56,57
- 问题: set -o pipefail 下大量使用 `VAR=$(find ... | head -1)`：find 扫描大目录（如整个 $LOCALAPPDATA）时 head 先退出，find 再写即收 SIGPIPE（141），pipefail 使命令替换整体失败、set -e 直接静默终止脚本。作者已在 40-41 行注释里正确处理了 dpkg|grep -q 的同类 SIGPIPE 坑，却漏掉了 find|head 这些同型点
- 成因: SIGPIPE×pipefail×set -e 三件套对 find|head 同样成立；仅当匹配结果唯一、find 不再写输出时才侥幸安全（多个 dsh-eac-shell.exe 残留即触发）
- 严重度: C
- 状态: 待复查（触发依赖目录树内多匹配，属竞态型边界）

### BUG-A-020（✅ 已修复 2026-09-05：sidecar-boot-probe 三件套：stdin error 监听、http timeout+destroy、exit fail-fast）

- 文件: tauri-shell/scripts/sidecar-boot-probe.js:60,72,45
- 问题: 与 BUG-A-001/002 同型三处：child.stdin 无 error 监听（sidecar 早死后写 boot.start/shutdown → EPIPE 崩溃）；http.get timeout:10000 只监听 'error' 不监听 'timeout'，对端挂起则等到总超时才失败；child 'exit' 只打印不 fail-fast
- 成因: 同一探活骨架复制自 boot-smoke.js，缺陷一并复制
- 严重度: C
- 状态: 确认

### BUG-A-021（✅ 已修复 2026-09-05：rescue-smoke/ui-verify-smoke/verify-shim 三处 httpGetJson 统一补 timeout+destroy）

- 文件: rescue-smoke.js:20-24 / ui-verify-smoke.js:22-26 / verify-shim-fix.cjs:18-22
- 问题: 三处 httpGetJson 复刻同一缺陷：timeout 选项仅 socket 级、未监听 'timeout'，CDP 端点 accept 后不响应时 Promise 永不 settle，pageTarget/waitForMainPage/waitForTarget 轮询循环被 await 卡死，外层超时预算失效
- 成因: 与 BUG-A-002 同根因，helper 复制传播
- 严重度: C
- 状态: 确认

---

# B区:tauri-shell Rust 与 sidecar 排查片段

### BUG-B-001（✅ 已修复 2026-09-05：/died 三条 URL 构造路径统一 percent_encode（含 server-died 的 code/log），并新增配对 percent_decode 闭环）

- 文件: tauri-shell/src/main.rs:1779
- 问题: boot.start 失败时构造 /died 页 URL,log 参数仅替换引号与换行,未做 URL 编码;错误消息含 `&`/`?`/`#` 等字符时会截断或破坏查询串,Url::parse 可能失败导致 /died 页不显示,用户无任何诊断入口。sidecar-spawn 失败路径(main.rs:1811)同样未编码。
- 成因: 与 boot.server-died 路径(main.rs:1565)的编码处理不一致,该处仅 `replace('"',"'").replace('\n'," ")`,遗漏 & ? # % 等保留字符。
- 严重度: M
- 状态: 确认

### BUG-B-002（✅ 已修复 2026-08-30：ExitRequested 改为 take() 移出共享槽位，Arc::into_inner 兜底 kill 复活）

- 文件: tauri-shell/src/main.rs:1983
- 问题: ExitRequested 优雅退出时,`Arc::into_inner(sc)` 永远返回 None —— `sc` 是从 `st.sidecar.lock().await.clone()` 克隆出来的,而 BRIDGE 全局的 `Option<Arc<Sidecar>>` 里仍持有同一份 Arc,强计数 ≥2,`owned.kill()` 兜底逻辑是死代码,sidecar 进程在 shutdown RPC 失败/超时后不会被 kill,残留孤儿 node 进程。
- 成因: 误用 Arc::into_inner 的语义(要求唯一所有权),未先把 BRIDGE 中的 Arc 置 None(take)再 into_inner。
- 严重度: M
- 状态: 确认

### BUG-B-003

- 文件: tauri-shell/src/main.rs:56
- 问题: `main_initialization_script` 与 http_serve 的 /inject/snapshot-ui.js(main.rs:1387)只读 `resource_root()/sidecar/snapshot-ui.js`,不像 `sidecar_script()`(main.rs:118)有 `tauri-shell/sidecar/` 的开发态回退;开发布局下读到空串,init 脚本尾行 `window.__dshOpenSnapshotPanel=openSnapshotPanel;` 抛 ReferenceError,快照面板在 dev 态失效且污染每次页面注入。
- 成因: 资源定位逻辑两处不一致,未抽出共用 helper。
- 严重度: M
- 状态: 确认

### BUG-B-004（✅ 已修复 2026-08-30：选择器限定 #dsh-exit-overlay [data-v]）

- 文件: tauri-shell/src/exit-overlay.js:45
- 问题: `document.querySelectorAll('[data-v]')` 未限定在 overlay 子树内,会把宿主页面(dsh web)里所有带 data-v 属性的元素也绑定 overlay 的 click 处理器——点击这些页面元素会误触发 dismiss 并向壳层发 win.close-* RPC。
- 成因: 选择器应为 `document.querySelectorAll('#dsh-exit-overlay [data-v]')`;每次 show 重复绑定也未做去重。
- 严重度: M
- 状态: 确认

### BUG-B-005（✅ 已修复 2026-08-30：style 节点与 keydown 监听纳入 dismiss 生命周期统一移除）

- 文件: tauri-shell/src/exit-overlay.js:58
- 问题: Escape/Cmd+W 的 keydown 监听只在按 Escape 时移除;通过按钮 dismiss 后监听器残留,之后每次按 Escape 都会重复执行 dismiss+`win.close-dialog` RPC,且每次 show 再叠加一个监听器(注入的 <style> 同样累积)。
- 成因: dismiss 路径未移除 keydown 监听与 style 节点,生命周期未与 overlay DOM 绑定。
- 严重度: C
- 状态: 确认

### BUG-B-006（✅ 已修复 2026-09-05：Sidecar::call 写失败路径回滚 pending 表，oneshot 不再泄漏）

- 文件: tauri-shell/src/main.rs:461-466
- 问题: `Sidecar::call` 先向 pending 表插入 id,随后 write_all/flush 失败直接 return Err,pending 中残留该 id 的 oneshot::Sender,永不清理(id 也永久消耗);长期运行写入失败多次会造成哈希表膨胀。
- 成因: 写失败路径未回滚 pending.insert;应在写失败后 `pending.lock().await.remove(&id)`。
- 严重度: C
- 状态: 确认

### BUG-B-007

- 文件: tauri-shell/src/main.rs:1088
- 问题: `stream.peek(&mut buf)` 用于协议探测(HTTP vs WS),peek 在「有任意字节可读」时即返回,不保证 2048 字节读满;客户端分片发送握手时,首个 peek 可能只含请求行而不含 `Upgrade: websocket` 头,WS 握手被误判为 HTTP 并回 200 HTML,握手失败。
- 成因: 用单次 peek 做需要完整头部的分流决策;应循环 peek 至出现 \r\n\r\n 或先读首行后再 peek 头部。
- 严重度: C
- 状态: 待复查(浏览器/WebView2 通常单段发送,实际触发概率低)

### BUG-B-008（✅ 已修复 2026-08-30：server.ts 尾部补 registerIpc(createSidecarIpcSurface(methods))；配套主窗注入 **DSH_BRIDGE_SESSION** 会话 token 使 sender 校验可绑定；冒烟实证 chrome:init/dsh:plugin-list/snapshot:overview 全通）

- 文件: tauri-shell/sidecar/server.ts:17,62-63
- 问题: server.ts import 了 `createSidecarIpcSurface` 并 load 了 `registerIpc`/`setDefaultIpcSurface`,但全文件从未调用任何一个 —— 冒号风格通道(chrome:init、dsh:balance-refresh、dsh:file-open、dsh:copy-text、dsh:open-external、dsh:plugin-*、guard:action、onboard:*、snapshot:*、chrome:recovery-* 等,由 dsh-desktop/lib/ipc/index.ts 的 registerIpc 注册)全部未注册。bridge.ts 页面侧恰好全部用冒号通道发 RPC,handleLine 一律回 "method not found",getInfo/菜单切换/快照/文件打开/复制/向导等页面功能静默失效(桥 .catch 吞掉,无可见报错)。
- 成因: 装配漏接一行,如 `const surface = createSidecarIpcSurface(methods); registerIpc(surface);`(或 setDefaultIpcSurface + registerIpc())。编译产物 server.js 同样缺失。
- 严重度: M
- 状态: 确认

### BUG-B-009（✅ 已修复 2026-09-05：壳层 files.open 拦截器改调 sidecar 的 files.open（自带授权+打开），删除对不存在的 files.authorize-open 的调用）

- 文件: tauri-shell/src/main.rs:733
- 问题: 壳层 files.open 拦截器调用 sidecar 方法 `files.authorize-open`,但 sidecar(及 dsh-desktop/lib)不存在该方法(全仓库 .ts 无匹配);sidecar 实现的是 `files.open`(server.ts:796,自带授权+打开)。调用方收到 method-not-found 错误,壳层文件打开链路必然失败。
- 成因: 壳/sidecar 方法契约不一致;且 bridge.ts 发的是 `dsh:file-open`(冒号),也不匹配壳层拦截的 `files.open`(点号)与 sidecar 的 `files.open`,三处契约互相错位。
- 严重度: M
- 状态: 确认

### BUG-B-010（✅ 已修复 2026-08-30：cookie 改为配对签发的随机 32 字节会话串，timingSafeEqual 校验，disconnect/重新配对即 null 失效）

- 文件: tauri-shell/sidecar/phone-bridge.ts:274
- 问题: 配对成功后签发的 `dsh_mobile` cookie 是静态常量 `dsh_mobile=1`,/api/rpc 校验(line 284)也只比对这一字面值,不与配对 token/会话绑定。后果:(1) 任何 LAN 设备构造 `Cookie: dsh_mobile=1` 即可绕过配对直接调用 RPC 白名单(含 session.prompt/session.create 等写动作),配对机制形同虚设;(2) `disconnect()` 注释声称"轮换 token,手机端既有 cookie 立即失效",实际 cookie 校验与 token 无关,断开后旧 cookie 一年内仍然有效。
- 成因: cookie 值应为配对时签发的随机会话串并随 disconnect 失效;当前实现把「配对口令」与「会话凭证」都退化成了常量。
- 严重度: S
- 状态: 确认

### BUG-B-011（✅ 已修复 2026-08-30：/desktop/decide 与 RPC decide 双路径加 expiresAt TTL 闸门）

- 文件: tauri-shell/sidecar/phone-bridge.ts:166-171
- 问题: `currentPairingState` 先判 `decided === true` 返回 approved、再判 TTL;token 已过期后才收到桌面批准(/desktop/decide 无 TTL 检查)时,过期的 pairing 仍会在下一次 pair-state 轮询里返回 approved 并签发 cookie,5 分钟 TTL 边界失效。
- 成因: 状态判定顺序错误且 decide 路径不校验 expiresAt;应先判过期再判 decided。
- 严重度: C
- 状态: 确认

### BUG-B-012（✅ 已修复 2026-09-05：详情展开改 await refresh() 重渲染后再 loadFiles 串行，消除旧 DOM 写入竞态）

- 文件: tauri-shell/sidecar/snapshot-ui.ts:603-605
- 问题: 「详情」展开文件清单存在竞态:`void refresh()` 与 `void loadFiles(id)` 并发,refresh 拉完 overview 后重渲染整棵树(新建 "加载中…" 占位盒),若 loadFiles 的 detail 应答先返回,内容写进的是已被替换掉的旧 DOM(`box.isConnected` 检查使其静默 no-op),新占位盒永远停在「加载中…」。
- 成因: 两个异步操作未编排顺序;应先 await refresh() 再 loadFiles,或 loadFiles 改为在渲染完成后按 id 重新查盒。
- 严重度: M
- 状态: 确认

### BUG-B-013（✅ 已修复 2026-09-05：export-logs 平台分支补全：桌面目录 os.homedir 解析，darwin/linux zip 后端 zip -qr，win32 维持 PowerShell）

- 文件: tauri-shell/sidecar/rescue-integration.ts:290-293
- 问题: `os_home_desktop` 只认 `USERPROFILE`,否则回退 `C:\Users\Public`;Linux/macOS 上该变量不存在,export-logs 的 zip 落盘路径非法必然失败。且 `buildZipCommand`(line 254)对非 darwin 一律用 `powershell`,Linux 无此命令 → spawn error → zip 不存在 → 报错「打包失败」。即 export-logs 在非 Windows 平台整体不可用。
- 成因: 平台分支不完整(缺 os.homedir()/Desktop 解析与 Linux zip 后端);与 server.ts 宣称的跨平台宿主语义不符。
- 严重度: M
- 状态: 确认

### BUG-B-014

- 文件: tauri-shell/sidecar/server.ts:151,190
- 问题: `psLnkRead`/`psLnkWrite` 用 `execFileSync`/`spawnSync`(timeout 8s/10s)执行 PowerShell,同步阻塞 sidecar 事件循环 —— 期间所有 stdio RPC(boot.*/快照/救援等)全部停摆,Rust 侧只看到 180s 超时窗口被消耗。
- 成因: 在单线程 JSON-RPC 服务里用同步子进程 API;应改异步 cp.execFile/spawn。
- 严重度: C
- 状态: 确认

### BUG-B-015（✅ 已修复 2026-09-05：桥 call() 超时作废 pending 时同步按帧 id 移除 queue 排队帧，重连不再重放已放弃的副作用调用）

- 文件: tauri-shell/sidecar/bridge.ts:56-68
- 问题: `call()` 在 WS 未就绪时把帧推入 queue,30s 超时仅删 pending 不删 queue 项;重连后 onopen 把 queue 全部 flush,这些「调用方早已放弃」的帧仍会被 sidecar 执行 —— 对有副作用的方法(boot.restart/snapshot.delete 等)意味着用户取消的操作被延迟重放。
- 成因: queue 帧与 pending 生命周期未绑定;超时/重连时应连同 queue 项一起作废(或给帧打上 pending 存活标记)。
- 严重度: C
- 状态: 确认

### BUG-B-016

- 文件: tauri-shell/sidecar/server.ts:1215-1224
- 问题: shutdown 处理先 `respond({bye:true})` 再 `rl.close()` → `gracefulExit()` 里 `process.exit(0)`;process.stdout 写管道是异步的,进程退出不保证应答帧已冲刷 —— 与 server.ts:285 自己对 exitProcess 的注释(「通知帧可能未冲刷即截断」)相矛盾。Rust 壳 ExitRequested 等不到 bye 时会空等 10s 超时。
- 成因: exit 前未等 stdout drain(应为 process.stdout.write 回调或 process.exitCode + 自然退出)。
- 严重度: C
- 状态: 待复查(管道缓冲小帧通常能落盘,Windows 上偶发)

### BUG-B-017

- 文件: tauri-shell/src/main.rs:1020-1029
- 问题: 浮窗(open_float_window)未挂 `.on_navigation(is_allowed_main_navigation)` 围栏,主窗有导航白名单而浮窗没有 —— 浮窗内页面/重定向可把该窗口导航到任意外站,导航围栏安全边界存在缺口(recovery-center 窗口同样未挂)。
- 成因: 围栏只在主窗 builder 上配置,新建窗口未复用同一策略。
- 严重度: M
- 状态: 待复查(浮窗加载同 webUrl,若为刻意放行则需注释说明)

### BUG-B-018

- 文件: tauri-shell/sidecar/bridge.ts:56-67
- 问题: `_call` 默认超时 30s,而 /died 页「重新启动」走的 `boot.start`(含市场队列/插件同步/服务拉起)在 Rust 侧按 180s 设计;慢机/冷启动超 30s 时页面显示「重启失败,请重试」,实际 boot 仍在后台推进,用户重复点击会并发触发多次 boot.start。
- 成因: 桥默认超时与长事务方法不匹配;/died 页应给 boot.start 显式传更大 timeoutMs。
- 严重度: M
- 状态: 待复查(取决于 boot.start 实际耗时分布)

### BUG-B-019（⏸ 暂缓 2026-09-05：已核实 src 内确无 http:: 使用；因本机 cargo 不可用无法同步 Cargo.lock，删除会使 CI --locked 失败，待工具链修复后随 cargo 一起清理）

- 文件: tauri-shell/Cargo.toml:18
- 问题: 声明了 `http = "1"` 依赖,但 src 内无任何 `http::`/`use http` 使用 —— 未使用依赖,与代码不匹配(CI 若开 unused-crate-dependencies lint 会报)。
- 成因: 早期 HTTP 服务实现的遗留依赖,后改为手写 TCP 应答后未清理。
- 严重度: C
- 状态: 确认

### BUG-B-020

- 文件: tauri-shell/src/main.rs:1537-1577
- 问题: `handle_sidecar_notify` 的 `boot.server-died` 分支是全仓库唯一的消费者 —— sidecar/dsh-desktop 中没有任何代码发射该方法(grep 零匹配),分支为死代码;且该分支 `code` 用 `c.to_string()` 取值,若 sidecar 发的是 JSON 字符串,会得到带引号的 `"1"` 原样拼进 URL。
- 成因: 通知契约一侧缺失(发射方未实现);取值应按 as_str/as_i64 分类型。
- 严重度: C
- 状态: 待复查(发射方可能在未纳入审查的 dsh-desktop lib 运行路径)

### BUG-B-021（✅ 已修复 2026-09-05：encode_back 改用 percent_encode 完整编码，消费侧 URLSearchParams/percent_decode 解码闭环）

- 文件: tauri-shell/src/main.rs:1247-1249
- 问题: `encode_back` 只编码 `\ : / 空格`,不编码 `? & # %`;current_web_url 若带查询串(如 `http://127.0.0.1:port/path?a=1&b=2`),拼进 /update、/about 的 back= 参数后 `&` 会截断 back 值,页面返回按钮跳到残缺的 URL。
- 成因: 手写编码表不全,应使用 url crate 的 percent-encoding(同 BUG-B-001 一类问题)。
- 严重度: C
- 状态: 确认

---

# C区:dsh-desktop 根级模块 排查片段

### BUG-C-001（✅ 已修复 2026-09-05：全仓确认无引用后删除根级孤儿 shortcut-maintenance.ts（逻辑在 lib/））

- 文件: dsh-desktop/shortcut-maintenance.ts:1
- 问题: 该文件被 tsconfig exclude,且根目录不存在同名 shortcut-maintenance.js;全仓无任何模块 require 根级该文件(实际使用的是 lib/shortcut-maintenance.ts/.js)。属残留孤儿文件,与 .js 发散比对无从谈起——一旦有人按惯例 require('./shortcut-maintenance.js') 将直接 MODULE_NOT_FOUND 崩溃。
- 成因: 逻辑已迁往 lib/shortcut-maintenance.ts,根级旧文件未删除;tsconfig 又以 exclude 掩盖了它不参与编译的事实。
- 严重度: C
- 状态: 确认

### 比对记录(非 bug)

- stream-write-guard.ts 与 stream-write-guard.js 逻辑逐行一致,无发散;引用方(lib/server.ts、lib/boot.ts、lib/state.ts)接口匹配。

### BUG-C-002（✅ 已修复 2026-09-05：builtin-collision 的 package.json/cordis.patch.yml 改 tmp+rename 原子写）

- 文件: dsh-desktop/builtin-collision.ts:178
- 问题: removeMarketDuplicate 用 fs.writeFileSync 直接覆写 profile 的 package.json(:178)与 cordis.patch.yml(:188),非原子写;进程在写入中途崩溃/断电会留下截断的 JSON/YAML,导致 profile 无法加载。同仓 compact-preset-migrate.ts:115-117 已采用 tmp+rename 原子写,说明项目有此意识,此处遗漏。
- 成因: 直接 writeFileSync 目标文件,未走临时文件 + rename。
- 严重度: C
- 状态: 确认

### BUG-C-003

- 文件: dsh-desktop/patch-row-heal.ts:110
- 问题: healSoulMdPatchRow 判「是否已有 config」只用正则负向先行断言检查 name 行**紧邻的下一行**(`(?![\t ]*config:)`)。当条目呈 `id → name → disabled → config` 形态时,断言看不到后面的 config,会再补一份 config 块 —— YAML duplicated mapping key,整棵插件树加载失败(dsh web 退出 1,启动崩溃循环)。这正是本文件注释中自承的 v4.4「重复 config 事故」,healRowConfig(:129)已改为扫描整个条目块,而 healSoulMdPatchRow 仍是旧式只看紧跟一行。
- 成因: 两修复器修复不同步;healSoulMdPatchRow 未移植「扫描整块再判 hasConfig」的逻辑。
- 严重度: M
- 状态: 待复查(取决于 soul-md 行是否真会出现 name→disabled→config 形态;顶层向导行可带 disabled,风险成立)

### BUG-C-004（✅ 已修复 2026-09-05：preset-sync 的 settings.yaml 改 tmp+rename 原子写）

- 文件: dsh-desktop/preset-sync.ts:127
- 问题: ensureDefaultAgentPreset 用 fs.writeFileSync 直接覆写 settings.yaml(:127 与 :133),非原子写;写入中途崩溃会截断用户全部设置。与 BUG-C-002 同类。
- 成因: 未走临时文件 + rename。
- 严重度: C
- 状态: 确认

### BUG-C-005

- 文件: dsh-desktop/profile-module-heal.ts:101
- 问题: Windows 上 fs.readlinkSync 读 junction 常返回带 `\\?\` 前缀的原始目标路径;:101 用 norm(resolve(...)).startsWith(storeRoot) 判定目标是否位于 profile 的 .pnpm store 内,带前缀时该判定恒为 false,pnpm 链接遮蔽永远不会被清理(函数静默失效,且只 log 不报警)。
- 成因: 未剥离 junction 目标的 `\\?\` 前缀即做路径前缀比较。
- 严重度: M
- 状态: 待复查(取决于 Node 版本在此机器上 readlink junction 的实际返回形态,需实测)

### BUG-C-006

- 文件: dsh-desktop/balance.ts:103
- 问题: computePricingState/minutesOfDay 用 date.getHours()(本地时区)计算峰谷,而价格表注释与官方公告明确高峰时段按 UTC+8(9:00-12:00、14:00-18:00)。非 UTC+8 时区的机器上峰谷判定与计费档位整体偏移,费用估算按错误档位计。
- 成因: 注释声明 UTC+8,实现却用本地时区,二者不一致;未做时区换算(应取 UTC 时间 +8h)。
- 严重度: M
- 状态: 待复查(若产品只面向国内用户可视为可接受,但与注释规格矛盾)

### BUG-C-007（✅ 已修复 2026-09-05：balance fetchJson 补 res.on(error, reject)）

- 文件: dsh-desktop/balance.ts:192
- 问题: fetchJson 只监听 req 的 'error',未监听 res(IncomingMessage)的 'error';响应流中途出错(如连接重置发生于 headers 之后)时 res 的 'error' 事件无监听器,按 Node 语义会作为未捕获异常抛出,可击穿主进程。
- 成因: 缺 res.on('error', reject)。
- 严重度: C
- 状态: 确认

### BUG-C-008（✅ 已修复 2026-08-30：非法 risk 改 fail-closed 归 'high'，不再被自动执行）

- 文件: dsh-desktop/rescue-agent.ts:376
- 问题: validateSuggestion 对缺失/非法的 risk 字段默认归为 'low'(`includes(item.risk) ? item.risk : 'low'`)。runAutoRepair(:573)只跳过 risk==='high' 的动作,因此 AI 只要漏写或乱写 risk(如 "critical"、"HIGH"、null),该建议即被当作低风险**自动执行**(包括 edit-file 改写 settings.yaml / cordis.patch.yml)。风险分级 fail-open。
- 成因: 未知 risk 应 fail-closed(按 high 处理或要求人工确认),实现却 fail-open 归为 low。
- 严重度: M
- 状态: 确认

### BUG-C-009（✅ 已修复 2026-09-05：rescue-agent chatCompletions 补 res 错误监听走既有 reject 链）

- 文件: dsh-desktop/rescue-agent.ts:699
- 问题: chatCompletions 的 doFetch 与 BUG-C-007 同型:只监听 req 'error',未监听 res 'error';响应流错误会成未捕获异常。
- 成因: 缺 res.on('error', ...)。
- 严重度: C
- 状态: 确认

### BUG-C-010

- 文件: dsh-desktop/plugin-updater.ts:190
- 问题: GitHub 源 URL 用 encodeURIComponent(repo) 编码 'owner/repo','/' 被编成 %2F:api.github.com 对路径中的 %2F 不解码,直接 404 —— releases/latest 与 tags 两连失败,githubLatest 恒返回 null,GitHub 源插件永远检测不到更新。同问题见于 :363 githubTarballCandidates(codeload URL 同样被 %2F 截断,能否工作取决于 codeload 是否解码)。
- 成因: 对路径段整体 encodeURIComponent,而 owner/repo 的 '/' 是路径分隔符不应编码。
- 严重度: M
- 状态: 待复查(api.github.com 拒 %2F 是已知行为;若有 GitHub 源插件在 PLUGIN_UPDATE_SOURCES 中即确认功能失效)

### BUG-C-011（✅ 已修复 2026-09-05：scoped 主包跳过改 path.relative 精确匹配，只跳过主包自身所在 scope 条目，不误伤其他 scope）

- 文件: dsh-desktop/plugin-updater.ts:484
- 问题: 合并依赖时跳过主包的判断 `e.name === path.basename(installed)` 只对非作用域包成立。作用域包(如 @deepseek-ai/dsh-xxx,内置插件的主流形态)installed=<staging>/node_modules/@deepseek-ai/dsh-xxx,basename 是 'dsh-xxx',而 stagedNms 顶层条目是 '@deepseek-ai' —— 比较恒失败,整个 @scope 目录(含主包自己的未合并原始拷贝)被 copyTree 进 merged/node_modules/@scope/,形成主包第二副本,与注释「主包已合并跳过」的意图相悖,可能造成模块双实例/遮蔽。
- 成因: 跳过逻辑未考虑 scoped 包的两级目录结构(应跳过 scope 目录或精确跳过 <scope>/<name>)。
- 严重度: M
- 状态: 确认

### BUG-C-012（✅ 已修复 2026-08-30：overlayVersion 改 fs.readFileSync + JSON.parse，绕开 require 缓存）

- 文件: dsh-desktop/updater.ts:109
- 问题: overlayVersion 用 require() 读 overlay 的 package.json,require 有模块缓存:applyUpdate 完成 overlay 原子换名后,同进程内再次调用 overlayVersion/activeVersion 仍返回**更新前的旧版本号**(路径相同命中缓存)。更新后 UI 显示版本、enginesGate 的 activeDsh 判定(plugin-updater.ts:468 经 activeVersion 取值)都会拿旧值,直到进程重启。
- 成因: 应使用 fs.readFileSync + JSON.parse(同文件 versionOfDir 的正确做法),而非带缓存的 require。
- 严重度: M
- 状态: 确认

### BUG-C-013（✅ 已修复 2026-08-30：saveSettings 改 tmp+rename 原子写，失败清理临时文件）

- 文件: dsh-desktop/updater.ts:86
- 问题: saveSettings 用 fs.writeFileSync 直接覆写 userData/settings.json,非原子;写入中途崩溃 → JSON 截断 → loadSettings(:78)catch 后静默返回 {},用户的端口、跳过版本、previousAgent 回退信息等全部配置无声丢失。与 BUG-C-002/C-004 同类但影响面更大(这是壳层主配置)。
- 成因: 未走临时文件 + rename;且损坏时无 .bak 回退。
- 严重度: M
- 状态: 确认

### BUG-C-014（✅ 已修复 2026-09-05：logStream 挂 error 监听降级（记日志+置空句柄），后续 write 走空值守卫）

- 文件: dsh-desktop/updater.ts:398
- 问题: applyUpdate 创建的 logStream(fs.createWriteStream)未挂 'error' 监听;写盘失败(磁盘满/权限)时 WriteStream 异步发出 'error' 事件,无监听器即未捕获异常,可击穿 Electron 主进程。runNpm 的 onChunk(:286)持续 logStream.write 加剧触发面。
- 成因: 缺 logStream.on('error', ...) 降级处理。
- 严重度: M
- 状态: 确认

---

# D区:dsh-desktop/lib 顶层模块 排查片段

### BUG-D-001（✅ 已修复 2026-09-05：锁创建改 fs.writeFileSync(flag:'wx') 原子排他，EEXIST 按「自 PID 放行/死锁自愈/活锁拒绝」分流，调用方复查 isAnotherDshWebRunning 双保险）

- 文件: dsh-desktop/lib/server-lock.ts:36-59（配合 server.ts:119-128）
- 问题: 跨实例进程锁存在 check-then-act 竞态：两个实例同时启动时可双双通过 `isAnotherDshWebRunning()` 检查，随后 `createDshWebLock()` 用 `fs.writeFileSync`（无排他标志）互相覆盖 PID，导致两个 dsh web 进程并发写同一 DSH_HOME——正是该锁要防的会话日志损坏（Issue #22）。
- 成因: 锁创建未使用原子排他操作（应为 `fs.writeFileSync(path, pid, { flag: 'wx' })` 或 mkdir 锁），探测（existsSync+kill(pid,0)）与创建（writeFileSync）之间存在完整 TOCTOU 窗口。
- 严重度: S
- 状态: 确认

### BUG-D-010（✅ 已修复 2026-09-05：超时强杀改调 proc.ts 的 killTree（IS_WIN/POSIX 双分支））

- 文件: dsh-desktop/lib/market-ops.ts:189-196
- 问题: 排队任务 5 分钟超时的强杀使用 Windows 专有 `taskkill`（未做 IS_WIN 分支）——POSIX 上 spawn('taskkill') 立即失败落入 catch，超时子进程（pnpm 卡死）永远不被终止，close 事件不触发，boot 链 `processPendingMarketOps()` 的 Promise 永不 resolve → 启动流程整体挂死。
- 成因: 跨平台进程回收未复用 proc.ts 的 killTree（其内部有 IS_WIN/POSIX 双分支）。
- 严重度: M
- 状态: 确认（仅影响非 Windows 宿主；Windows 主目标不受影响）

### BUG-D-011（✅ 已修复 2026-09-05：run-state.json 写入改 tmp+rename 原子替换）

- 文件: dsh-desktop/lib/run-state.ts:32-66
- 问题: run-state.json 的写入（writeRunState / markCleanExit）均为 `fs.writeFileSync` 直写目标文件，无 tmp+rename 原子替换——主进程崩溃/断电发生在写中途时得到截断 JSON；detectUncleanPreviousRun 解析失败按「首次运行」吞掉，看门狗（独立进程）读到损坏状态文件 likewise 失去崩溃判定依据。项目内 registry.json/pending.json（feature-pack.ts:493-499）均已用 tmp+rename，此处不一致。
- 成因: 状态文件写入未走原子替换约定。
- 严重度: C
- 状态: 确认

### BUG-D-012（✅ 已修复 2026-09-05：copyPluginPackage 复用 .eac-copy-stamp 戳记：源包变化时整目录 rm+copy 重建，消灭已下线文件残留）

- 文件: dsh-desktop/lib/plugin-copy.ts:234-262
- 问题: copyPluginPackage 只做「存在才覆盖」拷贝，从不删除目标侧已下线的文件——插件版本升级删掉某文件后，profile node_modules 里的旧文件永久残留（含 .js/.dll 等可被 loader 拣起的 stale 副本），与文件头「幂等」声明不符。
- 成因: 无「目标树减去拷贝清单」的清差步骤（相对 rm+cp 全量重建的性能取舍，但应至少在戳记变化时整目录替换）。
- 严重度: C
- 状态: 确认

### BUG-D-013（✅ 已修复 2026-09-05：导航白名单同时接受 ::1 与 WHATWG 序列化 [::1]）

- 文件: dsh-desktop/lib/window.ts:90
- 问题: `target.hostname === '::1'` 恒为 false——WHATWG URL 对 IPv6 字面量的 hostname 带方括号（'[::1]'），webUrl 未就绪期间（恢复页/加载态）来自 http://[::1]:port 的导航会被导航围栏误杀。
- 成因: 未按 WHATWG 序列化形式比较 IPv6 host（应同时判 '[::1]'）。
- 严重度: C
- 状态: 确认

### BUG-D-014（✅ 已修复 2026-09-05：imagePasteSave 先按 base64 串长估算超限拒绝，再解码）

- 文件: dsh-desktop/lib/plugin-manager-core.ts:296-303
- 问题: imagePasteSave 先做 `Buffer.from(base64)` 全量解码、后查 15MB 上限——超限 data URL（如数百 MB base64 串）在解码阶段即占满内存，大小闸门形同虚设；正则 `([A-Za-z0-9+/=]+)$` 对超长输入还有回溯扫描成本。
- 成因: 校验顺序错误（应先按 base64 串长 × 3/4 估算上限再解码）。
- 严重度: C
- 状态: 确认

### BUG-D-007（✅ 已修复 2026-09-05：updateBusy/clientUpdateBusy 置位提前到函数入口（quitting 检查后立即），try/finally 保证失败复位）

- 文件: dsh-desktop/lib/update-flow.ts:143-199（runClientUpdateFlow 355-428 同构）
- 问题: 防重入标志 `state.updateBusy` 在「发现新版本」确认弹窗**之后**才置位（199 行）。弹窗等待期间（用户可能停留任意久）第二次触发（托盘菜单/6h 定时器/15s 启动定时器）会通过 145 行的 busy 检查，出现两个并行更新流：两份确认弹窗、两次 applyUpdate 写同一 overlay 目录。clientUpdateBusy 同样滞后置位。
- 成因: busy 置位点应在函数入口（通过 quitting 检查后立即），而非用户确认之后。
- 严重度: M
- 状态: 确认

### BUG-D-008（✅ 已修复 2026-09-05：detectExternalDsh 改异步 execFile（promisify），12s 查询不再冻结主进程事件循环，返回值语义不变）

- 文件: dsh-desktop/lib/watchdog-boot.ts:119-122
- 问题: `detectExternalDsh` 在主进程用 `execSync` 跑 PowerShell CIM 查询（timeout 12000ms）——junction 巡检 tick 命中时主进程事件循环最长冻结 12 秒（窗口/托盘/IPC 全部无响应）。函数签名是 Promise 但内部完全同步，异步外形无实际收益。
- 成因: 同步 exec 阻塞主进程；应改 execFile 异步或 Worker。
- 严重度: M
- 状态: 确认

### BUG-D-009

- 文件: dsh-desktop/lib/update-flow.ts:219-225
- 问题: agent 更新「立即重启」分支只调 `killTree(state.serverProc)`（异步尽力、强杀补刀挂在 1500ms 定时器上）随即 `relaunch() + exitProcess(0)`——主进程退出后补刀定时器湮灭，旧 dsh web 可能仍占用稳定端口；新实例按 settings.webPort 复用同端口启动即撞绑定失败。同文件客户端更新分支（489 行）用的是 killTreeAndWait，两处节奏不一致。
- 成因: 退出路径未等待进程树回收（proc.ts 文件头明确该时序是 V4 修复关键）。
- 严重度: M
- 状态: 待复查（dsh web 端口绑定失败后的行为需确认；killTree 未 await 已由代码确认）

### BUG-D-006（✅ 已修复 2026-09-05：预览服务补 Host 头校验（仅 127.0.0.1/localhost/[::1]，封 DNS rebinding）+ isUnderFileRoots 路径围栏（消费方核实均为会话 cwd 项目文件））

- 文件: dsh-desktop/lib/preview.ts:56-104
- 问题: 预览静态服务无 Host 头校验、无一次性 token，且对**任意绝对路径**放行（唯一约束是 path.isAbsolute）——本机任意进程可经 `http://127.0.0.1:<port>/C:/...` 读取用户任意文件；浏览器侧还存在 DNS rebinding 通道（恶意站点域名重绑定到 127.0.0.1 后，页面以合法 Host 访问该端口读本地文件）。端口随机但可被本机枚举（netstat/端口扫描）。同项目已有 isUnderFileRoots 围栏却未在此应用。
- 成因: 安全边界只做了「回环地址 + GET/HEAD」，缺少请求来源（Host/Origin）校验与路径根约束。
- 严重度: S
- 状态: 待复查（若端口从未暴露给不可信渲染内容且仅本机同用户进程可达，实际风险降级为 M；DNS rebinding 需浏览器配合，建议补 Host 校验）

### BUG-D-004（✅ 已修复 2026-09-05：updatePack 移除不再引用插件处补 await removePlugin）

- 文件: dsh-desktop/lib/feature-pack.ts:958
- 问题: `updatePack` 移除不再引用插件时 `removePlugin(old, profile)` 缺少 await——Promise 悬空：后续 `restoreArtifactsFor` 与注册表写回不等待 pnpm remove 完成（顺序竞态），且 remove 失败成为 unhandledRejection（installPack/uninstallPack 中同名调用均有 await，可对照）。
- 成因: 漏写 await（也未标 void），异步错误未捕获。
- 严重度: M
- 状态: 确认

### BUG-D-005（✅ 已修复 2026-09-05：installPack catch 消费 snapshotRef：有快照走 restoreSnapshot，无快照能力退化逐个 removePlugin+restoreArtifactsFor 并清理包数据目录）

- 文件: dsh-desktop/lib/feature-pack.ts:844-853（installPack catch 分支）
- 问题: 安装中途失败（如插件装配成功后 preset/skill 同步抛错）只删除包数据目录，不回滚已执行的 `dsh plugin add`——文件头红线声明「安装/更新事务化：失败按保护中心快照回滚并清理半成品」，实际 catch 中无 restoreSnapshot / removePlugin，留下已安装但未入册的孤儿插件（注册表无记录，uninstallPack 也清不掉）。
- 成因: 事务回滚只实现了「数据目录清理」一半，快照 snapshotRef 在失败路径未被消费。
- 严重度: M
- 状态: 确认

### BUG-D-003

- 文件: dsh-desktop/lib/boot.ts:367（配合 run-state.ts:113-133）
- 问题: 客户端更新崩溃自回退「成功也不生效」：`autoRollbackClientIfCrashed(uncleanPrev)` 的返回值被忽略——即便备份还原成功，当前进程仍是崩溃过的新版二进制，boot 链继续按新版启动，没有 relaunch 进回退后的旧版；且 `fs.copyFileSync(p.bak, p.exe)` 试图覆盖**正在运行**的 exe（PORTABLE_EXECUTABLE_FILE 即当前进程映像），Windows 上对运行中的可执行文件写入会被拒绝（EPERM/EBUSY），回退大概率直接落入 catch 记日志后带伤继续启动。
- 成因: 回退后缺少「relaunch + 退出当前进程」步骤；平台层对运行映像的写锁未纳入设计。
- 严重度: M
- 状态: 待复查（Windows 运行映像写锁行为需实机确认；返回值被忽略已由代码确认）

### BUG-D-002

- 文件: dsh-desktop/lib/paths.ts:26-27（DANGEROUS_EXT）
- 问题: 危险扩展名围栏可能被 Windows 路径规范化绕过：`/\.(bat|...|reg)$/i` 只匹配字符串结尾，而 Windows 文件系统会剥离路径尾部的点和空格——如 `evil.ps1.` 或 `evil.bat ` 不命中正则，但实际打开/写入的正是 `evil.ps1`/`evil.bat`。
- 成因: 校验在字符串层、执行在文件系统层，两层对「同一文件」的判定不一致；未先对 basename 做 trimEnd(' .') 或用 path.extname 取扩展名再比对。
- 严重度: M
- 状态: 待复查（围栏消费方在 main.js IPC handler，需确认传入路径是否已规范化）

---

# E区:dsh-desktop/lib 子目录与 shared 排查片段

### BUG-E-001（✅ 已修复 2026-09-05：concatFiles 写流 error 监听常驻挂接（出错即 reject+destroy），分片删除推迟到合并成功之后，错误路径保留现场）

- 文件: dsh-desktop/lib/client-update/download.ts:269-284
- 问题: `concatFiles` 中写出流 `out`（`fs.createWriteStream(dest)`）的 `'error'` 监听器直到全部分片拼接循环结束后（第 281 行）才挂接。若 `out` 在循环期间出错（如磁盘满 ENOSPC、目标路径不可写），该 `'error'` 事件无监听器 → Node 对无监听器的 error 事件直接抛出未捕获异常 → 主进程崩溃；且此前已 `rmSync` 删掉的分片（第 278 行先删源分片）造成已下载数据丢失，合并半途的 dest 成为截断文件残留。
- 成因: 错误监听器挂接时机错误：per-source promise 只监听读流 `rs` 的 error/end，写流 `out` 的 error 在循环内完全无人接管；且流程设计上先删分片源再完成合并，错误路径无恢复能力。
- 严重度: S
- 状态: 确认

### BUG-E-002（✅ 已修复 2026-09-05：shell.exec 退出码区分成功与异常终止：有 err 且 code 非 number 映射 -1，新增可选 signal 透传（超时/信号终止不再误判为 0））

- 文件: dsh-desktop/lib/extension-host/sdk/index.ts:226-229
- 问题: SDK `shell.exec` 的退出码映射：`exec` 回调中 `err.code` 仅在子进程以非零码退出时是 number；当进程被 timeout 强杀、被信号终止或 spawn 失败时 `err.code` 为 undefined/null/字符串，代码 `typeof err?.code === 'number' ? err.code : 0` 一律回落为 0 —— 插件收到 `{code: 0}` 把失败（超时被杀/信号终止）误判为成功。
- 成因: 未区分「无 err 的成功退出」与「有 err 但 code 非 number 的异常终止」，异常路径应以非零（如 -1 或 124）或透传 signal 表示失败。
- 严重度: M
- 状态: 确认

### BUG-E-003（✅ 已修复 2026-08-30：archive 错误改为记录 + 收尾 Promise 拒绝传播，不再回调内 throw）

- 文件: dsh-desktop/lib/logger/diagnostics.ts:61-63
- 问题: `buildDiagnosticsZip` 中 `archive.on('error', (e) => { throw e; })` —— 在 EventEmitter 的 error 监听器里同步 throw，异常不会被 `buildDiagnosticsZip` 的 Promise 捕获，而是成为未捕获异常直接打挂主进程。archiver 在打包中途出错（磁盘满、源文件被占用/删除、zlib 内部错误等）时，「导出诊断日志」功能从可恢复的失败升级为整个应用崩溃。
- 成因: 错误传播方式错误：应保存错误并 reject 收尾 Promise（或让 finalize 的 rejection 透出），而不是在事件回调里 throw；`finished` Promise 只监听 output 流，未覆盖 archive 的错误。
- 严重度: S
- 状态: 确认

### BUG-E-004

- 文件: dsh-desktop/lib/logger/rotate.ts:63-65
- 问题: `_openNew()` 以 `'w'` 模式打开 main.00 —— 启动时（构造函数第 50 行）无条件截断上一会话遗留的 main.00，而不是把旧文件轮转为 main.01。紧随其后第 65 行的 `fs.fstatSync(this._fd).size` 因此恒为 0（无意义的续写尺寸探测）。崩溃后重启时，最需要的「崩溃当次」日志在 logger.init 瞬间被清空，事后无法诊断。
- 成因: 打开模式选择错误（'w' 截断 vs 'a' 追加/先轮转再开）；与文件头宣称的「崩溃安全优先」目标相悖。若系有意（每会话全新日志），则启动前应先把旧 main.00 轮出。
- 严重度: M
- 状态: 待复查

### BUG-E-005

- 文件: dsh-desktop/lib/plugin-guard/snapshot.ts:106,59,86-96
- 问题: `restore(id)` 先调 `snapshot('pre-restore:'+id)` 留反悔快照，而 `snapshot()` 内部会执行 `pruneSnapshots()`（保留最新 MAX_SNAPSHOTS=10 份，删更老的）。当回滚目标 `id` 恰是最老一份且当前已有 10 份快照时，pre-restore 快照一落盘即触发 prune 把目标快照目录删掉，后续 `fs.copyFileSync(src, …)` 全部 ENOENT，回滚静默退化为「ok 但 restored 为空/报错」；同理 markGood 的 lastGood 快照也可被 prune 删除，`lastGoodSnapshot()` 返回 null → 守护启动的回滚路径失效。
- 成因: prune 策略未排除「正在回滚的目标」与「lastGood 标记的快照」；快照计数与回滚动作之间没有保护窗口。
- 严重度: C
- 状态: 待复查

---

# F区:dsh-desktop scripts/test/native 排查片段

### BUG-F-001（✅ 已修复 2026-09-05：e2e-full 成功路径改同步 rmSync 后再 exit，临时根不再泄漏）

- 文件: dsh-desktop/scripts/e2e-full.ts:563-571
- 问题: 成功路径下临时根目录(root,可能含数 GB 插件闭包副本)永远不会被删除。`setTimeout(..., 500)` 调度 rmSync 后立即同步执行 `process.exit(code)`,定时器回调根本没有机会触发。
- 成因: `process.exit` 不会等待事件循环中挂起的 timer;异步清理必须与 exit 互斥(先 await 清理再 exit,或同步 rmSync)。
- 严重度: M(磁盘泄漏,每次成功跑 e2e 留下数 GB 临时目录)
- 状态: 确认

### BUG-F-002（✅ 已修复 2026-09-05：e2e-full 异常路径补 mock server close + taskkill 被测进程树再 exit(1)）

- 文件: dsh-desktop/scripts/e2e-full.ts:574-577
- 问题: `main()` 抛出未捕获异常时直接 `process.exit(1)`,不经过 finish():已 spawn 的应用进程(runExe)与 mock http server 均不回收,被测 exe 残留运行并占用 DEBUG_PORT/MOCK_PORT,导致下一次运行被 221 行的"已有同名 exe 在运行"守卫拒绝。
- 成因: catch 分支缺少与 finish() 等价的清理(taskkill 子进程树 + mock.server.close)。
- 严重度: M(进程泄漏/端口占用,中断后续 e2e)
- 状态: 确认

### BUG-F-003（✅ 已修复 2026-09-05：e2e-v4 成功路径同步 rmSync 后再 exit）

- 文件: dsh-desktop/scripts/e2e-v4.ts:476-485
- 问题: 与 BUG-F-001 同型:成功路径用 `setTimeout(100ms)` 调度 `fs.rmSync(root)` 清理数 GB 临时目录,随后 `finish()` 立即 `process.exit`,回调永不执行,临时目录必然残留。
- 成因: process.exit 不等挂起的 timer。
- 严重度: M(磁盘泄漏)
- 状态: 确认

### BUG-F-004（✅ 已修复 2026-09-05：e2e-v4 异常路径补杀 appPid 进程树再 exit(1)）

- 文件: dsh-desktop/scripts/e2e-v4.ts:494-497
- 问题: `main()` 异常时 catch 直接 `process.exit(1)`,不杀已 spawn 的应用进程(appPid),被测 exe 残留并占用 CDP 端口,下一次运行被 166 行单实例守卫拒绝。仅 325-331 的就绪失败分支做了 process.kill,异常路径没有。
- 成因: 缺少全局 try/finally 或 catch 内清理。
- 严重度: M(进程泄漏/假"已运行"阻塞后续测试)
- 状态: 确认

### BUG-F-006（✅ 已修复 2026-09-05：bench-boot 握手路径 try/finally 补 child.kill()）

- 文件: dsh-desktop/scripts/bench-boot.ts:204-222
- 问题: spawnAndInit 的 init 握手超时/失败路径不杀子进程:`await ready` 抛出时直接逃出函数,`child.kill()`(220 行)只在成功路径执行。Windows 上父进程退出不回收非 detached 子进程,失败的 host-bootstrap node 进程泄漏。
- 成因: 缺少 try/finally 包裹 kill;超时 reject 后无清理。
- 严重度: C(开发工具,失败场景下 node 进程残留)
- 状态: 确认

### BUG-F-007（✅ 已修复 2026-09-05：删除按映像名的全局 taskkill（不再误杀真实实例）；实现 --clean=<root>：限定 dsh-rescue-demo-* 目录 + 命令行匹配精确回收）

- 文件: dsh-desktop/scripts/demo-rescue-ai.cjs:63-65,71
- 问题: 脚本启动即 `taskkill /IM "Deepseek Harness EAC.exe" /T /F`,按映像名强杀本机**所有**实例——包括用户正在使用的真实应用(非演示副本),无任何确认提示。另外 232 行提示的 `--clean=<root>` 参数在脚本中没有任何处理逻辑(ARGS 解析后未使用),清理说明无效。
- 成因: 演示脚本用全局映像名 kill 代替精确 PID 管理;--clean 提示是过期遗留文本。
- 严重度: C(误杀用户真实会话的风险;文档误导)
- 状态: 确认

### BUG-F-008（✅ 已修复 2026-09-05：verify-bugfix-cdp 死三元改 opened === true，设置按钮缺失不再假通过）

- 文件: dsh-desktop/scripts/verify-bugfix-cdp.js:163
- 问题: `check('设置页已打开', opened === true || opened === 'no-button' ? !!opened : !!opened, ...)` —— 三元两个分支都是 `!!opened`,且 `'no-button'` 是真值字符串:当页面里**根本找不到设置按钮**时该检查反而通过(假阳性),后续 A-E 断言在错误页面上继续跑。
- 成因: 表达式写错,意图应是 `opened === true`,实际 `!!opened` 对任何非 false 值(包括 'no-button')都为 true。
- 严重度: M(验证脚本假通过,掩盖设置入口缺失回归)
- 状态: 确认

### BUG-F-009（✅ 已修复 2026-09-05：sim-client-update 按成败分支：成功同步 rmSync，失败保留现场）

- 文件: dsh-desktop/scripts/sim-client-update.ts:128-135
- 问题: 与 BUG-F-001 同型:`setTimeout(200ms)` 调度 `fs.rmSync(root)`(含 65MB 假安装包与下载产物)后立即 `process.exit`,临时目录必然残留;且 rmSync 调度在失败路径也执行——失败现场被删,与 e2e 系列"失败保留现场"的约定相反。
- 成因: process.exit 不等 timer;清理未按成败分支。
- 严重度: M(磁盘残留 + 失败现场丢失)
- 状态: 确认

### BUG-F-010（✅ 已修复 2026-09-05：feature-pack-cli 临时包 finally 清理（EXIT_LOCK 排队路径按 pending.json 消费语义保留））

- 文件: dsh-desktop/scripts/feature-pack-cli.ts:98-117
- 问题: fetchPackToTemp 对 URL 下载把包写入 `os.tmpdir()/dshpack-<pid>-<name>`,全文件(install/update/inspect)无任何删除逻辑——成功路径每次泄漏一个 .dshpack 临时文件(功能包可达数十 MB)。仅 EXIT_LOCK 排队路径需要保留该文件,成功/失败路径都应清理。
- 成因: 缺 finally 清理(需区分排队路径保留)。
- 严重度: C(临时目录膨胀)
- 状态: 确认

### BUG-F-011（✅ 已修复 2026-08-30：新增 valid_snapshot_id 白名单，load_snapshot/delete_snapshot_file 入口校验，engine.rs 各 restore 路径经 load_snapshot 同受守卫）

- 文件: dsh-desktop/native/snapshot/src/store.rs:97-101,130-133
- 问题: snapshot_id 无任何校验直接拼路径 `snapshots_dir().join(format!("{id}.json"))`。napi 暴露的 snapshot_delete / snapshot_detail / engine.rs 的 snapshot_restore 都接受来自 TS 侧的 id:传入 `../../x` 之类的穿越串,delete_snapshot_file 会删除存储目录之外任意 `.json` 文件,load_snapshot 可读取任意 .json(经 detail 返回内容)。分支名有 valid_branch_name 防穿越,快照 id 没有对应校验。
- 成因: FFI 边界未校验 id 字符集(应为 [A-Za-z0-9-] 白名单或 join 后 canonicalize 前缀检查)。
- 严重度: S(任意 .json 文件删除/读取,渲染进程可达 FFI 时即安全洞)
- 状态: 确认

### BUG-F-012（✅ 已修复 2026-08-30：object_path 改 hash.get(..2).unwrap_or("")，非字符边界安全降级不再 panic）

- 文件: dsh-desktop/native/snapshot/src/store.rs:47-50
- 问题: `object_path` 中 `&hash[..2.min(hash.len())]` 按字节切片:hash 若含多字节 UTF-8 字符且第 2 字节落在字符中间(如 "中…")会直接 panic。engine.rs snapshot_restore 的 `store.object_path(&f.hash)` 的 hash 来自磁盘上的快照 JSON(可损坏/手工编辑),napi 函数默认不 catch_unwind,panic 跨 FFI 边界 = 宿主进程 abort。
- 成因: 字节切片未用 chars/get(..2) 或 is_char_boundary 防护;输入来自不受信磁盘数据。
- 严重度: M(损坏的快照文件可使整个桌面进程崩溃)
- 状态: 确认

### BUG-F-013

- 文件: dsh-desktop/native/snapshot/src/engine.rs:329
- 问题: snapshot_restore 写回时 `target.join(f.path.replace('/', MAIN_SEPARATOR_STR))`,f.path 直接来自快照 JSON 文件内容,未校验是否含 `..`/绝对路径。损坏或被篡改的快照文件(如包含 `"path": "../../evil"`)会让恢复把对象内容写到 target_dir 之外(任意文件覆盖)。同理 341 行删除逻辑只作用于清单外文件,写回侧无防护。
- 成因: 磁盘快照 JSON 被当作受信输入,缺路径段白名单校验(拒绝 `..`、盘符、UNC)。
- 严重度: M(本地数据损坏面 → 任意文件写;需攻击者先能写快照目录)
- 状态: 待复查

### BUG-F-014

- 文件: dsh-desktop/native/supervisor/src/job.rs:415-438
- 问题: assign_to_job 按裸 pid `OpenProcess` 绑定:Node spawn 到 assign 之间若目标进程已退出且 pid 被 OS 复用,会把**无关进程**绑入 Job,之后 terminate_job/close_job(KILL_ON_JOB_CLOSE)会误杀该进程。竞态窗口毫秒级但真实存在,模块头注释只闭合了"插件代码逃逸"方向,未闭合 pid 复用方向。
- 成因: 缺进程身份校验(如 OpenProcess 后比对进程创建时间/映像路径)。
- 严重度: C(极小概率误杀第三方进程)
- 状态: 待复查

### BUG-F-015（✅ 已修复 2026-09-05：watchdog-behavior 死断言改为限流计数真实断言组（重启尝试/15s 窗口 ≤2/未达 cap 不出现上限日志））

- 文件: dsh-desktop/test/watchdog-behavior.test.ts:114
- 问题: `assert.ok(!log.includes('too many restarts') || true)` —— `|| true` 使断言恒真,是死断言:无论 watchdog 是否触发重启上限,该行都通过,给人"已覆盖重启上限行为"的假象。
- 成因: 弱断言写法;应删除该断言或改为真实的上限行为验证(等待 'too many restarts' 出现)。
- 严重度: C(假覆盖)
- 状态: 确认

### BUG-F-016（✅ 已修复 2026-09-05：stable-port 断言收紧为 port > 0 && 不在受限端口表）

- 文件: dsh-desktop/test/stable-port.test.ts:145,156
- 问题: 两处断言 `assert.ok(port === 0 || !CHROMIUM_RESTRICTED_PORTS.has(port))` 允许 port===0 通过:chooseStableWebPort 若因 bug 返回 0(失败语义),这两个用例照样通过(假阳性)。同文件 85 行已证明有效端口应为 >0。
- 成因: 断言下界过松。
- 严重度: C(假阳性窗口)
- 状态: 确认

### BUG-F-017（✅ 已修复 2026-09-05：logger-redact 条件断言改无条件：gotWarn 必须存在且含 boom）

- 文件: dsh-desktop/test/logger-redact.test.ts:139
- 问题: `if (gotWarn) assert.ok(gotWarn.message.includes('boom'), ...)` —— 条件断言:若被测代码从未记录 warn(gotWarn 为 null),断言整段跳过,测试照样通过。该用例本意是"异常 getter 必须产生单条 warn 记录",实际对"完全无告警"这一回归零防护。另外 98 行用例名写 `-> 1***8000` 而断言为 `138****8000`,名实不符(仅文档误导)。
- 成因: 用 if 包住关键断言代替强制断言。
- 严重度: C(假阳性窗口)
- 状态: 确认

### BUG-F-018（✅ 已修复 2026-09-05：diagnostics-zip PowerShell 双引号转义笔误改 '""'）

- 文件: dsh-desktop/test/diagnostics-zip.test.ts:115
- 问题: `ps.replace(/"/g, '"')` —— 替换串与目标完全相同,是恒等 no-op(本意显然是对双引号做命令行转义)。当前 ps 文本恰好不含双引号所以没炸,但一旦 zipPath/outDir 或脚本片段引入 `"`,powershell -Command 的引号配对即被破坏,解压静默失败。
- 成因: 转义写法笔误(应为 '""' 或改用 -EncodedCommand)。
- 严重度: C(潜在脆弱点)
- 状态: 确认

### BUG-F-019（✅ 已修复 2026-09-05：supervisor-phase1 死断言改为断言 ok===false 且 error 含「无可用回滚点」）

- 文件: dsh-desktop/test/supervisor-phase1.test.ts:194
- 问题: `assert.ok(installer.rollbackSdkPlugin('fence-ext').ok || true)` —— 与 F-015 同型死断言,`|| true` 恒真;rollbackSdkPlugin 返回 false(回滚失败)也通过。
- 成因: 注释称"无回滚点属预期",但写法把"回滚失败"也一并放行。
- 严重度: C(假覆盖)
- 状态: 确认

### BUG-F-005（✅ 已修复 2026-09-05：e2e-mario 成功路径同步 rmSync；异常路径补 taskkill 子进程树）

- 文件: dsh-desktop/scripts/e2e-mario.ts:252-261,264-267
- 问题: 与 BUG-F-001/002 同型双问题:(a) finish() 成功路径 `setTimeout(500ms)` 调度 rmSync 后立即 `process.exit`,root 永不清理;(b) `main().catch` 异常路径不 taskkill 子进程,被测 exe 残留。
- 成因: 同 F-001/F-002。
- 严重度: M
- 状态: 确认

---

# G区:对比 upsterm 上游回归排查片段(V1.1 增量)

> 方法:`git diff upsterm/main main` + 三个并行深查代理。**分叉关系（V1.1.1 修正）**:merge-base=671e87ec,本地领先 **123**、落后上游 **32** 提交——差异分两类:(a) 本地 123 提交引入的真回归(G 区);(b) 上游 32 提交中本地未合并的修复(H 区)。G-001/G-002 已核实分叉点即存在、本地删改,属 (a) 真回归。

### BUG-G-001（✅ 已修复 2026-08-30：按上游原样恢复 tauri.windows.conf.json 的 WebView2Loader.dll 资源映射）

- 文件: tauri-shell/tauri.windows.conf.json(已删除) + tauri-shell/tauri.conf.json:23-26
- 问题: **上游 tauri.windows.conf.json 被整文件删除**,其中含 Windows 专属资源映射 `"staged-resources/WebView2Loader.dll": "./WebView2Loader.dll"`(exe 同级);删除后 tauri.conf.json 的 resources 只剩 sidecar/ 与 dsh-desktop/ 两个子目录映射,WebView2Loader.dll 彻底不进安装包。stage-resources.mjs 注释明确"必须与壳 exe 同级,否则启动即 0xC0000135"——安装版在终端机器上**双击即失败,窗口根本创建不出来**(开发态 cargo run 不受影响:webview2-com build script 会把 dll 放到 target/debug,这正是"开发正常、安装版窗口有问题"的原因)。
- 成因: 合并平台配置时把 Windows 专属 conf 删掉,未把其中的 loader 映射并入主 conf;BUG-A-017 的疑点由此坐实(上游靠该文件兜底,本地把兜底删了)。
- 严重度: S(安装版无法启动)
- 状态: 确认(原 BUG-A-017 并入本条,根因明确)

### BUG-G-002（✅ 已修复 2026-08-30：fileDropSave 实现按分叉点原样移植回 plugin-manager-core.ts + server.ts 恢复 file-drop.save 处理器）

- 文件: tauri-shell/sidecar/server.ts(处理器已删) 对照 tauri-shell/sidecar/bridge.ts:190
- 问题: main 版 server.ts **删除了 `file-drop.save` 处理器**(上游 server.ts 存在于 batch 表),但 bridge.ts:190 `fileDrop.save()` 仍 `call('file-drop.save', ...)`——拖入文件(zip/二进制等)保存恒返回 "method not found",桥 .catch 吞掉,**文件拖入功能静默失效**(dsh-file-drop-eac 链路断)。
- 成因: 统一 lib 模块族重构时该处理器被当作迁移完成删除,但桥侧契约未同步(同 B-008/B-009 的契约错位族,但此条是"调用方还在、实现没了"的纯回归,上游两側齐全)。
- 严重度: M
- 状态: 确认

### BUG-G-003（✅ 已修复 2026-08-30：WindowState 新增 scale 字段（serde 默认 1.0 兼容旧文件），中心点用保存时 scale 换算，min_vis 乘目标屏 mscale 转物理像素）

- 文件: tauri-shell/src/main.rs:254-287(resolved_initial_bounds 恢复分支)
- 问题: 窗口状态恢复存在两处单位/坐标系混用——① `min_vis = MIN_VISIBLE_W.max(w * 0.4)` 中 `w` 是**逻辑宽度**,却拿去和**物理像素**坐标 `wa.position.x + wa.size.width - min_vis` 做 clamp;高 DPI(scale>1)下 min_vis 偏小,右/下边界钳位过松,窗口可被恢复到仅几十物理像素可见的近屏外位置。② 窗口中心点 `cx = st.x + st.w * scale / 2` 用的是**主屏** scale_factor,而 st.x/st.w 可能来自另一块不同缩放的副屏——中心点算错 → `monitor_from_point` 选错目标显示器 → 窗口被钳位进错误显示器的 work area(多屏混合 DPI 下窗口"乱跳/跑偏")。
- 成因: outer_position(物理)/outer_size.to_logical(逻辑)两类量存入同一 WindowState 后,恢复路径未统一坐标系;min_vis 应先乘目标显示器 mscale。
- 严重度: M(高 DPI/多屏用户窗口位置恢复错误,符合"窗口有问题"症状)
- 状态: 确认

### BUG-G-004（✅ 已修复 2026-08-30：window-state.json 改 tmp+rename 原子写）

- 文件: tauri-shell/src/main.rs:173-203(save_window_state)
- 问题: window-state.json 用 `std::fs::write` 直写目标文件,非原子;写入中途崩溃/断电留下截断 JSON,下次启动 serde_json::from_str 失败静默回退默认尺寸(窗口位置记忆无声丢失)。与系统性模式#4(非原子写)同族,为新增实例。
- 成因: 未走 tmp+rename。
- 严重度: C
- 状态: 确认

### BUG-G-005

- 文件: tauri-shell/Cargo.toml（无 windows-sys）对照上游提交 05ddcba(#244)
- 问题: **修正定性（V1.1.1）**：初判为"本地删除依赖"，复核分叉关系后确认——merge-base 为 671e87ec，本地领先 123、**落后上游 32 提交**；windows-sys 三处能力（① WM_SETICON 任务栏 Big 图标；② ShellExecuteW 直开文件/外链；③ GetUserDefaultLocaleName 语言检测）是上游 #244/#248 在分叉点之后**新增**的，本地从未合并。即这是"未合并上游修复/特性"而非本地回归，但效果相同：本地任务栏/Alt-Tab 图标无 Big 图标补齐，外链打开仍走 cmd start 旧路径。
- 成因: 本地 123 提交与上游 32 提交双向分叉，同步策略只出不进。
- 严重度: C
- 状态: 确认（属"未合并上游修复"类，见 H 区）

### BUG-G-006（🔶 部分修复 2026-08-30：① init 脚本尾行改 typeof 守卫，snapshot-ui.js 缺失不再抛 ReferenceError 断链；② additional_browser_args 仍待实机构建验证）

- 文件: tauri-shell/src/main.rs:56-62(main_initialization_script) + 1918(additional_browser_args)
- 问题: 两个"窗口菜单入口按钮消失"的候选放大器——① init 脚本 = BRIDGE_JS + snapshot-ui.js 内容 + 尾行 `window.__dshOpenSnapshotPanel=openSnapshotPanel;`,snapshot-ui.js 读取失败时(开发布局,BUG-B-003)尾行抛 ReferenceError;虽 BRIDGE_JS 已先执行、菜单按钮本身不受影响,但一旦未来把快照段调到 BRIDGE_JS 之前或合并压缩,同一缺陷会直接掐断整条注入链(菜单按钮/标题栏全灭),属悬在头顶的结构性风险。② `.additional_browser_args("--autoplay-policy=no-user-gesture-required")` 代码内自承"⚠️ 未验证(本机无 cargo 工具链)"——未验证的浏览器参数进了发布链路,若 WebView2 版本对参数敏感导致 webview 创建失败,主窗 build 失败只剩 eprintln,用户看到的是"窗口没了"。
- 成因: ① 注入串拼装依赖文件读取成功却无兜底;② 未验证参数上游没有、本地新增。
- 严重度: C(①结构性风险;②待实机构建验证)
- 状态: 待复查

### BUG-G-101（✅ 已修复 2026-08-30：export-logs 改调 chrome:export-logs 并透传会话 token 过 sender 校验）

- 文件: tauri-shell/sidecar/server.ts:963(menu.action 的 export-logs 分支)
- 问题: 该分支取 `methods['recovery.export-logs']` 调用,而全仓库不存在此方法名——真实实现挂在冒号通道 `chrome:export-logs`(dsh-desktop/lib/ipc/recovery.ts:68);`typeof f === 'function'` 恒 false,菜单「导出日志」恒返回 `{ok:false,'unavailable'}`。即使 BUG-B-008 修复(registerIpc 装配完成),注册键也是 `chrome:export-logs` 而非 `recovery.export-logs`,此分支仍失效——是独立于 B-008 的第二处断点。上游分叉点后的 646b899/6d094d8 正好重写了导出日志链路(Node 直生成 zip),本地未合并(见 BUG-H-001)。
- 成因: 点号旧通道名重构为冒号通道时漏改 menu.action 内部转发名。
- 严重度: M
- 状态: 确认

### BUG-G-102（✅ 已修复 2026-09-05：installDir 优先取 process.env.DSH_SHELL_EXE 所在目录（与 sidecar getExecDir 同源），回退 execPath）

- 文件: dsh-desktop/lib/update-flow.ts:340(clientUpdateOpts().installDir)
- 问题: `installDir = path.dirname(process.execPath)`——Tauri sidecar 宿主下 `process.execPath` 是 **node 二进制**而非壳 exe(server.ts:288 自己用 `DSH_SHELL_EXE` 求壳目录即是反证)。`runClientUpdateFlow`:491 与 `offerPendingClientUpdate`:551 的 applyUpdate 会把客户端更新的备份/原子替换做到 node 所在目录,**更新错目标目录**(轻则更新无效,重则污染 node 运行时目录)。sidecar 的 clientUpdateHost.getExecDir 才是正确实现,但 lib 版未消费它。
- 成因: lib 模块按 legacy-shell(execPath=壳 exe)假设取安装目录,未走宿主注入。
- 严重度: M
- 状态: 确认(打包布局若 node 与壳同目录则侥幸正确,建议对照 staged 布局复查)

### BUG-G-103（✅ 已修复 2026-08-30：sidecar 启动时从 settings 同步 state.notifyOnTurnEnd + toggle-notify 回写 state）

- 文件: dsh-desktop/lib/ipc/app.ts:49 + dsh-desktop/lib/boot.ts:436 + tauri-shell/sidecar/server.ts:924
- 问题: `chrome:init` 返回 `notifyOnTurnEnd: state.notifyOnTurnEnd`,而该字段只在 lib/boot.ts:436 的 boot() 里从 settings 同步;sidecar 自举路径(server.ts)不经过 lib/boot.ts,state 恒为默认值 true。且 sidecar 的 menu.action `toggle-notify`(server.ts:924)只写 settings 不回写 state——B-008 修复后菜单「会话完成通知」勾选态与用户真实设置脱钩(恒显示勾选)。
- 成因: 状态双源:lib 用 state 缓存、sidecar 用 settings 直读,两边无同步。
- 严重度: M
- 状态: 确认

### BUG-G-104（✅ 已修复 2026-08-30：预览读流挂 error 监听，出错 500 收尾不再未捕获异常）

- 文件: dsh-desktop/lib/preview.ts:99
- 问题: `fs.createReadStream(p).pipe(res)` 未挂 error 监听;statSync 通过后文件被删/独占/读失败时,流 'error' 事件未捕获,按 Node 语义抛异常打挂 sidecar 进程。与 BUG-E-001 同型的流错误监听缺失(不同文件、独立点位)。
- 成因: 同 E-001 模式。
- 严重度: M
- 状态: 待复查(触发需 stat 后竞态)

### BUG-G-105（✅ 已修复 2026-08-30：TrayIconBuilder 加 .menu_on_left_click(false)，左键专职切换显隐、菜单只留右键）

- 文件: tauri-shell/src/main.rs:1910-1923(.on_tray_icon_event 左键 Up → win.show()+set_focus())
- 问题: **「托盘菜单打不开」的机制级根因**。tauri 2.11.5 依赖的 tray-icon 0.24.2 默认 `menu_on_left_click: true`:Windows 消息泵在 WM_LBUTTONUP 时先派发 Click 事件、再 TrackPopupMenu——Click 处理器里的 `win.show()` + `win.set_focus()` 异步聚焦主窗,把刚弹出的托盘菜单顶掉,表现为**左键点托盘"菜单闪一下即关/打不开"**(右键正常)。两边均未调用 `.menu_on_left_click(false)`。注:上游同位置代码逐字相同,此缺陷上游同样存在(非回归),但它是该症状唯一直接的代码级解释。
- 成因: 框架默认行为与"单击切换窗口显隐"遗留约定叠加;修复为 TrayIconBuilder 加 `.menu_on_left_click(false)`(菜单只留右键,左键专职切换显隐)。
- 严重度: M
- 状态: 确认(机制源码级确认;用户触发路径需实机复核左/右键)

### BUG-G-106（✅ 已修复 2026-08-30：/died 重建窗补 initialization_script + on_navigation + disable_drag_drop_handler，与主窗同套注入）

- 文件: tauri-shell/src/main.rs:1819-1838(/died 重建窗 builder)
- 问题: **「窗口菜单入口按钮消失」的最强单点解释**。boot 失败建的 /died 窗口:无 initialization_script、无 on_navigation;/died 页靠内联 BRIDGE_JS 有桥,但「重新启动」retry() 成功后 boot.web-ready 把**这个窗口**导航到 webUrl——此后该窗永不注入桥:36px 玻璃栏/菜单按钮彻底消失,且 decorations(false) 下窗口无法拖动、最小化/最大化/关闭全部失效。上游同位置同样缺失(非回归),但缺陷真实存在且同时命中"按钮消失+窗口有问题"两个症状;本地该窗还丢了上游 #244 的 apply_window_icon。
- 成因: 重建窗 builder 漏挂 `.initialization_script(&init)`(主窗首建有,died 重建没有);修复一行即可。
- 严重度: M
- 状态: 确认

---

# H区:未合并的上游修复(落后 32 提交中的症状相关项)

> 本地 main 落后 upsterm/main 32 个提交。以下条目是上游已修、本地未合并且与本轮症状(菜单/托盘/窗口/启动)直接相关的修复;均待逐条对照本地 123 提交是否已有等效实现。已排除:b0a593a「补回 --no-open」——本地 dsh-desktop/lib/server.ts:167 已有等效 --no-open,不计。

### BUG-H-001

- 文件: 上游提交 646b899 + 6d094d8(菜单外链打开与日志导出修复)
- 问题: 上游把 Windows Tauri 客户端菜单外链打开改用 ShellExecuteW、日志导出改为 Node 直接生成 ZIP(含中文/空格路径回归测试)。本地未合并:外链仍走 `cmd /d /s /c start`(main.rs open_native_target,已知存在 fallback 失败模式,#251 即为此修),日志导出见 BUG-G-101 恒失败。
- 成因: 未合并上游修复;本地 cmd start 实现对引号标题陷阱做了防护,残余风险待实测。
- 严重度: M
- 状态: 待复查(cmd start 残余失败模式需实机验证)

### BUG-H-002（✅ 已修复 2026-08-30：上游 healCredentialsVersion 最终形态（含 #256 version:"1" 兼容）移植进 lib/server.ts，startServer 拉起内核前自愈；升级后启动卡死/必死两形态覆盖）

- 文件: 上游提交 25a8ccc + 5d89422(凭据库迁移修复)
- 问题: 上游标注「删除反向版式迁移——**升级后启动卡死元凶**」「0.1.2 全新建凭据库写读不对称自愈——version 引号化致**启动必死**」。本地凭据链路经 123 提交重构(dsh-desktop/lib 已无 credential 模块名),若未等效实现这两处自愈,升级用户会遭遇启动卡死/必死——这是"窗口有问题"最严重的潜在形态(根本到不了窗口)。
- 成因: 未合并上游修复;本地凭据实现待对照。
- 严重度: S(若确认缺失)
- 状态: 待复查(需对照本地凭据库读写与迁移代码)

### BUG-H-003

- 文件: 上游提交 05ddcba(#244:任务栏 Big 图标 WM_SETICON + 主窗首启尺寸自适应与坏状态防御)
- 问题: 本地未合并:① 任务栏/Alt-Tab 无 Big 图标补齐(见 BUG-G-005);② 上游的「主窗首启尺寸自适应 + 坏窗口状态防御」未并入——本地窗口状态记忆是 123 提交里的自实现,且带 BUG-G-003 单位混用缺陷,两条实现路线分叉,本地版缺上游的坏状态防御经验。
- 成因: 未合并上游修复;双方各自实现了窗口尺寸策略,需要人工裁决合并方向。
- 严重度: M
- 状态: 待复查

### BUG-H-004

- 文件: 上游提交 94304f3 + 5c5c197(#251:fix-rust-shell-cmd-start-fallback)
- 问题: 上游修复 Rust 壳 cmd start 打开外链/文件的 fallback 失败(改 ShellExecuteW)。本地 open_native_target 仍是 cmd start 实现(带引号防护但未含该 PR 的失败场景修复)。
- 成因: 未合并上游修复;与 BUG-H-001 同一链路。
- 严重度: M
- 状态: 待复查

### BUG-H-005

- 文件: 上游提交 204f38a(#249:内置 dsh-raw-html 托管版并修复 Tauri 启动)
- 问题: 上游修复了 dsh-raw-html 插件托管形态下的 Tauri 启动问题。本地未合并;若本地插件清单含 dsh-raw-html,对应启动路径可能带已修复的旧缺陷。
- 成因: 未合并上游修复。
- 严重度: M
- 状态: 待复查(需确认本地是否内置 dsh-raw-html 及其版本)

### BUG-H-006

- 文件: 上游提交 f45f25b + a996d91(手机桥 5.2.0 重写 + 新建对话双滚动条根治等)
- 问题: ① 上游 5.2.0 把手机桥整体重写为「完整 Web UI 反向代理」并修 LAN 明网兼容/二维码渲染;本地手机桥仍是 5.1.1 旧版且带 **BUG-B-010 静态 cookie 认证绕过**(S 级)——上游重写版是否一并闭合该认证面,直接决定 B-010 的修复路线(合并上游 vs 本地修补)。② 新建对话双滚动条、悬停浮层横向溢出(97b4fb6)等 UI 根治未并入。
- 成因: 未合并上游修复;手机桥属于双方各自大改过的模块,合并需人工裁决。
- 严重度: M
- 状态: 待复查

### BUG-H-007

- 文件: 上游提交 0cfe010 + 5c27228 + 4078ab9 + a498b0f(#250:设置滚动修复误判)与 bd550cc(5.3.1 十二处真 bug 根治)
- 问题: ① 设置页滚动修复的关键词误判已在上游改为结构化检测并修齐测试夹具,本地若仍是旧关键词检测会有误判回归;② 5.3.1「十二处真 bug 根治 + 内核版本钉防漂移」是打包级修复集,本地未合并,具体清单需逐条对照(潜在叠加缺陷面)。
- 成因: 未合并上游修复。
- 严重度: C(①)/ M(②,伞条目)
- 状态: 待复查

---
