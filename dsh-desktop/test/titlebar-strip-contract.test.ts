import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bridge = readFileSync(join(repo, 'tauri-shell', 'sidecar', 'bridge.ts'), 'utf8');

test('Tauri bridge 从同一标题栏高度声明页面兼容属性', () => {
  const barHeight = Number(bridge.match(/var BAR_HEIGHT = (\d+)/)?.[1]);
  assert.ok(barHeight > 0);
  assert.match(bridge, /setAttribute\('data-dsh-title-bar-height', String\(BAR_HEIGHT\)\)/);
});

test('vendored better-sidebar honors the attribute', () => {
  const client = readFileSync(join(repo, 'dsh-desktop', 'assets', 'plugins', 'dsh-better-sidebar', 'lib', 'client.js'), 'utf8');
  assert.match(client, /data-dsh-title-bar-height/);
  // 5.3.x 上游 bundle 的 CSS Modules 哈希由 .dxPSYW_panel 变为 .nArs4W_panel，
  // 契约本身不变：compat 属性存在时 panel 顶部让位标题栏条带。
  assert.match(client, /body\[data-dsh-title-bar-compat\] \.nArs4W_panel\{padding-top:var\(--dsh-title-bar-strip/);
});
