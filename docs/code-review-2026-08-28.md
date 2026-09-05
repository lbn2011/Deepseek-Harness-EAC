# 代码审查报告：性能与安全隐患

- **审查日期**：2026-08-28
- **审查范围**：自研核心源码 44,802 行 TS + 2,174 行 Rust
  - `dsh-desktop/`（根目录 `*.ts`、`lib/`、`scripts/`、`shared/`）
  - `tauri-shell/src/*.rs`、`tauri-shell/sidecar/*.ts`
- **排除**：`node_modules/`、`assets/plugins|skins/`（第三方皮肤与插件）、`tmp-p2boot/`、`*.js`（tsc 编译产物）
- **方法**：全量模式扫描定位 → 并行分链路精读 → 人工复核关键结论
- **可信度标注**：`✔` = 已人工读码复核；`○` = 工具/代理初筛，建议修复前再确认行号

---

## 一、P0 严重（建议立即修复）

### 1. `✔` WebSocket 桥零鉴权 → 任意本地网页可操控外壳（CSWSH）

**`tauri-shell/src/main.rs:1099`**

```rust
let ws = tokio_tungstenite::accept_async(stream).await  // 无任何校验
```

`handle_conn` 仅 peek 判断是否为 upgrade 请求，随后直接 `accept_async`。**没有校验 `Origin`、没有校验 `Host`、没有 token**。

- **影响**：任意本地网页（含用户在浏览器里打开的恶意站点、钓鱼邮件里的 HTML 附件）执行
  `new WebSocket("ws://127.0.0.1:19873")` 即可连入，进而调用全部壳层方法：`win.*`、
  `files.open`、`clipboard`，并透传给 sidecar 的 `boot.restart`、`plugins.*`、`rc.action`、
  `rescue.*`。这是**本地代码执行面的完全暴露**。WebSocket 不受同源策略约束，浏览器不会拦截。
- **修复**：升级前校验 `Origin` 必须为空或 `127.0.0.1/localhost:19873`；发放一次性随机 token，
  由桥在握手时携带（query 或 subprotocol）；非匹配直接 403。

---

### 2. `✔` 浮窗与恢复中心窗口缺失导航围栏 → 桥接能力泄露给外部页面

**`tauri-shell/src/main.rs:1020`（浮窗）、`:1069`（恢复中心）**

导航围栏只在主窗挂载：

```
1728:  .on_navigation(is_allowed_main_navigation)   ← 仅主窗
```

两个子窗口的 builder 链中**均无 `.on_navigation`**：

- 浮窗 `open_float_window`：`main.rs:1008-1014` 通过 `initialization_script` 注入完整 `BRIDGE_JS`
  （含 `window.dshDesktop._call`），但 `1020` 未加围栏。
- 恢复中心：`1069` 未加围栏；桥接能力经 `recovery_center_page()`（`main.rs:1351`）以页面内
  `<script>` 注入 `window.__DSH_BRIDGE_WS__` + preload 的形式下发。

- **影响**：任一子窗口内的页面一旦导航（或被诱导跳转）到外部 URL，外部页面即持有
  `window.dshDesktop._call`，可回连本地 WS。**与问题 1 链式组合 = 远程控机**。
- **修复**：给所有 `WebviewWindowBuilder` 挂同一 `is_allowed_main_navigation`；建议抽成
  `fn guarded_builder(...)` 统一入口，避免后续新增窗口再次遗漏。

---

### 3. `✔` 手机桥：固定会话 Cookie + 绑定 0.0.0.0 → 局域网未授权访问

**`tauri-shell/sidecar/phone-bridge.ts:274`、`:284`、`:355`**

```ts
headers['set-cookie'] = `dsh_mobile=1; Path=/; HttpOnly; SameSite=Strict; Max-Age=...`;  // 274
if (!cookies.some((c) => c === 'dsh_mobile=1')) { json(res, 401, ...); return; }        // 284
s.listen(0, '0.0.0.0', ...)                                                              // 355
```

配对 token 只用于**换取**会话 cookie，而 cookie 本身是**硬编码常量 `dsh_mobile=1`**。
`SameSite=Strict` 只防浏览器跨站，防不住 `curl`。

- **影响**：任何能连通该 LAN 端口的主机，只需发 `Cookie: dsh_mobile=1` 即通过鉴权，
  调用 `RPC_ALLOWLIST` 全部方法（含 `session.prompt`）——**未授权驱动 agent 读写工作区**。
  家庭/公司/公共 WiFi 下等同于把会话控制权开放给同网段。
