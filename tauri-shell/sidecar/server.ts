'use strict';

// L2 Node sidecar 实体化（ADR 0002；T3-a 第二阶段）。
// 职责：
//   1. stdio 行分隔 JSON-RPC 分发器（协议与 ping.js 一致，Rust L1 唯一对话面）
//   2. 挂载 dsh-desktop/lib/* 统一模块（ctx 注入按宿主语义提供）
//   3. 白名单方法注册表 + mod.call 通用逃生舱（白名单模块内具名导出直调）
//
// 纪律：stdout 只走协议帧；一切日志/兜底输出走 stderr。

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import * as readline from 'node:readline';
import type { HostCtx, HostShortcutLink } from '../../dsh-desktop/lib/host-ctx.js';
import { createSidecarIpcSurface } from './ipc-surface.js';
import * as rescueIntegration from './rescue-integration.js';

// 资源根：开发态 tauri-shell/sidecar → 仓库根/dsh-desktop；
// 打包态 resources/sidecar → resources/dsh-desktop（少一级）。
function resolveDesktopRoot(): string {
  const upTwo = path.resolve(__dirname, '..', '..', 'dsh-desktop');
  if (fs.existsSync(path.join(upTwo, 'package.json'))) return upTwo;
  const upOne = path.resolve(__dirname, '..', 'dsh-desktop');
  if (fs.existsSync(path.join(upOne, 'package.json'))) return upOne;
  return upTwo;
}
const DSH_DESKTOP_ROOT = process.env.DSH_RESOURCE_ROOT
  ? path.join(process.env.DSH_RESOURCE_ROOT, 'dsh-desktop')
  : resolveDesktopRoot();
function say(s: string): void { process.stderr.write('[sidecar] ' + s + '\n'); }

// ---- 业务模块动态加载 ------------------------------------------------
// 打包态 sidecar/ 与 dsh-desktop/ 同级（安装根或 resources/ 下），静态相对
// 路径 `../../dsh-desktop` 只对开发态（tauri-shell/sidecar → 仓库根）成立；
// 统一经 DSH_DESKTOP_ROOT 运行时解析，保证任意布局下加载一致（并与其他
// 模块共享 require 缓存，state 等单例不被复制）。
const load = <T,>(m: string): T => require(path.join(DSH_DESKTOP_ROOT, 'lib', m)) as T;
const { initHostCtx } = load<typeof import('../../dsh-desktop/lib/host-ctx.js')>('host-ctx.js');
const { state, initVNextState } = load<typeof import('../../dsh-desktop/lib/state.js')>('state.js');
const { setLogSink } = load<typeof import('../../dsh-desktop/lib/log.js')>('log.js');
const { bridge } = load<typeof import('../../dsh-desktop/lib/bridge.js')>('bridge.js');
const procMod = load<typeof import('../../dsh-desktop/lib/proc.js')>('proc.js');
const pathsMod = load<typeof import('../../dsh-desktop/lib/paths.js')>('paths.js');
const serverMod = load<typeof import('../../dsh-desktop/lib/server.js')>('server.js');
const guardBoxMod = load<typeof import('../../dsh-desktop/lib/guard.js')>('guard.js');
const runtimePatchesMod = load<typeof import('../../dsh-desktop/lib/session-heal.js')>('session-heal.js');
const companionSyncMod = load<typeof import('../../dsh-desktop/lib/plugins.js')>('plugins.js');
const { COMPANION_PLUGINS, pluginUpdateSources } = load<typeof import('../../dsh-desktop/lib/plugin-registry-data.js')>('plugin-registry-data.js');
const { copyPluginPackage } = load<typeof import('../../dsh-desktop/lib/plugin-copy.js')>('plugin-copy.js');
const pluginOpsMod = load<typeof import('../../dsh-desktop/lib/plugin-manager-core.js')>('plugin-manager-core.js');
const marketMod = load<typeof import('../../dsh-desktop/lib/market-ops.js')>('market-ops.js');
const shortcutsMod = load<typeof import('../../dsh-desktop/lib/shortcuts.js')>('shortcuts.js');
const junctionPatrolMod = load<typeof import('../../dsh-desktop/lib/watchdog-boot.js')>('watchdog-boot.js');
const clientUpdateMod = load<typeof import('../../dsh-desktop/lib/update-flow.js')>('update-flow.js');
const hotUpdateMod = load<typeof import('../../dsh-desktop/lib/hot-update/index.js')>('hot-update/index.js');
const previewMod = load<typeof import('../../dsh-desktop/lib/preview.js')>('preview.js');
const fileRootsMod = load<typeof import('../../dsh-desktop/lib/paths.js')>('paths.js');
const recoveryCenter = load<typeof import('../../dsh-desktop/lib/recovery-center/register-sidecar.js')>('recovery-center/register-sidecar.js');
const extHost = load<typeof import('../../dsh-desktop/lib/extension-host/manager.js')>('extension-host/manager.js');
const bridgeServer = load<typeof import('../../dsh-desktop/lib/extension-host/bridge-server.js')>('extension-host/bridge-server.js');
const { registerIpc } = load<typeof import('../../dsh-desktop/lib/ipc/index.js')>('ipc/index.js');
const { setDefaultIpcSurface } = load<typeof import('../../dsh-desktop/lib/ipc/transport.js')>('ipc/transport.js');
const { createDesktopPlatform } = load<typeof import('../../dsh-desktop/lib/platform.js')>('platform.js');

// ---- 宿主语义（对齐 legacy-shell main.js 的注入值） --------------------------
const APP_NAME = 'Deepseek Harness EAC';
// 平台感知的应用数据目录：Windows 用 APPDATA 布局，Linux/macOS 用 XDG 布局。
// 硬编码 AppData/Roaming 会让 Linux 容器（L3 冒烟）把 userDataDir 算成
// /root/AppData/Roaming/...（不存在）→ spawn 内核 cwd 无效 → ENOENT。
const IS_WIN_HOST = process.platform === 'win32';
const appDataDir = IS_WIN_HOST
  ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const userDataDir = path.join(appDataDir, APP_NAME);
// 确保 userDataDir 存在（settings.json / dsh-web.log / spawn 内核的 cwd
// 都依赖它；Linux 容器全新环境无该目录，缺了 saveSettings ENOENT 且
// spawn cwd 无效 → ENOENT）。
try { fs.mkdirSync(userDataDir, { recursive: true }); } catch { /* 兜底忽略 */ }
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const log = (tag: string, msg: string): void => say('[' + tag + '] ' + msg);

// 桌面平台能力（上游 #219 移植）：Linux/macOS 用 XDG 布局 + 外链剪贴板探测，
// Windows 用 APPDATA 布局；shell.info 据此暴露 userDataDir / capabilities。
const desktopPlatform = createDesktopPlatform();

let pkgVersion = '0.0.0';
try {
  pkgVersion = JSON.parse(fs.readFileSync(path.join(DSH_DESKTOP_ROOT, 'package.json'), 'utf8')).version || pkgVersion;
} catch { /* 保持缺省 */ }

type Mod = Record<string, unknown>;

const MOUNTED = [
  'state', 'log', 'host-ctx', 'proc', 'paths', 'server', 'boot', 'watchdog-boot',
  'shortcuts', 'plugin-copy', 'plugins', 'plugin-manager-core', 'market-modules',
  'market-ops', 'preview', 'guard', 'balance-ui', 'bridge', 'migration', 'onboarding',
  'run-state', 'session-heal', 'terminal', 'tray', 'update-flow', 'hot-update', 'window', 'ipc/index',
  'snapshot/manager', 'snapshot/scheduler', 'supervisor/registry',
  'supervisor/state-machine', 'supervisor/installer', 'supervisor/permissions',
  'supervisor/incidents', 'extension-host/manager', 'extension-host/bridge-server',
  'extension-host/job-fence', 'recovery-center/register-sidecar',
];

// ---- ctx 注入（与 main.js 注入块逐项对齐；GUI 类能力走兜底/委托） --------
const profileMod = pathsMod;
const bootMod = {
  startAndWait: async (overlays: string[] = []) => {
    const webUrl = await serverMod.startAndShowGuarded(overlays);
    return { webUrl, port: Number(new URL(webUrl).port) };
  },
  stopServer: async () => {
    const current = state.serverProc;
    if (!current) return;
    procMod.killTree(current);
    state.serverProc = null;
    await procMod.waitForProcExit(current, 20000);
  },
  killAndWaitForRestart: async () => {
    const current = state.serverProc;
    if (!current) return;
    procMod.killTree(current);
    state.serverProc = null;
    await procMod.waitForProcExit(current, 20000);
  },
  setIsRestarting: (value: boolean) => { state.restartingServer = value; },
  state: () => ({ running: !!state.serverProc, webUrl: state.webUrl }),
};
const desktopProfileFn = pathsMod.desktopProfile;
const showBoxFallback = async (opts: Record<string, unknown>) => {
  say('[dialog] ' + String((opts && opts.title) || '') + ': ' + String((opts && opts.message) || ''));
  // 无头兜底答 cancelId（fail-closed）：绝不自动应答「立即更新/立即重启」，
  // 否则周期检查会无人值守地杀服务换 exe 退出（5.3.0 前的隐性自动更新）。
  // 纯提示框（['确定']）没有 cancelId 也不分支读 response，回 0 占位。
  const cancelId = opts && (opts.cancelId as number);
  return { response: Number.isInteger(cancelId) ? cancelId : 0 };
};
const notifyFallback = (n: { title: string; body: string }) => say('[notify] ' + n.title + ': ' + n.body);
// .lnk 驱动（硬门槛④）：PowerShell WScript.Shell COM 实现，接口对齐 legacy-shell
// shell.readShortcutLink / writeShortcutLink（异步、失败抛错）。路径经环境
// 变量传入，规避引号/空格/中文转义；读取返回的 IconLocation 剥掉 ',N' 索引。
// 用异步 execFile：sidecar 是单线程 JSON-RPC 服务，同步等待 8-10s 会停摆全部
// stdio RPC。
async function psLnkRead(p: string): Promise<Record<string, unknown>> {
  const script = String.raw`
$ErrorActionPreference='Stop'
try {
  $sh = New-Object -ComObject WScript.Shell
  $sc = $sh.CreateShortcut($env:DSH_LNK_PATH)
  $icon = [string]$sc.IconLocation
  if ($icon -match ',\s*\d+$') { $icon = $icon -replace ',\s*\d+$', '' }
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  @{ target = [string]$sc.TargetPath; args = [string]$sc.Arguments; cwd = [string]$sc.WorkingDirectory; description = [string]$sc.Description; icon = $icon } | ConvertTo-Json -Compress
} catch { exit 1 }
`;
  try {
    const out = await new Promise<string>((resolve, reject) => {
      cp.execFile('powershell', ['-NoProfile', '-Command', script], {
        env: { ...process.env, DSH_LNK_PATH: p },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000,
      }, (err, stdout) => {
        if (err) reject(err); else resolve(String(stdout));
      });
    });
    return JSON.parse(out) as Record<string, unknown>;
  } catch (e) {
    throw new Error('lnk read failed: ' + p + ' (' + String(((e as Error).message) || e).slice(0, 120) + ')');
  }
}

