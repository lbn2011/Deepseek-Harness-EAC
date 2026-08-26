// Task 12⑨⑹ release 加固与导航围栏源码断言（tdd.md 安全专项）。
//
// 本机 MSVC link.exe 0xc0000139 阻断 tauri-shell cargo test，nav_fence.rs 的
// 表驱动单测（6 例）由 CI `cargo test --manifest-path ../tauri-shell/Cargo.toml`
// 运行；此处以源码断言补一层即时回归护栏：
//   1. Cargo.toml 默认 features 不含 "devtools"（release 亦禁用 devtools）
//   2. main.rs devtools 分支被 cfg(any(debug_assertions, ...)) 编译级门禁
//   3. main.rs 导航围栏委托 nav_fence::is_allowed_navigation（纯函数抽取）
//   4. nav_fence.rs 存在表驱动单测

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('Cargo.toml 默认 features 不含 devtools（release 禁 devtools）', () => {
  const cargo = readFileSync(join(root, 'tauri-shell', 'Cargo.toml'), 'utf8');
  const m = cargo.match(/^tauri = \{[^}]*features = (\[[^\]]*\])/m);
  assert.ok(m, '应找到 tauri features 数组');
  const features = m![1];
  assert.ok(!/devtools/.test(features), '默认 features 不得含 devtools，实际: ' + features);
  assert.ok(/tray-icon/.test(features), '保留 tray-icon');
});

test('main.rs devtools 分支被 cfg(debug_assertions) 编译级门禁', () => {
  const main = readFileSync(join(root, 'tauri-shell', 'src', 'main.rs'), 'utf8');
  const idx = main.indexOf('"devtools" =>');
  assert.ok(idx >= 0, 'main.rs 应存在 devtools 分支');
  const seg = main.slice(idx, idx + 260);
  assert.match(seg, /cfg\(any\(debug_assertions/, 'devtools 分支应含 cfg(any(debug_assertions,...)) 门禁');
});

test('main.rs 导航围栏委托 nav_fence::is_allowed_navigation', () => {
  const main = readFileSync(join(root, 'tauri-shell', 'src', 'main.rs'), 'utf8');
  assert.match(main, /mod nav_fence;/);
  assert.match(main, /fn is_allowed_main_navigation\(target: &tauri::Url\) -> bool/);
  assert.match(main, /nav_fence::is_allowed_navigation\(target, current_web_url\(\)\.as_deref\(\), WS_PORT\)/);
});

test('nav_fence.rs 含表驱动单测（scheme 拒 / 同源 / 回环端口白名单）', () => {
  const nf = readFileSync(join(root, 'tauri-shell', 'src', 'nav_fence.rs'), 'utf8');
  assert.match(nf, /#\[cfg\(test\)\]/);
  assert.match(nf, /rejects_non_http_schemes/);
  assert.match(nf, /allows_loopback_host_on_ws_port/);
  assert.match(nf, /rejects_external_hosts/);
});
