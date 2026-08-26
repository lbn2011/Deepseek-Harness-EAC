/**
 * lib/ipc/session.ts — 会话/余额/文件域 IPC（Task 4 自 registerChromeIpc
 * 拆分；Task 6.1 传输面化）。
 *
 * chrome:float-window + float:close（会话浮窗）/ dsh:balance-refresh /
 * dsh:balance-prices-get/set/reset（价格自定义）/ dsh:file-revert（精确
 * 内容回退）/ dsh:file-open（文件视图打开，Skills 根白名单 + 危险扩展名
 * 围栏）。浮窗复用/新建/登记全部经 HostWindows.openFloatWindow。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as updater from '../../updater.js';
import * as balance from '../../balance.js';
import { state } from '../state.js';
import { log } from '../log.js';
import { hostCtx } from '../host-ctx.js';
import { updCtx } from '../proc.js';
import { DANGEROUS_EXT, isUnderFileRoots } from '../paths.js';
import { refreshBalance } from '../balance-ui.js';
import { FLOAT_MAX } from '../window.js';
import { fromMainSession } from './sender.js';
import type { IpcSurface } from './transport.js';

/** 文件还原的单条变更（写前/写后全文精确匹配）。 */
interface RevertChange {
  path?: unknown;
  oldText?: unknown;
  newText?: unknown;
}

/** 单条还原结果。 */
interface RevertResult {
  path: string;
  status: string;
  error?: string;
}

