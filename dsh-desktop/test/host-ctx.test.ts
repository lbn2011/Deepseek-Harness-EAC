// Task 5.4：宿主上下文（lib/host-ctx.ts）契约测试。
//
// host-ctx 是双宿主过渡期的契约面：lib/* 统一模块不直接 import electron，
// 宿主能力（打包态/资源根/通知/剪贴板/消息框/.lnk）经单例注入。三段覆盖：
//   1. 运行时语义：未注入＝开发态缺省（GUI 能力静默/无头兜底，绝不抛错）；
//      initHostCtx 后全量生效；resetHostCtx 恢复缺省（teardown 防串扰）。
//   2. 零依赖门禁：Task 5 批次一 12 模块源码不得出现 electron import；
//      原 electron 面 6 模块必须改经 host-ctx。
//   3. 双宿主接线 + 打包清单：main.ts / sidecar 各自 initHostCtx；
//      sidecar 运行时新依赖 lib/host-ctx.js 必须在 stage-resources 清单。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { hostCtx, initHostCtx, resetHostCtx } = require('../lib/host-ctx.js');

after(() => resetHostCtx());

// ---------------------------------------------------------------------------
// 1. 运行时契约
// ---------------------------------------------------------------------------

test('未注入缺省＝开发态语义：isPackaged=false / resourcesPath 空 / 版本占位', () => {
  resetHostCtx();
  const host = hostCtx();
  assert.equal(host.isPackaged(), false);
  assert.equal(host.resourcesPath(), '');
  assert.equal(host.appVersion(), '0.0.0');
});

test('缺省 getPath 按 OS 惯例：appData/desktop/userData 三目录', () => {
  resetHostCtx();
  const host = hostCtx();
  const expectedAppData = process.platform === 'win32'
    ? (process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'))
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME || join(homedir(), '.config'));
  assert.equal(host.getPath('appData'), expectedAppData);
  assert.equal(host.getPath('desktop'), join(homedir(), 'Desktop'));
  assert.equal(host.getPath('userData'), join(expectedAppData, 'Deepseek Harness EAC'));
});

test('缺省 setPath 记忆 userData 覆盖（影响后续 getPath）', () => {
  resetHostCtx();
  const host = hostCtx();
  host.setPath?.('userData', '/tmp/dsh-userdata-override');
  assert.equal(host.getPath('userData'), '/tmp/dsh-userdata-override');
});

test('缺省 GUI 能力静默不抛错：notify/copyToClipboard/removeAppMenu', () => {
  resetHostCtx();
  const host = hostCtx();
  assert.doesNotThrow(() => host.notify({ title: 't', body: 'b' }));
  assert.doesNotThrow(() => host.notify({ title: 't', body: 'b', icon: 'x.png', onClick: () => {} }));
  assert.doesNotThrow(() => host.copyToClipboard('text'));
  assert.doesNotThrow(() => host.removeAppMenu?.());
});

test('缺省 showMessageBox 无头兜底：应答取 cancelId（＝保守的取消选择）', async () => {
  resetHostCtx();
  const host = hostCtx();
  const r1 = await host.showMessageBox({
    type: 'error', title: 'T', message: 'M', buttons: ['a', 'b', 'c'], defaultId: 0, cancelId: 2,
  });
  assert.equal(r1.response, 2, '有 cancelId 时按 cancelId 应答');
  const r2 = await host.showMessageBox({ type: 'info', title: 'T', message: 'M', buttons: ['x', 'y'] });
  assert.equal(r2.response, 1, '无 cancelId 时按最后一键（关闭语义）应答');
});

test('initHostCtx 注入全量生效：宿主实现逐项接管', () => {
  resetHostCtx();
  const seen: string[] = [];
  initHostCtx({
    isPackaged: () => true,
    resourcesPath: () => 'R:/resources',
    appVersion: () => '9.9.9',
    log: (tag, msg) => seen.push(`log:${tag}:${msg}`),
    exitProcess: (code) => seen.push(`exit:${code}`),
    requestQuit: () => seen.push('quit'),
    notify: (o) => seen.push(`notify:${o.title}`),
    copyToClipboard: (text) => seen.push(`clip:${text}`),
    getPath: (name) => `P:${name}`,
    setPath: (name, value) => seen.push(`set:${name}:${value}`),
    removeAppMenu: () => seen.push('menu'),
    showMessageBox: (o) => { seen.push(`box:${o.title}`); return Promise.resolve({ response: 0 }); },
    shortcuts: {
      readLink: (p) => { seen.push(`read:${p}`); return { target: 't.exe' }; },
      writeLink: (p) => seen.push(`write:${p}`),
    },
  });
  const host = hostCtx();
  assert.equal(host.isPackaged(), true);
  assert.equal(host.resourcesPath(), 'R:/resources');
  assert.equal(host.appVersion(), '9.9.9');
  host.log('tag', 'msg');
  host.exitProcess(3);
  host.requestQuit();
  host.notify({ title: 'N', body: 'B' });
  host.copyToClipboard('C');
  assert.equal(host.getPath('appData'), 'P:appData');
  host.setPath?.('userData', 'U');
  host.removeAppMenu?.();
  assert.equal(host.shortcuts?.readLink('a.lnk').target, 't.exe');
  host.shortcuts?.writeLink('a.lnk', 'create', { target: 't.exe' });
  assert.deepEqual(seen, [
    'log:tag:msg', 'exit:3', 'quit', 'notify:N', 'clip:C', 'set:userData:U',
    'menu', 'read:a.lnk', 'write:a.lnk',
  ]);
});

