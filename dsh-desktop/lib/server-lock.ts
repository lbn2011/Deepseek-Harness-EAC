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

/** 创建锁文件（写入本进程 PID），返回本次持锁 token（exit handler 凭它释放）。 */
export function createDshWebLock(): number {
  try {
    fs.writeFileSync(dshWebLockPath(), String(process.pid), 'utf8');
    lockHeld = true;
    lockToken += 1;
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
