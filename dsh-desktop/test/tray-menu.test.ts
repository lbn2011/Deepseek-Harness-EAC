// 11be738 移植回归：托盘「完全重启」项存在于 buildTrayMenuSpec() 规格，位于
// 「重启 Web 服务」之后（两项间无其他 label 项）；executeTrayAction
// ('full-restart') 置 state.forceQuit 并经宿主上下文调用 relaunch + requestQuit；
// 「退出」同样 forceQuit + requestQuit 但不 relaunch（两档区分）。
// Task 6 Wave 2：源码断言迁移为行为断言（require 编译产物，注入记录型
// mock hostCtx 捕获 relaunch/requestQuit 调用）。
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildTrayMenuSpec, executeTrayAction } = require('../lib/tray.js');
const { state } = require('../lib/state.js');
const { initHostCtx, resetHostCtx } = require('../lib/host-ctx.js');

type HostCall = ['relaunch'] | ['requestQuit'] | ['exit', number];

/** 注入记录型宿主 mock：捕获 relaunch/requestQuit/exit 调用（其余静默）。 */
function recordingHost(): HostCall[] {
  const calls: HostCall[] = [];
  initHostCtx({
    isPackaged: () => false,
    resourcesPath: () => '',
    appVersion: () => '0.0.0-test',
    log: () => { /* 测试静默 */ },
    exitProcess: (code: number) => { calls.push(['exit', code]); },
    requestQuit: () => { calls.push(['requestQuit']); },
    notify: () => { /* 测试静默 */ },
    copyToClipboard: () => { /* 测试静默 */ },
    getPath: () => '',
    showMessageBox: () => Promise.resolve({ response: 0 }),
    openExternal: () => { /* 测试静默 */ },
    openPath: () => { /* 测试静默 */ },
    showItemInFolder: () => { /* 测试静默 */ },
    relaunch: () => { calls.push(['relaunch']); },
  });
  return calls;
}

afterEach(() => {
  resetHostCtx();
  state.forceQuit = false;
});

test('规格含「完全重启」且紧随「重启 Web 服务」之后（两项间无其他 label 项）', () => {
  const spec = buildTrayMenuSpec() as Array<{ label?: string; type: string; action: string }>;
  const labels = spec.map((it) => it.label ?? '');
  const iRestart = labels.indexOf('重启 Web 服务');
  const iFull = labels.indexOf('完全重启');
  assert.ok(iRestart >= 0, '缺少托盘菜单项「重启 Web 服务」');
  assert.ok(iFull > iRestart, '「完全重启」应位于「重启 Web 服务」下方（11be738 原始位置）');
  // 两者之间只允许分隔符，不得插入其他业务菜单项。
  for (let i = iRestart + 1; i < iFull; i++) {
    assert.equal(spec[i]?.type, 'separator', '两项之间不应插入其他菜单项');
  }
  assert.equal(spec[iFull]?.action, 'full-restart', '「完全重启」语义 id 为 full-restart');
});

test('executeTrayAction full-restart：forceQuit + relaunch + requestQuit 三步语义', () => {
  const calls = recordingHost();
  state.forceQuit = false;
  executeTrayAction('full-restart');
  assert.equal(state.forceQuit, true, '须置 forceQuit 跳过驻留确认');
  assert.ok(calls.some((c) => c[0] === 'relaunch'), '须安排 relaunch（退出后自动拉起新实例）');
  assert.ok(calls.some((c) => c[0] === 'requestQuit'), '须触发退出流程');
});

test('「退出」与「完全重启」两档区分：退出不 relaunch', () => {
  const calls = recordingHost();
  state.forceQuit = false;
  executeTrayAction('quit');
  assert.equal(state.forceQuit, true, '退出同样跳过驻留确认');
  assert.ok(calls.some((c) => c[0] === 'requestQuit'), '须触发退出流程');
  assert.ok(!calls.some((c) => c[0] === 'relaunch'), '普通退出不得 relaunch（否则变成重启）');
});
