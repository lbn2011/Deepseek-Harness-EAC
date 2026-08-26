/**
 * lib/host-ctx.ts — 宿主上下文注入（Task 5.1；模板取 lib/desktop/guard-box.ts
 * 的 XxxCtx 单例注入 + runtime-paths.ts 的防御性缺省语义）。
 *
 * lib/* 统一模块不直接 import legacy-shell：legacy-shell API 面（打包态/资源根/
 * 版本号/系统通知/剪贴板/退出/系统目录/无主窗消息框/.lnk 快捷方式读写）
 * 经本单例注入，双宿主过渡期同一份模块可运行于——
 *   · legacy-shell main：main.ts 装配段 initHostCtx(legacy-shellHost())
 *   · Tauri sidecar：sidecar/server.ts 装配段 initHostCtx(sidecarHost())
 *   · Node 测试：initHostCtx(mock) 或直接用内置缺省（开发态语义）
 *
 * 未注入时按开发态缺省处理（对齐 lib/desktop/runtime-paths.ts 约定）：
 * isPackaged=false / resourcesPath='' / vendor 布局 / OS 惯例系统目录；
 * GUI 类能力（通知/剪贴板/消息框）缺省为静默或无头兜底，绝不抛错。
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { log as defaultLog } from './log.js';
import type { RecoveryWindow } from './renderer-recovery/policy.js';

/** 系统通知参数（legacy-shell Notification 语义子集）。 */
export interface HostNotifyOpts {
  title: string;
  body: string;
  /** 通知图标绝对路径（可选）。 */
  icon?: string;
  /** 用户点击通知回调（可选）。 */
  onClick?(): void;
}

/** 无主窗消息框参数（legacy-shell dialog.showMessageBox 语义子集）。 */
export interface HostMessageBoxOpts {
  type: 'error' | 'info' | 'warning' | 'none' | 'question';
  title: string;
  message: string;
  detail?: string;
  buttons: string[];
  defaultId?: number;
  cancelId?: number;
  /** 复选框文案（「记住我的选择」类交互；缺省宿主忽略）。 */
  checkboxLabel?: string;
  checkboxChecked?: boolean;
  noLink?: boolean;
}

/** 消息框应答（checkboxChecked 仅 checkboxLabel 宿主返回）。 */
export interface HostMessageBoxResult {
  response: number;
  checkboxChecked?: boolean;
}

/** .lnk 写入参数（legacy-shell shell.writeShortcutLink 语义子集）。 */
export interface HostShortcutWriteOpts {
  target: string;
  description?: string;
  icon?: string;
  iconIndex?: number;
  appUserModelId?: string;
}

/**
 * .lnk 读回结构（legacy-shell shell.readShortcutLink 返回面的宽松描述；全可选
 * —— legacy-shell ShortcutDetails 接口可直接结构化赋值，sidecar PowerShell 实现
 * 返回其子集）。
 */
export interface HostShortcutLink {
  target?: string;
  args?: string;
  cwd?: string;
  description?: string;
  icon?: string;
  iconIndex?: number;
  appUserModelId?: string;
}

/** Windows .lnk 快捷方式读写能力（宿主不支持则整体缺省 → 调用方跳过维护）。 */
export interface HostShortcuts {
  /** 读 .lnk；损坏/失败抛错（调用方自行捕获）。 */
  readLink(p: string): HostShortcutLink;
  /** 写 .lnk；失败抛错（调用方自行捕获）。 */
  writeLink(p: string, operation: 'create' | 'replace', opts: HostShortcutWriteOpts): void;
}

/**
 * 桥会话句柄（Task 6.1）：宿主中立的渲染端会话身份与推送通道，取代
 * state 里的 legacy-shell BrowserWindow 概念。
 *   · legacy-shell：主窗/浮窗/向导各注册一个（id＝webContents.id）
 *   · Tauri sidecar：WS 桥连接 token（Task 7 bridge 扩域后接入）
 */
export interface BridgeSession {
  /** 会话唯一标识（来源校验 token；宿主保证稳定且互异）。 */
  readonly id: string;
  /** 到该会话渲染端的推送通道（legacy-shell＝webContents.send）。 */
  send(channel: string, payload?: unknown): void;
  /** 聚焦承载会话的窗口（不存在时静默）。 */
  focus(): void;
  /** 关闭承载会话的窗口（尽力而为，不抛错）。 */
  close(): void;
  /** 会话是否仍存活（legacy-shell＝窗口未销毁）。 */
  isAlive(): boolean;
}

/** 更新进度窗句柄（宿主不支持时 openUpdateProgress 返回 null → 无头降级）。 */
export interface UpdateProgressHandle {
  /** 注入进度（pct=-1 不定态；payload 与 updating.html __setProgress 对齐）。 */
  setProgress(p: { pct: number; receivedMB?: number; totalMB?: number; meta?: unknown }): void;
  close(): void;
}

/** 打开更新进度窗参数。 */
export interface OpenUpdateProgressOpts {
  version: string;
  kind: 'agent' | 'client';
}

