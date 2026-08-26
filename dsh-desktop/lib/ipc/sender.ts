/**
 * lib/ipc/sender.ts — IPC 来源校验（Task 4 提取；Task 6.1 会话 token 化）。
 *
 * H 系列安全边界：所有敏感 handler 只接受「主窗会话」的调用；向导 handler
 * 只接受向导会话。集中一个判定函数，杜绝各 handler 自写校验时的口径漂移。
 *
 * Task 6.1：原实现比对 event.sender（legacy-shell webContents 身份）与
 * state.mainWindow.webContents；现比对来源会话 token 与宿主登记的
 * BridgeSession.id（legacy-shell 宿主两者同源 —— token 即 webContents.id，
 * 语义等价；sidecar 宿主 token 来自 WS 桥连接，Task 7 接入）。
 */

import { state } from '../state.js';
import type { IpcEvent } from './transport.js';

/** 事件来源是否为主窗会话。 */
export function fromMainSession(ev: IpcEvent): boolean {
  return !!state.mainSession && state.mainSession.isAlive() && ev.sender.sessionToken === state.mainSession.id;
}

/** 事件来源是否为内置插件选择向导会话。 */
export function fromWizardSession(ev: IpcEvent): boolean {
  return !!state.wizardSession && state.wizardSession.isAlive() && ev.sender.sessionToken === state.wizardSession.id;
}
