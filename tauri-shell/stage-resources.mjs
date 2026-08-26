'use strict';
// Tauri 打包资源装配（P4）：把运行所需的一切装进 staged-resources/，
// 供 tauri.conf.json 的 resources 映射进安装包。
//
// 布局（= main.rs resource_root() 的约定）：
//   staged-resources/sidecar/server.js|bridge.js|rescue-integration.js
//   staged-resources/dsh-desktop/<legacy-shell 时代的精确文件清单 + 生产 node_modules
//                              + assets + vendor/node + vendor/npm>
//
// 用法：node stage-resources.mjs [--skip-npm]（--skip-npm 复用上次 npm ci 产物）

import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dd = path.join(root, 'dsh-desktop');
const staged = path.join(root, 'tauri-shell', 'staged-resources');
const skipNpm = process.argv.includes('--skip-npm');

// 人工同步：新增根模块要加进来（legacy-shell 时代的 main.js / preload.js 已废弃，不再打包；
// wsl-backend.js 已随 refactor 删除，Task 0 起不再装配）。
const ROOT_FILES = [
  'updater.js', 'client-updater.js', 'logger.js', 'plugin-updater.js',
  'balance.js', 'session-watcher.js', 'session-encoding-heal.js', 'profile-module-heal.js',
  'patch-row-heal.js', 'builtin-collision.js', 'plugin-manager-state.js', 'plugin-guard.js',
  'rescue-agent.js', 'preset-sync.js', 'compact-preset-migrate.js', 'error-detail.js',
  'bundle-integrity.js', 'stable-port.js', 'stream-write-guard.js', 'koffi-preflight.js',
  'renderer-recovery.js', 'watchdog.js',
  'host-bootstrap.js',
];
const SCRIPTS = [
  'koffi-preflight.cjs', 'patch-session-manage.js', 'plugin-manager-patch.js',
  'onboarding.js', 'make-release-hashes.js', 'patch-deps.js',
];

// vnext 隔离体系（vnext-absorb Phase 2）：sidecar require 的 lib/{state,log,
// supervisor,extension-host,recovery-center} 编译产物 + 原生模块。
// host-ctx.js（Task 5.3）：sidecar 装配段 initHostCtx 的统一模块宿主上下文。
const LIB_VNEXT = [
  'state.js', 'log.js', 'host-ctx.js', 'proc.js', 'paths.js', 'server.js', 'server-lock.js',
  'boot.js', 'watchdog-boot.js', 'shortcuts.js', 'shortcut-maintenance.js', 'plugin-copy.js',
  'plugin-registry-data.js', 'plugins.js', 'plugin-manager-core.js', 'market-modules.js',
  'market-ops.js', 'preview.js', 'guard.js', 'balance-ui.js', 'bridge.js', 'migration.js',
  'onboarding.js', 'run-state.js', 'session-heal.js', 'terminal.js', 'tray.js',
  'update-flow.js', 'window.js', 'ipc/index.js', 'ipc/transport.js', 'ipc/sender.js',
  'ipc/app.js', 'ipc/recovery.js', 'ipc/plugin.js', 'ipc/onboard.js', 'ipc/session.js',
  'ipc/snapshot.js', 'snapshot/native.js', 'snapshot/paths.js', 'snapshot/manager.js',
  'snapshot/scheduler.js', 'supervisor/registry.js', 'supervisor/state-machine.js',
  'supervisor/installer.js', 'supervisor/permissions.js', 'supervisor/incidents.js',
  'extension-host/manager.js', 'extension-host/bridge-server.js',
  'extension-host/job-fence.js', 'extension-host/rpc.js', 'extension-host/sdk/index.js',
  'recovery-center/register-sidecar.js',
];
const NATIVE_MODULES = ['supervisor/index.node', 'snapshot/index.node'];
const SIDECAR_UI_FILES = ['snapshot-ui.js'];

function requireFile(file, label) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`[stage] 缺少${label || '文件'}: ${path.relative(root, file)}`);
  }
}

function copyRequired(src, dest, label) {
  requireFile(src, label);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest);
}

