/**
 * lib/recovery-center/register.ts — 恢复中心（VNext Phase 0，Task 8；Task 6
 * Wave 2 宿主中立化：本模块不再 import legacy-shell）。
 *
 * 独立恢复中心窗口（assets/recovery-center.html + 专用 preload），不依赖
 * dsh web 与主窗 —— 任意 plugin tree 启动失败时用户必定能进入这里关闭/
 * 卸载/回滚/隔离问题插件（架构文档 §3.4 / §9 Phase 0 交付标准）。
 *
 * 窗口生命周期整体委托宿主（HostWindows.openRecoveryCenter /
 * closeRecoveryCenter；legacy-shell 实现在 Wave 3 的顶层 host-legacy-shell/，Tauri
 * 壳对应 main.rs 窗口）。宿主开窗时把窗口的 BridgeSession 登记进
 * state.rcSession（窗口关闭时清空），rc:action / rc:close 的来源校验据此
 * 比对会话 token（取代原 event.sender === rcWindow.webContents 的
 * legacy-shell webContents 身份比对，语义等价）。
 *
 * 三个入口：
 *   1. 托盘常驻菜单「恢复中心…」（lib/tray.ts）；
 *   2. 启动失败链（lib/boot.ts handleBootFailure/fatal 的按钮）；
 *   3. DSH_DESKTOP_RECOVERY=1 直开（main.ts，跳过常规 boot）。
 *
 * IPC 单通道 rc:action（注册在宿主 IpcSurface 上；来源校验：恢复中心会话）。
 * 动作复用既有引擎：pluginManagerSetEnabled/SetRemoved（启停/移除）、
 * plugin-guard（快照/回滚/事故）、structuredLogger.buildDiagnosticsZip
 * （诊断包）、registry（档案/隔离标记）；安全模式 = relaunch 注入
 * DSH_DESKTOP_SAFE_MODE=1（lib/plugins 的 sync 检测该标记并把全部非核心
 * 配套插件按 disabled 写行）。版本号经 hostCtx().appVersion()、文件定位经
 * hostCtx().showItemInFolder()、重启/退出经 hostCtx().relaunch()/exitProcess()。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as structuredLogger from '../../logger.js';
import { state } from '../state.js';
import { log } from '../log.js';
import { desktopProfile, desktopProfileDir } from '../paths.js';
import { ensureGuard } from '../guard.js';
import { restartWebServiceCore } from '../server.js';
import { hostCtx } from '../host-ctx.js';
import { defaultIpcSurface, type IpcSurface, type IpcEvent } from '../ipc/transport.js';
import {
  pluginManagerCollect, pluginManagerSetEnabled, pluginManagerSetRemoved,
} from '../plugin-manager-core.js';
import {
  listRegistryEntries, setQuarantined, clearStartFailure,
  upsertLegacyPlugin,
} from '../supervisor/registry.js';
import { COMPANION_PLUGINS } from '../plugin-registry-data.js';

/**
 * 打开（或聚焦既有）恢复中心窗口：窗口创建/聚焦整体委托宿主窗口面（宿主
 * 同时登记 state.rcSession）。IPC 先于开窗注册（对齐原实现的注册顺序，
 * 渲染端首个 rc:action 不会竞态）。
 */
export function openRecoveryCenter(): void {
  const windows = hostCtx().windows;
  if (!windows) {
    // 无窗宿主（Node 测试 / sidecar 过渡期）：恢复中心窗口不可达。
    // sidecar 宿主的恢复中心走 register-sidecar.ts 的 rc.action RPC。
    log('recovery-center', '宿主无窗口能力，无法打开恢复中心');
    return;
  }
  registerRecoveryCenterIpc();
  windows.openRecoveryCenter();
  log('recovery-center', '恢复中心已打开');
}

/** 来源校验：只接受恢复中心会话（宿主开窗时登记 state.rcSession）。 */
function fromRecoverySession(ev: IpcEvent): boolean {
  return !!state.rcSession && state.rcSession.isAlive() && ev.sender.sessionToken === state.rcSession.id;
}

/** IPC 只注册一次（窗口可反复开关）。 */
let ipcRegistered = false;

