/**
 * lib/snapshot/manager.ts — 快照管理器门面（Rust 引擎之上的服务编排）。
 *
 * 职责：
 *   1. 把原生无状态函数组织成带路径决策与互斥的用例（store/source 路径
 *      由 paths.ts 统一决定，调用方只传业务参数）；
 *   2. 恢复编排：Windows 文件锁要求先停 dsh web 服务 → 恢复 → 拉回服务
 *      （复用 server.ts 的 startAndShowGuarded，守护启动含失败自修复）；
 *   3. 定时备份入口（scheduler 回调到这里，trigger='scheduled'）；
 *   4. 配置保存后通知调度器重排。
 *
 * busy 互斥：备份/恢复同一时刻只允许一个在跑（引擎本身幂等，但并发
 * 快照会让 parent 链交叉）。
 */

import { state } from '../state.js';
import { log } from '../log.js';
import { killTree, waitForProcExit } from '../proc.js';
import { startAndShowGuarded } from '../server.js';
import { snapshotScheduler } from './scheduler.js';
import { effectiveDshHome, snapshotStoreDir } from './paths.js';
import {
  loadSnapshotNative,
  type BranchInfo,
  type GcResult,
  type RestoreResult,
  type SnapshotConfig,
  type SnapshotDetail,
  type SnapshotSummary,
} from './native.js';

/** 统一返回面：ok=false 时带中文 error。 */
export interface SnapshotOpResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

function fail<T>(error: string): SnapshotOpResult<T> {
  return { ok: false, error };
}

function ok<T>(data?: T): SnapshotOpResult<T> {
  return { ok: true, ...(data === undefined ? {} : { data }) };
}

function errMsg(err: unknown): string {
  return String((err as Error).message || err);
}

let busy = false;

/** 引擎是否可用（原生模块缺失时 UI 显示降级提示）。 */
export function nativeAvailable(): boolean {
  return loadSnapshotNative() !== null;
}

/** 全景：配置 + 分支 + 快照列表（新→旧）+ 路径 + 调度状态。 */
export function overview(): SnapshotOpResult<{
  nativeAvailable: boolean;
  storeDir: string;
  sourceDir: string;
  config: SnapshotConfig;
  defaultExclusions: string[];
  branches: BranchInfo[];
  snapshots: SnapshotSummary[];
  scheduler: { armed: boolean; nextRunMs: number | null };
}> {
  const native = loadSnapshotNative();
  if (!native) return fail('快照引擎不可用（native/snapshot/index.node 缺失）');
  try {
    const storeDir = snapshotStoreDir();
    return ok({
      nativeAvailable: true,
      storeDir,
      sourceDir: effectiveDshHome(),
      config: native.snapshotConfigLoad(storeDir),
      defaultExclusions: native.snapshotDefaultExclusions(),
      branches: native.snapshotBranches(storeDir),
      snapshots: native.snapshotList(storeDir).reverse(),
      scheduler: snapshotScheduler.getState(),
    });
  } catch (err) {
    return fail('读取快照概览失败: ' + errMsg(err));
  }
}

/** 立即备份（trigger=manual；message 可选，缺省由引擎生成）。 */
export function createSnapshot(message?: string): SnapshotOpResult<SnapshotSummary> {
  const native = loadSnapshotNative();
  if (!native) return fail('快照引擎不可用');
  if (busy) return fail('已有备份/恢复任务进行中，请稍候');
  busy = true;
  try {
    const storeDir = snapshotStoreDir();
    const snap = native.snapshotCreate({
      storeDir,
      sourceDir: effectiveDshHome(),
      ...(message === undefined ? {} : { message }),
      trigger: 'manual',
    });
    log(
      'snapshot',
      `手动备份完成: ${snap.id}（新增 ${snap.filesNew}/${snap.filesTotal} 文件）`,
    );
    return ok(snap);
  } catch (err) {
    log('snapshot', '手动备份失败: ' + errMsg(err));
    return fail('备份失败: ' + errMsg(err));
  } finally {
    busy = false;
  }
}

/** 定时备份入口（scheduler 回调；失败仅记日志，不打扰用户）。 */
export async function createScheduledSnapshot(): Promise<void> {
  const native = loadSnapshotNative();
  if (!native || busy) return;
  busy = true;
  try {
    const storeDir = snapshotStoreDir();
    const snap = native.snapshotCreate({
      storeDir,
      sourceDir: effectiveDshHome(),
      trigger: 'scheduled',
    });
    log(
      'snapshot',
      `定时备份完成: ${snap.id}（新增 ${snap.filesNew}/${snap.filesTotal} 文件）`,
    );
  } catch (err) {
    log('snapshot', '定时备份失败: ' + errMsg(err));
  } finally {
    busy = false;
  }
}

/** 快照详情（含文件清单）。 */
export function snapshotDetail(snapshotId: string): SnapshotOpResult<SnapshotDetail> {
  const native = loadSnapshotNative();
  if (!native) return fail('快照引擎不可用');
  try {
    return ok(native.snapshotDetail(snapshotStoreDir(), snapshotId));
  } catch (err) {
    return fail(errMsg(err));
  }
}

