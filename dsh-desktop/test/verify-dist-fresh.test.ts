// TDD tests for the release freshness guard (v2.0.3 incident).
//
// v2.0.3 was published from artifacts built BEFORE the last source changes
// (after-pack edits at 20:52, installer.nsh commit at 22:31, artifacts built
// at 20:35, uploaded 22:33+). Users received an installer with the OLD
// installer logic and untrimmed deep paths — the root cause of issue #7.
//
// verifyDistFresh compares every tracked source file's mtime against the
// packaged artifacts' mtime and refuses (exit 1 in CLI mode) when any source
// is newer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyDistFresh } from '../scripts/verify-dist-fresh.js';

const T0 = new Date('2026-08-15T12:00:00Z');
const T1 = new Date('2026-08-15T13:00:00Z'); // artifact built
const T2 = new Date('2026-08-15T14:00:00Z'); // source edited after build

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fresh-'));
  const touch = (p, files, t) => {
    mkdirSync(join(root, p), { recursive: true });
    for (const f of files) {
      const fp = join(root, p, f);
      writeFileSync(fp, 'x');
      utimesSync(fp, t, t);
    }
  };
  touch('src', ['server.ts'], T0);
  touch('tauri-shell', ['installer-hooks.nsh'], T0);
  touch(join('target', 'release', 'bundle', 'nsis'), ['App-Setup-x64.exe'], T1);
  touch(join('target', 'release', 'bundle', 'deb'), ['app_amd64.deb'], T1);
  touch(join('target', 'release', 'bundle', 'appimage'), ['App.AppImage'], T1);
  return root;
}

test('passes when artifacts are newer than every source file', () => {
  const root = makeRepo();
  try {
    const r = verifyDistFresh(root);
    assert.equal(r.ok, true);
    assert.deepEqual(r.offenders, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails and names the offending file when a source is newer than artifacts', () => {
  const root = makeRepo();
  try {
    utimesSync(join(root, 'tauri-shell', 'installer-hooks.nsh'), T2, T2);
    const r = verifyDistFresh(root);
    assert.equal(r.ok, false);
    assert.ok(r.offenders.some((o) => o.includes('installer-hooks.nsh')), 'offender listed, got: ' + JSON.stringify(r.offenders));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ignores changes under target/, node_modules/ and vendor/', () => {
  const root = makeRepo();
  try {
    utimesSync(join(root, 'target', 'release', 'bundle', 'nsis', 'App-Setup-x64.exe'), T2, T2);
    mkdirSync(join(root, 'node_modules', 'foo'), { recursive: true });
    const nm = join(root, 'node_modules', 'foo', 'index.js');
    writeFileSync(nm, 'x');
    utimesSync(nm, T2, T2);
    mkdirSync(join(root, 'vendor', 'npm'), { recursive: true });
    const v = join(root, 'vendor', 'npm', 'x.js');
    writeFileSync(v, 'x');
    utimesSync(v, T2, T2);
    const r = verifyDistFresh(root);
    assert.equal(r.ok, true, 'ignored paths must not count, offenders: ' + JSON.stringify(r.offenders));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails when no Tauri bundle artifacts exist', () => {
  const root = makeRepo();
  try {
    rmSync(join(root, 'target'), { recursive: true, force: true });
    const r = verifyDistFresh(root);
    assert.equal(r.ok, false);
    assert.ok(/no .*artifacts/i.test(r.error || ''), 'must report missing artifacts');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Task 11.1（tdd.md T15）：portable zip 纳入新鲜度守卫 + 平台参数 ----

test('platform=win 把 portable/*.zip 纳入产物集（zip 缺失即失败）', () => {
  const root = makeRepo();
  try {
    const r = verifyDistFresh(root, undefined, { platform: 'win' });
    assert.equal(r.ok, false, 'win 平台必须要求 portable zip 存在');
    assert.match(r.error || '', /portable/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('platform=win：portable zip 存在且比源新则通过，比源旧则失败', () => {
  const root = makeRepo();
  try {
    touchPortable(root, 'Deepseek-Harness-EAC-6.0.0-portable.zip', T1);
    let r = verifyDistFresh(root, undefined, { platform: 'win' });
    assert.equal(r.ok, true, 'portable zip 与产物同刻：应通过，offenders=' + JSON.stringify(r.offenders));
    utimesSync(join(root, 'target', 'release', 'portable', 'Deepseek-Harness-EAC-6.0.0-portable.zip'), new Date('2026-08-15T11:30:00Z'), new Date('2026-08-15T11:30:00Z'));
    r = verifyDistFresh(root, undefined, { platform: 'win' });
    assert.equal(r.ok, false, 'portable zip 比源旧：整组产物 mtime 被拉低应失败');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('platform=linux 忽略 portable 目录（即使不存在 zip 也通过）', () => {
  const root = makeRepo();
  try {
    const r = verifyDistFresh(root, undefined, { platform: 'linux' });
    assert.equal(r.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('默认（无 platform）不要求 portable zip——向后兼容形状', () => {
  const root = makeRepo();
  try {
    const r = verifyDistFresh(root);
    assert.equal(r.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function touchPortable(root: string, name: string, t: Date) {
  mkdirSync(join(root, 'target', 'release', 'portable'), { recursive: true });
  const p = join(root, 'target', 'release', 'portable', name);
  writeFileSync(p, 'zip');
  utimesSync(p, t, t);
}

