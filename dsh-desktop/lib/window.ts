/**
 * lib/window.ts — 主窗/浮窗生命周期与渲染进程自恢复装配（Task 3.1 自 main.js
 * 提取；Task 6 Wave 1 宿主中立化：本模块不再 import legacy-shell）。
 *
 * 窗口创建与事件接线（导航围栏、右键菜单、快捷键、最大化同步、关闭策略、
 * BridgeSession 登记、浮窗构造/复用）全部属宿主职责 —— legacy-shell 机制由
 * Wave 3 在顶层 host-legacy-shell/windows.ts 实现；原 attachEditContextMenu /
 * guardFloatWebContents（WebContents 强耦合）与 createFloatWindow 主体一并
 * 迁往彼处。此处保留宿主中立部分：
 *   showBox（映射 hostCtx().showMessageBox）/ isAllowedWebUrl（纯函数）；
 *   createWindow 薄委托 hostCtx().windows?.createMain；
 *   closeAllFloatWindows（遍历 state.floatSessions 会话回收）；
 *   initRendererRecovery / attachWindowToRecovery / startHeartbeatLoop
 *   （renderer-recovery.js 状态机装配，上游 Issue #9 根治修复）；
 *   reloadMainWindow（整体委托宿主，恢复页分支在宿主实现）；FLOAT_MAX 常量。
 */

import * as path from 'node:path';
import { RendererRecovery } from '../renderer-recovery.js';
import type { FailureRecord, RecoveryWindow, WindowKind } from '../renderer-recovery.js';
import { state } from './state.js';
import { log } from './log.js';
import { hostCtx } from './host-ctx.js';
import { writeRunState } from './run-state.js';
import { waitUntilUp } from './server.js';
import { bridge } from './bridge.js';

/**
 * 会话浮窗全局上限（防资源滥用）。上限判定随浮窗创建移入宿主
 * （HostWindows.openFloatWindow），常量对宿主中立保留。
 */
export const FLOAT_MAX = 8;

/** showBox 参数（legacy-shell MessageBoxOptions 语义子集的自有宽松结构）。 */
export interface ShowBoxOpts {
  type?: 'error' | 'info' | 'warning' | 'none' | 'question';
  title?: string;
  message: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
  checkboxLabel?: string;
  checkboxChecked?: boolean;
  noLink?: boolean;
  /**
   * legacy-shell 的 icon 参数（NativeImage/路径）：HostMessageBoxOpts 无 icon 字段，
   * 接受但忽略 —— 图标策略由宿主决定（Wave 3 视需要扩宿主面）。
   */
  icon?: unknown;
}

/** showBox 应答（对齐 HostMessageBoxResult；checkboxChecked 仅配 checkboxLabel 时有值）。 */
export interface ShowBoxResult {
  response: number;
  checkboxChecked?: boolean;
}

/**
 * 消息框：映射到宿主消息框（hostCtx().showMessageBox）。原「有主窗时挂主窗」
 * 的模态语义由宿主实现自行决定（legacy-shell 宿主可在实现内挂主窗）；无头宿主
 * 走缺省兜底（记日志并按 cancelId 应答），不抛错。
 */
export function showBox(opts: ShowBoxOpts): Promise<ShowBoxResult> {
  return hostCtx().showMessageBox({
    type: opts.type ?? 'none',
    title: opts.title ?? '',
    message: opts.message,
    ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
    buttons: opts.buttons ?? [],
    ...(opts.defaultId !== undefined ? { defaultId: opts.defaultId } : {}),
    ...(opts.cancelId !== undefined ? { cancelId: opts.cancelId } : {}),
    ...(opts.checkboxLabel !== undefined ? { checkboxLabel: opts.checkboxLabel } : {}),
    ...(opts.checkboxChecked !== undefined ? { checkboxChecked: opts.checkboxChecked } : {}),
    ...(opts.noLink !== undefined ? { noLink: opts.noLink } : {}),
  });
}

// H1（共享给宿主窗口装配）：origin 精确比较（protocol+host+port），杜绝前缀/
// 异域/userinfo 逃逸；file: 一律拦截（同 webContents 下 file 页面仍持有
// preload 桥）。
export function isAllowedWebUrl(url: string): boolean {
  try {
    const target = new URL(url);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
    if (state.webUrl) {
      const base = new URL(state.webUrl);
      return target.origin === base.origin;
    }
    // WHATWG URL 把 IPv6 字面量序列化为带方括号的 hostname（'[::1]'），
    // 两种形态都要放行。
    return target.hostname === '127.0.0.1' || target.hostname === 'localhost'
      || target.hostname === '::1' || target.hostname === '[::1]';
  } catch {
    return false;
  }
}

/** createWindow 参数。 */
export interface CreateWindowOpts {
  /** true 时窗口创建后不主动显示（后台重建场景）。 */
  startHidden?: boolean;
}

/**
 * 创建主窗口（薄委托）：窗口构造、加载态页、导航/开窗围栏、右键菜单、快捷
 * 键、最大化同步、关闭按退出策略分流、BridgeSession 登记与恢复机挂接全部由
 * 宿主实现（legacy-shell：Wave 3 的 host-legacy-shell/windows.ts createMain）。无窗口
 * 能力的宿主（Node 测试 / sidecar 过渡期）静默返回。
 */
