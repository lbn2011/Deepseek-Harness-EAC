// TDD tests for make-release-hashes (Task 11.1 / tdd.md T15).
//
// v6.0.0 起发布产物扩展为五类：NSIS .exe / .blockmap / .deb / .AppImage /
// 便携 .zip（原 v4 版只处理 .exe/.blockmap 的 Electron 遗留形状）。
// 行为契约：
//   1. 多目录参数聚合（argv[2..]），SHA256SUMS.txt 写入首个目录；
//   2. 输出行格式 `<sha256hex>  <文件名>`（两个空格，GNU sha256sum 兼容）；
//   3. 跳过已存在的 SHA256SUMS.txt 自身，避免自我哈希；
//   4. 目录为空/不存在时返回失败（CLI exit 1）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as crypto from 'node:crypto';
import { writeHashSums } from '../scripts/make-release-hashes.js';

function sha256Of(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function makeDir(name: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), name));
  for (const [f, c] of Object.entries(files)) {
    const p = join(dir, f);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, c, 'utf8');
  }
  return dir;
}

test('聚合多目录五类扩展名并写入 SHA256SUMS.txt 到首个目录', async () => {
  const d1 = makeDir('dsh-hash-a-', { 'Setup.exe': 'exe-bytes', 'app.deb': 'deb-bytes' });
  const d2 = makeDir('dsh-hash-b-', { 'Deepseek-Harness-EAC-6.0.0-x86_64.AppImage': 'appimage-bytes', 'portable.zip': 'zip-bytes', 'Setup.exe.blockmap': 'blockmap-bytes' });
  try {
    const r = await writeHashSums([d1, d2]);
    assert.equal(r.files.length, 5, '五类产物全部纳入: ' + JSON.stringify(r.files));
    const out = readFileSync(join(d1, 'SHA256SUMS.txt'), 'utf8');
    const lines = out.trim().split('\n');
    assert.equal(lines.length, 5);
    for (const line of lines) {
      const [hex, name] = line.split('  ');
      assert.match(hex, /^[0-9a-f]{64}$/, '行格式为 `<hex>  <name>`');
      assert.ok(name, '文件名非空');
    }
    // 抽查哈希正确性（按内容）
    assert.ok(out.includes(sha256Of('deb-bytes') + '  app.deb'));
    assert.ok(out.includes(sha256Of('appimage-bytes') + '  Deepseek-Harness-EAC-6.0.0-x86_64.AppImage'));
  } finally {
    rmSync(d1, { recursive: true, force: true });
    rmSync(d2, { recursive: true, force: true });
  }
});

test('跳过 SHA256SUMS.txt 自身与无关扩展名', async () => {
  const d = makeDir('dsh-hash-c-', {
    'app.AppImage': 'x',
    'SHA256SUMS.txt': 'old-content',
    'notes.txt': 'n',
    'debug.log': 'l',
  });
  try {
    const r = await writeHashSums([d]);
    assert.equal(r.files.length, 1);
    assert.equal(r.files[0], 'app.AppImage');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('目录不存在或无产物时抛错（CLI 转.exit 1）', async () => {
  const missing = join(tmpdir(), 'dsh-hash-none-' + Date.now());
  await assert.rejects(() => writeHashSums([missing]), /不存在/);
  const empty = makeDir('dsh-hash-empty-', { 'readme.md': 'x' });
  try {
    await assert.rejects(() => writeHashSums([empty]), /没有.*产物/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
