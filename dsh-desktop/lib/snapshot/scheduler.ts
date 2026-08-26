/**
 * lib/snapshot/scheduler.ts — 定时备份调度器。
 *
 * 职责：按存储配置（interval / daily）计算并维持一个 setTimeout 链，
 * 到点回调（由 manager 注入，内部创建 trigger='scheduled' 快照）。
 * 计算是纯函数（computeNextDelay），单测不依赖定时器。
 *
 * 语义：
 *   · daily（HH:MM）：下一次该时刻（今天已过则明天）；
 *   · interval（N 分钟）：以最近一次快照时间为基线 —— 启动时若已超期
 *     立即触发，否则补齐剩余时长。无任何快照时立即触发首次。
 *   · 配置关闭时不排程；保存配置后重排（rearm）。
 */

import { log } from '../log.js';
import { loadSnapshotNative } from './native.js';
import type { SnapshotConfig } from './native.js';
import { effectiveDshHome, snapshotStoreDir } from './paths.js';

/** 调度器当前视图（测试与诊断用）。 */
export interface SchedulerState {
  armed: boolean;
  /** 已排定的触发时刻（Unix 毫秒；armed=false 时为 null）。 */
  nextRunMs: number | null;
}

const MIN_DELAY_MS = 30_000;

/**
 * 计算距下次定时备份的毫秒数；返回 null = 不排程（未启用/引擎不可用）。
 * 纯函数：nowMs 注入便于单测。
 *
 * @param config 存储配置（scheduleEnabled / scheduleMode / intervalMinutes / dailyTime）
 * @param lastSnapshotMs 最近一次快照时间（null = 从未备份）
 * @param nowMs 当前时刻
 */
export function computeNextDelay(
  config: Pick<SnapshotConfig, 'scheduleEnabled' | 'scheduleMode' | 'intervalMinutes' | 'dailyTime'>,
  lastSnapshotMs: number | null,
  nowMs: number,
): number | null {
  if (!config.scheduleEnabled) return null;
  if (config.scheduleMode === 'interval') {
    const interval = Math.max(1, Math.floor(config.intervalMinutes)) * 60_000;
    if (lastSnapshotMs === null) return 0;
    const elapsed = nowMs - lastSnapshotMs;
    if (elapsed >= interval) return 0;
    return interval - elapsed;
  }
  if (config.scheduleMode === 'daily') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(config.dailyTime).trim());
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 23 || mm > 59) return null;
    const now = new Date(nowMs);
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    if (target.getTime() <= nowMs) target.setDate(target.getDate() + 1);
    return target.getTime() - nowMs;
  }
  return null;
}

/** 调度器实例（模块单例；boot 启动 / 退出停止 / 配置保存重排）。 */
class SnapshotScheduler {
  private timer: NodeJS.Timeout | null = null;
  private nextRunMs: number | null = null;
  private running = false;
  /** 到点回调（manager.createScheduledSnapshot）。 */
  private fire: (() => Promise<void>) | null = null;

  /** 注入触发回调并（重新）排程。 */
  arm(fire: () => Promise<void>): void {
    this.fire = fire;
    this.rearm('arm');
  }

  /** 停止排程（应用退出/引擎不可用）。 */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunMs = null;
    this.fire = null;
  }

  /** 当前状态（诊断）。 */
  getState(): SchedulerState {
    return { armed: this.timer !== null, nextRunMs: this.nextRunMs };
  }

  /** 配置变更后重排（保持已注入的回调）。 */
  rearm(reason: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunMs = null;
    if (!this.fire) return;
    const native = loadSnapshotNative();
    if (!native) return;
    let storeDir: string;
    let lastMs: number | null;
    try {
      storeDir = snapshotStoreDir();
      const config = native.snapshotConfigLoad(storeDir);
      const list = native.snapshotList(storeDir);
      const current = config.currentBranch;
      lastMs =
        list
          .filter((s) => s.branch === current)
          .map((s) => s.createdAtMs)
          .reduce((mx, t) => Math.max(mx, t), 0) || null;
      const delay = computeNextDelay(config, lastMs, Date.now());
      if (delay === null) {
        log('snapshot', `调度器未排程（${reason}）：定时备份未启用或配置非法`);
        return;
      }
      const clamped = Math.max(MIN_DELAY_MS, delay);
      this.nextRunMs = Date.now() + clamped;
      this.timer = setTimeout(() => void this.tick(), clamped);
      if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
      log(
        'snapshot',
        `调度器已排程（${reason}）：${new Date(this.nextRunMs).toLocaleString('sv-SE')}（${Math.round(clamped / 1000)}s 后）`,
      );
    } catch (err) {
      log('snapshot', '调度器排程失败: ' + String((err as Error).message || err));
    }
  }

  /** 到点：触发备份（防重入），完成后按最新配置重排。 */
  private async tick(): Promise<void> {
    this.timer = null;
    this.nextRunMs = null;
    if (!this.fire || this.running) return;
    this.running = true;
    try {
      await this.fire();
    } catch (err) {
      log('snapshot', '定时备份失败: ' + String((err as Error).message || err));
    } finally {
      this.running = false;
      this.rearm('tick');
    }
  }
}

export const snapshotScheduler = new SnapshotScheduler();

/** manager 侧的默认触发回调注入点（boot 调用）。 */
export function startScheduler(runScheduled: () => Promise<void>): void {
  snapshotScheduler.arm(runScheduled);
}

/** 供诊断：快照存储与源目录信息。 */
export function schedulerPaths(): { storeDir: string; sourceDir: string } {
  return { storeDir: snapshotStoreDir(), sourceDir: effectiveDshHome() };
}