function registerRecoveryCenterIpc(surface: IpcSurface = defaultIpcSurface()): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  surface.on('rc:close', (_payload, ev) => {
    if (fromRecoverySession(ev)) hostCtx().windows?.closeRecoveryCenter();
  });

  surface.handle('rc:action', async (payload, ev) => {
    if (!fromRecoverySession(ev)) return { ok: false, error: 'unauthorized' };
    const { action, value } = (payload ?? {}) as { action?: string; value?: unknown };
    try {
      switch (action) {
        case 'status': {
          const g = ensureGuard();
          return {
            ok: true,
            appVersion: hostCtx().appVersion(),
            profile: desktopProfile(),
            plugins: listRegistryEntries(),
            snapshots: g.listSnapshots().slice(0, 20),
            incidents: g.listIncidents().slice(0, 20),
          };
        }
        case 'disable':
        case 'enable': {
          const enabled = action === 'enable';
          const res = pluginManagerSetEnabled(String(value), enabled);
          if (res.ok) {
            clearStartFailure(String(value));
            log('recovery-center', (enabled ? '启用' : '停用') + '插件 ' + String(value));
          }
          return res;
        }
        case 'remove': {
          const res = pluginManagerSetRemoved(String(value), true);
          if (res.ok) log('recovery-center', '移除插件 ' + String(value));
          return res;
        }
        case 'quarantine': {
          const ok = setQuarantined(String(value), true);
          log('recovery-center', '隔离插件 ' + String(value) + (ok ? '' : '（未登记）'));
          return ok
            ? { ok: true }
            : { ok: false, error: '注册表中无此插件档案' };
        }
        case 'unquarantine': {
          const ok = setQuarantined(String(value), false);
          clearStartFailure(String(value));
          return ok ? { ok: true } : { ok: false, error: '注册表中无此插件档案' };
        }
        case 'retry-boot': {
          const r = await restartWebServiceCore();
          return r.ok ? { ok: true, url: r.url } : { ok: false, error: r.error };
        }
        case 'safe-mode': {
          // 安全模式：relaunch 前注入进程环境标记（RelaunchOptions 不支持
          // env，子进程继承当前 env），lib/plugins 的 sync 据此把全部非核心
          // 配套插件按 disabled 写行（核心插件保持可用）。
          state.quitting = true;
          state.forceQuit = true;
          process.env.DSH_DESKTOP_SAFE_MODE = '1';
          hostCtx().relaunch();
          hostCtx().exitProcess(0);
          return { ok: true };
        }
        case 'snapshot': {
          const s = ensureGuard().snapshot('recovery-center');
          return s ? { ok: true, snapshot: s } : { ok: false, error: '快照创建失败' };
        }
        case 'rollback-last-good': {
          if (state.serverProc && !state.restartingServer) {
            return { ok: false, error: 'service-running', hint: '请先重试启动失败/停止服务后再回滚' };
          }
          const last = ensureGuard().lastGoodSnapshot();
          if (!last) return { ok: false, error: 'no-good-snapshot' };
          return ensureGuard().restore(last.id);
        }
        case 'read-log': {
          const file = String(value || 'desktop.log');
          // 白名单：只读两个桌面侧日志，杜绝任意文件读取。
          const allowed = ['desktop.log', 'dsh-web.log'];
          if (!allowed.includes(file)) return { ok: false, error: 'forbidden' };
          try {
            const p = path.join(state.logsDir, file);
            const TAIL = 32 * 1024;
            const size = fs.statSync(p).size;
            const len = Math.min(size, TAIL);
            const buf = Buffer.alloc(len);
            const fd = fs.openSync(p, 'r');
            try {
              fs.readSync(fd, buf, 0, len, Math.max(0, size - TAIL));
            } finally {
              fs.closeSync(fd);
            }
            return { ok: true, tail: buf.toString('utf8') };
          } catch (err) {
            return { ok: false, error: String((err as Error).message) };
          }
        }
        case 'export-logs': {
          const zipPath = await structuredLogger.buildDiagnosticsZip({
            logsDir: state.logsDir,
            userDataDir: state.userDataDir,
            dshHome: state.dshHome,
          });
          hostCtx().showItemInFolder(zipPath);
          return { ok: true, zipPath };
        }
        default:
          return { ok: false, error: 'unknown action' };
      }
    } catch (err) {
      return { ok: false, error: String((err as Error).message) };
    }
  });
}

// ---------------------------------------------------------------------------
// Phase 0.3：插件档案批量登记（boot 链在 sync 后调用一次）
// ---------------------------------------------------------------------------

/**
 * 为全部已装插件建档：内置配套表（source=builtin）+ patch 行里的其余插件
 * （source=market，市场/手工安装均走 dsh plugin add）。风险等级 Phase 0
 * 统一为 legacy-cordis（SDK 插件出现后由安装器写 isolated-sdk）。
 */
export function archivePluginProfiles(): void {
  try {
    for (const p of COMPANION_PLUGINS) {
      upsertLegacyPlugin({ id: p.id, source: 'builtin' });
    }
    // patch 行中登记、但不在内置表里的 = 市场/手工安装插件。
    const builtin = new Set(COMPANION_PLUGINS.map((p) => p.id));
    const rows = pluginManagerCollect() as { id: string; core?: boolean }[];
    for (const r of rows) {
      if (builtin.has(r.id) || r.core) continue;
      upsertLegacyPlugin({ id: r.id, source: 'market' });
    }
    log('recovery-center', '插件档案已登记到扩展注册表');
  } catch (err) {
    log('recovery-center', '插件档案登记失败: ' + String((err as Error).message));
  }
}