async function psLnkWrite(p: string, op: string, opts: Record<string, unknown>): Promise<void> {
  const script = String.raw`
$ErrorActionPreference='Stop'
$lnk = $env:DSH_LNK_PATH
if (($env:DSH_LNK_OP -eq 'create') -and (Test-Path -LiteralPath $lnk)) { exit 2 }
try {
  $sh = New-Object -ComObject WScript.Shell
  $sc = $sh.CreateShortcut($lnk)
  $sc.TargetPath = $env:DSH_LNK_TARGET
  if ($env:DSH_LNK_ARGS) { $sc.Arguments = $env:DSH_LNK_ARGS }
  if ($env:DSH_LNK_CWD) { $sc.WorkingDirectory = $env:DSH_LNK_CWD }
  if ($env:DSH_LNK_DESC) { $sc.Description = $env:DSH_LNK_DESC }
  if ($env:DSH_LNK_ICON) { $sc.IconLocation = $env:DSH_LNK_ICON }
  $sc.Save()
  exit 0
} catch { exit 1 }
`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_LNK_PATH: p,
    DSH_LNK_OP: String(op || 'replace'),
    DSH_LNK_TARGET: String(opts.target || ''),
    DSH_LNK_ARGS: opts.args == null ? '' : String(opts.args),
    DSH_LNK_CWD: opts.cwd == null ? '' : String(opts.cwd),
    DSH_LNK_DESC: opts.description == null ? '' : String(opts.description),
    DSH_LNK_ICON: opts.icon == null ? '' : String(opts.icon),
  };
  try {
    await new Promise<void>((resolve, reject) => {
      cp.execFile('powershell', ['-NoProfile', '-Command', script], {
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
      }, (err) => {
        if (err) reject(err); else resolve();
      });
    });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException & { code?: number | string }).code;
    throw new Error('lnk ' + String(op) + ' failed (' + String(code ?? '?') + '): ' + p);
  }
}

// ---- Task 5.3：统一模块宿主上下文注入（lib/host-ctx.js 的 sidecar 适配） ----
// lib/* 统一模块经 host-ctx 取宿主能力（Task 7 全量挂载后本注入即其在 Tauri
// 宿主下的唯一宿主面；现阶段传递加载的 state/log/recovery-center 等尚未消费
// host-ctx，提前装配保证双入口过渡期语义就位）。取值对齐上方过渡模块 init：
//   · 打包态判定＝DSH_RESOURCE_ROOT 显式指定，或 sidecar 旁 dsh-desktop 布局
//     （打包态 resources/sidecar + resources/dsh-desktop；开发态仓库根/dsh-desktop）
//   · GUI 类能力（消息框/通知）走 stderr 无头兜底；剪贴板/.lnk 复用 PowerShell 实现
const hostCtxMod = require(path.join(DSH_DESKTOP_ROOT, 'lib', 'host-ctx.js')) as {
  initHostCtx(d: HostCtx): void;
};
const HOST_IS_PACKAGED = !!process.env.DSH_RESOURCE_ROOT
  || !fs.existsSync(path.join(path.resolve(__dirname, '..', '..', 'dsh-desktop'), 'package.json'));
const HOST_RESOURCES_PATH = process.env.DSH_RESOURCE_ROOT
  || (HOST_IS_PACKAGED ? path.resolve(__dirname, '..') : '');
const hostPathOverrides: Record<string, string> = {};
hostCtxMod.initHostCtx({
  isPackaged: () => HOST_IS_PACKAGED,
  resourcesPath: () => HOST_RESOURCES_PATH,
  appVersion: () => pkgVersion,
  log,
  exitProcess: (code) => process.exit(code),
  // 优雅退出＝请壳走 ExitRequested 有界收口（同 client-update 交接通道，
  // 壳会同步有界关停 sidecar/dsh web，不在 sidecar 里直接 process.exit）。
  requestQuit: () => notify('shell.quit-for-update', {}),
  notify: (o) => say('[notify] ' + o.title + ': ' + o.body),
  copyToClipboard: (text) => { void writeClipboardText(text); },
  getPath: (name) => hostPathOverrides[name]
    || (name === 'appData' ? appDataDir : name === 'desktop' ? path.join(os.homedir(), 'Desktop') : userDataDir),
  setPath: (name, value) => { hostPathOverrides[name] = value; },
  removeAppMenu: () => { /* 无原生菜单概念：no-op */ },
  showMessageBox: (opts) => {
    // 无头兜底（对齐 host-ctx NODE_DEFAULT 语义）：内容走 stderr 可追溯，
    // 应答取 cancelId（＝用户取消/关闭的保守选择）。
    say('[dialog] ' + opts.title + ': ' + opts.message + (opts.detail ? ' — ' + opts.detail : ''));
    return Promise.resolve({ response: typeof opts.cancelId === 'number' ? opts.cancelId : opts.buttons.length - 1 });
  },
  // 外链/完全重启复用壳层既有通道（main.rs shell.open-external 带 http(s)
  // 校验；shell.relaunch＝app.restart 整壳重启）；openPath/showItemInFolder
  // 的壳层通道随 Task 8 补齐，现阶段 stderr 无头兜底（对齐 notify/
  // showMessageBox 过渡语义；Task 7 IPC 域挂载前无 sidecar 侧消费者）。
  openExternal: (url) => notify('shell.open-external', { url }),
  openPath: (p) => say('[shell] openPath: ' + p),
  showItemInFolder: (p) => say('[shell] showItemInFolder: ' + p),
  relaunch: () => notify('shell.relaunch', {}),
  shortcuts: {
    // PowerShell 实现返回 Record<string, unknown>（过渡 shortcutsMod 同款），
    // 结构即 HostShortcutLink 子集，收窄桥接给统一模块。
    readLink: async (p) => (await psLnkRead(p)) as HostShortcutLink,
    writeLink: async (p, operation, o) => {
      await psLnkWrite(p, operation, o as unknown as Record<string, unknown>);
    },
  },
});

// /update 进度页开关状态（showUpdateWindow/destroy 维护）。
let updateWindowOpen = false;
const clientUpdateHost = {
  log,
  showBox: showBoxFallback,
  isQuitting: () => quitting,
  getAppVersion: () => pkgVersion,
  getUserDataDir: () => userDataDir,
  getDshHome: () => dshHome,
  // 更新进度窗 = 壳层 /update 页（boot.server-died 同款「通知 → 壳导航」模式）。
  // 返回句柄只维护 isDestroyed/destroy 语义，供流程 finally 清理。
  showUpdateWindow: (version: string, kind: string) => {
    updateWindowOpen = true;
    notify('client-update.show', { version: version || '', kind: kind || 'client' });
    return {
      isDestroyed: () => !updateWindowOpen,
      destroy: () => {
        if (updateWindowOpen) {
          updateWindowOpen = false;
          notify('client-update.hide', {});
        }
      },
    };
  },
  // 进度推送 → WS 广播（/update 页经 _onNotify 渲染）。
  makeUpdateProgressPusher: () => ({
    client: (received: number, total: number, meta?: unknown) =>
      notify('client-update.progress', Object.assign({ channel: 'client', received: received, total: total }, meta && typeof meta === 'object' ? meta : {})),
    agent: (stage: string) => notify('client-update.progress', { channel: 'agent', stage: stage }),
    force: (m: unknown) => notify('client-update.progress', Object.assign({ channel: 'force' }, m && typeof m === 'object' ? m : {})),
  }),
  // 更新交接前有界关停 dsh web（= legacy-shell prepareQuitForClientUpdate 的服务面）。
  prepareQuitForClientUpdate: async () => {
    say('prepareQuitForClientUpdate: 关停 dsh web');
    try { await (bootMod.stopServer as () => Promise<void>)(); } catch (e) { say('关停失败（继续交接）: ' + String(((e as Error).message) || e)); }
  },
  // 更新交接后的「退出进程」= 壳整体优雅退出（ExitRequested 有界收口
  // sidecar/dsh web）。不在 sidecar 直接 process.exit：通知帧可能未冲刷即截断。
  exitProcess: () => { notify('shell.quit-for-update', {}); },
  // 打包态取壳层 exe 目录（DSH_SHELL_EXE）；开发态 sidecar 的 node 不适用。
  getExecDir: () => (process.env.DSH_SHELL_EXE ? path.dirname(process.env.DSH_SHELL_EXE) : path.dirname(process.execPath)),
};

// ---- boot-server（P2：dsh web 服务编排） --------------------------------
// settings 兼容层：与 updater.js 的 userData/settings.json 同文件同语义
// （load 回退 {}，save 2 空格缩进 + 尾换行），端号偏好双壳共享。
let quitting = false;

// 当前内核 Web 服务地址（手机桥 RPC 转发用）。boot.start / boot.restart
// 成功后更新，服务停止时清空。
let currentWebInfo: { webUrl: string; port: number } | null = null;