function pluginEntrypoints(pkg) {
  const result = [];
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) result.push(value.replace(/^\.\//, ''));
  };
  add(pkg.main);
  add(pkg.module);
  if (typeof pkg.exports === 'string') add(pkg.exports);
  else if (pkg.exports && typeof pkg.exports === 'object') {
    const walk = (value) => {
      if (typeof value === 'string') add(value);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(pkg.exports);
  }
  return [...new Set(result)].filter((entry) => !entry.includes('*') && !/\.d\.(?:ts|mts|cts)$/i.test(entry));
}

function validatePluginTree(dir, label) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const pluginDir = path.join(dir, entry.name);
    const manifest = path.join(pluginDir, 'package.json');
    if (!existsSync(manifest)) {
      throw new Error(`[stage] ${label}插件目录没有 package.json: ${path.relative(root, pluginDir)}`);
    }
    let pkg;
    try { pkg = JSON.parse(readFileSync(manifest, 'utf8')); }
    catch (err) { throw new Error(`[stage] ${label}插件 manifest 无法解析: ${path.relative(root, manifest)} (${err.message})`); }
    const points = pluginEntrypoints(pkg);
    if (points.length === 0) throw new Error(`[stage] ${label}插件没有可校验入口: ${path.relative(root, manifest)}`);
    for (const rel of points) requireFile(path.join(pluginDir, rel), `${label}插件入口`);
  }
}

console.log('[stage] 清理旧装配目录' + (skipNpm ? '（--skip-npm：保留上次的生产 node_modules）' : ''));
// 注意：node_modules 必须在整树清空前判定并豁免，否则 --skip-npm 永远不生效
// （先 rm 全目录再 existsSync 检查，检查对象必不存在）。
const stagedNm = path.join(staged, 'dsh-desktop', 'node_modules');
const keepStagedNm = skipNpm && existsSync(stagedNm);
rmSync(path.join(staged, 'sidecar'), { recursive: true, force: true });
if (keepStagedNm) {
  for (const entry of readdirSync(path.join(staged, 'dsh-desktop'))) {
    if (entry === 'node_modules') continue;
    rmSync(path.join(staged, 'dsh-desktop', entry), { recursive: true, force: true });
  }
} else {
  rmSync(staged, { recursive: true, force: true });
}
mkdirSync(path.join(staged, 'sidecar'), { recursive: true });
mkdirSync(path.join(staged, 'dsh-desktop'), { recursive: true });

console.log('[stage] 编译 TypeScript（tsc 就地产物）');
execSync('npx tsc -p tsconfig.json', { cwd: dd, stdio: 'inherit' });

console.log('[stage] sidecar 产物');
for (const f of ['server.js', 'bridge.js', 'ping.js', 'rescue-integration.js', 'ipc-surface.js']) {
  cpSync(path.join(root, 'tauri-shell', 'sidecar', f), path.join(staged, 'sidecar', f));
}

