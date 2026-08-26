import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const main = readFileSync(join(repo, 'tauri-shell', 'src', 'main.rs'), 'utf8');
const config = JSON.parse(readFileSync(join(repo, 'tauri-shell', 'tauri.conf.json'), 'utf8'));

test('Task 9.2 壳层资源定位与 spawn 平台差异由 Platform 抽象承载', () => {
  assert.match(main, /trait Platform/);
  assert.match(main, /fn resource_root\(/);
  assert.match(main, /fn configure_command\(/);
  assert.match(main, /impl Platform for CurrentPlatform/);
  assert.match(main, /#\[cfg\(windows\)\][\s\S]*creation_flags\(0x0800_0000\)/);
});

test('Task 9.2 Linux bundle targets 包含 deb 与 AppImage 并保留 NSIS', () => {
  assert.deepEqual(config.bundle.targets, ['nsis', 'deb', 'appimage']);
});