// 手机连接桥（5.1.1：LAN 配对 + 白名单 RPC + 手机端占位页，见 phone-bridge.ts）。
const phoneBridgeMod = require('./phone-bridge.js') as {
  createPhoneBridge(options: {
    getWebUrl: () => string | null;
    log: (message: string) => void;
    sessionFile: string;
  }): {
    start(): Promise<{ url: string; port: number }>;
    stop(): Promise<void>;
    status(): { running: boolean; port: number; lanUrl: string; mobileReady: boolean; pairing: { state: string; expiresAt: number | null } };
    decide(approved: boolean): { ok: boolean; error?: string };
    disconnect(): { ok: boolean };
  };
};
const phoneBridge = phoneBridgeMod.createPhoneBridge({
  getWebUrl: () => (currentWebInfo ? currentWebInfo.webUrl : null),
  log: (m) => say(m),
  sessionFile: path.join(userDataDir, 'phone-bridge-session.json'),
});
function handlePhoneMethod(method: string, p: RpcParams): RpcResult | Promise<RpcResult> {
  if (method === 'phone.start') return phoneBridge.start().then((r) => ({ ok: true, ...r }));
  if (method === 'phone.stop') return phoneBridge.stop().then(() => ({ ok: true }));
  if (method === 'phone.status') return { ok: true, ...phoneBridge.status() };
  if (method === 'phone.decide') return phoneBridge.decide(p?.approved === true) as RpcResult;
  if (method === 'phone.disconnect') return phoneBridge.disconnect() as RpcResult;
  return { ok: false, error: 'unknown phone method' };
}

const settingsFile = path.join(userDataDir, 'settings.json');
const { readJsonFile } = require(path.join(DSH_DESKTOP_ROOT, 'lib', 'plugin-copy.js')) as {
  readJsonFile(file: string): Record<string, unknown> | null;
};
const { writeJsonAtomic } = require(path.join(DSH_DESKTOP_ROOT, 'lib', 'atomic-json.js')) as {
  writeJsonAtomic(file: string, value: unknown): void;
};
function loadSettings(): Record<string, unknown> {
  return readJsonFile(settingsFile) ?? {};
}
function saveSettings(s: Record<string, unknown>): void {
  try { writeJsonAtomic(settingsFile, s); } catch (e) { say('保存 settings 失败: ' + String(e)); }
}

/** 无 id 的 JSON-RPC 通知帧（Rust 侧经 WS 广播给页面，并自行订阅壳层事件）。 */
function notify(method: string, params: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params: params == null ? {} : params }) + '\n');
}

say('modules mounted; dshHome=' + dshHome + '; profile=' + desktopProfileFn());

// ---- SessionWatcher（5.3.3 批次 D 接线，= Electron main.js onSessionTurnEnd）----
// 会话任务完成通知：2s 轮询 <dshHome>/sessions 的 zstd 日志，turn/end 时经
// 壳层系统通知提醒（notifyOnTurnEnd 设置项控制，同会话 30s 限频）。
const sessionWatcherMod = require(path.join(DSH_DESKTOP_ROOT, 'session-watcher.js')) as {
  SessionWatcher: new (opts: {
    sessionsDir: string;
    log: (tag: string, msg: string) => void;
    onTurnEnd: (info: { sessionId: string; title?: string; body?: string }) => void;
  }) => { start(): void; stop(): void };
};
let sessionWatcher: { start(): void; stop(): void } | null = null;
const turnEndNotifyAt = new Map<string, number>();
function startSessionWatcher(): void {
  if (sessionWatcher) return;
  try {
    const s = loadSettings() as { notifyOnTurnEnd?: boolean };
    if (s.notifyOnTurnEnd === false) return;
    sessionWatcher = new sessionWatcherMod.SessionWatcher({
      sessionsDir: path.join(dshHome, 'sessions'),
      log,
      onTurnEnd: (info) => {
        if (quitting) return;
        const now = Date.now();
        const last = turnEndNotifyAt.get(info.sessionId) || 0;
        if (now - last < 30000) return; // 同会话至多一条 toast / 30s
        // sidecar 与壳同生命周期：会话数按月累积，Map 从不清理就是慢速泄漏。
        // 超限先淘汰最旧一半（时间戳序），限频语义不受影响。
        if (turnEndNotifyAt.size >= 500) {
          const oldest = [...turnEndNotifyAt.entries()].sort((a, b) => a[1] - b[1]).slice(0, 250);
          for (const [k] of oldest) turnEndNotifyAt.delete(k);
        }
        turnEndNotifyAt.set(info.sessionId, now);
        notifyFallback({
          title: info.title || 'DSH 任务完成',
          body: info.body || '会话任务已完成',
        });
      },
    });
    sessionWatcher.start();
  } catch (e) {
    say('SessionWatcher 启动失败（不影响主流程）: ' + String(((e as Error).message) || e));
  }
}

// ---- vnext 初始化：日志 sink + 共享状态 + 恢复中心 ctx ----------------------
setLogSink(log);
initVNextState({ dshHome, userDataDir, logsDir: path.join(userDataDir, 'logs') });
// BUG-G-103：sidecar 自举不经过 lib/boot.ts（其 436 行才从 settings 同步该
// 字段），state.notifyOnTurnEnd 恒为默认 true——启动时先同步一次。
state.notifyOnTurnEnd = (loadSettings() as { notifyOnTurnEnd?: boolean }).notifyOnTurnEnd !== false;
bridge.ensureGuard = guardBoxMod.ensureGuard;
bridge.processPendingMarketOps = marketMod.processPendingMarketOps;
bridge.syncCompanionPlugins = companionSyncMod.syncCompanionPlugins;
bridge.healProfileModules = companionSyncMod.healProfileModules;
bridge.restoreKeptArtifacts = companionSyncMod.restoreKeptArtifacts;

// 前置文件树准备：旧凭据格式迁移 → 市场排队 → 退役清理 → 配套插件/技能
// 同步 → 模块遮蔽修复 → 构建产物回填。boot.start 与重启/恢复中心
// retry-boot 共用。
async function preBootSync(): Promise<void> {
  await marketMod.processPendingMarketOps();
  companionSyncMod.retireRemovedBuiltinPlugins(profileMod.desktopProfileDir());
  companionSyncMod.syncCompanionPlugins();
  companionSyncMod.syncBundledSkills();
  companionSyncMod.healProfileModules();
  await companionSyncMod.restoreKeptArtifacts(desktopProfileFn());
}

// 原地重启（= main.js restartWebServiceCore）：无锁窗口内消费市场排队 →
// 同步配套插件 → 修复模块遮蔽 → 恢复保留产物 → 重新拉起。boot.restart 与
// 恢复中心的 retry-boot 共用；服务未在运行（恢复中心直开模式）时走 boot.start
// 同款前置链直接拉起。
async function restartWebServiceCore(): Promise<{ ok: boolean; webUrl?: string; port?: number; error?: string }> {
  const running = (bootMod.state as () => { running: boolean })().running;
  (bootMod.setIsRestarting as (v: boolean) => void)(true);
  // 5.3.3 接线：boot-server 的模块私有重启标志同步写共享 state —— 恢复中心
  // 的重启竞态护栏（safeModeEnable 等：running && !restartingServer 才放行）
  // 此前读到的是恒 false 的死字段，护栏从未生效。
  vnextState.state.restartingServer = true;
  try {
    if (!running) {
      log('service', '请求启动 dsh web 服务（未在运行）');
      await preBootSync();
      const r = await guardedStartAndWait([]);
      log('service', 'dsh web 服务已启动: ' + r.webUrl);
      currentWebInfo = { webUrl: r.webUrl, port: r.port };

      notify('boot.web-ready', r);
      return { ok: true, webUrl: r.webUrl, port: r.port };
    }
    log('service', '请求重启 dsh web 服务');
    await (bootMod.killAndWaitForRestart as () => Promise<void>)();
    await (marketMod.processPendingMarketOps as () => Promise<void>)();
    (companionSyncMod.syncCompanionPlugins as () => void)();
    (companionSyncMod.healProfileModules as () => void)();
    await companionSyncMod.restoreKeptArtifacts(desktopProfileFn());
    const r = await (bootMod.startAndWait as (o: string[]) => Promise<{ webUrl: string; port: number }>)([]);
    log('service', 'dsh web 服务已重启: ' + r.webUrl);
    currentWebInfo = { webUrl: r.webUrl, port: r.port };

    notify('boot.web-ready', r);
    return { ok: true, webUrl: r.webUrl, port: r.port };
  } catch (e) {
    log('service', '重启失败: ' + String(((e as Error).message) || e));
    // 失败路径同样清缓存：旧 webUrl 已不可达，手机桥按「未运行」处理。
    currentWebInfo = null;
    return { ok: false, error: String(((e as Error).message) || e) };
  } finally {
    (bootMod.setIsRestarting as (v: boolean) => void)(false);
    vnextState.state.restartingServer = false;
  }
}

