/**
 * lib/hot-update/engine.ts — 热更新状态机编排。
 *
 * 状态转移（每次先落盘再行动）：
 *   IDLE → RESOLVED → DOWNLOADED → STAGED → SNAPSHOTTED → APPLYING → APPLIED
 *        → RESTART →（重启后 onBootSuccess）→ COMMITTED → IDLE
 * 与主设计 §7.2 的差异：STAGED（解包+校验）先于 SNAPSHOTTED（快照），因快照
 * 需要 hu-manifest 的 files[]；崩溃安全语义不变——SNAPSHOTTED 之前安装树未动。
 *
 * 崩溃恢复（init）：IDLE..SNAPSHOTTED 丢弃 staging；APPLYING/APPLIED 从快照
 * 恢复（shell exe 例外：文件锁归 Rust boot-attempts 熔断处理）；RESTART 等
 * 待本轮 boot 验证（onBootSuccess 提交 / onBootFailure 计数，≥3 熔断回滚）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { computeSha256, downloadWithSourceSwitch, isNoSpaceError } from '../client-update/index.js';
import { exchangeFiles, restoreFromBackup, snapshotBeforeApply, unpackAndVerify } from './apply.js';
import { spawnShellSwap } from './shell-swap.js';
import { fetchManifest, proxiedUrls, resolveApplicable, type Resolution } from './manifest.js';
import {
  clearStaging,
  clearStagingAndBackups,
  huDirs,
  loadState,
  pruneOldBackups,
  saveState,
  type HuDirs,
} from './store.js';
import type { HuManifest, HuState, HotComponent, HotUpdateCtx } from './types.js';

const MAX_VERIFY_ATTEMPTS = 3;

export interface HotUpdateApi {
  /** 启动初始化：基线协调 + 崩溃恢复 + 备份清理。 */
  init(): void;
  /** 拉取清单并解析/应用（manual=菜单手动检查）。返回给 UI 的摘要。 */
  checkOnce(opts?: { manual?: boolean }): Promise<{ status: string; seq?: number; message?: string }>;
  /** boot.start 成功后调用：VERIFIED → COMMITTED。 */
  onBootSuccess(): void;
  /** boot 失败时调用：verifyAttempts 计数，≥3 熔断回滚（FF6）。 */
  onBootFailure(): void;
  /** 救援中心「回滚最近热更新」。 */
  rollbackLatest(): Promise<{ ok: boolean; message: string }>;
  getState(): HuState;
}

interface BaselineFile {
  baselineSeq: number;
  appVersion: string;
  components?: Partial<Record<HotComponent, { seq: number; version: string }>>;
}