/**
 * 恢复到指定快照：停服务（若在跑）→ 引擎恢复 → 拉回服务。
 * safetySnapshot 缺省 true（恢复前自动留档当前状态）。
 */
export async function restoreSnapshot(
  snapshotId: string,
  safetySnapshot = true,
): Promise<SnapshotOpResult<RestoreResult>> {
  const native = loadSnapshotNative();
  if (!native) return fail('快照引擎不可用');
  if (busy) return fail('已有备份/恢复任务进行中，请稍候');
  busy = true;
  state.restartingServer = true;
  let wasRunning = false;
  try {
    // 1. 停 dsh web（Windows 文件锁：占用中的 profile 文件写回会 EACCES）
    const oldProc = state.serverProc;
    if (oldProc) {
      wasRunning = true;
      log('snapshot', '恢复前停止 dsh web 服务');
      killTree(oldProc);
      state.serverProc = null;
      await waitForProcExit(oldProc, 20000);
    }
    // 2. 引擎恢复（写回清单 + 清理清单外增量 + 可选安全快照）
    const storeDir = snapshotStoreDir();
    const result = native.snapshotRestore({
      storeDir,
      snapshotId,
      targetDir: effectiveDshHome(),
      safetySnapshot,
    });
    log(
      'snapshot',
      `恢复完成 → ${snapshotId}（写回 ${result.restoredFiles}，删除增量 ${result.deletedFiles}）`,
    );
    // 3. 拉回服务（之前在跑才拉）
    if (wasRunning) {
      try {
        await startAndShowGuarded();
        log('snapshot', '恢复后 dsh web 服务已重启');
      } catch (err) {
        log('snapshot', '恢复后重启服务失败: ' + errMsg(err));
        return fail('文件已恢复，但重启 Web 服务失败: ' + errMsg(err));
      }
    }
    return ok(result);
  } catch (err) {
    log('snapshot', '恢复失败: ' + errMsg(err));
    // 半恢复状态比不恢复更糟：尽力把服务拉回来再报错
    if (wasRunning) {
      try {
        await startAndShowGuarded();
      } catch {
        /* 已在错误信息里说明 */
      }
    }
    return fail('恢复失败: ' + errMsg(err));
  } finally {
    state.restartingServer = false;
    busy = false;
  }
}

/** 创建分支（fromId 缺省 = 当前分支 head）。 */
export function createBranch(name: string, fromId?: string): SnapshotOpResult<BranchInfo> {
  const native = loadSnapshotNative();
  if (!native) return fail('快照引擎不可用');
  try {
    const b = native.snapshotCreateBranch(snapshotStoreDir(), name, fromId);
    return ok(b);
  } catch (err) {
    return fail(errMsg(err));
  }
}

/** 删除分支（当前分支不可删）。 */
export function deleteBranch(name: string): SnapshotOpResult<void> {
  const native = loadSnapshotNative();
  if (!native) return fail('快照引擎不可用');
  try {
    native.snapshotDeleteBranch(snapshotStoreDir(), name);
    return ok();
  } catch (err) {
    return fail(errMsg(err));
  }
}

/** 切换当前分支（后续手动/定时备份落在该分支）。 */
export function setCurrentBranch(name: string): SnapshotOpResult<void> {
  const native = loadSnapshotNative();
  if (!native) return fail('快照引擎不可用');
  try {
    native.snapshotSetCurrentBranch(snapshotStoreDir(), name);
    snapshotScheduler.rearm('switch-branch');
    return ok();
  } catch (err) {
    return fail(errMsg(err));
  }
}

/** 保存配置（校验在引擎内；保存后调度器按新计划重排）。 */
export function saveConfig(config: Partial<SnapshotConfig>): SnapshotOpResult<SnapshotConfig> {
  const native = loadSnapshotNative();
  if (!native) return fail('快照引擎不可用');
  try {
    const storeDir = snapshotStoreDir();
    const merged: SnapshotConfig = { ...native.snapshotConfigLoad(storeDir), ...config };
    const saved = native.snapshotConfigSave(storeDir, merged);
    snapshotScheduler.rearm('config-save');
    log('snapshot', `配置已保存（${saved.scheduleMode}${saved.scheduleMode === 'daily' ? ' ' + saved.dailyTime : ' ' + saved.intervalMinutes + 'min'}，${saved.scheduleEnabled ? '启用' : '停用'}）`);
    return ok(saved);
  } catch (err) {
    return fail(errMsg(err));
  }
}

/** 删除快照（分支 head 不可删；空间由 GC 回收）。 */
export function deleteSnapshot(snapshotId: string): SnapshotOpResult<void> {
  const native = loadSnapshotNative();
  if (!native) return fail('快照引擎不可用');
  try {
    native.snapshotDelete(snapshotStoreDir(), snapshotId);
    return ok();
  } catch (err) {
    return fail(errMsg(err));
  }
}

/** 回收无引用对象（删除快照后释放磁盘）。 */
export function gc(): SnapshotOpResult<GcResult> {
  const native = loadSnapshotNative();
  if (!native) return fail('快照引擎不可用');
  try {
    return ok(native.snapshotGc(snapshotStoreDir()));
  } catch (err) {
    return fail(errMsg(err));
  }
}