// ---- 5.3.3：守护启动接线（guardedBoot 在 Tauri 化时断线的最小恢复）--------
// 启动前取 profile 快照；成功 → markGood 标「最后良好」（恢复中心
// 「回退最后良好快照」的数据来源，此前永不写入、恒空转）；失败 →
// 事故留痕。完整 guardedBoot 重试链不接：sidecar 启动链已自带有界重试
// 与救援引导，重试语义重复。
let agentPreviousConfirmed = false;
async function guardedStartAndWait(overlays: string[]): Promise<{ webUrl: string; port: number }> {
  const g = (guardBoxMod.ensureGuard as () => {
    snapshot(r: string): { id: string } | null;
    markGood(id: string): void;
    reportIncident(t: string, d: string): { ok: boolean };
  })();
  const snap = g.snapshot('boot');
  try {
    const r = await (bootMod.startAndWait as (o: string[]) => Promise<{ webUrl: string; port: number }>)(overlays);
    if (snap) g.markGood(snap.id);
    // agent-previous 备份生命周期：更新后的首次健康启动即清理上一版备份
    // （5.3.2 及以前 confirmPreviousAgentHealthy 零调用，数百 MB 备份永滞）。
    if (!agentPreviousConfirmed) {
      agentPreviousConfirmed = true;
      // 两个「确认健康后的清理」都【严禁】在 boot.start 关键路径上同步执行：
      // backups/<ts> 全量镜像与 agent-previous 覆盖层可达数百 MB～数 GB，
      // 同步 rm 冻结事件循环数分钟 → 全部 RPC 卡死 + boot.start 180s 超时
      // 弹 died 页（5.3.5 首发实测事故）。推迟 30s 且清理本体走 fs.promises。
      setTimeout(() => {
        void (async () => {
          try {
            // async（fs.promises.rm）：agent-previous 数百 MB 级，严禁同步删。
            await updater.confirmPreviousAgentHealthy((pathsMod.updCtx as () => unknown)());
          } catch (e) {
            log('update', '确认上一版健康失败: ' + String(((e as Error).message) || e));
          }
          try {
            const cu = require(path.join(DSH_DESKTOP_ROOT, 'client-updater.js')) as {
              cleanupClientBackupIfHealthy(c: unknown, o?: unknown): Promise<{ removed: string[]; kept: string[] }>;
            };
            const r = await cu.cleanupClientBackupIfHealthy((pathsMod.updCtx as () => unknown)());
            if (r.removed.length) log('update', '已延迟清理更新备份 ' + r.removed.length + ' 份');
          } catch (e) {
            log('update', '清理更新备份失败: ' + String(((e as Error).message) || e));
          }
        })();
      }, 30_000).unref();
    }
    return r;
  } catch (e) {
    try {
      g.reportIncident('boot-failed', 'dsh web 服务拉起失败。\n\n错误：\n' + String(((e as Error).message) || e));
    } catch { /* 尽力而为 */ }
    throw e;
  }
}

recoveryCenter.init({
  appVersion: pkgVersion,
  profile: desktopProfileFn(),
  restartWebService: async () => restartWebServiceCore(),
  requestSafeModeRelaunch: () => notify('shell.relaunch-safe-mode', {}),
});

// ---- 方法注册表 -----------------------------------------------------------
interface RpcReq { id: number | null; method: string; params?: Record<string, unknown> }
type RpcResult = Record<string, unknown>;
type RpcParams = Record<string, unknown> | undefined;

// 图标 dataUri 模块级缓存：bridge openMenu 每次开菜单都调 chrome.init，
// 5.3.2 及以前每次重读 146KB 图标 + base64 并经 WS 回环发 ~195KB JSON。
let chromeIconDataUri: string | null = null;
function chromeIcon(): string {
  if (chromeIconDataUri !== null) return chromeIconDataUri;
  try {
    const buf = fs.readFileSync(path.join(DSH_DESKTOP_ROOT, 'assets', 'icon.png'));
    chromeIconDataUri = buf.length > 0 && buf[0] === 0x89 && buf[1] === 0x50
      ? 'data:image/png;base64,' + buf.toString('base64')
      : '';
  } catch { chromeIconDataUri = ''; /* 无图标不致命 */ }
  return chromeIconDataUri;
}

const methods: Record<string, (p: RpcParams) => unknown> = {
  'shell.info': (): RpcResult => ({
    sidecar: 'server.ts',
    node: process.version,
    platform: process.platform,
    pid: process.pid,
    dshHome,
    userDataDir: desktopPlatform.userDataDir(),
    capabilities: desktopPlatform.capabilities(),
    version: pkgVersion,
    modules: MOUNTED,
    balance: balanceCache,
  }),
  'profile.name': (): RpcResult => ({ name: desktopProfileFn() }),
  'profile.dir': (): RpcResult => ({ dir: (profileMod.desktopProfileDir as () => string)() }),
  'runtime.nodeExe': (): RpcResult => ({ exe: procMod.nodeExe() }),
  'runtime.dshBin': (): RpcResult => ({ bin: procMod.dshBin() }),
  'plugins.removedIds': (): RpcResult => ({ ids: [...pluginOpsMod.removedPluginIds()] }),
  'guard.ensure': (): RpcResult => ({ ok: !!(guardBoxMod.ensureGuard as () => unknown)() }),
  // ---- boot.*（P2：dsh web 服务编排，Rust 壳的启动主链路） ----
  'boot.start': async (p): Promise<RpcResult> => {
    const overlays = Array.isArray(p && p.overlays) ? (p!.overlays as string[]) : [];
    // 打包态捆绑依赖完整性校验（issue #7，= Electron startAndShowGuarded 前置）：
    // 空壳包以明确文案提示重装，用户选「仍然启动」才继续。
    await (previewMod.verifyBundledModules as () => Promise<void>)();
    // 前置文件树准备（= main.js boot() 在 startAndShowGuarded 之前的序列，
    // 摘除 GUI 项）：市场排队 → 退役清理 → 配套插件/技能同步 → 模块遮蔽
    // 修复 → 构建产物回填。koffi 预检与 junction 巡检属 P3 壳层集成。
    try {
      await preBootSync();
    } catch (e) {
      say('boot 前置准备失败（继续尝试拉起服务）: ' + String(((e as Error).message) || e));
    }
    // 共享 profile 一次性迁移（= Electron main.js boot() 序列）：必须在
    // syncCompanionPlugins 写新 profile 之后、皮肤行落位（applyLegacySkinChoice
    // 在 sync 内消费）之前判定 —— preBootSync 已完成 sync，此处执行迁移清理。
    try {
      (shortcutsMod.migrateFromSharedWebProfile as () => void)();
    } catch (e) {
      say('共享 profile 迁移失败（不影响启动）: ' + String(((e as Error).message) || e));
    }
    // vnext（Phase 2）：插件档案登记 + 示例 SDK 插件安装（幂等）。
    try {
      recoveryCenter.archivePluginProfiles();
    } catch (e) {
      say('插件档案登记失败: ' + String(((e as Error).message) || e));
    }
    try {
      extHost.ensureBundledSdkPlugins();
    } catch (e) {
      say('示例 SDK 插件安装失败: ' + String(((e as Error).message) || e));
    }
    // 恢复中心直开模式（Rust 壳检测 DSH_DESKTOP_RECOVERY=1 已打开恢复中心
    // 窗口）：跳过 dsh web 启动，sidecar 只保持存活供恢复中心动作调用。
    if (process.env.DSH_DESKTOP_RECOVERY === '1') {
      say('[vnext] DSH_DESKTOP_RECOVERY=1，跳过 dsh web 启动（恢复中心直开模式）');
      return { ok: true, recoveryMode: true };
    }
    // vnext（Phase 2）：Core Bridge 回环端点必须在拉起 dsh web 之前就绪，
    // 其 URL/token 经 process.env 注入（childEnv 展开 process.env）。
    try {
      const mgr = extHost.getExtensionHostManager();
      const bridge = await bridgeServer.startExtensionBridgeServer(mgr);
      state.eacBridge = bridge;
      process.env.DSH_EAC_BRIDGE_URL = bridge.url;
      process.env.DSH_EAC_BRIDGE_TOKEN = bridge.token;
      say('[vnext] Core Bridge 端点就绪: ' + bridge.url);
    } catch (e) {
      say('[vnext] Core Bridge 端点启动失败（隔离工具桥接不可用）: ' + String(((e as Error).message) || e));
    }
    let r: { webUrl: string; port: number };
    try {
      r = await guardedStartAndWait(overlays);
    } catch (e) {
      // 崩溃循环计数（= main.js recordBootFailureNow）：连续失败达阈值后，
      // 救援页据 rescue.state.crash 引导安全模式。
      rescueIntegration.recordBootFailureNow(String(((e as Error).message) || e));
      hotUpdate.onBootFailure(); // 热更验证失败计数，≥3 熔断回滚（FF6）
      notify('boot.failed', { error: String(((e as Error).message) || e) });
      throw e;
    }
    rescueIntegration.clearRescueState?.();
    currentWebInfo = { webUrl: r.webUrl, port: r.port };

    notify('boot.web-ready', r);
    startBalanceLoop(); // 服务就绪后启动 15min 余额轮询（= main.js startBalanceLoop）
    scheduleAutoUpdateChecks(); // 启动 60s 首检 + 12h 周期（P4 更新链）
    scheduleHotUpdateChecks(); // 启动 90s 首检 + 独立 6h 周期（组件级热更新）
    hotUpdate.onBootSuccess(); // 热更重启后的验证提交（phase 非 RESTART 时为 no-op）
    // vnext（Phase 2）：并行拉起全部启用的 SDK 插件宿主（不阻塞 boot）。
    void extHost.startEnabledExtensionHosts();
    return r;
  },
  'boot.stop': async (): Promise<RpcResult> => {
    await (bootMod.stopServer as () => Promise<void>)();
    // 显式停服后必须清掉缓存：手机桥 getWebUrl() 拿着旧 webUrl 会逐请求
    // 打死端口 502，而不是语义正确的「服务未运行」。
    currentWebInfo = null;
    return { ok: true };
  },
  'boot.state': (): RpcResult => (bootMod.state as () => unknown)() as RpcResult,
  // ---- phone.*（手机连接桥：LAN 配对 + 白名单 RPC + 手机端占位页） ----
  'phone.start': (p): RpcResult | Promise<RpcResult> => handlePhoneMethod('phone.start', p),
  'phone.stop': (p): RpcResult | Promise<RpcResult> => handlePhoneMethod('phone.stop', p),
  'phone.status': (p): RpcResult => handlePhoneMethod('phone.status', p) as RpcResult,
  'phone.decide': (p): RpcResult => handlePhoneMethod('phone.decide', p) as RpcResult,
  'phone.disconnect': (p): RpcResult => handlePhoneMethod('phone.disconnect', p) as RpcResult,
  // ---- chrome.init（getInfo；字段集对齐 main.js chrome:init handler） ----
  'chrome.init': (): RpcResult => {
    const s = loadSettings() as {
      closeToTray?: boolean; exitAction?: string; shortcutPolicy?: string;
      notifyOnTurnEnd?: boolean; repos?: { github?: string; gitee?: string };
    };
    const iconDataUri = chromeIcon();
    const exitAction = s.exitAction === 'ask' || s.exitAction === 'minimize' || s.exitAction === 'quit'
      ? s.exitAction
      : s.closeToTray === false ? 'quit' : s.closeToTray === true ? 'minimize' : 'ask';
    let repos = { github: '', gitee: '' };
    try {
      const cu = require(path.join(DSH_DESKTOP_ROOT, 'client-updater.js')) as { resolveRepos(r: unknown): { github: string; gitee: string } };
      repos = cu.resolveRepos(s.repos);
    } catch { /* 回退空串（菜单隐藏更新源区） */ }
    return {
      appVersion: pkgVersion,
      agentVersion: procMod.dshVersion(),
      agentSource: procMod.dshVersionSource(),
      notifyOnTurnEnd: s.notifyOnTurnEnd !== false,
      closeToTray: s.closeToTray !== false,
      exitAction,
      shortcutPolicy: s.shortcutPolicy === 'never' ? 'never' : 'auto',
      iconDataUri,
      repoUrls: { github: repos.github ? 'https://github.com/' + repos.github : '', gitee: repos.gitee ? 'https://gitee.com/' + repos.gitee : '' },
      // 预览静态服务端口（boot.start 里 startPreviewStaticServer 已 listen；
      // 服务未起时 0 = 插件侧回退宿主 /dsh-files/static/ 路由）。
      staticPort: (previewMod.getPreviewStaticPort as () => number)(),
    };
  },
  // 原地重启 Web 服务核心：无锁窗口内消费市场排队 → 同步配套插件 →
  // 修复模块遮蔽 → 恢复保留产物 → 重新拉起。
  'boot.restart': async (): Promise<RpcResult> => restartWebServiceCore(),
  // bridge.ts 的 restartService() 调 service.restart（此前无注册 → -32601 被插件
  // 静默吞掉，「重启服务后生效」实际不重启）：与 boot.restart 同一核心。
  'service.restart': async (): Promise<RpcResult> => restartWebServiceCore(),
  // ---- 恢复中心（vnext-absorb Phase 2）：Rust 壳创建的恢复中心窗口经专用
  // preload（WS JSON-RPC）调用这两个方法；动作分发在 lib/recovery-center。----
  'rc.action': async (p): Promise<RpcResult> => {
    const action = String((p && p.action) || '');
    return await recoveryCenter.handleRcAction(action, p && p.value);
  },
  'rc.close': (): RpcResult => ({ ok: true }),
};