- **修复**：cookie 值改为 `randomBytes(32).toString('hex')` 服务端保存；默认绑定 `127.0.0.1`，
  跨设备访问走显式授权 + 反向隧道。

---

### 4. `✔` 纯文本日志通道零脱敏 → 凭据明文落盘并外送 AI

**`dsh-desktop/lib/log.ts:65`** → **`rescue-agent.ts:37`、`:175`**

```ts
// 通道 1：desktop.log 纯文本
if (state.desktopLog) state.desktopLog.write(line);   // log.ts:65 —— 不经任何脱敏
```

结构化通道是脱敏的（`lib/logger/api.ts:332` 挂了 `RedactTransform({ redactLevel: 'deep' })`），
**但纯文本通道整条绕过**。函数注释（log.ts:50）写"结构化通道会做 PII 脱敏"，说明作者
有意做脱敏，纯文本通道是遗漏。

链条放大：`rescue-agent.ts:37` 定义 `LOG_TAIL_BYTES = 48 * 1024`，`:175` 把 `desktop.log`
尾部 48KB 作为诊断上下文**直送 DeepSeek API**，且 `sendManifest` 默认全勾选。

- **影响**：日志里出现的 API key / token / Authorization 头明文落盘，并在用户点击"一键诊断"时
  上传到第三方 API。
- **修复**：`log.ts:65` 写入前套 `_valueMasked(line)`（最低成本）；诊断上下文发送前强制过一遍
  deep redact；默认勾选改为用户显式确认。

---

### 5. `✔` 更新包：无独立信任锚 + 安装前 TOCTOU

**`dsh-desktop/lib/client-update/download.ts:388-404`、`apply.ts:239`**

```ts
if (expected) { /* SHA-256 强校验 */ }
else {
  ctx.log('client-update', '上游未提供哈希…，跳过内容校验（大小校验兜底）');   // 400
  if (sel.totalSize > 0 && Math.abs(stat.size - sel.totalSize) > 2*1024*1024) {
    ctx.log(..., '（继续，安装器会自校验）');   // 402 —— 仍继续
  }
}
```

三重问题叠加：

1. **无哈希即放行**：`expected` 为 null 时只过 64MB 下限，直接放行到 `apply.ts:239` 执行安装器；
   第 402 行的大小偏差也只打日志、`继续`。
2. **哈希与下载目标同源**：digest 来自同一份 release JSON，`SHA256SUMS.txt` 也来自同一 release 资产
   ——同源即无独立信任锚，控制 `DSH_DESKTOP_RELEASE_API` 或镜像即可同时伪造文件与哈希。
3. **TOCTOU**：下载时校验，`offerPendingClientUpdate` 安装前仅 `existsSync` 不重算哈希；
   `pendingClientUpdate.path` 存于 settings.json 跨启动保留，文件位于用户可写目录。

- **影响**：攻击者投送无 digest 的恶意 exe，或同权限进程/恶意插件在安装前替换文件 →
  以用户权限执行任意程序。
- **修复**：① 无哈希时**中止**而非放行；② 内置发布者公钥，校验 Authenticode/签名；
  ③ 安装前重算 SHA-256 与 settings 记录值比对；④ 下载目录收紧 ACL。

---

### 6. `✔` AI 自报 risk 决定是否自动改盘 → 提示词注入即任意文件改写

**`dsh-desktop/rescue-agent.ts:572-578`**

```ts
for (const s of suggestions) {
  if (s && s.risk === 'high') { applied.push({ action: s.action, skipped: 'high-risk' }); continue; }
  const r = await safe(() => execute!(s));   // 其余全部无条件执行
}
```

`suggestions` 来自 AI 输出（`:568`），而 AI 的诊断上下文包含日志尾部与插件输出（**外部可控**）。
`risk` 字段本身由 AI 自报，`:375` 仅有白名单兜底。

- **影响**：攻击者在插件输出/日志中注入内容，诱导 AI 以 `risk: 'low'` 输出 `edit-file` /
  `remove` 动作，`applyProfileEdit`（`:533`）**无需用户确认直接改写磁盘**。
- **修复**：`risk` 由 action 类型**强制映射**（`restore` / `remove` / `edit-file` 恒判为 high），
  禁止 AI 自报；高危动作必须用户二次确认。

