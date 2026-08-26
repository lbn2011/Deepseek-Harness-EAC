#!/usr/bin/env node
'use strict';

// 生成 SHA256SUMS.txt（V6）：为最终发布产物计算 SHA-256，供 Release 页面公布；
// 客户端自更新（client-updater）会自动取该文件做下载内容校验（Gitee 无
// digest 字段时的唯一校验来源）。发布时把 SHA256SUMS.txt 一起作为 Release
// 资产上传（保持原文件名）。
//
// v6.0.0（Task 11.1）：产物面从 Electron 遗留的 .exe/.blockmap 扩展为
// Tauri 双平台五类：.exe / .blockmap（NSIS）、.deb / .AppImage（Linux）、
// .zip（Windows 便携包）；支持多目录聚合（产物分处 nsis/deb/appimage/
// portable 多目录时一次汇总），SHA256SUMS.txt 写入首个目录。
//
// 用法：node scripts/make-release-hashes.js <dir1> [dir2 ...]（默认 dist/）

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const ARTIFACT_RE = /\.(exe|blockmap|deb|appimage|zip)$/i;
export const HASH_SUMS_NAME = 'SHA256SUMS.txt';

export interface HashSumsResult {
  /** 纳入哈希的文件名（跨目录聚合，按名排序）。 */
  files: string[];
  /** SHA256SUMS.txt 输出路径（= 首个目录）。 */
  outFile: string;
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(file);
    rs.on('data', (c) => h.update(c as Buffer));
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

/** 聚合多目录产物并写入 SHA256SUMS.txt（导出供测试与复用）。 */
export async function writeHashSums(dirs: string[]): Promise<HashSumsResult> {
  if (dirs.length === 0) throw new Error('[release-hashes] 未提供产物目录');
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) throw new Error(`[release-hashes] 产物目录不存在: ${dir}`);
  }
  const names = new Set<string>();
  for (const dir of dirs) {
    for (const n of fs.readdirSync(dir)) {
      if (n === HASH_SUMS_NAME) continue; // 不自我哈希
      if (ARTIFACT_RE.test(n)) names.add(n);
    }
  }
  const sorted = [...names].sort();
  if (sorted.length === 0) throw new Error('[release-hashes] 产物目录里没有 .exe/.blockmap/.deb/.AppImage/.zip 产物');
  const lines: string[] = [];
  for (const name of sorted) {
    let hex: string | undefined;
    for (const dir of dirs) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) { hex = await sha256(p); break; }
    }
    if (!hex) continue; // 理论不可达（names 来自目录列举）
    lines.push(`${hex}  ${name}`);
    console.log(`${hex}  ${name}`);
  }
  const [firstDir] = dirs;
  if (!firstDir) throw new Error('[release-hashes] 未提供产物目录');
  const outFile = path.join(firstDir, HASH_SUMS_NAME);
  fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
  console.log(`[release-hashes] 已生成 ${outFile}（${lines.length} 个产物）`);
  return { files: sorted, outFile };
}

if (require.main === module) {
  (async () => {
    const dirs = process.argv.slice(2).map((a) => path.resolve(a));
    if (dirs.length === 0) dirs.push(path.join(__dirname, '..', 'dist'));
    try {
      await writeHashSums(dirs);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  })();
}