// ---- 真实现面（P3：对齐原 Electron 主链路各 ipcMain.handle 语义，去 GUI 化） --------
const balance = require(path.join(DSH_DESKTOP_ROOT, 'balance.js')) as {
  queryBalance(home: string): Promise<Record<string, unknown> & { prices?: Record<string, unknown> }>;
  readActiveModel(home: string): string;
  DEFAULT_PRICES: Record<string, unknown>;
  FALLBACK_PRICES: Record<string, unknown>;
  computePricingState(peakWindows?: unknown): { period: string } & Record<string, unknown>;
  tierPrices(base: unknown, override: unknown, tier: string): Record<string, number>;
  sanitizePrices(prices: unknown): { peak: Record<string, number>; offpeak: Record<string, number> };
};
const pluginUpdater = require(path.join(DSH_DESKTOP_ROOT, 'plugin-updater.js')) as Record<string, (...a: unknown[]) => unknown>;

function home(): string { return dshHome; }

let balanceTimer: NodeJS.Timeout | null = null;
let balanceCache: unknown = null;

async function refreshBalance(): Promise<unknown> {
  const s = loadSettings() as { pricing?: { peakWindows?: unknown }; balancePrices?: Record<string, unknown> };
  let result: Record<string, unknown> & { prices?: Record<string, unknown> };
  try {
    result = await balance.queryBalance(home()) as typeof result;
  } catch (e) {
    result = { ok: false, error: String(((e as Error).message) || e), balances: [] };
  }
  const model = balance.readActiveModel(home()) || 'deepseek-v4-pro';
  const table = result.prices || balance.DEFAULT_PRICES;
  const pricing = balance.computePricingState(s.pricing && s.pricing.peakWindows);
  const base = (table as Record<string, unknown>)[model] || balance.FALLBACK_PRICES;
  const ov = (s.balancePrices && s.balancePrices[model]) || {};
  const tier = (src: string): Record<string, number> => balance.tierPrices(base, ov, src);
  result.prices = tier(pricing.period) as Record<string, unknown>;
  result.pricing = { ...pricing, prices: { peak: tier('peak'), offpeak: tier('offpeak') } };
  balanceCache = result;
  // 推送（= legacy-shell 的 webContents.send('dsh:balance')；桥转发成 window 事件）。
  notify('dsh.balance', result);
  return result;
}

function startBalanceLoop(): void {
  if (balanceTimer) return;
  void refreshBalance().catch(() => {});
  balanceTimer = setInterval(() => { void refreshBalance().catch(() => {}); }, 15 * 60 * 1000);
  if (balanceTimer.unref) balanceTimer.unref();
}

