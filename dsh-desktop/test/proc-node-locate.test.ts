import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const proc = require('../lib/proc.js');

test('Task 9.3 node 运行时按平台返回 vendored 布局', () => {
  assert.equal(proc.nodeRuntimeRelativePath('win32'), join('vendor', 'node', 'node.exe'));
  assert.equal(proc.nodeRuntimeRelativePath('linux'), join('vendor', 'node', 'bin', 'node'));
  assert.equal(proc.nodeRuntimeRelativePath('darwin'), join('vendor', 'node', 'bin', 'node'));
});

test('Task 9.3 fetch-node 支持 linux-x64 下载与对应 vendor 目标', () => {
  const source = readFileSync(join(root, 'scripts', 'fetch-node.ts'), 'utf8');
  assert.match(source, /linux-x64/);
  assert.match(source, /node-v\$\{version\}-linux-x64\.tar\.xz/);
  assert.match(source, /vendor.*node.*bin.*node/s);
});

test('Task 9.3 Tauri 壳解析 Windows 与 Linux node 路径并按平台回退 PATH', () => {
  const source = readFileSync(join(root, '..', 'tauri-shell', 'src', 'main.rs'), 'utf8');
  assert.match(source, /vendor\/node\/node\.exe/);
  assert.match(source, /vendor\/node\/bin\/node/);
  assert.match(source, /cfg!\(windows\).*"node\.exe".*"node"/s);
});
