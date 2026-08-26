/**
 * lib/recovery-center/register-sidecar.ts — 恢复中心动作分发（Tauri sidecar
 * 适配，Task 3.5 自 main 侧 vnext-absorb 变体移植）。
 *
 * 与 register.ts（legacy-shell BrowserWindow + ipcMain 版）平行：Tauri 三层架构
 * 下窗口由 Rust 壳创建（main.rs open_recovery_center），本模块只提供：
 *   - init(ctx)：sidecar 启动时注入壳层/编排能力；
 *   - handleRcAction(action, value)：sidecar `rc.action` RPC 的动作分发
 *     （恢复中心页面经专用 preload 的 WS JSON-RPC 调用）；
 *   - archivePluginProfiles()：boot 链在 sync 后为全部插件建档。
 *
 * 动作引擎走 lib/desktop/* 过渡层（sidecar mount + ctx 注入的同一批模块
 * 实例，Node module cache 保证单例）；Task 6.4 统一 recovery-center 时与
 * register.ts 合流。lib/desktop 与根级 rescue-agent 经运行时 require 取
 * （类型断言），避免把过渡层拖进 erasableSyntaxOnly 严格编译程序。
 *
 * 三个入口（对应 legacy-shell 版）：
 *   1. 托盘常驻菜单「恢复中心…」（Rust 托盘项 → open_recovery_center）；
 *   2. 启动失败链（sidecar boot 失败 → 请求壳层打开恢复中心）；
 *   3. DSH_DESKTOP_RECOVERY=1（Rust 壳启动时检测并直开恢复中心窗口）。
 *
 * 动作复用既有引擎：plugin-ops（启停/移除）、guard-box（快照/回滚/事故）、
 * logger.buildDiagnosticsZip（诊断包）、supervisor/registry（档案/隔离标记）；
 * 安全模式 = guard 快照 + patch 只留核心行 + safe-mode.json + 请求壳层
 * relaunch 注入 DSH_DESKTOP_SAFE_MODE=1。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeModePatch } from '../../rescue-agent.js';
import { buildDiagnosticsZip } from '../../logger.js';
import { state } from '../state.js';
import { log } from '../log.js';
import {
  listRegistryEntries, setQuarantined, clearStartFailure,
  upsertLegacyPlugin,
} from '../supervisor/registry.js';

/** guard-box 快照/事故引擎面（sidecar mount 后与 lib/desktop 同实例）。 */
interface GuardApi {
  listSnapshots(): unknown[];
  listIncidents(): unknown[];
  snapshot(reason: string): { id: string } | null;
  lastGoodSnapshot(): { id: string } | null;
  restore(id: string): Record<string, unknown>;
}

import { ensureGuard } from '../guard.js';
import {
  pluginManagerCollect, pluginManagerSetEnabled, pluginManagerSetRemoved,
} from '../plugin-manager-core.js';
import { COMPANION_PLUGINS } from '../plugin-registry-data.js';
import { desktopProfileDir } from '../paths.js';

const bootState = (): { running: boolean } => ({ running: !!state.serverProc });

/** 由 sidecar 注入的壳层/编排能力（窗口创建在 Rust，这里只做请求）。 */
export interface RecoveryCenterCtx {
  appVersion: string;
  profile: string;
  /** 重启 Web 服务（走 sidecar 既有 boot.restart 全链路）。 */
  restartWebService(): Promise<{ ok: boolean; url?: string; error?: string }>;
  /** 请求壳层以安全模式 relaunch（Rust 侧 set env DSH_DESKTOP_SAFE_MODE=1 + restart）。 */
  requestSafeModeRelaunch(): void;
}

let ctx: RecoveryCenterCtx | null = null;

export function init(d: RecoveryCenterCtx): void {
  ctx = d;
}

// --- 安全模式状态（<dshHome>/guard/safe-mode.json；对齐 main.js 语义） ------

function safeModeStateFile(): string {
  return path.join(state.dshHome, 'guard', 'safe-mode.json');
}

function safeModeStatus(): { active: boolean; enteredAt?: string; snapshotId?: string } | null {
  try {
    const st = JSON.parse(fs.readFileSync(safeModeStateFile(), 'utf8')) as { active?: boolean };
    return st && st.active === true ? (st as { active: boolean; enteredAt?: string; snapshotId?: string }) : null;
  } catch {
    return null;
  }
}

function writeSafeModeJson(value: { active: boolean; enteredAt: string; snapshotId: string; removed: number }): void {
  try {
    fs.mkdirSync(path.dirname(safeModeStateFile()), { recursive: true });
    const tmp = safeModeStateFile() + '.tmp-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    try { fs.renameSync(tmp, safeModeStateFile()); } catch {
      fs.rmSync(safeModeStateFile(), { force: true, maxRetries: 3 });
      fs.renameSync(tmp, safeModeStateFile());
    }
  } catch (err) {
    log('recovery-center', '写 safe-mode.json 失败: ' + String((err as Error).message));
  }
}