---

## 二、P1 中等

| # | 位置 | 问题 | 修复 |
|---|------|------|------|
| 7 | `○` `main.rs:370` | `resolve_node()` 最终回退裸 `node` / `node.exe` → PATH / 当前目录劫持 | 删除裸名回退，找不到内置 node 直接报错退出 |
| 8 | `○` `main.rs:1105` + `phone-bridge.ts:220` | `mpsc::unbounded_channel` 出站队列、请求体 `chunks.push` 无上限 → 内存打爆 | 改有界通道 + 1MB body 上限 |
| 9 | `○` `sidecar/server.ts:1188`、`:1231` | `mod.call` 逃生舱经无认证 WS 可达，白名单含 `proc` 等副作用模块 | 缩小白名单，禁止 `proc`；或仅本地 stdio 面可调用 |
| 10 | `○` `sidecar/rescue-integration.ts:201-205` | `edit-file` 的 `readFile/writeFile` 无路径白名单，配合问题 1 可任意读写 | ctx 内限定 profileDir 并拒绝 `..` |
| 11 | `○` `tauri.conf.json:10` | `csp: null` 全站禁用 CSP，且 HTTP 响应仅有 Content-Type/Length → XSS 即可取桥全权 | `http_serve` 补 CSP / `X-Frame-Options` / `X-Content-Type-Options` |
| 12 | `○` `lib/extension-host/bridge-server.ts:40-56` | bridge token 经环境变量注入子进程，同用户任意进程可读环境 → 插件隔离边界被绕过 | 改 stdio / 命名管道握手下发 token |
| 13 | `○` `lib/ipc/session.ts:161` | `content.replace(newText, oldText)` 把 oldText 当替换串，`$&` / `` $` `` 被展开 → 文件内容被污染 | `content.replace(newText, () => oldText)` |
| 14 | `○` `lib/feature-pack.ts:618-627` | 解压无预算（zip bomb），且仅过滤字面 `..` 段，**未做 `path.relative` 前缀校验** | 加解压字节/条目上限 + resolve 后前缀断言 |
| 15 | `○` `lib/feature-pack.ts:694-716` | pack.json（外部内容）可声明任意 npm/github 包并自动 `dsh plugin add` | 包名白名单 + 二次确认 |
| 16 | `○` `lib/migration.ts:101-103` | `builtinNames` 取自可篡改的 JSON，未校验即 `rmSync(recursive, force)` → `../` 可递归删除任意目录 | 校验包名正则 + 解析后必须位于 `node_modules` 下 |
| 17 | `○` `lib/logger/redact.ts:445` | `_flush` 在 deep 模式下把残余 `_buf` **原样 push**（未脱敏）→ 末行/超长行分片尾部明文 | 补 `JSON.parse + deepRedact` 兜底 |
| 18 | `○` `lib/logger/redact.ts:101-102`、`:159` | 前缀规则大小写敏感（`Bearer ` 不匹配）；手机号/邮箱要求字符连续 → `138 0013 8000` 漏网 | 加 `i` 标志；允许 `+86`/空格/连字符 |
| 19 | `○` `lib/client-update/net.ts:17`、`:22` | 跟随 3xx 不校验协议 → https 可降级到 http，且 headers 透传给新主机 | 重定向目标强制 https |
| 20 | `○` `lib/client-update/download.ts:26`、`:50-65` | 硬编码第三方代理 `gh.geekertao.top` 且**优先于**原地址 | 代理降为兜底，或仅在 digest 存在时启用 |
| 21 | `○` `lib/client-update/download.ts:381` | 无下载大小上限，只校验下限 → 撑爆磁盘 | 按 `sel.totalSize` 累计并在 `data` 事件中止 |
| 22 | `○` `lib/market-ops.ts:68-227` | 市场任务 target 无白名单即作 argv；pnpm 拦截构建脚本后**自动**写 allowBuilds 重试 | target 加包名/URL 正则白名单并拒绝 `-` 开头；allowBuilds 需用户确认 |
| 23 | `○` `rescue-agent.ts:674`、`:687` | `DEEPSEEK_API_BASE` 允许 `http://`，`Authorization: Bearer` 明文外发 | 非 localhost 强制 https |

---

## 三、P2 低（记录，排期处理）