console.log('[stage] dsh-desktop 根模块 + 统一 lib + scripts + package.json');
for (const f of ROOT_FILES) {
  const src = path.join(dd, f);
  copyRequired(src, path.join(staged, 'dsh-desktop', f), '根模块');
}
console.log('[stage] 统一 lib 隔离体系（lib 模块 + shared 协议 + 原生 .node）');
for (const f of LIB_VNEXT) {
  copyRequired(path.join(dd, 'lib', f), path.join(staged, 'dsh-desktop', 'lib', f), 'vnext 库');
}
for (const f of SIDECAR_UI_FILES) {
  copyRequired(path.join(root, 'tauri-shell', 'sidecar', f), path.join(staged, 'sidecar', f), 'sidecar 面板');
}
// shared/protocol.js：隔离体系单点协议源，extension-host/rpc.js 运行时 require
// （../../shared/protocol.js）——漏装配会让 sidecar 启动即 MODULE_NOT_FOUND。
copyRequired(path.join(dd, 'shared', 'protocol.js'), path.join(staged, 'dsh-desktop', 'shared', 'protocol.js'), '共享协议');
mkdirSync(path.join(staged, 'dsh-desktop', 'native'), { recursive: true });
for (const f of NATIVE_MODULES) {
  copyRequired(path.join(dd, 'native', f), path.join(staged, 'dsh-desktop', 'native', f), '原生模块');
}
mkdirSync(path.join(staged, 'dsh-desktop', 'scripts'), { recursive: true });
for (const f of SCRIPTS) {
  copyRequired(path.join(dd, 'scripts', f), path.join(staged, 'dsh-desktop', 'scripts', f), '脚本');
}
// package.json + lock 原样拷贝（npm ci 要求两者一致；--omit=dev 只装生产树）。
// .npmrc（legacy-peer-deps）必须随行：内核包互相声明 peer，staged 目录里的
// npm ci 若不带该配置会因 lock 缺 peer 闭包直接 EUSAGE 拒装（全新打包必踩）。
copyRequired(path.join(dd, 'package.json'), path.join(staged, 'dsh-desktop', 'package.json'), 'package.json');
copyRequired(path.join(dd, 'package-lock.json'), path.join(staged, 'dsh-desktop', 'package-lock.json'), 'package-lock.json');
copyRequired(path.join(dd, '.npmrc'), path.join(staged, 'dsh-desktop', '.npmrc'), '.npmrc');

console.log('[stage] assets（114MB：38 插件 + 10 皮肤 + 图标）');
cpSync(path.join(dd, 'assets'), path.join(staged, 'dsh-desktop', 'assets'), { recursive: true });
validatePluginTree(path.join(dd, 'assets', 'plugins'), '源');
validatePluginTree(path.join(staged, 'dsh-desktop', 'assets', 'plugins'), 'staging');

console.log('[stage] vendor node/npm 运行时');
mkdirSync(path.join(staged, 'dsh-desktop', 'vendor'), { recursive: true });
cpSync(path.join(dd, 'vendor', 'node'), path.join(staged, 'dsh-desktop', 'vendor', 'node'), { recursive: true });
if (existsSync(path.join(dd, 'vendor', 'npm'))) {
  cpSync(path.join(dd, 'vendor', 'npm'), path.join(staged, 'dsh-desktop', 'vendor', 'npm'), { recursive: true });
}

console.log('[stage] 生产 node_modules（npm ci --omit=dev，首次较慢）');
const nmDest = path.join(staged, 'dsh-desktop', 'node_modules');
if (!keepStagedNm) {
  execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: path.join(staged, 'dsh-desktop'), stdio: 'inherit' });
}

// dsh-desktop 锚点补丁（patch-deps：可选升级字段 / picker 退出码 / 设置左栏滚动）——
// npm ci 从 registry 全新安装会还原成未打补丁的内核文件，必须在 staged 树上重放。
// 脚本幂等：npm ci 的 postinstall（patch-deps.js 已随 SCRIPTS 入 staged）若已应用则直接跳过。
console.log('[stage] 重放 dsh-desktop 锚点补丁（patch-deps）');
execSync('node scripts/patch-deps.js', { cwd: path.join(staged, 'dsh-desktop'), stdio: 'inherit' });

// 上游修复的 vendored 覆盖（bash 输出折叠，PR #181）——npm ci 会还原成
// registry 版本，把仓库内的修复副本盖回去。
// （dsh-subprocess-local 的 pwsh 超时 vendored 修复已废弃：0.1.1-rc.2 上游以
//  Promise.race(done, delay(graceMs)) 原生实现同类兜底，随 registry 版本走。）
const vendoredBashFix = path.join(dd, 'node_modules', '@deepseek-ai', 'dsh-tool-bash', 'lib', 'index.js');
if (existsSync(vendoredBashFix)) {
  cpSync(vendoredBashFix, path.join(nmDest, '@deepseek-ai', 'dsh-tool-bash', 'lib', 'index.js'));
  console.log('[stage] 已回填 dsh-tool-bash 的 vendored 修复');
}

console.log('[stage] 完成：' + staged);