/**
 * 窗口宿主面（Task 6.2）：主窗生命周期/控制语义的 `win.*` 通道对接层。
 * legacy-shell 直调 BrowserWindow；Tauri sidecar 经壳层通道转发（实现留 Task 8）；
 * 无窗宿主（Node 测试/sidecar 过渡期）缺省 undefined → 调用方按无窗降级。
 */
export interface HostWindows {
  /** 创建主窗（boot 编排调用；startHidden 供恢复流程后台重建）。 */
  createMain(opts?: { startHidden?: boolean }): void;
  /** 主窗加载指定 URL（服务就绪/换端口重载）。 */
  loadMain(url: string): Promise<void> | void;
  showMain(): void;
  hideMain(): void;
  focusMain(): void;
  restoreMain(): void;
  minimizeMain(): void;
  maximizeMain(): void;
  unmaximizeMain(): void;
  closeMain(): void;
  reloadMain(): void;
  toggleDevTools(): void;
  setMainFullScreen(v: boolean): void;
  isMainVisible(): boolean;
  isMainMinimized(): boolean;
  isMainMaximized(): boolean;
  isMainFullScreen(): boolean;
  /** 主窗就绪后回调一次（已可见立即回调；主窗不存在时不回调）。 */
  onMainReady(cb: () => void): void;
  /** 到主窗渲染端的推送通道（无主窗时静默）。 */
  sendToMain(channel: string, payload?: unknown): void;
  /**
   * 会话浮窗（复用或新建，语义＝原 createFloatWindow + reuse 分支）：
   * 宿主负责窗口与 state.floatSessions/floatBySession 登记。
   */
  openFloatWindow(sessionId: string): { ok: boolean; id?: number; reused?: boolean; error?: string };
  /** 关闭指定会话 token 的浮窗（float:close 来源校验后调用）。 */
  closeFloatByToken(token: string): void;
  /**
   * 打开（或聚焦）恢复中心窗口。宿主开窗时把窗口的 BridgeSession 登记进
   * state.rcSession（窗口关闭时清空）—— rc:action/rc:close 的来源校验据此
   * 比对（lib/recovery-center/register.ts）。窗口关闭经 rc:close 回收。
   */
  openRecoveryCenter(): void;
  /** 关闭恢复中心窗口（rc:close 动作；未开时静默，并清空 state.rcSession）。 */
  closeRecoveryCenter(): void;
  /**
   * 打开内置插件选择向导窗口；返回 false＝宿主无窗口能力（调用方按
   * 用户取消收口）。窗口关闭/提交经 onboarding 中立回调收口。
   */
  openPluginWizard(mode: 'first' | 'rerun'): boolean;
  /** 打开模态更新进度窗；null＝宿主不支持（无头降级）。 */
  openUpdateProgress(opts: OpenUpdateProgressOpts): UpdateProgressHandle | null;
  /**
   * 渲染恢复机专用（Task 6.2）：销毁当前主窗并重建（宿主登记新桥会话并
   * 挂载恢复机），返回恢复机的结构化窗口句柄；无窗宿主缺省 → 恢复机按
   * 重建失败计数。
   */
  rebuildMainWindowForRecovery?(opts: { startHidden: boolean }): RecoveryWindow | null;
}

/** 托盘宿主面（Task 6.2 事件桥接；Rust 壳实现留 Task 8）。 */
export interface HostTray {
  /** 创建/重建托盘（菜单规格实时经 buildTrayMenuSpec 拉取）。 */
  create(): void;
  /** 销毁托盘（退出清理期调用；未创建时静默）。 */
  destroy(): void;
  /** 托盘气泡提示（仅 Windows 语义；其余宿主静默）。 */
  displayBalloon(opts: { title?: string; content: string }): void;
}

/**
 * 宿主接口：lib/* 模块的全部宿主依赖面。必选成员各宿主都能给出等价实现
 * （Node 缺省兜底见下方 NODE_DEFAULT）；可选成员是宿主专属能力，缺省时
 * 调用方按「能力不存在」静默降级。
 */