- `main.rs:743` / `sidecar/server.ts:640` — `files.open` 分支直进 `cmd /c start ""` 插值 → 改 `execFile`/`ShellExecuteW` 参数数组
- `main.rs:1363`、`:461` — 每请求 `eprintln!` 无采样；`pending` 表超时不清理 → 日志无界 + HashMap 泄漏
- `main.rs:275`、`:238` — `Resized`/`Moved` 事件里同步 `fs::write`（800ms 节流但仍阻塞 UI 线程）→ `spawn_blocking`
- `lib/feature-pack.ts:496`、`:1121` — 临时文件名可预测（`.tmp` / `.tmp-<pid>`）→ `fs.mkdtemp` + `O_EXCL`
- `lib/feature-pack.ts:622` — 未拦截 NTFS 交替数据流（`a.txt:evil.exe`）→ 拒绝含 `:` 的 entry
- `lib/extension-host/bridge-server.ts:108` — token 用 `!==` 比较 → `crypto.timingSafeEqual`
- `lib/extension-host/bridge-server.ts:58-60` — `close()` 未 `closeAllConnections()` → 保活连接拖延退出
- `lib/ipc/session.ts:136`、`:194` — 路径白名单未 realpath 解析符号链接 → 校验前 `realpathSync`
- `lib/client-update/download.ts:76` — 临时文件名可预测 → `mkdtemp`
- `lib/client-update/apply.ts:148` — bat 内联变量仅转义 `%`，未处理 `"`
- `lib/plugin-updater.ts:352-357` — `copyTree` 跟随符号链接 → 用 `lstat` 判定并跳过
- `rescue-agent.ts:537` — `backupTaken: true` 无条件返回（未真正备份也谎报）→ 按实际调用置位
- `lib/logger/diagnostics.ts:135`、`:148` — YAML 仅浅掩码，自定义密钥字段残留 → 转 JSON 后 deepRedact
- `lib/renderer-recovery/machine.ts:137-166` — `attach` 无幂等守卫 → 重复注册监听器
- `lib/logger/redact.ts:295`、`:388` — Buffer 仅取前 2048 字节脱敏；`_buf` 无长度上限

---

## 四、性能专项

| # | 位置 | 问题 | 修复 |
|---|------|------|------|
| P1 | `✔` `session-watcher.ts:160`+`:177`+`:221` | **每 2 秒** `readdirSync` 递归全会话树，并对每个文件 `readFileSync` **整文件**进内存（zstd 会话可达数十 MB）；`files` Map 只增不删（`:151`、`:204`），长跑进程内存与遍历量单调增长 | 改 `fs.watch` 事件驱动 + `fs.read(fd, offset)` 增量读；按 mtime 淘汰 Map 条目 |
| P2 | `○` `sidecar/server.ts:1072-1085`、`:706/716` | `pluginDirSize` 同步递归 `readdirSync/statSync`；`balance.models` 在**逐行循环内** `new RegExp` → sidecar 事件循环阻塞，所有 RPC 一起停摆 | 改 `fs.promises`；正则循环外预编译 |
| P3 | `○` `lib/ipc/session.ts:141-168` | `dsh:file-revert` 对最多 300 个、每个 ≤400KB 的文件做**全同步**循环 → 单次调用最多同步读写 120MB，主进程长时间冻结，心跳超时触发误恢复 | 改 `fs.promises` 或分批 `setImmediate` 让出 |
| P4 | `○` `lib/server.ts:469`、`:509`、`:146` | 先 `readFileSync` 整个 dsh-web.log 再 `.slice(-40000)`；日志流以 `'a'` 追加**从不轮转** → 文件无界增长 | 按 size 读尾部 64KB；日志按大小轮转 |
| P5 | `○` `lib/bundle-integrity.ts:110`、`:46-59` | 启动时对清单中每个包同步递归遍历 node_modules（数千包） | 改异步遍历或仅按包抽样校验 |
| P6 | `○` `lib/plugin-copy.ts:248-252`、`:292-299` | 同步整树拷贝（单包资产自述 58MB）→ 启动/更新时界面冻结 | 改 `fs.promises.cp` 或分批让出 |
| P7 | `○` `lib/logger/redact.ts:207-252` | 每个字符串跑 **24 个前缀正则 + 9 个值正则**，且 `:248` 先 `match` 再 `replace`（双倍全文扫描） | 合并为单遍扫描，去掉 match 预检 |
| P8 | `○` `lib/ipc/app.ts:36-38`、`:43/130` | `chrome:init` 每次同步读整张 icon.png + base64；`chrome:menu` 至少两次 `loadSettings()`（每次同步读盘 + JSON.parse） | 进程内缓存 data URI；设置加内存缓存，写后失效 |
| P9 | `○` `lib/server.ts:59-60` | 每次 `childEnv()` 同步读 settings.yaml 并用正则全文匹配，超长空白段 O(n²) 回溯 | 缓存判定结果、限制读取长度 |
| P10 | `○` `updater.ts:296-302` | `stdoutBuf/stderrBuf` 无上限累积 npm `--loglevel=info` 全部输出（可达数十 MB） | 只保留尾部若干 KB |

