/**
 * lib/hot-update/apply.ts — 包操作：解包、双层校验、快照、交换。
 *
 * 解包用运行时依赖 unzipper（feature-pack.ts 已有 Open.file 用法）；
 * 交换按 hu-manifest files[] 逐条执行（replace 覆盖 / delete 幂等删除）。
 * 快照（SNAPSHOTTED）必须发生在交换（APPLYING）之前——回滚的唯一依据。
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { FenceError, checkFence, checkManifestFence } from './fence.js';
import { writeJsonAtomic } from './store.js';
import type { HuBackupManifest, HuManifest } from './types.js';

// unzipper 随 dsh-desktop 树分发（feature-pack.ts 同款结构化类型，无 @types 包）
interface ZipEntry { type: string; path: string; buffer(): Promise<Buffer> }
const unzipper = require('unzipper') as {
  Open: { file(p: string): Promise<{ files: ZipEntry[] }> };
};

function sha256Buf(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * 解包 zip 到 destDir，返回包内清单。仅接受 replace 项与清单一一对应的包
 * （夹带拒绝）；逐文件 sha256 校验失败即抛错（FF1）。
 */
export async function unpackAndVerify(zipPath: string, destDir: string): Promise<HuManifest> {
  const directory = await unzipper.Open.file(zipPath);
  let hu: HuManifest | null = null;
  const files = new Map<string, Buffer>();
  for (const entry of directory.files) {
    if (entry.type === 'Directory') continue;
    if (entry.path.includes('..') || path.isAbsolute(entry.path)) {
      throw new FenceError(`zip-slip 嫌疑路径: ${entry.path}`);
    }
    const buf = await entry.buffer();
    if (entry.path === 'hu-manifest.json') {
      hu = JSON.parse(buf.toString('utf8')) as HuManifest;
      continue;
    }
    files.set(entry.path.split('\\').join('/'), buf);
  }
  if (!hu) throw new FenceError('包内缺 hu-manifest.json');
  if (hu.schemaVersion > 1) throw new FenceError(`包清单 schemaVersion ${hu.schemaVersion} 高于支持值`);
  const replaceOps = (hu.files || []).filter((f) => f.mode === 'replace');
  checkManifestFence(
    hu.component,
    (hu.files || []).map((f) => f.path),
  );
  const declared = new Set(replaceOps.map((f) => f.path));
  for (const name of files.keys()) {
    if (!declared.has(name)) throw new FenceError(`包内夹带未声明文件: ${name}`);
  }
  for (const op of replaceOps) {
    const buf = files.get(op.path);
    if (!buf) throw new FenceError(`replace 条目缺包内文件: ${op.path}`);
    if (op.sha256 && sha256Buf(buf) !== op.sha256) {
      throw new Error(`[hot-update] 文件校验失败: ${op.path}（sha256 不符，应用中止，现版本继续运行）`);
    }
  }
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'hu-manifest.json'), JSON.stringify(hu, null, 2));
  for (const [name, buf] of files) {
    const dest = path.join(destDir, ...name.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  }
  return hu;
}

/**
 * 快照：按 files[] 反推受影响文件集，把现值按原路径复制到 backupDir，
 * 写 hu-backup-manifest.json（热更新统一快照格式，主设计 §7.3）。
 */
export function snapshotBeforeApply(
  installRoot: string,
  backupDir: string,
  hu: HuManifest,
  appVersion: string,
): HuBackupManifest {
  const files: HuBackupManifest['files'] = [];
  fs.mkdirSync(backupDir, { recursive: true });
  for (const op of hu.files || []) {
    checkFence(hu.component, op.path);
    const target = path.join(installRoot, ...op.path.split('/'));
    const backupPath = path.join(backupDir, ...op.path.split('/'));
    const existed = fs.existsSync(target);
    if (existed) {
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.copyFileSync(target, backupPath);
      files.push({ path: op.path, sha256: sha256Buf(fs.readFileSync(target)), existed: true });
    } else {
      files.push({ path: op.path, sha256: null, existed: false });
    }
  }
  const manifest: HuBackupManifest = {
    kind: 'hotupdate',
    seq: hu.seq,
    component: hu.component,
    fromVersion: null,
    toVersion: hu.version,
    appVersion,
    createdAt: new Date().toISOString(),
    files,
    reason: 'pre-hotupdate',
  };
  writeJsonAtomic(path.join(backupDir, 'hu-backup-manifest.json'), manifest);
  return manifest;
}

/** 交换：replace 写入/覆盖（父目录自动创建），delete 幂等删除。 */
export function exchangeFiles(installRoot: string, stagedDir: string, hu: HuManifest): void {
  for (const op of hu.files || []) {
    const target = path.join(installRoot, ...op.path.split('/'));
    if (op.mode === 'replace') {
      const src = path.join(stagedDir, ...op.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(src, target);
    } else {
      fs.rmSync(target, { force: true });
    }
  }
}

/**
 * 从快照恢复（回滚路径，FF3/FF6）：existed=true 按原路径复制回，
 * existed=false 删除（应用前不存在的文件）。skipPath 命中的条目跳过
 * （运行中 exe 被锁定，归 Rust boot-attempts 熔断处理）。
 */
export function restoreFromBackup(
  installRoot: string,
  backupDir: string,
  opts: { skipPath?: (p: string) => boolean } = {},
): void {
  const manifestPath = path.join(backupDir, 'hu-backup-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as HuBackupManifest;
  for (const f of manifest.files) {
    if (opts.skipPath?.(f.path)) continue;
    const target = path.join(installRoot, ...f.path.split('/'));
    if (f.existed) {
      const src = path.join(backupDir, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(src, target);
    } else {
      fs.rmSync(target, { force: true });
    }
  }
}
