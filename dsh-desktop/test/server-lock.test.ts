import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

// 7f7fa05（fix #22）：跨实例并发 dsh web 检测 —— 两个 web 进程并发写同一
// DSH_HOME 会损坏会话日志。锁语义（lib/server-lock.ts，宿主无关）：
//   · 无锁 / 锁 PID 已死 → 放行（死锁文件自动清理）；
//   · 锁 PID 是本进程 → 放行（startServer 重入 / 受限端口重启交接路径，
//     自己的锁不得挡自己）；
//   · 锁 PID 是他人且存活 → 拒绝（错误指引含锁路径）；
//   · create/remove 由本进程持锁标记保护：未持锁时 remove 不误删他人锁。

const require = createRequire(import.meta.url);
const lock = require('../lib/server-lock.js');
const { state } = require('../lib/state.js');

function withTmpHome(fn: () => void | Promise<void>): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'srvlock-'));
  const prevHome = state.dshHome;
  state.dshHome = join(tmp, 'dsh-home');
  mkdirSync(state.dshHome, { recursive: true });
  return Promise.resolve(fn()).finally(() => {
    state.dshHome = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  });
}

test('无锁文件：isAnotherDshWebRunning 放行', () => withTmpHome(() => {
  assert.equal(lock.isAnotherDshWebRunning(), false);
}));

test('锁含已死 PID：放行并自动清理残留锁文件', () => withTmpHome(() => {
  writeFileSync(lock.dshWebLockPath(), '3999999', 'utf8');
  assert.equal(lock.isAnotherDshWebRunning(), false);
  assert.equal(existsSync(lock.dshWebLockPath()), false);
}));

test('锁含非法内容（非数字）：放行不崩溃', () => withTmpHome(() => {
  writeFileSync(lock.dshWebLockPath(), 'not-a-pid', 'utf8');
  assert.equal(lock.isAnotherDshWebRunning(), false);
}));

test('锁含本进程 PID：放行（自身锁，重入/受限端口重启路径）', () => withTmpHome(() => {
  writeFileSync(lock.dshWebLockPath(), String(process.pid), 'utf8');
  assert.equal(lock.isAnotherDshWebRunning(), false);
}));

test('锁含他人存活 PID：拒绝；进程死后放行并清理', async () => withTmpHome(async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  await new Promise<void>((r) => child.once('spawn', r));
  try {
    writeFileSync(lock.dshWebLockPath(), String(child.pid), 'utf8');
    assert.equal(lock.isAnotherDshWebRunning(), true);
  } finally {
    child.kill();
    await new Promise<void>((r) => child.once('exit', r));
  }
  assert.equal(lock.isAnotherDshWebRunning(), false);
  assert.equal(existsSync(lock.dshWebLockPath()), false);
}));

test('createDshWebLock 写入本进程 PID；removeDshWebLock(token) 删除', () => withTmpHome(() => {
  const token = lock.createDshWebLock();
  assert.equal(readFileSync(lock.dshWebLockPath(), 'utf8'), String(process.pid));
  lock.removeDshWebLock(token);
  assert.equal(existsSync(lock.dshWebLockPath()), false);
}));

test('token 代次隔离：新持锁后旧 token 的 remove 不删新锁（M1 重入竞态）', () => withTmpHome(() => {
  const t1 = lock.createDshWebLock();
  const t2 = lock.createDshWebLock(); // M1 重入：新 startServer 接管锁
  assert.notEqual(t1, t2);
  lock.removeDshWebLock(t1); // 旧 proc exit：token 过期
  assert.equal(existsSync(lock.dshWebLockPath()), true); // 新锁保留
  lock.removeDshWebLock(t2); // 新 proc exit：正常释放
  assert.equal(existsSync(lock.dshWebLockPath()), false);
}));

test('未持锁时 removeDshWebLock 不误删他人锁（幂等保护）', () => withTmpHome(() => {
  writeFileSync(lock.dshWebLockPath(), '12345', 'utf8');
  lock.removeDshWebLock(0);
  assert.equal(existsSync(lock.dshWebLockPath()), true);
}));
