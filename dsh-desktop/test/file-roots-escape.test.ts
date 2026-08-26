// Task 12⑦（tdd.md 安全专项 / AC-12）：H2/H3 路径围栏逃逸测试。
//
// 安全边界（主文档 §8）：文件还原/打开仅限「会话 cwd」根集合之内；
// 危险扩展名（Startup\*.bat 等可执行/脚本类）一律拒绝，防止路径逃逸
// 写入自启动目录或执行任意命令。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { DANGEROUS_EXT, isUnderFileRoots } = await import('../lib/paths.js');

// ---- DANGEROUS_EXT：危险扩展名围栏 ----

test('DANGEROUS_EXT 拒绝可执行/脚本/快捷方式类扩展名', () => {
  const dangerous = [
    'C:\\Users\\x\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\pwn.bat',
    'C:\\Windows\\Temp\\x.cmd',
    'malware.exe',
    'evil.ps1',
    'auto.vbs',
    'shortcut.lnk',
    'payload.js',
    'macro.jse',
    'installer.msi',
    'screen.scr',
    'pif.pif',
    'registry.reg',
    'BATCH.BAT', // 大小写不敏感
  ];
  for (const p of dangerous) {
    assert.ok(DANGEROUS_EXT.test(p), `应拒绝危险扩展名: ${p}`);
  }
});

test('DANGEROUS_EXT 放行普通文档/资源类扩展名', () => {
  const safe = ['notes.txt', 'report.md', 'data.json', 'image.png', 'archive.zip', 'config.yaml', 'code.ts', 'readme'];
  for (const p of safe) {
    assert.ok(!DANGEROUS_EXT.test(p), `不应拒绝安全扩展名: ${p}`);
  }
});

// ---- isUnderFileRoots：会话 cwd 根集合围栏 ----

function makeSessionHome(cwd: string): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-roots-'));
  const sessionDir = join(home, 'sessions', 'session-1');
  mkdirSync(sessionDir, { recursive: true });
  const header = JSON.stringify({ cwd }) + '\n';
  writeFileSync(join(sessionDir, 'session.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(header, 'utf8')));
  return home;
}

test('isUnderFileRoots 放行会话 cwd 之下的项目文件', () => {
  const project = join(tmpdir(), 'dsh-proj-' + Date.now());
  mkdirSync(project, { recursive: true });
  const home = makeSessionHome(project);
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    assert.equal(isUnderFileRoots(join(project, 'src', 'app.ts')), true, 'cwd 子路径应放行');
    assert.equal(isUnderFileRoots(project), true, 'cwd 根本身应放行');
  } finally {
    process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('isUnderFileRoots 拒绝会话 cwd 之外的绝对路径（Startup\*.bat 逃逸）', () => {
  const project = join(tmpdir(), 'dsh-proj2-' + Date.now());
  mkdirSync(project, { recursive: true });
  const home = makeSessionHome(project);
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const startup = join(tmpdir(), 'Startup', 'evil.bat');
    assert.equal(isUnderFileRoots(startup), false, 'Startup\\*.bat 必须拒绝');
    const sibling = join(tmpdir(), 'other-project', 'x.ts');
    assert.equal(isUnderFileRoots(sibling), false, '会话 cwd 之外的兄弟目录必须拒绝');
    assert.equal(isUnderFileRoots(join(project, '..', '..', 'Windows', 'evil.bat')), false, '路径穿越 ..\\.. 必须拒绝');
  } finally {
    process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('isUnderFileRoots 拒绝裸可执行类绝对路径（DANGEROUS_EXT 双保险）', () => {
  const project = join(tmpdir(), 'dsh-proj3-' + Date.now());
  mkdirSync(project, { recursive: true });
  const home = makeSessionHome(project);
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    // 会话 cwd 之外 + 危险扩展名 → 双重拒绝
    const bat = join(tmpdir(), 'Startup', 'pwn.bat');
    assert.equal(isUnderFileRoots(bat), false);
    assert.ok(DANGEROUS_EXT.test(bat));
  } finally {
    process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
