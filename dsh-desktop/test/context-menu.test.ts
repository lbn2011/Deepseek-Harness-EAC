import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shell = readFileSync(join(repo, 'tauri-shell', 'src', 'main.rs'), 'utf8');
const bridge = readFileSync(join(repo, 'tauri-shell', 'sidecar', 'bridge.ts'), 'utf8');

test('Tauri 主窗通过壳层导航围栏', () => {
  assert.match(shell, /fn is_allowed_main_navigation\(/);
  assert.match(shell, /\.on_navigation\(is_allowed_main_navigation\)/);
  assert.match(shell, /127\.0\.0\.1|localhost|::1/);
});

test('Tauri 标题栏菜单保留重启、快照与重新加载入口', () => {
  const restart = bridge.indexOf('data-act="restart-service"');
  const snapshot = bridge.indexOf('data-act="open-snapshot-manager"');
  const reload = bridge.indexOf('data-act="reload"');
  assert.ok(restart >= 0);
  assert.ok(snapshot > restart);
  assert.ok(reload > snapshot);
});

test('Tauri bridge 提供主窗与浮窗的独立标题栏', () => {
  assert.match(bridge, /var BAR_HEIGHT = 36/);
  assert.match(bridge, /var FLOAT_BAR_HEIGHT = 24/);
  assert.match(bridge, /win\.start-dragging/);
});