---

## 五、修复路线图（按投入产出排序）

**第一批（本周，阻断发布）**——都是改动量小、收益极大的修复：

1. `main.rs:1099` 加 Origin/Host 校验 + 一次性 token —— **约 20 行**，消除最大的本地 RCE 面
2. `main.rs:1020` / `:1069` 补 `.on_navigation`，抽 `guarded_builder` 统一入口 —— **约 10 行**
3. `phone-bridge.ts:274` cookie 改随机值 + `:355` 绑定 127.0.0.1 —— **约 5 行**
4. `log.ts:65` 写入前套 `_valueMasked` —— **1 行**，止血凭据明文落盘
5. `download.ts:399-404` 无哈希时**中止**而非放行 —— **约 5 行**
6. `rescue-agent.ts:572-578` risk 改由 action 强制映射 —— **约 10 行**

**第二批（本迭代）**：P1 表格中 7-23 项，重点是 #17/#18 脱敏绕过、#14 解压预算、#16 递归删除校验。

**第三批（性能）**：P1（session-watcher 改事件驱动）与 P3、P4 收益最高，直接消除界面冻结与内存单调增长。

---

## 六、已排查但未发现问题（避免过度恐慌）

以下常见高危项经确认**不存在**，无需投入：

- **绑定 0.0.0.0 的本地主服务**：`lib/server.ts:165-166`、`bridge-server.ts:47`、
  `stable-port.ts:70/78` 均显式 `127.0.0.1`（唯一例外是上文 P0-3 的 phone-bridge）
- **硬编码 / 可预测 token**：`bridge-server.ts:39` 用 `crypto.randomBytes(24)`，且未写入日志
- **字面 Zip Slip 已挡**：`feature-pack.ts` 已过滤 `..` 段（残留风险是未做前缀断言 + 无解压预算，见 P1-14）
- **npm 安装脚本执行**：`updater.ts:454`、`plugin-updater.ts:437` 均带 `--ignore-scripts`
  （风险集中在 `market-ops` 的 pnpm 链路，见 P1-22）
- **ReDoS 灾难性回溯**：`redact.ts` 各值正则量词均有界（`{0,6000}`、固定 `{3}`、互斥分支）
- **shell 命令拼接**：`feature-pack.ts:566` 用 `spawn` 数组参数、无 `shell: true`
- **全局可写权限 / 0777**：全部使用 `writeFileSync` 默认权限
- **Rust `unsafe` 块**：项目中不存在；`unwrap/expect` 仅出现在启动期与测试中
- **忙等轮询（Rust 侧）**：无 `loop + sleep`，均为事件驱动
- **泄露的定时器 / 监听器**：`renderer-recovery/machine.ts` 与 `watchdog.ts` 的
  `destroyed` 事件与 `stop()` 均有清理
- **AI 生成内容当代码执行**：js-yaml 为 4.3.1，`load` 默认安全模式；skills 仅落盘 `SKILL.md`

---

## 七、过程说明

- 审查采用「模式扫描 → 并行分链路精读 → 人工复核」三段式：先全量 grep 高危 API 定位，
  再派 4 个审查代理分别精读【本地服务/IPC】【更新下载解压】【Rust 外壳/sidecar】
  【自愈/日志脱敏】四条链路，最后由人工逐条读码复核 P0 结论。
- **已修正 1 处代理误报**：恢复中心窗口的桥接能力并非经 builder 的 `initialization_script`
  注入，而是经 `recovery_center_page()`（`main.rs:1351`）页面内 `<script>` 注入；
  核心结论（缺导航围栏、桥接能力外泄）仍然成立。
- 标注 `○` 的条目来自代理初筛，修复前建议再确认一次行号（代码可能在审查期间变动）。
