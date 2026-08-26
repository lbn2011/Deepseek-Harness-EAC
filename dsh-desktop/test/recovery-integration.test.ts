import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const repo = join(root, '..');
const bridge = readFileSync(join(repo, 'tauri-shell', 'sidecar', 'bridge.ts'), 'utf8');
const shell = readFileSync(join(repo, 'tauri-shell', 'src', 'main.rs'), 'utf8');
const server = readFileSync(join(repo, 'tauri-shell', 'sidecar', 'server.ts'), 'utf8');
const windowSrc = readFileSync(join(root, 'lib', 'window.ts'), 'utf8');
const watchdogSrc = readFileSync(join(root, 'lib', 'watchdog-boot.ts'), 'utf8');
const recoveryIpcSrc = readFileSync(join(root, 'lib', 'ipc', 'recovery.ts'), 'utf8');
const bootSrc = readFileSync(join(root, 'lib', 'boot.ts'), 'utf8');
const runStateSrc = readFileSync(join(root, 'lib', 'run-state.ts'), 'utf8');
const updateFlowSrc = readFileSync(join(root, 'lib', 'update-flow.ts'), 'utf8');

test('renderer recovery 状态机仍挂接窗口抽象', () => {
  assert.match(windowSrc, /from '\.\.\/renderer-recovery\.js'/);
  assert.match(windowSrc, /export function initRendererRecovery\(\)/);
  assert.match(windowSrc, /state\.recovery\.attach\(win, kind\)/);
});

test('run-state 暴露运行态写入与 clean-exit 标记', () => {
  assert.match(runStateSrc, /export function writeRunState\(/);
  assert.match(runStateSrc, /export function markCleanExit\(/);
});

test('watchdog 生命周期由 sidecar boot 链接线', () => {
  assert.match(watchdogSrc, /export function startWatchdog\(\)/);
  assert.match(bootSrc, /writeRunState\(\);/);
  assert.match(bootSrc, /startWatchdog\(\);/);
});

test('已知退出与更新重启路径都会标记 clean exit', () => {
  const marks = [bootSrc, recoveryIpcSrc, updateFlowSrc]
    .reduce((count, source) => count + (source.match(/markCleanExit\(\)/g) ?? []).length, 0);
  assert.ok(marks >= 4, `预期至少 4 条 clean-exit 路径，实际 ${marks}`);
});

test('心跳通道在 Tauri bridge 与统一 IPC 中对齐', () => {
  assert.match(bridge, /log\.renderer-heartbeat/);
  assert.match(recoveryIpcSrc, /dsh:renderer-heartbeat/);
  assert.match(windowSrc, /state\.recovery\.checkHeartbeats\(\)/);
});

test('恢复中心页面与四个恢复动作都可达', () => {
  for (const channel of ['chrome:recovery-state', 'chrome:recovery-reload', 'chrome:recovery-restart', 'chrome:export-logs']) {
    assert.ok(recoveryIpcSrc.includes(`'${channel}'`));
    assert.ok(bridge.includes(`'${channel}'`));
  }
  assert.ok(existsSync(join(root, 'assets', 'recovery.html')));
  assert.match(shell, /open_recovery_center_window/);
});

test('Tauri sidecar 装配 boot.start 与统一 IPC 传输面', () => {
  assert.match(server, /'boot\.start'/);
  assert.match(server, /createSidecarIpcSurface/);
  assert.match(server, /setDefaultIpcSurface/);
});