/** 注册会话/余额/文件域全部 channel（清单见文件头；boot 时经 lib/ipc/index.ts 统一调用）。 */
export function registerSessionIpc(surface: IpcSurface): void {
  // 会话浮窗（V4 多窗口）：主窗请求把某个会话弹出到独立窗口（校验来源；
  // 复用/数量上限/登记由宿主 openFloatWindow 承接——同一会话只保留一个
  // 浮窗，复用分支不受上限约束）。
  surface.handle('chrome:float-window', (payload, ev) => {
    if (!fromMainSession(ev)) return { ok: false, error: 'unauthorized' };
    const { action, sessionId } = (payload ?? {}) as { action?: string; sessionId?: unknown };
    if (action !== 'open') return { ok: false, error: 'bad-action' };
    if (!state.webUrl) return { ok: false, error: 'not-ready' };
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: 'bad-session' };
    const w = hostCtx().windows;
    if (!w || state.floatSessions.size >= FLOAT_MAX) return { ok: false, error: 'too-many' };
    return w.openFloatWindow(sessionId);
  });

  // 浮窗关闭：仅允许浮窗关闭自身（来源 token 命中已登记浮窗会话才关）。
  surface.on('float:close', (_payload, ev) => {
    hostCtx().windows?.closeFloatByToken(ev.sender.sessionToken);
  });

  surface.handle('dsh:balance-refresh', async (_payload, ev) => {
    if (!fromMainSession(ev)) return state.balanceCache;
    return refreshBalance();
  });

  // Token 价格自定义（V4.2，dsh-balance 插件「价格设置」页）：读写
  // settings.json 的 balancePrices.<model>.{peak,offpeak}（¥/百万 token，
  // 三字段 cacheMiss/cacheHit/output，必须为 >= 0 的数字）。保存后立即
  // 重推余额数据，dock 的费用估算即时生效。
  surface.handle('dsh:balance-prices-get', async (payload, ev) => {
    if (!fromMainSession(ev)) return { ok: false, error: 'unauthorized' };
    const { model } = (payload ?? {}) as { model?: unknown };
    const s = updater.loadSettings(updCtx());
    const defaults = balance.DEFAULT_PRICES[String(model ?? '')] ?? balance.FALLBACK_PRICES;
    const prices = s.balancePrices as Record<string, unknown> | undefined;
    const current = (prices && prices[String(model ?? '')]) || null;
    return { ok: true, model: String(model ?? ''), defaults, current };
  });

  surface.handle('dsh:balance-prices-set', async (payload, ev) => {
    if (!fromMainSession(ev)) return { ok: false, error: 'unauthorized' };
    const { model, prices } = (payload ?? {}) as { model?: unknown; prices?: unknown };
    const m = String(model ?? '');
    if (!balance.DEFAULT_PRICES[m]) return { ok: false, error: '未知模型: ' + m };
    try {
      const cleaned = balance.sanitizePrices(
        prices as { peak?: unknown; offpeak?: unknown } | null | undefined,
      );
      const ctx = updCtx();
      const s = updater.loadSettings(ctx);
      if (!s.balancePrices || typeof s.balancePrices !== 'object') s.balancePrices = {};
      (s.balancePrices as Record<string, unknown>)[m] = cleaned;
      updater.saveSettings(ctx, s);
      await refreshBalance();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message) };
    }
  });

  surface.handle('dsh:balance-prices-reset', async (payload, ev) => {
    if (!fromMainSession(ev)) return { ok: false, error: 'unauthorized' };
    const { model } = (payload ?? {}) as { model?: unknown };
    const m = String(model ?? '');
    try {
      const ctx = updCtx();
      const s = updater.loadSettings(ctx);
      const prices = s.balancePrices as Record<string, unknown> | undefined;
      if (prices && prices[m]) {
        delete prices[m];
        updater.saveSettings(ctx, s);
      }
      await refreshBalance();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message) };
    }
  });

  // 文件还原（「文件」视图的回退）：按会话日志里已持久化的写前/写后全文，
  // 做精确内容匹配后替换 —— 只有内容一致才动手，天然幂等且安全。
  surface.handle('dsh:file-revert', async (payload, ev) => {
    if (!fromMainSession(ev)) return { results: [] };
    const { changes } = (payload ?? {}) as { changes?: unknown };
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 300)
      return { results: [] };
    const results: RevertResult[] = [];
    for (const c of changes as RevertChange[]) {
      const p = String((c && c.path) || '');
      const oldText = String((c && c.oldText) ?? '');
      const newText = String((c && c.newText) ?? '');
      if (!path.isAbsolute(p) || oldText.length > 400000 || newText.length > 400000) {
        results.push({ path: p, status: 'invalid' });
        continue;
      }
      if (!isUnderFileRoots(p)) {
        results.push({ path: p, status: 'forbidden' });
        continue;
      }
      try {
        const exists = fs.existsSync(p);
        const content = exists ? fs.readFileSync(p, 'utf8') : null;
        if (oldText === '' && newText !== '') {
          // 新建 → 删除（内容必须仍是 agent 写入的原文）
          if (content !== null && content === newText) {
            fs.rmSync(p);
            results.push({ path: p, status: 'reverted' });
          } else {
            results.push({ path: p, status: content === null ? 'missing' : 'conflict' });
          }
        } else if (newText === '' && oldText !== '') {
          // 删除 → 恢复（文件必须仍不存在）
          if (content === null) {
            fs.writeFileSync(p, oldText, 'utf8');
            results.push({ path: p, status: 'reverted' });
          } else {
            results.push({ path: p, status: 'conflict' });
          }
        } else {
          if (content !== null && content.includes(newText)) {
            fs.writeFileSync(p, content.replace(newText, oldText), 'utf8');
            results.push({ path: p, status: 'reverted' });
          } else if (content !== null && content === oldText) {
            results.push({ path: p, status: 'skipped' });
          } else {
            results.push({ path: p, status: content === null ? 'missing' : 'conflict' });
          }
        }
      } catch (err) {
        results.push({ path: p, status: 'failed', error: String((err as Error).message) });
      }
    }
    log('file-revert', JSON.stringify(results.slice(0, 20)));
    return { results };
  });

  // 「全部文件」视图的打开请求：用系统默认程序打开项目文件。
  surface.handle('dsh:file-open', async (payload, ev) => {
    if (!fromMainSession(ev)) return { ok: false, error: 'forbidden' };
    const { path: p } = (payload ?? {}) as { path?: unknown };
    if (typeof p !== 'string' || !path.isAbsolute(p))
      return { ok: false, error: 'path must be absolute' };
    // Skills 根目录（~/.dsh/skills、~/.agents/skills）不在会话工作区内，但
    // 「设置 → Skills 与 MCP → 打开目录」需要放行；严格限定为两个根本身及其
    // 子路径（白名单，非任意路径），危险扩展名检查仍生效。
    const skillsRoots = [
      path.join(state.dshHome || path.join(os.homedir(), '.dsh'), 'skills'),
      path.join(process.env.DSH_AGENTS_HOME || path.join(os.homedir(), '.agents'), 'skills'),
    ];
    const underSkillsRoot = skillsRoots.some((r) => {
      const rp = path.resolve(r);
      return p === rp || p.startsWith(rp + path.sep);
    });
    if (!underSkillsRoot && !isUnderFileRoots(p))
      return { ok: false, error: 'path outside session workspace' };
    if (DANGEROUS_EXT.test(p))
      return { ok: false, error: 'executable files are not openable from the file view' };
    try {
      if (!fs.existsSync(p)) return { ok: false, error: 'file not found' };
      hostCtx().openPath(p);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message) };
    }
  });
}
