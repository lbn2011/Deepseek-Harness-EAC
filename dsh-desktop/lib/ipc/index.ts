/**
 * lib/ipc/index.ts — IPC 注册总入口（Task 4；Task 6.1 传输面化）。
 *
 * 按域拆分：app（外壳/菜单）/ recovery（恢复页/心跳/诊断导出）/ plugin
 * （保护中心/管理/更新/图片粘贴）/ onboard（选择向导）/ session（浮窗/
 * 余额/文件）。channel 名与行为与拆分前的 registerChromeIpc 一一对齐。
 *
 * Task 6.1：注册面从 ipcMain 换成注入的 IpcSurface——boot 链不传参时取
 * 宿主装配期注入的缺省注册面（legacy-shell main.ts 的 legacy-shellIpcSurface() /
 * sidecar 的 JSON-RPC 注册面）；测试直接传 createRecordingIpcSurface()。
 */

import { defaultIpcSurface, type IpcSurface } from './transport.js';
import { registerAppIpc } from './app.js';
import { registerRecoveryIpc } from './recovery.js';
import { registerPluginIpc } from './plugin.js';
import { registerOnboardIpc } from './onboard.js';
import { registerSessionIpc } from './session.js';
import { registerSnapshotIpc } from './snapshot.js';

/**
 * 注册全部 IPC handler（boot 链在 createWindow 之前调用一次）。
 * surface 省缺时取宿主装配期注入的缺省注册面。
 */
export function registerIpc(surface?: IpcSurface): void {
  const sf = surface ?? defaultIpcSurface();
  registerAppIpc(sf);
  registerRecoveryIpc(sf);
  registerPluginIpc(sf);
  registerOnboardIpc(sf);
  registerSessionIpc(sf);
  registerSnapshotIpc(sf);
}