/** 恢复中心动作分发（sidecar `rc.action` 方法）。未知动作/异常 → { ok:false }。 */
export async function handleRcAction(action: string, value?: unknown): Promise<Record<string, unknown>> {
  try {
    switch (action) {
      case 'status': {
        const g = ensureGuard();
        return {
          ok: true,
          appVersion: ctx ? ctx.appVersion : '',
          profile: ctx ? ctx.profile : '',
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
        return { ...res };
      }
      case 'remove': {
        const res = pluginManagerSetRemoved(String(value), true);
        if (res.ok) log('recovery-center', '移除插件 ' + String(value));
        return { ...res };
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
        if (!ctx) return { ok: false, error: 'recovery-center 未初始化' };
        const r = await ctx.restartWebService();
        return r.ok ? { ok: true, url: r.url } : { ok: false, error: r.error };
      }
      case 'safe-mode': {
        // 安全模式（对齐 main.js safeModeSet(true) 语义，Tauri 版）：
        // guard 快照 → patch 只留核心插件行 → 落 safe-mode.json →
        // 请求壳层 relaunch（重启后 companion-sync 的安全模式守卫不回写
        // 配套插件行，核心插件保持可用）。
        if (bootState().running && !state.restartingServer) {
          return { ok: false, error: 'service-running', hint: '请先停止 Web 服务（或从救援页进入安全模式）' };
        }
        const st = safeModeStatus();
        if (st) return { ok: false, error: 'already-on', hint: '安全模式已在启用状态' };
        const g = ensureGuard();
        const snap = g.snapshot('safe-mode-before');
        if (!snap) return { ok: false, error: '安全模式备份失败（无法创建 guard 快照）' };
        const patchFile = path.join(desktopProfileDir(), 'cordis.patch.yml');
        let text = '';
        try { text = fs.readFileSync(patchFile, 'utf8'); } catch { /* 无 patch 文件按空文本处理 */ }
        const rows = (() => { try { return pluginManagerCollect() as Array<{ id: string; core?: boolean }>; } catch { return []; } })();
        const coreIds = rows.filter((r) => r.core).map((r) => r.id);
        const { patch, removed } = safeModePatch(text, coreIds);
        try {
          if (patch !== text) fs.writeFileSync(patchFile, patch, 'utf8');
        } catch (err) {
          return { ok: false, error: '写入安全模式配置失败: ' + String((err as Error).message) };
        }
        writeSafeModeJson({
          active: true,
          enteredAt: new Date().toISOString(),
          snapshotId: snap.id,
          removed: removed.length,
        });
        state.quitting = true;
        state.forceQuit = true;
        if (ctx) ctx.requestSafeModeRelaunch();
        log('recovery-center', '安全模式已开启（核心 ' + coreIds.length + ' 个，移除 ' + removed.length + ' 个插件行）');
        return { ok: true, restartRequired: true, removed: removed.length, core: coreIds.length };
      }
      case 'snapshot': {
        const s = ensureGuard().snapshot('recovery-center');
        return s ? { ok: true, snapshot: s } : { ok: false, error: '快照创建失败' };
      }
      case 'rollback-last-good': {
        if (bootState().running && !state.restartingServer) {
          return { ok: false, error: 'service-running', hint: '请先重试启动失败/停止服务后再回滚' };
        }
        const last = ensureGuard().lastGoodSnapshot();
        if (!last) return { ok: false, error: 'no-good-snapshot' };
        return { ...ensureGuard().restore(last.id) };
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
        const zipPath = await buildDiagnosticsZip({
          logsDir: state.logsDir,
          userDataDir: state.userDataDir,
          dshHome: state.dshHome,
        });
        return { ok: true, zipPath };
      }
      default:
        return { ok: false, error: 'unknown action' };
    }
  } catch (err) {
    return { ok: false, error: String((err as Error).message) };
  }
}

// ---------------------------------------------------------------------------
// 插件档案批量登记（boot 链在 sync 后调用一次；与 legacy-shell 版语义一致）
// ---------------------------------------------------------------------------

/**
 * 为全部已装插件建档：内置配套表（source=builtin）+ patch 行里的其余插件
 * （source=market，市场/手工安装均走 dsh plugin add）。风险等级统一为
 * legacy-cordis（SDK 插件出现后由安装器写 isolated-sdk）。
 */
export function archivePluginProfiles(): void {
  try {
    for (const p of COMPANION_PLUGINS) {
      upsertLegacyPlugin({ id: p.id, source: 'builtin' });
    }
    // patch 行中登记、但不在内置表里的 = 市场/手工安装插件。
    const builtin = new Set(COMPANION_PLUGINS.map((p) => p.id));
    const rows = pluginManagerCollect() as Array<{ id: string; core?: boolean }>;
    for (const r of rows) {
      if (builtin.has(r.id) || r.core) continue;
      upsertLegacyPlugin({ id: r.id, source: 'market' });
    }
    log('recovery-center', '插件档案已登记到扩展注册表');
  } catch (err) {
    log('recovery-center', '插件档案登记失败: ' + String((err as Error).message));
  }
}