// 剪贴板（PowerShell Set-Clipboard；legacy-shell clipboard 的无 GUI 等价物）。
// 剪贴板是全系统互斥句柄：被其他进程占开时 Set-Clipboard 报 ExternalException
// （打开剪贴板失败），通常亚秒级释放——有界重试把瞬时锁变成成功。
function writeClipboardText(text: string, attempts = 3): Promise<boolean> {
  return new Promise((resolve) => {
    const ps = cp.spawn('powershell', ['-NoProfile', '-Command', '$input | Set-Clipboard'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    ps.on('error', () => resolve(false));
    ps.on('exit', (code) => {
      if (code === 0) { resolve(true); return; }
      if (attempts > 1) {
        setTimeout(() => { void writeClipboardText(text, attempts - 1).then(resolve); }, 300);
        return;
      }
      resolve(false);
    });
    ps.stdin.end(text, 'utf8');
  });
}

// 系统默认程序打开文件（= shell.openPath；explorer 解析关联）。
function openPathNative(p: string): Promise<string> {
  return new Promise((resolve) => {
    cp.exec(`start "" "${p.replace(/"/g, '')}"`, { windowsHide: true }, (err) => resolve(err ? String(err.message) : ''));
  });
}

const batch: Record<string, (p: RpcParams) => unknown> = {
  'balance.refresh': async (): Promise<unknown> => refreshBalance(),
  'balance.prices-get': (p): Record<string, unknown> => {
    const model = String((p && p.model) || '');
    const s = loadSettings() as { balancePrices?: Record<string, unknown> };
    const defaults = (balance.DEFAULT_PRICES as Record<string, unknown>)[model] || balance.FALLBACK_PRICES;
    const current = (s.balancePrices && s.balancePrices[model]) || null;
    return { ok: true, model, defaults, current };
  },
  'balance.prices-set': async (p): Promise<Record<string, unknown>> => {
    const m = String((p && p.model) || '');
    if (!m) return { ok: false, error: '模型名称不能为空' };
    try {
      const cleaned = balance.sanitizePrices(p && p.prices);
      const s = loadSettings();
      if (!s.balancePrices || typeof s.balancePrices !== 'object') s.balancePrices = {};
      (s.balancePrices as Record<string, unknown>)[m] = cleaned;
      saveSettings(s);
      await refreshBalance();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(((e as Error).message) || e) };
    }
  },
  'balance.prices-reset': async (p): Promise<Record<string, unknown>> => {
    const m = String((p && p.model) || '');
    try {
      const s = loadSettings() as { balancePrices?: Record<string, unknown> };
      if (s.balancePrices && s.balancePrices[m]) {
        delete s.balancePrices[m];
        saveSettings(s as Record<string, unknown>);
      }
      await refreshBalance();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(((e as Error).message) || e) };
    }
  },
  'balance.models': (): Record<string, unknown> => {
    // 与 main.js dsh:balance-models 同款轻量 YAML 扫描（llm-pi-ai.providers.models）。
    try {
      const settingsPath = path.join(home(), 'settings.yaml');
      if (!fs.existsSync(settingsPath)) return { ok: true, models: [] };
      const text = fs.readFileSync(settingsPath, 'utf8');
      const lines = text.split(/\r?\n/);
      const models: { id: string; name: string; provider: string }[] = [];
      let inProviders = false;
      let providerIndent = -1;
      let currentProvider = '';
      let inModels = false;
      let modelsIndent = -1;
      let currentModel: { id: string; name: string; provider: string } | null = null;
      for (const line of lines) {
        if (!line.trim() || line.trim().startsWith('#')) continue;
        const indent = line.search(/\S/);
        if (/^llm-pi-ai\s*:/i.test(line)) { inProviders = true; providerIndent = -1; continue; }
        if (inProviders && /^\s+providers\s*:/i.test(line)) { providerIndent = indent; continue; }
        if (providerIndent >= 0) {
          if (indent <= providerIndent && line.trim()) {
            if (/^[a-z]/i.test(line.trim())) break;
            continue;
          }
          const providerMatch = line.match(new RegExp(`^\\s{${providerIndent + 2},${providerIndent + 6}}([a-z][\\w-]*)\\s*:`));
          if (providerMatch && !inModels && !['models', 'baseurl', 'apikeyenv', 'displayname', 'api'].includes(providerMatch[1]!.toLowerCase())) {
            currentProvider = providerMatch[1]!;
            continue;
          }
          if (/^\s+models\s*:/i.test(line) && indent > providerIndent) { inModels = true; modelsIndent = indent; continue; }
          if (inModels) {
            if (indent <= modelsIndent && line.trim()) {
              inModels = false;
              currentModel = null;
              const reProvider = line.match(new RegExp(`^\\s{${providerIndent + 2},${providerIndent + 6}}([\\w][\\w-]*)\\s*:`));
              if (reProvider) currentProvider = reProvider[1]!;
              continue;
            }
            const modelMatch = line.match(/^\s+-\s+id\s*:\s*(\S+)/);
            if (modelMatch) {
              const modelId = modelMatch[1]!.replace(/^["']|["']$/g, '');
              currentModel = { id: modelId, name: modelId, provider: currentProvider };
              models.push(currentModel);
              continue;
            }
            const nameMatch = line.match(/^\s+name\s*:\s*(.+)/);
            if (nameMatch && currentModel) {
              currentModel.name = nameMatch[1]!.trim().replace(/^["']|["']$/g, '');
              continue;
            }
          }
        }
      }
      const seen = new Set<string>();
      const uniqueModels = models.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
      return { ok: true, models: uniqueModels };
    } catch (e) {
      return { ok: true, models: [] };
    }
  },
  'clipboard.write-text': async (p): Promise<Record<string, unknown>> => {
    const text = (p && p.text) as string;
    if (typeof text !== 'string' || !text || text.length > 2048) return { ok: false };
    return { ok: await writeClipboardText(text) };
  },
  'image-paste.save': (p): Record<string, unknown> => {
    try {
      return (pluginOpsMod.imagePasteSave as (d: string, n: string) => Record<string, unknown>)(String((p && p.dataUrl) || ''), String((p && p.name) || '粘贴图片'));
    } catch (e) {
      return { ok: false, error: String(((e as Error).message) || e) };
    }
  },
  // 拖入文件保存（BUG-G-002：bridge.ts fileDrop.save 仍调用本通道，处理器与
  // 实现在统一 lib 重构中被一并误删，拖入文件恒 method not found 静默失效）。
  'file-drop.save': (p): Record<string, unknown> => {
    try {
      return (pluginOpsMod.fileDropSave as (d: string, n: string) => Record<string, unknown>)(String((p && p.dataUrl) || ''), String((p && p.name) || '拖入文件'));
    } catch (e) {
      return { ok: false, error: String(((e as Error).message) || e) };
    }
  },
  'files.revert': (p): Record<string, unknown> => {
    const changes = (p && p.changes) as Array<{ path?: string; oldText?: string; newText?: string }>;
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 300) return { results: [] };
    const results: Record<string, unknown>[] = [];
    for (const c of changes) {
      const fp = String((c && c.path) || '');
      const oldText = String((c && c.oldText) ?? '');
      const newText = String((c && c.newText) ?? '');
      if (!path.isAbsolute(fp) || oldText.length > 400000 || newText.length > 400000) {
        results.push({ path: fp, status: 'invalid' });
        continue;
      }
      if (!(fileRootsMod.isUnderFileRoots as (x: string) => boolean)(fp)) {
        results.push({ path: fp, status: 'forbidden' });
        continue;
      }
      try {
        const exists = fs.existsSync(fp);
        const content = exists ? fs.readFileSync(fp, 'utf8') : null;
        if (oldText === '' && newText !== '') {
          if (content !== null && content === newText) { fs.rmSync(fp); results.push({ path: fp, status: 'reverted' }); }
          else results.push({ path: fp, status: content === null ? 'missing' : 'conflict' });
        } else if (newText === '' && oldText !== '') {
          if (content === null) { fs.writeFileSync(fp, oldText, 'utf8'); results.push({ path: fp, status: 'reverted' }); }
          else results.push({ path: fp, status: 'conflict' });
        } else {
          if (content !== null && content.includes(newText)) {
            // replace 只回滚第一处匹配：同一改动在文件中出现多处时只换一处
            // 却报 reverted 会误导调用方。行为保持单处替换（与写入侧对称），
            // 多于一处时附带 occurrences 供上层判断。
            const occurrences = content.split(newText).length - 1;
            fs.writeFileSync(fp, content.replace(newText, () => oldText), 'utf8');
            results.push(occurrences > 1
              ? { path: fp, status: 'reverted', occurrences, note: 'oldText 多处匹配，仅回滚第一处' }
              : { path: fp, status: 'reverted' });
          } else if (content !== null && content === oldText) {
            results.push({ path: fp, status: 'skipped' });
          } else {
            results.push({ path: fp, status: content === null ? 'missing' : 'conflict' });
          }
        }
      } catch (err) {
        results.push({ path: fp, status: 'failed', error: String(((err as Error).message) || err) });
      }
    }
    log('file-revert', JSON.stringify(results.slice(0, 20)));
    return { results };
  },
  'files.open': async (p): Promise<Record<string, unknown>> => {
    const fp = (p && p.path) as string;
    if (typeof fp !== 'string' || !path.isAbsolute(fp)) return { ok: false, error: 'path must be absolute' };
    // 归一化必须先于前缀比对：原始串可携带 `..`/大小写变体/符号链接骗过
    // 字面前缀命中，短路 isUnderFileRoots 后经壳层 files.open（ShellExecuteW
    // 无二次校验）打开任意文件。realPath 跟随符号链接与 ..；叶子不存在时
    // 用已解析的父目录拼回（随后 existsSync 把关）。
    try {
      fp = fs.realpathSync(fp);
    } catch {
      try {
        fp = path.resolve(fs.realpathSync(path.dirname(fp)), path.basename(fp));
      } catch { /* 连父目录都不可解析：保持原串，交给下方围栏判定 */ }
    }
    const lower = (x: string): string => (process.platform === 'win32' ? x.toLowerCase() : x);
    const skillsRoots = [
      path.join(home(), 'skills'),
      path.join(process.env.DSH_AGENTS_HOME || path.join(os.homedir(), '.agents'), 'skills'),
    ].map((r) => lower(path.resolve(r)));
    const fpL = lower(fp);
    const underSkillsRoot = skillsRoots.some((r) => fpL === r || fpL.startsWith(r + path.sep));
    if (!underSkillsRoot && !(fileRootsMod.isUnderFileRoots as (x: string) => boolean)(fp)) {
      return { ok: false, error: 'path outside session workspace' };
    }
    if ((fileRootsMod.DANGEROUS_EXT as RegExp).test(fp)) {
      return { ok: false, error: 'executable files are not openable from the file view' };
    }
    try {
      if (!fs.existsSync(fp)) return { ok: false, error: 'file not found' };
      const msg = await openPathNative(fp);
      if (msg) return { ok: false, error: msg };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(((e as Error).message) || e) };
    }
  },
  'plugins.list': (): Record<string, unknown> => {
    return { list: (pluginOpsMod.pluginManagerCollect as () => unknown[])() };
  },
  'plugins.set-enabled': (p) => {
    return pluginOpsMod.pluginManagerSetEnabled(String((p && p.id) || ''), !!(p && p.enabled));
  },
  'plugins.set-removed': (p) => {
    return pluginOpsMod.pluginManagerSetRemoved(String((p && p.id) || ''), !!(p && p.removed));
  },
  'plugins.updates': async (p): Promise<Record<string, unknown>> => {
    try {
      const ctx = procMod.updCtx();
      const sources = pluginUpdateSources(pluginOpsMod.removedPluginIds());
      const list = await (pluginUpdater.checkPluginUpdates as (c: unknown, s: unknown[], o: unknown) => Promise<unknown[]>)(ctx, sources, {
        force: !!(p && p.force),
        profileDirP: (profileMod.desktopProfileDir as () => string)(),
      });
      return {
        list,
        autoUpdate: (pluginUpdater.isAutoUpdateEnabled as (c: unknown) => boolean)(ctx),
        checkedAt: (loadSettings() as { pluginUpdateCheckedAt?: string }).pluginUpdateCheckedAt || null,
      };
    } catch (e) {
      log('plugin-update', '插件更新清单加载失败: ' + String(((e as Error).message) || e));
      return { list: [], autoUpdate: false, error: String(((e as Error).message) || e) };
    }
  },
  'plugins.update': async (p): Promise<Record<string, unknown>> => {
    const sources = pluginUpdateSources(pluginOpsMod.removedPluginIds());
    const source = sources.find((s) => s.id === String(p && p.id));
    if (!source) return { ok: false, error: '未知或不可更新的内置插件: ' + String(p && p.id) };
    try {
      const res = await (pluginUpdater.applyBuiltinPluginUpdate as (c: unknown, s: unknown, o: unknown) => Promise<Record<string, unknown>>)(procMod.updCtx(), source, {
        profileDirP: (profileMod.desktopProfileDir as () => string)(),
        guard: (guardBoxMod.ensureGuard as () => unknown)(),
        copyIntoProfile: (overlayDir: string, name: string) => copyPluginPackage(profileMod.desktopProfileDir(), overlayDir, name),
      });
      if (!res.ok) return res;
      if (res.noop) return { ok: true, noop: true, current: res.current, latest: res.latest };
      log('plugin-update', '手动更新内置插件 ' + String(p && p.id) + ' → ' + res.latest + (res.restartRequired ? '（重启服务生效）' : ''));
      return { ok: true, version: res.latest, restartRequired: res.restartRequired };
    } catch (e) {
      log('plugin-update', '更新插件 ' + String(p && p.id) + ' 失败: ' + String(((e as Error).message) || e));
      return { ok: false, error: String(((e as Error).message) || e) };
    }
  },
  'plugins.auto-update': (p): Record<string, unknown> => {
    try {
      const s = loadSettings();
      s.pluginAutoUpdate = !!(p && p.enabled);
      saveSettings(s);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(((e as Error).message) || e) };
    }
  },
  'guard.action': (p): Record<string, unknown> => {
    const action = String((p && p.action) || '');
    const value = p && p.value;
    const g = guardBoxMod.ensureGuard();
    switch (action) {
      case 'status': {
        const st = loadSettings() as { shareWebProfile?: boolean };
        return {
          ok: true,
          profile: desktopProfileFn(),
          shareWebProfile: st.shareWebProfile === true,
          snapshots: (g.listSnapshots as () => unknown[])().slice(0, 20),
          incidents: (g.listIncidents as () => unknown[])().slice(0, 20),
          lastGood: (g.lastGoodSnapshot as () => unknown)(),
        };
      }
      case 'snapshot': {
        const s = (g.snapshot as (r: string) => unknown)(String(value || 'manual'));
        return { ok: !!s, snapshot: s };
      }
      case 'restore': {
        const running = (bootMod.state as () => { running: boolean })().running;
        if (running) {
          return { ok: false, error: 'service-running', hint: '请先重启 Web 服务（或让回滚在重启间隙执行）' };
        }
        return (g.restore as (v: unknown) => Record<string, unknown>)(value) as Record<string, unknown>;
      }
      case 'check':
        return { ok: true, report: (g.healthCheck as () => unknown)() };
      case 'repair': {
        const r = (g.repair as () => { applied: unknown })();
        return { ok: true, applied: r.applied };
      }
      case 'incident':
        return (g.readIncident as (v: unknown) => Record<string, unknown>)(value) as Record<string, unknown>;
      case 'resolve-incident':
        return (g.resolveIncident as (v: unknown) => Record<string, unknown>)(value) as Record<string, unknown>;
      default:
        return { ok: false, error: 'unknown action' };
    }
  },
  'menu.action': async (p): Promise<Record<string, unknown> | null> => {
    const action = String((p && p.action) || '');
    const s = loadSettings() as { notifyOnTurnEnd?: boolean; shortcutPolicy?: string; exitAction?: string; closeToTray?: boolean };
    switch (action) {
      case 'toggle-notify': {
        s.notifyOnTurnEnd = s.notifyOnTurnEnd === false;
        saveSettings(s as Record<string, unknown>);
        // BUG-G-103：chrome:init 读的是 state.notifyOnTurnEnd（lib/ipc/app.ts），
        // 只写 settings 不回写 state 会导致菜单勾选态与真实设置脱钩。
        state.notifyOnTurnEnd = s.notifyOnTurnEnd === true;
        return { notifyOnTurnEnd: s.notifyOnTurnEnd, exitAction: s.exitAction || 'ask' };
      }
      case 'toggle-shortcut-policy': {
        s.shortcutPolicy = s.shortcutPolicy === 'never' ? 'auto' : 'never';
        saveSettings(s as Record<string, unknown>);
        return { shortcutPolicy: s.shortcutPolicy, exitAction: s.exitAction || 'ask' };
      }
      case 'set-exit-action': {
        const v = String((p && p.value) || '');
        if (v !== 'ask' && v !== 'minimize' && v !== 'quit') return null;
        s.exitAction = v;
        s.closeToTray = v !== 'quit'; // 同步旧字段，降级回旧版时行为不回退
        saveSettings(s as Record<string, unknown>);
        return { notifyOnTurnEnd: s.notifyOnTurnEnd !== false, closeToTray: s.closeToTray !== false, exitAction: v };
      }
      case 'restart-service': {
        const r = await (methods['boot.restart'] as (p2?: unknown) => Promise<Record<string, unknown>>)({} as Record<string, unknown>);
        return r;
      }
      // ---- P4 更新链 + 壳页动作（对齐 main.js 各 case 语义） ----
      case 'check-client-update': {
        try {
          await clientUpdateMod.runClientUpdateFlow(true);
        } catch (e) {
          log('client-update', '手动检查失败: ' + String(((e as Error).message) || e));
        }
        return { ok: true };
      }
      case 'check-agent-update': {
        try {
          await runAgentUpdateFlow(true);
        } catch (e) {
          log('update', '手动检查失败: ' + String(((e as Error).message) || e));
        }
        return { ok: true };
      }
      case 'check-hotupdate': {
        // 手动检查 = 用户已同意；命中即走完整状态机（下载→快照→交换→重启）
        try {
          const r = await hotUpdate.checkOnce({ manual: true });
          return { ok: true, ...r };
        } catch (e) {
          log('hot-update', '手动检查失败: ' + String(((e as Error).message) || e));
          return { ok: false, error: String(((e as Error).message) || e) };
        }
      }
      case 'hotupdate-state': {
        const s = hotUpdate.getState();
        return { ok: true, phase: s.phase, appliedSeq: s.appliedSeq, components: s.components, blockedSeqs: s.blockedSeqs, lastCheckAt: s.lastCheckAt };
      }
      case 'export-logs': {
        // BUG-G-101：原名 'recovery.export-logs' 全仓不存在；真实通道是
        // BUG-B-008 装配的 'chrome:export-logs'（lib/ipc/recovery.ts:68）。
        // 该 handler 校验 fromMainSession，须把桥附带的会话 token 透传进去。
        const f = methods['chrome:export-logs'] as ((p2?: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;
        if (typeof f !== 'function') return { ok: false, error: 'unavailable' };
        const token = p && typeof (p as Record<string, unknown>).__sessionToken === 'string'
          ? (p as Record<string, unknown>).__sessionToken as string
          : '';
        return await f({ __sessionToken: token });
      }
      case 'about': {
        // 壳层把主窗导航到 /about（back=当前 webUrl），菜单本身无返回值。
        notify('shell.about', {});
        return { ok: true };
      }
      default:
        // 未知动作：菜单静默关闭，无报错（对齐占位语义）。
        return null;
    }
  },
};
Object.assign(methods, batch);

// ---- P4 更新链（agent 内核更新流，对齐 main.js runUpdateFlow） -------------
const updater = require(path.join(DSH_DESKTOP_ROOT, 'updater.js')) as {
  checkLatest(c: unknown): Promise<string>;
  activeVersion(c: unknown): string;
  loadSettings(c: unknown): Record<string, unknown>;
  saveSettings(c: unknown, s: unknown): void;
  compareVersions(a: string, b: string): number;
  applyUpdate(c: unknown, latest: string, o: { onProgress: (ev: string) => void }): Promise<void>;
  confirmPreviousAgentHealthy(c: unknown): Promise<boolean>;
};
const onboardingLogic = require(path.join(DSH_DESKTOP_ROOT, 'scripts', 'onboarding.js')) as {
  CORE_PLUGIN_IDS: Set<string>;
  RECOMMENDED_PLUGIN_IDS: Set<string>;
  pluginCurrentState(entries: unknown[], plugins: unknown[]): Record<string, boolean>;
  buildSelectionOps(plugins: unknown[], coreIds: Set<string>, want: Set<string>, current: Record<string, boolean> | null): Array<{ id: string; enable: boolean }>;
  sanitizeSelection(ids: unknown, plugins: unknown[], coreIds: Set<string>): Set<string>;
  buildCatalog(plugins: unknown[], o: unknown): unknown[];
};
let agentUpdateBusy = false;

async function runAgentUpdateFlow(manual: boolean): Promise<void> {
  if (quitting) return;
  if (agentUpdateBusy) {
    if (manual) await showBoxFallback({ type: 'info', title: '更新', message: '更新正在进行中，请稍候。' });
    return;
  }
  const c = procMod.updCtx();
  let latest: string;
  try {
    latest = await updater.checkLatest(c);
  } catch (err) {
    log('update', '检查失败: ' + String(((err as Error).message) || err));
    if (manual) {
      await showBoxFallback({ type: 'warning', title: '检查更新失败', message: '无法连接 npm registry。' });
    }
    return;
  }
  const current = updater.activeVersion(c);
  const settings = loadSettings();
  if (updater.compareVersions(latest, current) <= 0) {
    if (manual) await showBoxFallback({ type: 'info', title: '检查更新', message: '当前已是最新版本。' });
    return;
  }
  if (!manual && settings.skipVersion === latest) return;
  const { response } = await showBoxFallback({
    type: 'info',
    title: '发现新版本',
    message: `官方 @deepseek-ai/dsh 发布了新版本：${latest}`,
    buttons: ['立即更新', '跳过此版本', '稍后'],
    // 无头兜底按 cancelId 应答（fail-closed）：不传则回 0 =「立即更新」，
    // 周期检查会在无人确认的情况下直接开更（见 showBoxFallback 注释）。
    cancelId: 2,
  });
  if (response === 1) {
    settings.skipVersion = latest;
    saveSettings(settings);
    return;
  }
  if (response === 2) return;
  agentUpdateBusy = true;
  updateWindowOpen = true;
  notify('client-update.show', { version: latest, kind: 'agent' });
  const progressAgent = (ev: string): void => notify('client-update.progress', { channel: 'agent', stage: ev });
  try {
    const g = (guardBoxMod.ensureGuard as () => { snapshot(r: string): unknown })();
    if (!g.snapshot('pre-update:dsh:' + latest)) {
      throw new Error('更新前保护快照失败（profile 不可读），已中止更新以保证可回滚。');
    }
    await updater.applyUpdate(c, latest, { onProgress: progressAgent });
    updateWindowOpen = false;
    notify('client-update.hide', {});
    const { response: r2 } = await showBoxFallback({
      type: 'info',
      title: '更新完成',
      message: `已更新到 @deepseek-ai/dsh@${latest}`,
      detail: '重启应用后生效。',
      buttons: ['立即重启', '稍后重启'],
      // 同上：不传 cancelId 兜底会答 0 =「立即重启」，整壳无人值守重启。
      cancelId: 1,
    });
    if (r2 === 0) {
      // 整壳重启（sidecar 随壳有界收口；run-state 属 legacy-shell watchdog 机制，Tauri 用崩溃计数替代）。
      notify('shell.relaunch', {});
    }
  } catch (err) {
    log('update', '更新失败: ' + String(((err as Error).message) || err));
    await showBoxFallback({ type: 'error', title: '更新失败', message: '未能完成更新，仍使用当前版本。' });
  } finally {
    agentUpdateBusy = false;
    if (updateWindowOpen) {
      updateWindowOpen = false;
      notify('client-update.hide', {});
    }
  }
}

// ---- 内置插件选择向导（wizard.open / onboard.*，对齐 main.js ipc 面） -------
// 页面 = 壳层 /wizard（serve assets/onboarding.html + 桥注入），RPC 走本表。
const companionPlugins = () => COMPANION_PLUGINS as unknown[];
function pluginDirSize(dirName: string): number {
  let total = 0;
  try {
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) total += fs.statSync(full).size;
      }
    };
    walk(path.join(DSH_DESKTOP_ROOT, 'assets', 'plugins', dirName));
  } catch { /* 未落盘按 0 展示 */ }
  return total;
}
function buildOnboardingCatalog(): unknown[] {
  return (onboardingLogic.buildCatalog as (p: unknown[], o: unknown) => unknown[])(companionPlugins(), {
    coreIds: onboardingLogic.CORE_PLUGIN_IDS,
    recommendedIds: onboardingLogic.RECOMMENDED_PLUGIN_IDS,
    describe: (name: string) => ((pluginOpsMod.pluginManagerPackageDescription as (n: string) => string)(name)),
    dirSize: (dirName: string) => pluginDirSize(dirName),
  });
}
function pluginCurrentState(): Record<string, boolean> | null {
  const { entries } = (pluginOpsMod.pluginManagerReadPatch as () => { entries: unknown[] })();
  return (onboardingLogic.pluginCurrentState as (e: unknown[], p: unknown[]) => Record<string, boolean>)(entries, companionPlugins());
}
let wizardMode: 'first' | 'rerun' = 'rerun';

