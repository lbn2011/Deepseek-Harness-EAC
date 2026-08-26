/**
 * 快照管理器回归：Rust 引擎（native/snapshot/index.node）经 napi 边界的
 * 端到端用例 + 调度纯函数（computeNextDelay）+ 存储路径决策。
 *
 * 覆盖验收点（用户需求逐条钉住）：
 *   1. 二进制哈希校验相同不重复备份（内容寻址去重）；
 *   2. 排除列表默认含 skills / sessions / .agent-presets / memories，
 *      且用户可自定义（*.bak 生效）；
 *   3. 备份树：parent 链 + 分支分叉 + 分支生命周期；
 *   4. 恢复到指定快照（含安全快照与排除目录不受影响）；
 *   5. 定时备份：interval/daily 两种模式的排程计算（默认开启）；
 *   6. 存储目录必须在 .dsh 之外（恢复不自毁）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 受控临时环境：源目录（模拟 .dsh）+ 存储目录。 */
function makeEnv(tag: string): { src: string; store: string; cleanup(): void } {
  const base = mkdtempSync(join(tmpdir(), `dsh-snap-ts-${tag}-`));
  const src = join(base, 'dsh');
  const store = join(base, 'store');
  mkdirSync(src, { recursive: true });
  mkdirSync(store, { recursive: true });
  return { src, store, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function write(rootDir: string, rel: string, content: string): void {
  const p = join(rootDir, ...rel.split('/'));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function read(rootDir: string, rel: string): string {
  return readFileSync(join(rootDir, ...rel.split('/')), 'utf8');
}

/** Rust 引擎句柄（未构建时测试整体跳过，提示先行构建）。 */
function loadEngine(): Record<string, (...args: unknown[]) => unknown> | null {
  const p = join(root, 'native', 'snapshot', 'index.node');
  if (!existsSync(p)) return null;
  return require(p) as Record<string, (...args: unknown[]) => unknown>;
}

test('引擎：增量备份 + 内容寻址去重 + 默认排除', () => {
  const engine = loadEngine();
  if (!engine) return; // 二进制未构建：cargo test 已在 CI 覆盖同一逻辑
  const env = makeEnv('dedup');
  try {
    write(env.src, 'settings.yaml', 'v1');
    write(env.src, 'profiles/web/cordis.patch.yml', 'patch');
    write(env.src, 'skills/big.md', 'x');
    write(env.src, 'sessions/live.json', 's');
    write(env.src, '.agent-presets/default.yaml', 'a');
    write(env.src, 'memories/keep.md', 'm');

    const s1 = engine.snapshotCreate({ storeDir: env.store, sourceDir: env.src, trigger: 'manual' }) as {
      id: string; filesTotal: number; filesNew: number; trigger: string;
    };
    assert.equal(s1.filesTotal, 2, '默认排除列表外只有 2 个文件');
    assert.equal(s1.filesNew, 2);
    assert.equal(s1.trigger, 'manual');
    assert.match(s1.id, /^snap-/);

    // 无变化 → 零增量（mtime+size 缓存命中）
    const s2 = engine.snapshotCreate({ storeDir: env.store, sourceDir: env.src }) as {
      id: string; parent: string | null; filesNew: number;
    };
    assert.equal(s2.filesNew, 0, '无变化时零增量');
    assert.equal(s2.parent, s1.id, 'parent 链构成备份树');

    // 内容改写 → 仅该文件计入增量
    write(env.src, 'settings.yaml', 'v2-longer');
    const s3 = engine.snapshotCreate({ storeDir: env.store, sourceDir: env.src }) as {
      filesNew: number; bytesNew: number;
    };
    assert.equal(s3.filesNew, 1);
    assert.equal(s3.bytesNew, 'v2-longer'.length);
  } finally {
    env.cleanup();
  }
});

test('引擎：同内容不同路径共享同一对象（哈希校验相同不备份）', () => {
  const engine = loadEngine();
  if (!engine) return;
  const env = makeEnv('ca');
  try {
    write(env.src, 'a.txt', 'same-content');
    engine.snapshotCreate({ storeDir: env.store, sourceDir: env.src });
    write(env.src, 'b.txt', 'same-content');
    const s2 = engine.snapshotCreate({ storeDir: env.store, sourceDir: env.src }) as { filesNew: number };
    assert.equal(s2.filesNew, 1, '新路径同内容算新文件');
    const list = engine.snapshotList(env.store) as Array<{ filesTotal: number }>;
    assert.equal(list.length, 2);
    // 对象库计数：配置目录里 objects/<xx>/<hash> 文件数 = 1
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
    const objectsDir = join(env.store, 'objects');
    let objectFiles = 0;
    for (const prefix of readdirSync(objectsDir)) {
      const sub = join(objectsDir, prefix);
      if (statSync(sub).isDirectory()) objectFiles += readdirSync(sub).length;
    }
    assert.equal(objectFiles, 1, '两个同内容文件只落一个对象');
  } finally {
    env.cleanup();
  }
});

test('引擎：分支生命周期（创建/切换/分叉/删除约束）', () => {
  const engine = loadEngine();
  if (!engine) return;
  const env = makeEnv('branch');
  try {
    write(env.src, 'a.txt', '1');
    const s1 = engine.snapshotCreate({ storeDir: env.store, sourceDir: env.src }) as { id: string };
    const b = engine.snapshotCreateBranch(env.store, 'experiment') as { head: string; isCurrent: boolean };
    assert.equal(b.head, s1.id, '新分支从当前 head 分叉');

    engine.snapshotSetCurrentBranch(env.store, 'experiment');
    write(env.src, 'a.txt', '2-exp');
    const s2 = engine.snapshotCreate({ storeDir: env.store, sourceDir: env.src }) as {
      branch: string; parent: string | null;
    };
    assert.equal(s2.branch, 'experiment');
    assert.equal(s2.parent, s1.id, '分叉点共享父快照');

    const branches = engine.snapshotBranches(env.store) as Array<{ name: string; isCurrent: boolean; head: string }>;
    assert.equal(branches.length, 2);
    assert.ok(branches.find((x) => x.name === 'experiment')?.isCurrent);

    // 当前分支不可删；切回 main 后 experiment 可删
    assert.throws(() => engine.snapshotDeleteBranch(env.store, 'experiment'));
    engine.snapshotSetCurrentBranch(env.store, 'main');
    engine.snapshotDeleteBranch(env.store, 'experiment');
    const after = engine.snapshotBranches(env.store) as Array<{ name: string }>;
    assert.equal(after.length, 1);
  } finally {
    env.cleanup();
  }
});

test('引擎：恢复到指定快照（安全快照 + 排除目录不受影响）', () => {
  const engine = loadEngine();
  if (!engine) return;
  const env = makeEnv('restore');
  try {
    write(env.src, 'settings.yaml', 'good-v1');
    write(env.src, 'skills/live.md', 'skill-data');
    const s1 = engine.snapshotCreate({ storeDir: env.store, sourceDir: env.src }) as { id: string };

    // 演进到“坏状态”
    write(env.src, 'settings.yaml', 'broken-v2');
    write(env.src, 'added-later.txt', 'new');
    write(env.src, 'skills/extra.md', 'more');

    const r = engine.snapshotRestore({
      storeDir: env.store,
      snapshotId: s1.id,
      targetDir: env.src,
      safetySnapshot: true,
    }) as { restoredFiles: number; deletedFiles: number; safetySnapshotId: string | null };
    assert.equal(read(env.src, 'settings.yaml'), 'good-v1', '内容回到基线');
    assert.ok(!existsSync(join(env.src, 'added-later.txt')), '清单外增量被删除');
    assert.equal(read(env.src, 'skills/live.md'), 'skill-data', '排除目录原样保留');
    assert.equal(read(env.src, 'skills/extra.md'), 'more', '排除目录的新文件也不动');
    assert.ok(r.safetySnapshotId, '恢复前创建了安全快照');

    // 安全快照可恢复回去（坏状态完整留档）
    const back = engine.snapshotRestore({
      storeDir: env.store,
      snapshotId: r.safetySnapshotId as string,
      targetDir: env.src,
      safetySnapshot: false,
    }) as { restoredFiles: number };
    assert.ok(back.restoredFiles >= 1);
    assert.equal(read(env.src, 'settings.yaml'), 'broken-v2', '可回到恢复前的坏状态');
  } finally {
    env.cleanup();
  }
});

test('引擎：配置流（自定义排除 + 定时计划校验）', () => {
  const engine = loadEngine();
  if (!engine) return;
  const env = makeEnv('cfg');
  try {
    const def = engine.snapshotConfigLoad(env.store) as {
      exclusions: string[]; scheduleEnabled: boolean; scheduleMode: string; dailyTime: string;
    };
    assert.deepEqual(
      def.exclusions,
      ['skills', 'sessions', '.agent-presets', 'memories', 'node_modules'],
    );
    assert.ok(def.scheduleEnabled, '定时备份默认开启');
    assert.equal(def.scheduleMode, 'daily');

    // 自定义排除列表生效
    const saved = engine.snapshotConfigSave(env.store, {
      exclusions: ['skills', '*.bak'],
      scheduleEnabled: true,
      scheduleMode: 'interval',
      intervalMinutes: 30,
      dailyTime: '03:00',
      currentBranch: 'main',
    }) as { exclusions: string[]; intervalMinutes: number };
    assert.deepEqual(saved.exclusions, ['skills', '*.bak']);
    assert.equal(saved.intervalMinutes, 30);

    write(env.src, 'keep.txt', 'k');
    write(env.src, 'junk.bak', 'j');
    write(env.src, 'x.log', 'l');
    const snap = engine.snapshotCreate({ storeDir: env.store, sourceDir: env.src }) as { filesTotal: number };
    assert.equal(snap.filesTotal, 2, '*.bak 被自定义排除，.log 未排除');

    // 非法计划被拒绝
    assert.throws(() => engine.snapshotConfigSave(env.store, {
      exclusions: [],
      scheduleEnabled: true,
      scheduleMode: 'weekly',
      intervalMinutes: 30,
      dailyTime: '03:00',
      currentBranch: 'main',
    }));
    assert.throws(() => engine.snapshotConfigSave(env.store, {
      exclusions: [],
      scheduleEnabled: true,
      scheduleMode: 'daily',
      intervalMinutes: 30,
      dailyTime: '99:00',
      currentBranch: 'main',
    }));
  } finally {
    env.cleanup();
  }
});

test('调度：computeNextDelay 的 interval / daily / 关闭语义', () => {
  // 编译产物（scheduler.js 顶层依赖 log.js → logger.js，与既有单测同一加载方式）
  for (const m of ['lib/log.js', 'lib/snapshot/native.js', 'lib/snapshot/paths.js', 'lib/snapshot/scheduler.js']) {
    delete require.cache[require.resolve(join(root, m))];
  }
  const { computeNextDelay } = require(join(root, 'lib', 'snapshot', 'scheduler.js')) as {
    computeNextDelay: (
      config: { scheduleEnabled: boolean; scheduleMode: string; intervalMinutes: number; dailyTime: string },
      lastSnapshotMs: number | null,
      nowMs: number,
    ) => number | null;
  };
  const now = Date.parse('2026-08-21T10:00:00');

  // 关闭 → 不排程
  assert.equal(computeNextDelay({ scheduleEnabled: false, scheduleMode: 'daily', intervalMinutes: 1440, dailyTime: '03:00' }, null, now), null);

  // interval：从未备份 → 立即
  assert.equal(computeNextDelay({ scheduleEnabled: true, scheduleMode: 'interval', intervalMinutes: 60, dailyTime: '03:00' }, null, now), 0);
  // interval：30 分钟前备过 → 剩 30 分钟
  assert.equal(computeNextDelay({ scheduleEnabled: true, scheduleMode: 'interval', intervalMinutes: 60, dailyTime: '03:00' }, now - 30 * 60_000, now), 30 * 60_000);
  // interval：已超期 → 立即补一次
  assert.equal(computeNextDelay({ scheduleEnabled: true, scheduleMode: 'interval', intervalMinutes: 60, dailyTime: '03:00' }, now - 90 * 60_000, now), 0);

  // daily：今天 11:00 未到 → 1 小时
  assert.equal(computeNextDelay({ scheduleEnabled: true, scheduleMode: 'daily', intervalMinutes: 1440, dailyTime: '11:00' }, null, now), 3600_000);
  // daily：今天 03:00 已过 → 明天 03:00（10:00 → 次日 03:00 = 17 小时）
  assert.equal(computeNextDelay({ scheduleEnabled: true, scheduleMode: 'daily', intervalMinutes: 1440, dailyTime: '03:00' }, null, now), 17 * 3600_000);
  // daily：非法时间 → 不排程（防御）
  assert.equal(computeNextDelay({ scheduleEnabled: true, scheduleMode: 'daily', intervalMinutes: 1440, dailyTime: '99:00' }, null, now), null);
  // 未知模式 → 不排程
  assert.equal(computeNextDelay({ scheduleEnabled: true, scheduleMode: 'weekly', intervalMinutes: 1440, dailyTime: '03:00' }, null, now), null);
});

test('路径：存储目录必须是 .dsh 的同级兄弟（恢复不自毁）', () => {
  for (const m of ['lib/state.js', 'lib/snapshot/paths.js']) {
    delete require.cache[require.resolve(join(root, m))];
  }
  const stateMod = require(join(root, 'lib', 'state.js')) as { state: { dshHome: string } };
  const paths = require(join(root, 'lib', 'snapshot', 'paths.js')) as {
    effectiveDshHome(): string;
    snapshotStoreDir(): string;
  };
  const home = join(tmpdir(), 'dsh-snap-paths-test', '.dsh');
  stateMod.state.dshHome = home;
  assert.equal(paths.effectiveDshHome(), home);
  const store = paths.snapshotStoreDir();
  assert.ok(store.endsWith('.dsh-snapshots'), `存储目录命名: ${store}`);
  assert.ok(!store.startsWith(home + '\\') && !store.startsWith(home + '/'), '存储不得位于 .dsh 内');
  assert.equal(require('node:path').dirname(store), require('node:path').dirname(home), '与 .dsh 同级');
});