export function createWindow(opts: CreateWindowOpts = {}): void {
  hostCtx().windows?.createMain(opts);
}

// ---------------------------------------------------------------------------
// 会话浮窗（V4 多窗口）：浮窗的创建/复用/围栏/右键菜单由宿主
// HostWindows.openFloatWindow 承接（同一会话只保留一个浮窗、上限 FLOAT_MAX、
// 独立 partition 隔离 localStorage —— 见 state.floatSessions 注释）；
// lib 侧只保留会话登记的统一回收入口。
// ---------------------------------------------------------------------------

// 关闭全部浮窗（应用退出时调用）：逐个关闭宿主登记的浮窗会话并清空登记。
export function closeAllFloatWindows(): void {
  for (const session of state.floatSessions) {
    session.close();
  }
  state.floatSessions.clear();
  state.floatBySession.clear();
}

// ---------------------------------------------------------------------------
// 渲染进程自恢复：装配 renderer-recovery 状态机（上游 Issue #9 根治修复）
// ---------------------------------------------------------------------------

/**
 * 构建渲染进程自恢复状态机（renderer-recovery.ts，上游 Issue #9 根治）：
 * 把日志/退出态/服务存活/窗口重建/服务就绪等待等宿主能力适配进恢复机，
 * 幂等（已构建直接复用）。窗口挂接由 attachWindowToRecovery 供宿主接线。
 */
export function initRendererRecovery(): unknown {
  if (state.recovery) return state.recovery;
  const opts = {
    log: (msg: string): void => log('recovery', msg),
    isQuitting: (): boolean => state.quitting,
    isServerAlive: (): boolean =>
      !!state.serverProc && state.serverProc.exitCode === null && !state.serverProc.killed,
    getTarget: (): { kind: 'url'; url: string } | null =>
      state.webUrl ? { kind: 'url', url: state.webUrl } : null,
    loadingPage: path.join(__dirname, '..', 'assets', 'loading.html'),
    recoveryPage: path.join(__dirname, '..', 'assets', 'recovery.html'),
    // 窗口重建整体委托宿主（销毁旧窗 + createMain + 登记新桥会话并挂恢复机）；
    // 无窗宿主缺省 → 恢复机按重建失败计数。
    rebuildMainWindow: ({ startHidden }: { startHidden?: boolean } = {}): RecoveryWindow | null =>
      hostCtx().windows?.rebuildMainWindowForRecovery?.({ startHidden: !!startHidden }) ?? null,
    waitServerUp: (maxMs: number): Promise<string> => {
      if (!state.webUrl) return Promise.reject(new Error('webUrl 未知'));
      return waitUntilUp(state.webUrl, maxMs);
    },
    onGaveUp: (lastFailure: FailureRecord | null): void => {
      writeRunState({
        renderer: {
          state: 'gave-up',
          lastFailure: lastFailure ? `${lastFailure.reason}（exitCode=${lastFailure.exitCode}）` : 'unknown',
          at: new Date().toISOString(),
        },
      });
    },
    onStable: (): void => {
      writeRunState({ renderer: { state: 'healthy', at: new Date().toISOString() } });
    },
    // 系统通知经宿主上下文（legacy-shell Notification / sidecar 静默）：
    // 图标沿 assets/icon.png 绝对路径，点击唤回主窗（bridge 注入）。
    notify: (title: string, body: string): void => {
      hostCtx().notify({
        title,
        body,
        icon: path.join(__dirname, '..', 'assets', 'icon.png'),
        onClick: () => bridge.showMainWindow(),
      });
    },
  };
  state.recovery = new RendererRecovery(opts);
  return state.recovery;
}

/**
 * 把窗口挂到已构建的恢复状态机：宿主（host-legacy-shell/windows.ts）在
 * createMain / openFloatWindow 末尾调用（主窗 kind='main'、浮窗 'float'）；
 * state.recovery 未构建时静默跳过（boot 链保证 createWindow 前先
 * initRendererRecovery）。
 */
export function attachWindowToRecovery(win: RecoveryWindow, kind: WindowKind): void {
  if (state.recovery) state.recovery.attach(win, kind);
}

/** 每 15s 轮询一次恢复状态机的心跳判定（可见窗口失联才触发恢复流程）。 */
export function startHeartbeatLoop(): void {
  // renderer 心跳由 preload 每 5s 上报；这里周期性判定「可见窗口」是否失联
  // （窗口不可见时页面定时器被节流，判定只针对可见窗口）。
  setInterval(() => {
    if (state.recovery) state.recovery.checkHeartbeats();
  }, 15000).unref();
}

// 统一的「重新加载」入口：整体委托宿主（windows.reloadMain）——恢复页分支
// （已放弃自动恢复时改走恢复流程 retryNow）需要窗口对象，属宿主实现内部
// 职责。菜单与 Ctrl+R 共用。
export function reloadMainWindow(): void {
  hostCtx().windows?.reloadMain();
}