Object.assign(methods, {
  // 打开向导（设置页「选择向导」入口）：壳层导航主窗到 /wizard。
  'wizard.open': (): RpcResult => {
    wizardMode = 'rerun';
    notify('wizard.show', { mode: wizardMode });
    return { ok: true };
  },
  'onboard.list': (): RpcResult => ({
    mode: wizardMode,
    catalog: buildOnboardingCatalog(),
    current: wizardMode === 'rerun' ? pluginCurrentState() : null,
  }),
  'onboard.submit': async (p: RpcParams): Promise<RpcResult> => {
    const ids = p && Array.isArray(p.ids) ? p.ids : [];
    try {
      (profileMod.ensureDesktopProfileInit as () => void)();
      const want = (onboardingLogic.sanitizeSelection as (i: unknown, p: unknown[], c: Set<string>) => Set<string>)(ids, companionPlugins(), onboardingLogic.CORE_PLUGIN_IDS);
      const current = wizardMode === 'rerun' ? pluginCurrentState() : null;
      const ops = (onboardingLogic.buildSelectionOps as unknown as (
        p: unknown[], c: Set<string>, w: Set<string>, cur: Record<string, boolean> | null,
      ) => Array<{ id: string; enable: boolean }>)(companionPlugins(), onboardingLogic.CORE_PLUGIN_IDS, want, current);
      const errors: string[] = [];
      for (const op of ops) {
        try {
          const res = (pluginOpsMod.pluginManagerSetEnabled as (id: string, en: boolean) => { ok: boolean; error?: string })(op.id, op.enable);
          if (!res.ok) errors.push(op.id + ': ' + (res.error || 'unknown'));
          else log('plugin-manager', '向导已' + (op.enable ? '启用' : '停用') + '内置插件 ' + op.id);
        } catch (err) {
          errors.push(op.id + ': ' + String(((err as Error).message) || err));
        }
      }
      const s = loadSettings();
      s.pluginOnboardingDone = true;
      s.builtinPluginSelection = Array.from(want);
      saveSettings(s);
      log('boot', '插件选择向导已应用：' + ops.length + ' 个插件状态变更' + (errors.length ? '，失败 ' + errors.join('; ') : ''));
      const mode = wizardMode;
      notify('wizard.close', { applied: ops.length });
      if (mode === 'rerun') {
        // 二次向导：重启 Web 服务让 host 侧插件生效（与市场安装后同路径）。
        await (methods['boot.restart'] as (p2?: unknown) => Promise<Record<string, unknown>>)({} as Record<string, unknown>);
      }
      return { ok: true, applied: ops.length, errors };
    } catch (e) {
      return { ok: false, error: String(((e as Error).message) || e) };
    }
  },
  'onboard.close': (): RpcResult => {
    notify('wizard.close', { cancelled: true });
    return { ok: true };
  },
});