export interface HostCtx {
  /** 是否打包态（vendor ↔ resources 布局、看门狗/快捷方式维护等门控）。 */
  isPackaged(): boolean;
  /** 打包态资源根（resources/）；开发态为空串。 */
  resourcesPath(): string;
  /** 应用版本号（legacy-shell app.getVersion / sidecar package.json）。 */
  appVersion(): string;
  /** 宿主日志通道（缺省路由到 lib/log.ts）。 */
  log(tag: string, msg: string): void;
  /** 立即终止进程，跳过优雅退出链（legacy-shell app.exit / process.exit）。 */
  exitProcess(code: number): void;
  /** 请求宿主走优雅退出链（legacy-shell app.quit；无优雅链宿主等价 exit(0)）。 */
  requestQuit(): void;
  /** 系统通知（无通知通道宿主静默，不抛错）。 */
  notify(opts: HostNotifyOpts): void;
  /** 复制文本到系统剪贴板（无剪贴板宿主静默，不抛错）。 */
  copyToClipboard(text: string): void;
  /** 系统目录（legacy-shell app.getPath 语义；缺省按 OS 惯例）。 */
  getPath(name: 'appData' | 'desktop' | 'userData' | 'crashDumps'): string;
  /** 启动早期重定向系统目录（legacy-shell app.setPath('userData')；缺省记录覆盖）。 */
  setPath?(name: 'userData', value: string): void;
  /** 移除原生应用菜单（legacy-shell 专属；缺省 no-op）。 */
  removeAppMenu?(): void;
  /** 无主窗消息框；缺省无头兜底（记日志并按 cancelId 应答）。 */
  showMessageBox(opts: HostMessageBoxOpts): Promise<HostMessageBoxResult>;
  /** Windows .lnk 快捷方式能力（缺省 undefined → 调用方跳过维护）。 */
  shortcuts?: HostShortcuts;
  /** 用系统默认浏览器打开 http(s) URL（缺省记日志）。 */
  openExternal(url: string): void;
  /** 用系统文件管理器打开目录（缺省记日志）。 */
  openPath(p: string): void;
  /** 在文件管理器中定位文件（缺省记日志）。 */
  showItemInFolder(p: string): void;
  /** 完全重启：安排 relaunch 后立即退出（legacy-shell relaunch+exit / 壳层 restart）。 */
  relaunch(): void;
  /** 窗口宿主面（缺省 undefined → 无窗环境降级：IPC/浮窗/恢复中心按无能力处理）。 */
  windows?: HostWindows;
  /** 托盘宿主面（缺省 undefined → 无托盘环境：气泡静默、驻留策略退化为直接退出）。 */
  tray?: HostTray;
}

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

/** OS 惯例 appData（对齐 legacy-shell app.getPath('appData') 的落点）。 */
function defaultAppData(): string {
  if (IS_WIN) return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (IS_MAC) return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/** 缺省 setPath 的目录覆盖表（legacy-shell 宿主的 setPath 影响后续 getPath）。 */
const defaultPathOverrides: Partial<Record<'appData' | 'desktop' | 'userData' | 'crashDumps', string>> = {};

const NODE_DEFAULT: HostCtx = {
  isPackaged: () => false,
  resourcesPath: () => '',
  appVersion: () => '0.0.0',
  log: defaultLog,
  exitProcess: (code) => process.exit(code),
  requestQuit: () => process.exit(0),
  notify: () => { /* 无通知通道：静默（调用方本就不依赖通知成功） */ },
  copyToClipboard: () => { /* 无剪贴板通道：静默 */ },
  getPath: (name) => {
    const ov = defaultPathOverrides[name];
    if (ov) return ov;
    if (name === 'appData') return defaultAppData();
    if (name === 'desktop') return path.join(os.homedir(), 'Desktop');
    if (name === 'crashDumps') {
      // legacy-shell 缺省落点＝userData/Crashpad；Node 缺省对齐该布局。
      return path.join(defaultAppData(), 'Deepseek Harness EAC', 'Crashpad');
    }
    return path.join(defaultAppData(), 'Deepseek Harness EAC');
  },
  setPath: (name, value) => {
    defaultPathOverrides[name] = value;
  },
  removeAppMenu: () => { /* 无原生菜单概念：no-op */ },
  showMessageBox: (opts) => {
    // 无头兜底：消息内容走日志通道可追溯；应答取 cancelId（语义＝用户取消/
    // 关闭），让 fatal 等调用方按「无 GUI 环境的保守选择」走退出路径。
    defaultLog('dialog', `[headless] ${opts.title}: ${opts.message}${opts.detail ? ' — ' + opts.detail : ''}`);
    return Promise.resolve({ response: opts.cancelId ?? opts.buttons.length - 1 });
  },
  openExternal: (url) => {
    defaultLog('shell', '[headless] openExternal: ' + url);
  },
  openPath: (p) => {
    defaultLog('shell', '[headless] openPath: ' + p);
  },
  showItemInFolder: (p) => {
    defaultLog('shell', '[headless] showItemInFolder: ' + p);
  },
  // 无 relaunch 通道的纯 Node 环境：记录意图后按干净退出收口。
  relaunch: () => {
    defaultLog('shell', '[headless] relaunch（无头环境等价 requestQuit）');
    process.exit(0);
  },
};

let current: HostCtx = NODE_DEFAULT;

/** 注入宿主实现（legacy-shell main / Tauri sidecar / 测试 mock 各自装配）。 */
export function initHostCtx(d: HostCtx): void {
  current = d;
}

/** 恢复内置缺省（测试 teardown 用）。 */
export function resetHostCtx(): void {
  current = NODE_DEFAULT;
  for (const k of Object.keys(defaultPathOverrides) as Array<'appData' | 'desktop' | 'userData' | 'crashDumps'>) {
    delete defaultPathOverrides[k];
  }
}

/** 取当前宿主上下文（未注入时为开发态缺省）。 */
export function hostCtx(): HostCtx {
  return current;
}