function huLog(ctx: HotUpdateCtx, msg: string): void {
  ctx.log('hot-update', msg);
  try {
    const dirs = huDirs(ctx.userDataDir);
    fs.mkdirSync(dirs.logs, { recursive: true });
    fs.appendFileSync(path.join(dirs.logs, 'hotupdate.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* 日志失败不阻塞 */
  }
}

function progress(ctx: HotUpdateCtx, stage: string, extra: Record<string, unknown> = {}): void {
  ctx.notify('client-update.progress', { channel: 'hotupdate', stage, ...extra });
}

export function createHotUpdate(ctx: HotUpdateCtx): HotUpdateApi {
  const dirs: HuDirs = huDirs(ctx.userDataDir);

  const save = (state: HuState): void => saveState(dirs, state);

  function restoreAllBackups(state: HuState, skipShellExe: boolean): void {
    if (!state.pending) return;
    const opts: { skipPath?: (p: string) => boolean } = {};
    if (skipShellExe) opts.skipPath = (p: string) => p === 'dsh-eac-shell.exe';
    for (const name of Object.values(state.pending.backups || {})) {
      if (!name) continue;
      const backupDir = path.join(dirs.backups, name);
      if (!fs.existsSync(backupDir)) continue;
      try {
        restoreFromBackup(ctx.installRoot, backupDir, opts);
      } catch (err) {
        if (err instanceof Error && /EPERM|EBUSY/.test(err.message)) {
          // 锁定文件（运行中 exe/node 脚本）：留待 Rust 熔断或下一轮恢复
          huLog(ctx, `快照恢复遇锁定文件（${name}），跳过: ${err.message}`);
          continue;
        }
        throw err;
      }
    }
  }

  async function apply(resolution: Resolution, state: HuState): Promise<void> {
    state.pending = {
      seq: resolution.seq,
      components: Object.fromEntries(resolution.components.map((c) => [c.name, c.ref])),
      restartLevel: resolution.restartLevel,
      backups: {},
    };
    state.phase = 'RESOLVED';
    save(state);
    huLog(ctx, `开始应用热更新 seq=${resolution.seq}（${resolution.components.map((c) => c.name).join('+')}）`);
    progress(ctx, 'downloading', { seq: resolution.seq });

    const manifests: { name: HotComponent; hu: HuManifest }[] = [];
    for (const comp of resolution.components) {
      const zipPath = path.join(dirs.staging, String(resolution.seq), `${comp.name}.zip`);
      fs.mkdirSync(path.dirname(zipPath), { recursive: true });
      await downloadWithSourceSwitch(proxiedUrls(comp.ref.url), zipPath, {
        ctx: { log: (tag: string, msg: string) => huLog(ctx, msg) } as never,
      });
      const got = await computeSha256(zipPath);
      if (got !== comp.ref.sha256) {
        throw new Error(`包 sha256 校验失败（${comp.name}，期望 ${comp.ref.sha256.slice(0, 12)}…）：应用中止，现版本继续运行`);
      }
      state.phase = 'DOWNLOADED';
      save(state);

      const stagedDir = path.join(dirs.staging, String(resolution.seq), comp.name);
      const hu = await unpackAndVerify(zipPath, stagedDir);
      manifests.push({ name: comp.name, hu });
      state.phase = 'STAGED';
      save(state);

      const backupName = `${hu.seq}-${Date.now()}`;
      snapshotBeforeApply(ctx.installRoot, path.join(dirs.backups, backupName), hu, ctx.appVersion);
      state.pending.backups[comp.name] = backupName;
      save(state);
      state.phase = 'SNAPSHOTTED';
      save(state);
    }

    progress(ctx, 'applying', { seq: resolution.seq });
    state.phase = 'APPLYING';
    save(state);
    for (const { name, hu } of manifests) {
      const stagedDir = path.join(dirs.staging, String(resolution.seq), name);
      exchangeFiles(ctx.installRoot, stagedDir, hu);
      state.components[name] = { seq: hu.seq, version: hu.version };
    }
    state.appliedSeq = Math.max(state.appliedSeq, resolution.seq);
    state.phase = 'APPLIED';
    save(state);

    progress(ctx, 'restarting', { seq: resolution.seq });
    state.phase = 'RESTART';
    state.verifyAttempts = 0;
    save(state);
    if (resolution.restartLevel === 'app-restart') {
      // shell 组件：detached 交换脚本负责等解锁/备份/覆盖/重启
      const shellComp = manifests.find((m) => m.name === 'shell');
      const newExe = path.join(dirs.staging, String(resolution.seq), 'shell', 'dsh-eac-shell.exe');
      const currentExe = process.env.DSH_SHELL_EXE || path.join(ctx.installRoot, 'dsh-eac-shell.exe');
      if (!shellComp || !fs.existsSync(newExe)) throw new Error('shell 包缺 dsh-eac-shell.exe');
      spawnShellSwap(newExe, currentExe, path.join(dirs.root, 'shell-swap'));
      huLog(ctx, 'shell 交换脚本已 detached 启动，退出当前壳');
      ctx.quitForUpdate();
      return;
    }
    huLog(ctx, '热更文件交换完成，触发 sidecar 重生');
    ctx.restartSidecar();
  }

  function abortFailedApply(state: HuState, err: unknown, touched: boolean): void {
    huLog(ctx, `热更新中止 @${state.phase}: ${err instanceof Error ? err.message : String(err)}`);
    if (touched) {
      try {
        restoreAllBackups(state, true);
      } catch (restoreErr) {
        huLog(ctx, `中止回滚也失败: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`);
      }
    }
    const seq = state.pending?.seq;
    if (touched && seq != null && !state.blockedSeqs.includes(seq)) state.blockedSeqs.push(seq);
    state.pending = null;
    state.phase = 'IDLE';
    save(state);
    clearStaging(dirs);
    ctx.notify('client-update.hide', {});
  }

  return {
    init(): void {
      fs.mkdirSync(dirs.staging, { recursive: true });
      fs.mkdirSync(dirs.backups, { recursive: true });
      const state = loadState(dirs);

      // 基线协调（FF5）：正式更新后的新树 baselineSeq > state.appliedSeq → 重置
      try {
        const baselinePath = path.join(ctx.installRoot, 'hotupdate-baseline.json');
        if (fs.existsSync(baselinePath)) {
          const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as BaselineFile;
          if ((baseline.baselineSeq || 0) > state.appliedSeq) {
            huLog(ctx, `基线协调：安装树 baselineSeq=${baseline.baselineSeq} > state=${state.appliedSeq}，重置状态`);
            const fresh = loadState(dirs);
            fresh.baselineSeq = baseline.baselineSeq;
            fresh.appliedSeq = baseline.baselineSeq;
            fresh.components = baseline.components || {};
            fresh.phase = 'IDLE';
            fresh.pending = null;
            fresh.blockedSeqs = [];
            fresh.verifyAttempts = 0;
            save(fresh);
            clearStagingAndBackups(dirs);
            pruneOldBackups(dirs);
            return;
          }
        }
      } catch (err) {
        huLog(ctx, `基线文件解析失败（忽略）: ${err instanceof Error ? err.message : String(err)}`);
      }

      switch (state.phase) {
        case 'IDLE':
        case 'RESOLVED':
        case 'DOWNLOADED':
        case 'STAGED':
        case 'SNAPSHOTTED':
          // 安装树未动：丢弃现场即可
          if (state.phase !== 'IDLE') huLog(ctx, `崩溃恢复：丢弃 ${state.phase} 现场`);
          state.pending = null;
          state.phase = 'IDLE';
          save(state);
          clearStaging(dirs);
          break;
        case 'APPLYING':
        case 'APPLIED': {
          // 交换被打断：从快照恢复到应用前，seq 入黑名单
          const seq = state.pending?.seq;
          huLog(ctx, `崩溃恢复：${state.phase} 残留，回滚快照（seq=${seq}）`);
          restoreAllBackups(state, true);
          if (seq != null && !state.blockedSeqs.includes(seq)) state.blockedSeqs.push(seq);
          state.pending = null;
          state.phase = 'IDLE';
          save(state);
          break;
        }
        case 'RESTART':
        case 'VERIFIED':
          // 重启后首次 boot：等待 onBootSuccess/onBootFailure 验证
          huLog(ctx, `热更新 seq=${state.pending?.seq} 待验证（attempt=${state.verifyAttempts + 1}）`);
          break;
        default:
          state.phase = 'IDLE';
          save(state);
      }
      pruneOldBackups(dirs);
    },

    async checkOnce(opts: { manual?: boolean } = {}): Promise<{ status: string; seq?: number; message?: string }> {
      const state = loadState(dirs);
      state.lastCheckAt = new Date().toISOString();
      save(state);
      if (state.phase !== 'IDLE') return { status: 'busy', message: `状态机非空闲（${state.phase}）` };
      let manifest;
      try {
        manifest = await fetchManifest((m) => huLog(ctx, m));
      } catch (err) {
        // 自动检查静默失败；手动检查报错给 UI
        const message = `清单拉取失败: ${err instanceof Error ? err.message : String(err)}`;
        if (opts.manual) throw new Error(message);
        return { status: 'error', message };
      }
      const resolution = resolveApplicable(manifest, state, ctx.appVersion);
      if (!resolution) {
        if (opts.manual) huLog(ctx, '手动检查：无适用热更新');
        return { status: 'up-to-date' };
      }
      if (opts.manual) {
        const ok = ctx.confirm ? await ctx.confirm(resolution) : true;
        if (!ok) return { status: 'declined', seq: resolution.seq };
      } else if (ctx.confirm) {
        const ok = await ctx.confirm(resolution);
        if (!ok) return { status: 'declined', seq: resolution.seq };
      } else {
        // 无同意通道：仅广播可用性，不自动动安装树
        ctx.notify('client-update.progress', { channel: 'hotupdate', stage: 'available', seq: resolution.seq, title: resolution.title });
        return { status: 'available', seq: resolution.seq };
      }
      try {
        await apply(resolution, state);
        return { status: 'applied', seq: resolution.seq };
      } catch (err) {
        const cur = loadState(dirs);
        abortFailedApply(cur, err, ['APPLYING', 'APPLIED', 'RESTART'].includes(cur.phase));
        const message = isNoSpaceError(err) ? (err as Error).message : `热更新失败: ${err instanceof Error ? err.message : String(err)}`;
        if (opts.manual) throw new Error(message);
        return { status: 'error', message };
      }
    },

    onBootSuccess(): void {
      const state = loadState(dirs);
      if (state.phase !== 'RESTART' && state.phase !== 'VERIFIED') return;
      const seq = state.pending?.seq;
      huLog(ctx, `热更新 seq=${seq} 验证通过，提交`);
      state.phase = 'IDLE';
      state.verifyAttempts = 0;
      state.pending = null;
      save(state);
      clearStaging(dirs); // 备份保留 14 天（pruneOldBackups）
      ctx.notify('client-update.hide', {});
      progress(ctx, 'done', { seq });
    },

    onBootFailure(): void {
      const state = loadState(dirs);
      if (state.phase !== 'RESTART' && state.phase !== 'VERIFIED') return;
      state.verifyAttempts += 1;
      const seq = state.pending?.seq;
      huLog(ctx, `boot 失败，验证计数 ${state.verifyAttempts}/${MAX_VERIFY_ATTEMPTS}（seq=${seq}）`);
      if (state.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
        huLog(ctx, `熔断（FF6）：连续 ${state.verifyAttempts} 次验证失败，回滚 seq=${seq}`);
        try {
          restoreAllBackups(state, true);
        } catch (err) {
          huLog(ctx, `熔断回滚失败: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (seq != null && !state.blockedSeqs.includes(seq)) state.blockedSeqs.push(seq);
        state.pending = null;
        state.phase = 'IDLE';
        state.verifyAttempts = 0;
        save(state);
        ctx.restartSidecar(); // 以恢复后的文件重新拉起
        return;
      }
      save(state);
    },

    async rollbackLatest(): Promise<{ ok: boolean; message: string }> {
      const state = loadState(dirs);
      if (state.phase !== 'IDLE') return { ok: false, message: `状态机非空闲（${state.phase}），稍后重试` };
      const names = fs.existsSync(dirs.backups) ? fs.readdirSync(dirs.backups) : [];
      const seqOf = (n: string): number => parseInt((n.split('-')[0] ?? '0'), 10);
      const candidate = names
        .filter((n) => /^\d+-\d+$/.test(n))
        .sort((a, b) => seqOf(b) - seqOf(a))[0];
      if (!candidate) return { ok: false, message: '没有可回滚的热更新备份' };
      const seq = seqOf(candidate);
      huLog(ctx, `救援回滚：${candidate}`);
      try {
        restoreFromBackup(ctx.installRoot, path.join(dirs.backups, candidate));
      } catch (err) {
        return { ok: false, message: `回滚失败: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!state.blockedSeqs.includes(seq)) state.blockedSeqs.push(seq);
      // 组件身份退回基线（文件已还原为基线内容）
      for (const [comp, info] of Object.entries(state.components) as [HotComponent, { seq: number; version: string }][]) {
        if (info.seq === seq) state.components[comp] = { seq: state.baselineSeq, version: 'baseline' };
      }
      save(state);
      ctx.restartSidecar();
      return { ok: true, message: `已回滚 seq=${seq}，重启服务生效` };
    },

    getState(): HuState {
      return loadState(dirs);
    },
  };
}
