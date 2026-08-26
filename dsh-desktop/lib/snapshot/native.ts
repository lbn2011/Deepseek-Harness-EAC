/**
 * lib/snapshot/native.ts — Rust 快照引擎（native/snapshot/index.node）的加载与类型面。
 *
 * 加载模式与 lib/extension-host/job-fence.ts 一致：惰性 require + 缓存 +
 * 失败返回 null（渲染进程/单测环境优雅降级）。类型面与
 * native/snapshot/src/{types,engine}.rs 的 napi 导出一一对齐（napi 自动
 * snake_case → camelCase）。
 */

import * as path from 'node:path';

/** 快照摘要（列表/树渲染用）。 */
export interface SnapshotSummary {
  id: string;
  parent: string | null;
  branch: string;
  message: string;
  createdAtMs: number;
  /** manual | scheduled | restore-point。 */
  trigger: string;
  filesTotal: number;
  filesNew: number;
  bytesNew: number;
  filesSkipped: number;
}

/** 快照详情（含完整文件清单）。 */
export interface SnapshotDetail {
  id: string;
  parent: string | null;
  branch: string;
  message: string;
  createdAtMs: number;
  trigger: string;
  files: Array<{ path: string; hash: string; size: number }>;
}

/** 分支信息。 */
export interface BranchInfo {
  name: string;
  head: string;
  createdAtMs: number;
  isCurrent: boolean;
}

/** 存储配置（TS 侧可读写的完整面）。 */
export interface SnapshotConfig {
  exclusions: string[];
  scheduleEnabled: boolean;
  /** interval | daily。 */
  scheduleMode: string;
  intervalMinutes: number;
  /** HH:MM（24 小时制）。 */
  dailyTime: string;
  currentBranch: string;
}

/** 创建快照选项。 */
export interface CreateSnapshotOpts {
  storeDir: string;
  sourceDir: string;
  message?: string;
  trigger?: string;
  branch?: string;
}

/** 恢复选项。 */
export interface RestoreOpts {
  storeDir: string;
  snapshotId: string;
  targetDir: string;
  safetySnapshot?: boolean;
}

/** 恢复结果。 */
export interface RestoreResult {
  restoredFiles: number;
  deletedFiles: number;
  safetySnapshotId: string | null;
}

/** GC 结果。 */
export interface GcResult {
  removedObjects: number;
  bytesFreed: number;
}

/** Rust 引擎的完整导出面（与 native/snapshot/src/engine.rs 对齐）。 */
export interface SnapshotNative {
  snapshotCreate(opts: CreateSnapshotOpts): SnapshotSummary;
  snapshotList(storeDir: string): SnapshotSummary[];
  snapshotDetail(storeDir: string, snapshotId: string): SnapshotDetail;
  snapshotBranches(storeDir: string): BranchInfo[];
  snapshotCreateBranch(storeDir: string, name: string, fromId?: string): BranchInfo;
  snapshotDeleteBranch(storeDir: string, name: string): void;
  snapshotSetCurrentBranch(storeDir: string, name: string): void;
  snapshotRestore(opts: RestoreOpts): RestoreResult;
  snapshotDelete(storeDir: string, snapshotId: string): void;
  snapshotGc(storeDir: string): GcResult;
  snapshotConfigLoad(storeDir: string): SnapshotConfig;
  snapshotConfigSave(storeDir: string, config: SnapshotConfig): SnapshotConfig;
  snapshotDefaultExclusions(): string[];
}

let cached: SnapshotNative | null | undefined;

/** 加载原生模块（失败返回 null；单测/无二进制环境降级）。 */
export function loadSnapshotNative(): SnapshotNative | null {
  if (cached !== undefined) return cached;
  try {
    const file = path.join(__dirname, '..', '..', 'native', 'snapshot', 'index.node');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require(file) as SnapshotNative;
  } catch {
    cached = null;
  }
  return cached;
}

/** 测试注入（卸载缓存，强制下次重新加载）。 */
export function resetSnapshotNativeCache(): void {
  cached = undefined;
}
