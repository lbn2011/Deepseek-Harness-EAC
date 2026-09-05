/**
 * lib/hot-update/store.ts — 状态机持久化（userData/hotupdate/）。
 *
 * 纪律：每次状态转移先落盘再行动（崩溃安全）。写盘统一走 writeJsonAtomic
 * （tmp + rename，Windows rename 覆盖前先删目标）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { HuState } from './types.js';

export interface HuDirs {
  root: string;
  staging: string;
  backups: string;
  logs: string;
  stateFile: string;
}

export function huDirs(userDataDir: string): HuDirs {
  const root = path.join(userDataDir, 'hotupdate');
  return {
    root,
    staging: path.join(root, 'staging'),
    backups: path.join(root, 'backups'),
    logs: path.join(root, 'logs'),
    stateFile: path.join(root, 'state.json'),
  };
}

export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* Windows rename 不覆盖已存在目标时才需要；删除失败由 rename 兜底 */
  }
  fs.renameSync(tmp, file);
}

export function defaultState(): HuState {
  return {
    schemaVersion: 1,
    appliedSeq: 0,
    components: {},
    baselineSeq: 0,
    phase: 'IDLE',
    pending: null,
    blockedSeqs: [],
    verifyAttempts: 0,
    lastCheckAt: null,
  };
}

export function loadState(dirs: HuDirs): HuState {
  try {
    const raw = JSON.parse(fs.readFileSync(dirs.stateFile, 'utf8')) as Partial<HuState>;
    return { ...defaultState(), ...raw };
  } catch {
    return defaultState();
  }
}

export function saveState(dirs: HuDirs, state: HuState): void {
  writeJsonAtomic(dirs.stateFile, state);
}

/** 清 staging（保留目录本身）。 */
export function clearStaging(dirs: HuDirs): void {
  fs.rmSync(dirs.staging, { recursive: true, force: true });
  fs.mkdirSync(dirs.staging, { recursive: true });
}

/** 清 staging + backups（基线重置时调用；旧热更备份随新基线失效）。 */
export function clearStagingAndBackups(dirs: HuDirs): void {
  clearStaging(dirs);
  fs.rmSync(dirs.backups, { recursive: true, force: true });
  fs.mkdirSync(dirs.backups, { recursive: true });
}

/** 备份保留 14 天，启动清理任务删除。 */
export function pruneOldBackups(dirs: HuDirs, keepDays = 14): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dirs.backups);
  } catch {
    return;
  }
  const cutoff = Date.now() - keepDays * 86400_000;
  for (const name of names) {
    const m = /^(\d+)-(\d+)$/.exec(name); // <seq>-<unix-ms>
    const p = path.join(dirs.backups, name);
    try {
      const ts = m ? parseInt((m[2] ?? ''), 10) || fs.statSync(p).mtimeMs : fs.statSync(p).mtimeMs;
      if (ts < cutoff) fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* 竞态删除容忍 */
    }
  }
}
