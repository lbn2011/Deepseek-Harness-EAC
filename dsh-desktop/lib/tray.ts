/**
 * lib/tray.ts — 系统托盘与退出策略（Task 3.2 自 main.js 提取；Task 6 Wave 2
 * 宿主中立化：本模块不再 import legacy-shell）。
 *
 *   退出行为三档（ask/minimize/quit，含旧 closeToTray 布尔迁移）；
 *   showMainWindow（bridge 注入给各域通知回调）；
 *   buildTrayMenuSpec / executeTrayAction（菜单结构化规格 + 中立语义执行）；
 *   createTray / trayHintOnce（托盘生命周期，整体委托 hostCtx().tray）；
 *   repoUrls / showAbout（关于对话框）。
 *
 * Tray/Menu 的原生实现不驻留本模块：legacy-shell 实现由 Wave 3 在顶层
 * host-legacy-shell/ 提供（经 hostCtx().tray 注入），Tauri Rust 壳的托盘接线在
 * Task 8。宿主托盘实现契约：
 *   · create()：创建托盘后置位 state.trayActive（图标缺失等静默跳过时保持
 *     false；托盘存在性判断统一走 state.trayActive）；
 *   · 菜单规格实时经 buildTrayMenuSpec() 拉取（checkbox 态随设置变化），
 *     菜单项点击/勾选把 action（及 checkbox 新态）转发 executeTrayAction()；
 *   · 托盘单击/双击行为约定（对齐原 legacy-shell 实现）：单击＝主窗可见则隐藏、
 *     否则 showMainWindow()；双击＝showMainWindow()。
 */

import * as updater from '../updater.js';
import * as clientUpdater from '../client-updater.js';
import { state } from './state.js';
import { log } from './log.js';
import { IS_WIN, updCtx, dshVersion, dshVersionSource } from './proc.js';
import { restartWebServiceCore } from './server.js';
import { showBox } from './window.js';
import { openRecoveryCenter } from './recovery-center/register.js';
import { bridge } from './bridge.js';
import { hostCtx } from './host-ctx.js';

/** 托盘菜单项规格（宿主中立：宿主据此构建原生菜单）。 */
export interface TrayMenuItem {
  /** 展示文案（separator 项无）。 */
  label?: string;
  /** 菜单项类型（normal / separator / checkbox）。 */
  type: 'normal' | 'separator' | 'checkbox';
  /** checkbox 项当前勾选态（拉取规格时求值）。 */
  checked?: boolean;
  /** 语义动作 id（executeTrayAction 入口；separator 为空串，宿主不派发）。 */
  action: string;
}

/** 读取 closeToTray（默认 true：关闭主窗驻留托盘）。 */
export function closeToTrayEnabled(): boolean {
  const s = updater.loadSettings(updCtx());
  return s.closeToTray !== false;
}

/** 写 closeToTray 设置。 */
export function setCloseToTray(v: boolean): void {
  const s = updater.loadSettings(updCtx());
  s.closeToTray = !!v;
  updater.saveSettings(updCtx(), s);
}

// 退出行为三档：ask（每次询问）/ minimize（后台运行）/ quit（直接退出）。
// 旧版本只有 closeToTray 布尔开关，这里做迁移：closeToTray === false → quit，
// 显式 true → minimize（保持旧默认行为），未设置（新安装）→ ask。
export function getExitAction(): 'ask' | 'minimize' | 'quit' {
  const s = updater.loadSettings(updCtx());
  if (s.exitAction === 'ask' || s.exitAction === 'minimize' || s.exitAction === 'quit')
    return s.exitAction;
  if (s.closeToTray === false) return 'quit';
  if (s.closeToTray === true) return 'minimize';
  return 'ask';
}

/** 写退出行为（同步旧字段，避免降级回旧版本时行为回退）。 */
export function setExitAction(v: string): void {
  if (v !== 'ask' && v !== 'minimize' && v !== 'quit') return;
  const s = updater.loadSettings(updCtx());
  s.exitAction = v;
  // 同步旧字段，避免降级回旧版本时行为回退。
  s.closeToTray = v !== 'quit';
  updater.saveSettings(updCtx(), s);
}

// 退出确认弹窗（exitAction === "ask"）。带「记住我的选择」勾选框。
export async function askExitAction(): Promise<'quit' | 'minimize'> {
  const { response, checkboxChecked } = await showBox({
    type: 'question',
    title: '退出 Deepseek Harness',
    message: '要退出程序，还是在后台运行？',
    detail: '后台运行时窗口会隐藏到系统托盘，任务完成后会发通知。',
    buttons: ['最小化到后台', '退出程序'],
    defaultId: 0,
    cancelId: -1,
    checkboxLabel: '记住我的选择，不再询问',
    checkboxChecked: false,
    noLink: true,
  });
  const choice: 'quit' | 'minimize' = response === 1 ? 'quit' : 'minimize';
  if (checkboxChecked) setExitAction(choice);
  return choice;
}

/** 仓库地址（关于对话框与设置页展示）。 */
export function repoUrls(): { github: string; gitee: string } {
  const repos = clientUpdater.resolveRepos();
  return {
    github: 'https://github.com/' + repos.github,
    gitee: 'https://gitee.com/' + repos.gitee,
  };
}

