/**
 * lib/server-lock.ts — 跨实例 dsh web 进程锁（7f7fa05，fix #22 移植）。
 *
 * 背景：两个 dsh web 进程并发写同一 DSH_HOME 会损坏会话日志（Issue #22）。
 * 语义（对齐 main.js 版，宿主无关化 + 竞态加固）：
 *   · startServer spawn 前检测 `<dshHome>/dsh-web.lock`；
 *   · 锁 PID 已死 → 放行并自动清理残留锁；锁 PID 是本进程 → 放行
 *     （startServer 重入 / 受限端口重启交接会再入，自己的锁不得挡自己——
 *     main.js 版无此检查，M1 重入会被自身锁误挡，此处一并修复）；
 *   · 锁 PID 是他人且存活 → 拒绝启动（错误文案含锁路径与手动删除指引）；
 *   · watchServerProc 的 exit handler 持 createDshWebLock 返回的 token
 *     释放锁：M1 重入场景旧 proc 的 exit 不得删掉新 proc 刚接管的锁
 *     （token 代次隔离）；受限端口重启交接（handedOff）由递归 startServer
 *     重新持锁。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { state } from './state.js';
import { log } from './log.js';

/** 本进程是否持有 dsh web 锁（模块内标记，防误删他人锁）。 */
let lockHeld = false;

/** 持锁代次：每次 createDshWebLock 递增，exit handler 按代次释放。 */
let lockToken = 0;

/** 锁文件路径：`<dshHome>/dsh-web.lock`。 */
export function dshWebLockPath(): string {
  const home = state.dshHome || path.join(os.homedir(), '.dsh');
  return path.join(home, 'dsh-web.lock');
}

/** 是否有另一进程的 dsh web 正在运行（死锁自动清理；自身锁放行）。 */
export function isAnotherDshWebRunning(): boolean {
  const lockPath = dshWebLockPath();
  try {
    if (!fs.existsSync(lockPath)) return false;
    const pid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
    if (isNaN(pid)) return false;
    if (pid === process.pid) return false; // 自己的锁：重入/重启交接路径
    try {
      process.kill(pid, 0); // 信号 0 仅探活
      return true;
    } catch {
      // 持锁进程已死：清理残留锁后放行。
      fs.unlinkSync(lockPath);
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * 创建锁文件（写入本进程 PID），返回本次持锁 token（exit handler 凭它释放）。
 *
 * BUG-D-001：'wx' 原子排他创建闭合 check-then-act 竞态（探测与写入之间的
 * TOCTOU 窗口内另一实例可插队写锁）。EEXIST 视为锁已被抢：自己的锁（重入/
 * 交接竞态下旧 proc exit handler 未及释放）覆写放行；他人死锁清理残留后
 * 重试一次；他人活锁则不持锁返回（lockHeld 保持 false，removeDshWebLock
 * 成空操作），由调用方复查 isAnotherDshWebRunning 走既有「发现另一实例」
 * 拒绝路径。
 */
export function createDshWebLock(): number {
  const lockPath = dshWebLockPath();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
        lockHeld = true;
        lockToken += 1;
        return lockToken;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
        let pid = NaN;
        try {
          pid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
        } catch {
          continue; // 读侧竞态（他人刚好释放/清理）：重试原子创建
        }
        if (pid === process.pid) {
          fs.writeFileSync(lockPath, String(process.pid), 'utf8');
          lockHeld = true;
          lockToken += 1;
          return lockToken;
        }
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        if (isNaN(pid) || !alive) {
          // 死锁/残缺锁：同 isAnotherDshWebRunning 的自愈语义，清理后重试一次。
          fs.unlinkSync(lockPath);
          continue;
        }
        log('dsh', 'dsh web 锁已被其他进程持有（PID ' + pid + '，锁文件：' + lockPath + '）');
        return lockToken;
      }
    }
  } catch (err) {
    log('dsh', '创建 dsh web 锁文件失败: ' + String((err as Error).message || err));
  }
  return lockToken;
}

/**
 * 释放锁文件（幂等）。仅当 token 仍是当前持锁代次时生效——M1 重入后旧
 * proc 的 exit 不得删掉新 proc 刚接管的锁。
 */
export function removeDshWebLock(token: number): void {
  if (!lockHeld || token !== lockToken) return;
  lockHeld = false;
  try {
    if (fs.existsSync(dshWebLockPath())) fs.unlinkSync(dshWebLockPath());
  } catch (err) {
    log('dsh', '清理 dsh web 锁文件失败: ' + String((err as Error).message || err));
  }
}