// ---- 自动更新定时器（对齐 main.js：启动 60s 首检 + 12h 周期） ----------------
// boot.start 成功后调度一次；重复调用幂等。待装更新（下载完未安装）优先提示。
let autoUpdateScheduled = false;
function scheduleAutoUpdateChecks(): void {
  if (autoUpdateScheduled) return;
  autoUpdateScheduled = true;
  setTimeout(() => {
    try { clientUpdateMod.offerPendingClientUpdate(); } catch { /* 无待装更新 */ }
    clientUpdateMod.runClientUpdateFlow(false).catch(() => { /* 网络失败不打扰 */ });
  }, 60000).unref();
  setInterval(() => {
    clientUpdateMod.runClientUpdateFlow(false).catch(() => { /* 网络失败不打扰 */ });
  }, 12 * 3600 * 1000).unref();
}

// ---- 组件级热更新（docs/hot-update-design-addendum-2026-09-05） ------------
// 状态机目录挂在 Rust app_data_dir（DSH_USER_DATA 注入，与 boot-attempts 熔断
// 标记同根）；缺省回退 sidecar 计算的 userDataDir。引擎不传 confirm：
// 自动检查只广播可用性（hotupdate.available），不动安装树；菜单手动检查
// 视为用户已同意直接应用（sidecar 的 showMessageBox 是无头兜底，恒返回
// 取消/确定的假应答，接进来会造成自动批准的危险语义）。
const hotUpdate = hotUpdateMod.createHotUpdate({
  installRoot: path.resolve(DSH_DESKTOP_ROOT, '..'),
  dshDesktopRoot: DSH_DESKTOP_ROOT,
  userDataDir: process.env.DSH_USER_DATA || userDataDir,
  appVersion: pkgVersion,
  log,
  notify,
  restartSidecar: () => {
    // 有界收口：先关停 dsh web（避免孤儿占端口）→ 通知 Rust 重生 → 自退。
    // Rust 侧见退出即按标记重生新进程（读热更后的代码）并重发 boot.start。
    void (async () => {
      try { await (bootMod.stopServer as () => Promise<void>)(); } catch { /* 关停失败继续退出 */ }
      notify('shell.restart-sidecar', {});
      setTimeout(() => process.exit(0), 500).unref();
    })();
  },
  quitForUpdate: () => { notify('shell.quit-for-update', {}); },
});
hotUpdate.init();
recoveryCenter.setHotUpdateApi(hotUpdate); // 救援中心「回滚最近热更新」入口

// 热更检查调度：启动后 90s 首检（避开 60s 的正式更新首检）+ 独立 6h 周期
//（grill 决议 2026-09-05：与正式更新 12h 解耦）。
let hotUpdateScheduled = false;
function scheduleHotUpdateChecks(): void {
  if (hotUpdateScheduled) return;
  hotUpdateScheduled = true;
  setTimeout(() => { hotUpdate.checkOnce({ manual: false }).catch(() => { /* 自动检查静默失败 */ }); }, 90000).unref();
  setInterval(() => { hotUpdate.checkOnce({ manual: false }).catch(() => { /* 静默 */ }); }, 6 * 3600 * 1000).unref();
}

// ---- 救援链（硬门槛②；实现于 rescue-integration.ts，同产物编译） ----------
rescueIntegration.initRescue({
  dshHome,
  userDataDir,
  pkgVersion,
  desktopProfile: desktopProfileFn,
  desktopProfileDir: () => (profileMod.desktopProfileDir as () => string)(),
  dshVersion: () => procMod.dshVersion(),
  dshVersionSource: () => procMod.dshVersionSource(),
  log,
  notify,
  mods: {
    boot: {
      ...bootMod,
      // rescue retry / recovery.reload 直调 startAndWait 会绕过守护启动链
      //（快照/最后良好/事故留痕），更关键的是绕过 currentWebInfo 写入 ——
      // 救援拉起后手机桥 getWebUrl() 仍返回旧值/空，代理恒 503。统一走
      // guardedStartAndWait 并在成功后同步缓存。
      startAndWait: async (overlays: string[]) => {
        const r = await guardedStartAndWait(overlays);
        currentWebInfo = { webUrl: r.webUrl, port: r.port };
        return r;
      },
    },
    guardBox: guardBoxMod, pluginOps: pluginOpsMod, companionSync: companionSyncMod, balance,
  },
  bootRestart: () => (methods['boot.restart'] as (p?: unknown) => Promise<Record<string, unknown>>)({} as Record<string, unknown>),
});
Object.assign(methods, rescueIntegration.rescueMethods());

// ---- Task 7.1 收口（BUG-B-008）：把 lib/ipc 的冒号通道注册进 methods 表 ----
// createSidecarIpcSurface(methods) 的 register 会把 chrome:init / dsh:* /
// guard:action / onboard:* / snapshot:* / chrome:recovery-* 等通道逐一写入
// methods；缺了这行装配，页面桥（bridge.ts 全部走冒号通道）在 handleLine
// 里一律 method not found，getInfo/菜单开关/快照/文件打开/复制/向导静默失效。
registerIpc(createSidecarIpcSurface(methods as Record<string, (p?: Record<string, unknown>) => unknown>));

function respond(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line: string) => { void handleLine(line); });
rl.on('close', () => { void gracefulExit(); });

async function gracefulExit(): Promise<void> {
  quitting = true;
  try { if (sessionWatcher) { sessionWatcher.stop(); sessionWatcher = null; } } catch { /* 尽力回收 */ }
  try { await (bootMod.stopServer as () => Promise<void>)(); } catch { /* 尽力回收 */ }
  process.exit(0);
}

async function handleLine(line: string): Promise<void> {
  const text = line.trim();
  if (!text) return;
  let req: RpcReq;
  try { req = JSON.parse(text); } catch {
    return respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  const { id, method, params } = req;
  try {
    if (method === 'ping') return respond({ jsonrpc: '2.0', id, result: { pong: true, ts: Date.now() } });
    if (method === 'shutdown') {
      // vnext（Phase 2）：退出前树杀全部 Extension Host（含 Core Bridge 端点）。
      try {
        await extHost.shutdownExtensionHosts();
      } catch (e) {
        say('关闭插件宿主异常: ' + String(((e as Error).message) || e));
      }
      respond({ jsonrpc: '2.0', id, result: { bye: true } });
      rl.close();
      return;
    }
    const fixed = methods[method];
    if (fixed) {
      const result = await fixed(params);
      return respond({ jsonrpc: '2.0', id, result: result === undefined ? null : result });
    }
    respond({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
  } catch (e) {
    respond({ jsonrpc: '2.0', id, error: { code: -32000, message: String(((e as Error).message) || e) } });
  }
}