/** 关于对话框（版本信息 + 仓库地址复制）。 */
export async function showAbout(): Promise<void> {
  const urls = repoUrls();
  const { response } = await showBox({
    type: 'info',
    title: '关于 Deepseek Harness EAC',
    message: 'Deepseek Harness EAC（封装版本 ' + hostCtx().appVersion() + '）',
    detail:
      'DeepSeek Harness 桌面客户端\n\nagent 版本：' +
      dshVersion() +
      '（' +
      dshVersionSource() +
      '）\n数据目录：' +
      state.userDataDir +
      '\nDSH_HOME：' +
      (state.dshHome || '（dsh 默认）') +
      '\n\n项目仓库：\n  GitHub: ' +
      urls.github +
      '\n  Gitee:  ' +
      urls.gitee +
      '\n\n交流群：EAC 交流群（群号 523412163）\n反馈问题：⋯ 菜单 → 反馈建议',
    buttons: ['复制 GitHub 地址', '复制 Gitee 地址', '确定'],
  });
  if (response === 0) hostCtx().copyToClipboard(urls.github);
  else if (response === 1) hostCtx().copyToClipboard(urls.gitee);
}

/**
 * 托盘菜单结构化规格：宿主实现（legacy-shell Wave 3 / Rust 壳 Task 8）据此构建
 * 原生菜单；checkbox 项勾选态每次拉取时求值。项集与原 legacy-shell 菜单一一对齐。
 */
export function buildTrayMenuSpec(): TrayMenuItem[] {
  return [
    { label: '显示 Deepseek Harness EAC', type: 'normal', action: 'show' },
    // VNext Phase 0：恢复中心常驻入口（不依赖 Web UI，插件故障时可达）。
    { label: '恢复中心…', type: 'normal', action: 'recovery-center' },
    { type: 'separator', action: '' },
    { label: '检查 dsh 更新…', type: 'normal', action: 'update-agent' },
    { label: '检查客户端更新…', type: 'normal', action: 'update-client' },
    {
      label: '会话完成通知',
      type: 'checkbox',
      checked: state.notifyOnTurnEnd,
      action: 'toggle-notify',
    },
    { type: 'separator', action: '' },
    // V4（用户建议④）：不关闭应用重启 dsh web 服务（皮肤/插件生效路径）。
    { label: '重启 Web 服务', type: 'normal', action: 'restart-service' },
    // 11be738：完全重启——跳过驻留确认直接退出并 relaunch（比重启 Web 服务
    // 更重：主进程状态/窗口全部重建，覆盖 Web 服务重启治不了的壳层故障）。
    { label: '完全重启', type: 'normal', action: 'full-restart' },
    { type: 'separator', action: '' },
    { label: '反馈建议…', type: 'normal', action: 'feedback' },
    { type: 'separator', action: '' },
    { label: '退出', type: 'normal', action: 'quit' },
  ];
}

/**
 * 托盘菜单动作的中立语义执行（宿主把菜单项点击/勾选转发到这里；action 为
 * buildTrayMenuSpec 的语义 id）。checkbox 动作带 checked＝宿主上报的新态，
 * 缺省时按取反处理。
 */
export function executeTrayAction(action: string, checked?: boolean): void {
  switch (action) {
    case 'show':
      showMainWindow();
      break;
    case 'recovery-center':
      openRecoveryCenter();
      break;
    case 'update-agent':
      showMainWindow();
      void bridge.runUpdateFlow(true);
      break;
    case 'update-client':
      showMainWindow();
      void bridge.runClientUpdateFlow(true);
      break;
    case 'toggle-notify': {
      const v = checked !== undefined ? checked : !state.notifyOnTurnEnd;
      state.notifyOnTurnEnd = v;
      const s = updater.loadSettings(updCtx());
      s.notifyOnTurnEnd = v;
      updater.saveSettings(updCtx(), s);
      break;
    }
    case 'restart-service':
      showMainWindow();
      void restartWebServiceCore();
      break;
    case 'full-restart':
      state.forceQuit = true;
      hostCtx().relaunch();
      hostCtx().requestQuit();
      break;
    case 'feedback':
      showMainWindow();
      hostCtx().openExternal('https://github.com/zouyuxuan122/Deepseek-Harness-EAC/issues');
      break;
    case 'quit':
      state.forceQuit = true;
      hostCtx().requestQuit();
      break;
  }
}

/** 首次驻留托盘时气泡提示一次。 */
export function trayHintOnce(): void {
  if (state.trayHintShown || !state.trayActive) return;
  state.trayHintShown = true;
  try {
    hostCtx().tray?.displayBalloon({
      title: 'Deepseek Harness EAC 仍在运行',
      content: '窗口已隐藏到系统托盘，点击托盘图标可重新打开。',
    });
  } catch {
    /* 气球通知失败静默 */
  }
}

/** 显示/聚焦主窗口（托盘、各域通知回调共用；bridge 注入）。 */
export function showMainWindow(): void {
  const w = hostCtx().windows;
  if (!w) return;
  if (w.isMainMinimized()) w.restoreMain();
  w.showMain();
  w.focusMain();
}

/**
 * 创建系统托盘（仅 Windows）：整体委托宿主托盘面（图标/tooltip/菜单/点击
 * 接线见文件头契约）。托盘存在性判断统一 state.trayActive（宿主置位）。
 */
export function createTray(): void {
  if (!IS_WIN) return;
  const tray = hostCtx().tray;
  if (!tray) return; // 无托盘宿主（Node 测试 / sidecar 过渡期）：静默降级
  try {
    tray.create();
    if (state.trayActive) log('boot', '系统托盘已就绪');
  } catch (err) {
    log('boot', '创建系统托盘失败: ' + String((err as Error).message));
  }
}