test('resetHostCtx 恢复缺省并清空路径覆盖', () => {
  resetHostCtx();
  hostCtx().setPath?.('userData', '/stale-override'); // 缺省态先记一个覆盖
  assert.equal(hostCtx().getPath('userData'), '/stale-override');
  initHostCtx({
    isPackaged: () => true,
    resourcesPath: () => 'R',
    appVersion: () => '1.2.3',
    log: () => {},
    exitProcess: () => {},
    requestQuit: () => {},
    notify: () => {},
    copyToClipboard: () => {},
    getPath: () => 'INJECTED',
    showMessageBox: () => Promise.resolve({ response: 0 }),
  });
  assert.equal(hostCtx().getPath('appData'), 'INJECTED');
  resetHostCtx();
  const host = hostCtx();
  assert.equal(host.isPackaged(), false, '注入态须被重置');
  assert.notEqual(host.getPath('userData'), '/stale-override', '缺省态路径覆盖须一并清理');
  assert.notEqual(host.getPath('appData'), 'INJECTED');
});

// ---------------------------------------------------------------------------
// 2. 零依赖门禁（Task 5 批次一 12 模块）
// ---------------------------------------------------------------------------

const TASK5_MODULES = [
  'proc', 'paths', 'server', 'boot', 'watchdog-boot', 'plugin-copy',
  'plugins', 'plugin-manager-core', 'market-modules', 'market-ops', 'preview', 'shortcuts',
];

test('批次一 12 模块零 electron import（Task 6.5 全量门禁的前置切片）', () => {
  for (const m of TASK5_MODULES) {
    const src = readFileSync(join(root, 'lib', `${m}.ts`), 'utf8');
    assert.doesNotMatch(src, /from\s+['"]electron['"]/, `${m}.ts 不得直接 import electron`);
    assert.doesNotMatch(src, /require\(\s*['"]electron['"]\s*\)/, `${m}.ts 不得直接 require electron`);
  }
});

test('原 electron 面 6 模块改经 host-ctx 注入宿主能力', () => {
  for (const m of ['proc', 'server', 'boot', 'watchdog-boot', 'plugins', 'shortcuts']) {
    const src = readFileSync(join(root, 'lib', `${m}.ts`), 'utf8');
    assert.match(src, /host-ctx\.js/, `${m}.ts 应 import lib/host-ctx.ts`);
    assert.match(src, /hostCtx\(\)/, `${m}.ts 应经 hostCtx() 取宿主能力`);
  }
});

// ---------------------------------------------------------------------------
// 3. 双宿主接线 + 打包清单
// ---------------------------------------------------------------------------

test('Tauri sidecar 装配统一 HostCtx', () => {
  const sidecarSrc = readFileSync(join(root, '..', 'tauri-shell', 'sidecar', 'server.ts'), 'utf8');
  assert.match(sidecarSrc, /initHostCtx\(\{/, 'sidecar/server.ts 须装配 Tauri 宿主适配器');
  assert.match(sidecarSrc, /shell\.quit-for-update/, 'sidecar requestQuit 须走壳层有界收口通道');
});

test('打包清单：sidecar 运行时依赖 lib/host-ctx.js 已入装配链', () => {
  const stageSrc = readFileSync(join(root, '..', 'tauri-shell', 'stage-resources.mjs'), 'utf8');
  // copyLibTree 整树递归装配 lib/ 运行产物（替代手维护 LIB_VNEXT 清单），
  // 源 lib/host-ctx.js 存在即随包；同时断言整树装配函数在岗。
  assert.match(stageSrc, /function copyLibTree\(\)/, 'stage-resources 须含 copyLibTree 整树装配');
  const src = join(root, 'lib', 'host-ctx.js');
  assert.equal(existsSync(src), true, '源 lib/host-ctx.js 必须存在（copyLibTree 随之装配，否则打包态 sidecar 启动即 MODULE_NOT_FOUND）');
});
