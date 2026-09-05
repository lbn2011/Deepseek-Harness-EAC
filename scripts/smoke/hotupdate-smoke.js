#!/usr/bin/env node
/**
 * hotupdate-smoke.js — 组件级热更新全链路冒烟（FF1–FF6 全自动化）。
 *
 * 覆盖（主设计 §11 + grill 决议 2026-09-05「全部自动化」）：
 *   基础  sidecar 包快乐路径：检查→下载→校验→快照→交换→RESTART→提交
 *   FF1   篡改必中止（包级 sha256 / 文件级 sha256 两层各一例）
 *   FF2   版本围栏（appVersionRange 外 entry 永不进入 RESOLVED）
 *   FF3   任意时刻可恢复：子进程在 APPLYING（部分交换）/APPLIED/RESTART
 *         三个阶段被 SIGKILL ×3，重启恢复后安装树逐字节 == 预期
 *   FF4   壳存活：sidecar 热更期间守望进程不退出、shell exe 未被动过
 *   FF5   基线协调：baselineSeq > appliedSeq → 状态重置、staging/backups 清空
 *   FF6   熔断：连续 3 次验证失败 → 自动回滚 + blockedSeqs + 再重启
 *   仓库侧 generate.mjs 沙箱：--hotupdate 生成 / --check 一致性 / 围栏拒收
 *
 * 用法: node scripts/smoke/hotupdate-smoke.js
 * 依赖: dsh-desktop 编译产物（lib/hot-update/index.js）与 node_modules/fflate。
 */

const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DD = path.join(ROOT, 'dsh-desktop');
const HU_INDEX = path.join(DD, 'lib', 'hot-update', 'index.js');
const GENERATE_MJS = path.join(ROOT, 'updates', 'generate.mjs');
const TMP = path.join(ROOT, 'tmp-hotupdate-smoke');
const APP_VERSION = '6.0.0';

if (!fs.existsSync(HU_INDEX)) {
  console.error('[smoke] 缺编译产物 ' + HU_INDEX + ' —— 先在 dsh-desktop 跑 npx tsc -p tsconfig.json');
  process.exit(2);
}

const fflate = require(path.join(DD, 'node_modules', 'fflate'));
// 必须在引擎模块加载前设置覆盖（manifest.ts 的 MANIFEST_URLS 模块级求值），
// 而 mock 源端口要先于 require 确定 → mock 固定端口 18790。
const MOCK_PORT = 18790;
process.env.DSH_HOTUPDATE_MANIFEST_URL = `http://127.0.0.1:${MOCK_PORT}/updates/hotupdate.json`;
const huApi = require(HU_INDEX);

// --- 小工具 ---------------------------------------------------------------

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const strToBuf = (s) => Buffer.from(s, 'utf8');

/** 目录快照：{相对路径: sha256}（字节级比对用）。 */
function treeHash(dir) {
  const out = {};
  const walk = (d, prefix) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const rel = prefix ? prefix + '/' + name : name;
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p, rel);
      else out[rel] = sha256(fs.readFileSync(p));
    }
  };
  walk(dir, '');
  return out;
}

function assert(cond, label) {
  if (cond) {
    console.log('  ✓ ' + label);
  } else {
    console.error('  ✗ ' + label);
    process.exit(1);
  }
}

function assertTreeEqual(a, b, label) {
  const ka = Object.keys(a).sort().join('|');
  const kb = Object.keys(b).sort().join('|');
  if (ka !== kb) {
    console.error(`  ✗ ${label}: 文件集不同\n    A=[${ka}]\n    B=[${kb}]`);
    process.exit(1);
  }
  for (const k of ka.split('|')) {
    if (a[k] !== b[k]) {
      console.error(`  ✗ ${label}: 内容不同 ${k}`);
      process.exit(1);
    }
  }
  console.log('  ✓ ' + label + `（${ka.split('|').length} 文件逐字节一致）`);
}

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

// --- 包构造（fflate：与运行时 unzipper 解包同一格式约定） -------------------

/**
 * 构造热更包 zip Buffer + 其 hu-manifest（供清单/沙箱/篡改用）。
 * replaces: {zip内路径: 内容Buffer}；deletes: [路径]（仅清单，无包内文件）。
 */
function buildPackage({ seq, component, version, replaces, deletes = [], restartLevel }) {
  const files = Object.entries(replaces).map(([p, buf]) => ({
    path: p, sha256: sha256(buf), size: buf.length, mode: 'replace',
  }));
  for (const p of deletes) files.push({ path: p, sha256: null, size: 0, mode: 'delete' });
  const hu = {
    schemaVersion: 1,
    seq,
    component,
    version,
    appVersionRange: { min: '0.0.0', max: null },
    restartLevel: restartLevel || (component === 'shell' ? 'app-restart' : 'sidecar-restart'),
    files,
  };
  const zipped = {};
  zipped['hu-manifest.json'] = fflate.strToU8(JSON.stringify(hu, null, 2));
  for (const [p, buf] of Object.entries(replaces)) zipped[p] = new Uint8Array(buf);
  return { hu, zip: Buffer.from(fflate.zipSync(zipped, { level: 0 })) };
}

/** 清单 entry（mock 源 / generate 沙箱共用形状）。 */
function entryFor(seq, title, component, pkg, urlBase, range) {
  return {
    seq,
    title,
    publishedAt: new Date().toISOString(),
    appVersionRange: range || { min: '0.0.0', max: null },
    notes: title,
    components: {
      [component]: {
        version: pkg.hu.version,
        url: `${urlBase}/packages/${component}-${seq}.zip`,
        sha256: sha256(pkg.zip),
        size: pkg.zip.length,
        restartLevel: pkg.hu.restartLevel,
      },
    },
  };
}

// --- mock 清单/包源 --------------------------------------------------------

function startMockSource() {
  const state = { manifest: { schemaVersion: 1, channel: 'stable', generatedAt: '', latestSeq: 0, signature: null, entries: [] }, packages: new Map() };
  const server = http.createServer((req, res) => {
    if (req.url === '/updates/hotupdate.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state.manifest));
      return;
    }
    const m = /^\/packages\/(.+)$/.exec(req.url || '');
    const pkg = m && state.packages.get(m[1]);
    if (pkg) {
      res.writeHead(200, { 'content-length': pkg.length });
      res.end(pkg);
      return;
    }
    res.writeHead(404);
    res.end('no such package: ' + req.url);
  });
  return new Promise((resolve) => {
    server.listen({ port: MOCK_PORT, host: '127.0.0.1' }, () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        base,
        setEntries(entries) {
          state.manifest = { schemaVersion: 1, channel: 'stable', generatedAt: new Date().toISOString(), latestSeq: entries.reduce((m, e) => Math.max(m, e.seq), 0), signature: null, entries };
          for (const e of entries) {
            for (const c of Object.values(e.components || {})) {
              const name = c.url.split('/').pop();
              if (!state.packages.has(name)) state.packages.set(name, null); // 占位，注入见 addPackage
            }
          }
        },
        addPackage(name, buf) { state.packages.set(name, buf); },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// --- 沙箱安装树 ------------------------------------------------------------

function buildInstallTree() {
  const installRoot = path.join(TMP, 'install');
  const userData = path.join(TMP, 'userdata');
  rmrf(TMP);
  const mk = (rel, content) => {
    const p = path.join(installRoot, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  mk('sidecar/server.js', 'SIDECAR-V0\n');
  mk('sidecar/rescue-integration.js', 'RESCUE-V0\n');
  mk('dsh-desktop/main.js', 'MAIN-V0\n');
  mk('dsh-desktop/lib/core.js', 'CORE-V0\n');
  mk('dsh-desktop/assets/onboarding.html', '<html>V0</html>\n');
  mk('dsh-eac-shell.exe', 'EXE-V0\n');
  fs.mkdirSync(userData, { recursive: true });
  return { installRoot, userData };
}

function makeEngine(installRoot, userData, sinks) {
  const ctx = {
    installRoot,
    dshDesktopRoot: path.join(installRoot, 'dsh-desktop'),
    userDataDir: userData,
    appVersion: APP_VERSION,
    log: (tag, msg) => sinks.logs.push(`[${tag}] ${msg}`),
    notify: (ev, params) => sinks.events.push({ ev, params }),
    restartSidecar: () => { sinks.restarts += 1; },
    quitForUpdate: () => { sinks.quits += 1; },
  };
  return huApi.createHotUpdate(ctx);
}

function readState(userData) {
  return huApi.loadState(huApi.huDirs(userData));
}

function pollPhase(userData, phase, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (readState(userData).phase === phase) return true;
    } catch { /* 尚未落盘 */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  }
  return false;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// --- FF3 子进程脚本（部分交换 / 全量交换 / RESTART 挂住被杀） ---------------

const CHILD_SCRIPT = `
const path = require('node:path');
const api = require(process.env.HU_INDEX);
const installRoot = process.env.HU_INSTALL;
const dirs = api.huDirs(process.env.HU_USERDATA);
const seq = parseInt(process.env.HU_SEQ, 10);
const component = process.env.HU_COMPONENT;
const target = process.env.HU_PHASE;
(async () => {
  const stagedDir = path.join(dirs.staging, String(seq), component);
  const hu = await api.unpackAndVerify(process.env.HU_ZIP, stagedDir);
  const backupName = hu.seq + '-' + Date.now();
  api.snapshotBeforeApply(installRoot, path.join(dirs.backups, backupName), hu, '6.0.0');
  const state = api.loadState(dirs);
  state.pending = {
    seq, restartLevel: 'sidecar-restart',
    components: { [component]: { version: hu.version } },
    backups: { [component]: backupName },
  };
  state.phase = 'APPLYING';
  api.saveState(dirs, state);
  if (target === 'APPLYING') {
    // 部分交换现场：只交换第一个文件条目即挂住
    api.exchangeFiles(installRoot, stagedDir, { ...hu, files: hu.files.slice(0, 1) });
  } else {
    api.exchangeFiles(installRoot, stagedDir, hu);
    if (target !== 'APPLYING') {
      state.phase = 'APPLIED';
      api.saveState(dirs, state);
      if (target === 'RESTART') {
        state.phase = 'RESTART';
        state.verifyAttempts = 0;
        api.saveState(dirs, state);
      }
    }
  }
  setInterval(() => {}, 1000); // 挂住，等父进程 SIGKILL
})().catch((e) => { console.error(e); process.exit(3); });
`;

function killChildAtPhase(childScriptPath, env, phase, installRoot, userData) {
  const before = treeHash(installRoot);
  const child = spawn(process.execPath, [childScriptPath], {
    env: { ...process.env, ...env, HU_PHASE: phase },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (!pollPhase(userData, phase, 30000)) {
    child.kill('SIGKILL');
    throw new Error(`子进程未达 ${phase} 阶段（30s 超时）`);
  }
  child.kill('SIGKILL');
  return { before, waitExit: () => new Promise((r) => child.on('exit', r)) };
}

// ===========================================================================
// 主流程
// ===========================================================================

(async () => {
  console.log('[hotupdate-smoke] 启动（FF1–FF6 全自动化）');
  const mock = await startMockSource();
  // 必须在引擎模块加载前设置覆盖（MANIFEST_URLS 模块级求值）
  process.env.DSH_HOTUPDATE_MANIFEST_URL = mock.base + '/updates/hotupdate.json';
  delete require.cache[HU_INDEX]; // 确保 env 生效后加载

  const { installRoot, userData } = buildInstallTree();
  const V0 = treeHash(installRoot);
  const sinks = { events: [], logs: [], restarts: 0, quits: 0 };

  // ---- 基础快乐路径：seq=1 sidecar 包 ------------------------------------
  console.log('\n[基础] sidecar 热更快乐路径');
  const pkg1 = buildPackage({
    seq: 1, component: 'sidecar', version: `${APP_VERSION}-hu1`,
    replaces: { 'sidecar/server.js': strToBuf('SIDECAR-V1\n') },
  });
  mock.addPackage('sidecar-1.zip', pkg1.zip);
  mock.setEntries([entryFor(1, 'sidecar 修复浮窗失联', 'sidecar', pkg1, mock.base)]);
  let engine = makeEngine(installRoot, userData, sinks);
  engine.init();
  const r1 = await engine.checkOnce({ manual: true });
  assert(r1.status === 'applied', 'checkOnce 返回 applied（实际 ' + r1.status + '）');
  assert(fs.readFileSync(path.join(installRoot, 'sidecar', 'server.js'), 'utf8') === 'SIDECAR-V1\n', 'server.js 已交换为 V1');
  assert(readState(userData).phase === 'RESTART', 'phase=RESTART（等待重启验证）');
  engine.onBootSuccess();
  const s1 = readState(userData);
  assert(s1.phase === 'IDLE' && s1.components.sidecar && s1.components.sidecar.seq === 1, 'boot 后提交：IDLE + components.sidecar.seq=1');
  assert(sinks.events.some((e) => e.ev === 'client-update.progress' && e.params.channel === 'hotupdate'), '进度通知经 client-update.progress（channel=hotupdate）');

  // ---- FF2：版本围栏 -------------------------------------------------------
  console.log('\n[FF2] 版本围栏：appVersionRange 外 entry 不进 RESOLVED');
  const pkg2 = buildPackage({
    seq: 2, component: 'sidecar', version: `${APP_VERSION}-hu2`,
    replaces: { 'sidecar/server.js': strToBuf('SIDECAR-V2\n') },
  });
  mock.addPackage('sidecar-2.zip', pkg2.zip);
  mock.setEntries([entryFor(2, '未来版本专用', 'sidecar', pkg2, mock.base, { min: '9.9.9', max: null })]);
  const r2 = await engine.checkOnce({ manual: true });
  assert(r2.status === 'up-to-date', '围栏外 entry 被解析层丢弃（实际 ' + r2.status + '）');
  assert(fs.readFileSync(path.join(installRoot, 'sidecar', 'server.js'), 'utf8') === 'SIDECAR-V1\n', '安装树未被围栏外 entry 触碰');

  // ---- FF1：篡改必中止（两层各一例） ---------------------------------------
  console.log('\n[FF1a] 包级 sha256 篡改 → 中止，现版本继续运行');
  const pkg3 = buildPackage({
    seq: 3, component: 'resources', version: `${APP_VERSION}-hu3`,
    replaces: { 'dsh-desktop/lib/core.js': strToBuf('CORE-V3\n') },
  });
  mock.addPackage('resources-3.zip', pkg3.zip);
  const e3 = entryFor(3, '包级篡改例', 'resources', pkg3, mock.base);
  e3.components.resources.sha256 = 'f'.repeat(64); // 篡改包级哈希
  mock.setEntries([e3]);
  let threw = false;
  try { await engine.checkOnce({ manual: true }); } catch { threw = true; }
  assert(threw, 'checkOnce 抛错（手动检查面）');
  assert(fs.readFileSync(path.join(installRoot, 'dsh-desktop', 'lib', 'core.js'), 'utf8') === 'CORE-V0\n', 'core.js 保持 V0（应用中止）');
  assert(readState(userData).phase === 'IDLE', '状态机回落 IDLE');

  console.log('\n[FF1b] 文件级 sha256 篡改（zip 内夹换内容）→ 中止');
  const pkg4 = buildPackage({
    seq: 4, component: 'resources', version: `${APP_VERSION}-hu4`,
    replaces: { 'dsh-desktop/lib/core.js': strToBuf('CORE-V4-GOOD\n') },
  });
  // 篡改：包内实际内容与 hu-manifest 声明的 sha256 不符
  const tamperedZip = Buffer.from(fflate.zipSync({
    'hu-manifest.json': fflate.strToU8(JSON.stringify(pkg4.hu, null, 2)),
    'dsh-desktop/lib/core.js': fflate.strToU8('CORE-V4-EVIL\n'),
  }, { level: 0 }));
  mock.addPackage('resources-4.zip', tamperedZip);
  mock.setEntries([entryFor(4, '文件级篡改例', 'resources', { hu: pkg4.hu, zip: tamperedZip }, mock.base)]);
  threw = false;
  try { await engine.checkOnce({ manual: true }); } catch (e) { threw = /sha256/.test(String(e.message)); }
  assert(threw, '逐文件 sha256 校验拦截（错误信息含 sha256）');
  assert(fs.readFileSync(path.join(installRoot, 'dsh-desktop', 'lib', 'core.js'), 'utf8') === 'CORE-V0\n', 'core.js 保持 V0');

  // ---- FF4：壳存活（守望进程 + shell exe 不被 sidecar 热更触碰） ----------
  console.log('\n[FF4] 壳存活：sidecar 热更期间守望进程不退出、exe 未动');
  const watcher = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  const pkg5 = buildPackage({
    seq: 5, component: 'resources', version: `${APP_VERSION}-hu5`,
    replaces: { 'dsh-desktop/main.js': strToBuf('MAIN-V5\n'), 'dsh-desktop/lib/core.js': strToBuf('CORE-V5\n') },
  });
  mock.addPackage('resources-5.zip', pkg5.zip);
  mock.setEntries([entryFor(5, 'resources 修复包', 'resources', pkg5, mock.base)]);
  const r5 = await makeEngine(installRoot, userData, sinks).checkOnce({ manual: true }).catch((e) => ({ status: 'error:' + e.message }));
  assert(r5.status === 'applied', 'resources 包应用成功');
  assert(watcher.exitCode === null, '守望（壳）进程存活');
  assert(sha256(fs.readFileSync(path.join(installRoot, 'dsh-eac-shell.exe'))) === sha256(strToBuf('EXE-V0\n')), 'shell exe 未被触碰');
  watcher.kill('SIGKILL');

  // ---- FF3：任意时刻可恢复（强杀 ×3） --------------------------------------
  console.log('\n[FF3] 强杀 ×3：APPLYING（部分交换）/ APPLIED / RESTART');
  const childScriptPath = path.join(TMP, 'hu-child.cjs');
  fs.writeFileSync(childScriptPath, CHILD_SCRIPT);
  const childEnv = { HU_INDEX, HU_INSTALL: installRoot, HU_USERDATA: userData };
  const rounds = [
    { seq: 10, phase: 'APPLYING', component: 'sidecar', pkg: buildPackage({ seq: 10, component: 'sidecar', version: 'hu10', replaces: { 'sidecar/server.js': strToBuf('SIDECAR-V10\n') }, deletes: ['sidecar/rescue-integration.js'] }) },
    { seq: 11, phase: 'APPLIED', component: 'resources', pkg: buildPackage({ seq: 11, component: 'resources', version: 'hu11', replaces: { 'dsh-desktop/main.js': strToBuf('MAIN-V11\n') } }) },
    { seq: 12, phase: 'RESTART', component: 'sidecar', pkg: buildPackage({ seq: 12, component: 'sidecar', version: 'hu12', replaces: { 'sidecar/server.js': strToBuf('SIDECAR-V12\n') } }) },
  ];
  for (const round of rounds) {
    mock.addPackage(`round-${round.seq}.zip`, round.pkg.zip);
    fs.writeFileSync(path.join(TMP, `pkg-${round.seq}.zip`), round.pkg.zip);
    const before = treeHash(installRoot);
    const { waitExit } = killChildAtPhase(childScriptPath, { ...childEnv, HU_ZIP: path.join(TMP, `pkg-${round.seq}.zip`), HU_COMPONENT: round.component, HU_SEQ: String(round.seq) }, round.phase, installRoot, userData);
    await waitExit();
    const eng = makeEngine(installRoot, userData, sinks);
    eng.init();
    const st = readState(userData);
    if (round.phase === 'RESTART') {
      // 重启自检通过 → 提交（新内容保留）
      eng.onBootSuccess();
      assertTreeEqual(treeHash(installRoot), { ...before, 'sidecar/server.js': sha256(strToBuf('SIDECAR-V12\n')) }, `FF3 seq=${round.seq}（${round.phase}）：交换内容保留并提交`);
      assert(readState(userData).phase === 'IDLE', 'RESTART 恢复后提交为 IDLE');
    } else {
      assertTreeEqual(treeHash(installRoot), before, `FF3 seq=${round.seq}（${round.phase} 强杀）：安装树逐字节恢复`);
      assert(st.phase === 'IDLE' && st.blockedSeqs.includes(round.seq), `seq=${round.seq} 入 blockedSeqs、状态 IDLE`);
    }
    mock.setEntries([]); // 清空待应用，避免后续 checkOnce 捡到这些 seq
  }

  // ---- FF6：熔断（连续 3 次验证失败 → 自动回滚 + 再重启） -------------------
  console.log('\n[FF6] 熔断：连续 3 次验证失败');
  const before6 = treeHash(installRoot);
  const restartsBefore = sinks.restarts;
  const pkg30 = buildPackage({
    seq: 30, component: 'resources', version: 'hu30',
    replaces: { 'dsh-desktop/lib/core.js': strToBuf('CORE-V30-BROKEN\n') },
  });
  mock.addPackage('resources-30.zip', pkg30.zip);
  mock.setEntries([entryFor(30, '验证失败例', 'resources', pkg30, mock.base)]);
  const eng6 = makeEngine(installRoot, userData, sinks);
  eng6.init();
  const r30 = await eng6.checkOnce({ manual: true });
  assert(r30.status === 'applied' && readState(userData).phase === 'RESTART', 'seq=30 应用至 RESTART');
  eng6.onBootFailure();
  eng6.onBootFailure();
  assert(readState(userData).phase === 'RESTART' && readState(userData).verifyAttempts === 2, '前两次失败仅计数');
  eng6.onBootFailure();
  const st6 = readState(userData);
  assert(st6.phase === 'IDLE' && st6.blockedSeqs.includes(30), '第 3 次失败熔断：回滚 + blockedSeqs');
  assertTreeEqual(treeHash(installRoot), before6, 'FF6：安装树逐字节恢复');
  assert(sinks.restarts > restartsBefore, '熔断后触发再次重启（重载恢复的文件）');

  // ---- FF5：基线协调 --------------------------------------------------------
  console.log('\n[FF5] 基线协调：正式更新后 state 重置为新基线');
  fs.mkdirSync(path.join(huApi.huDirs(userData).backups, '1-dummy'), { recursive: true });
  fs.writeFileSync(path.join(huApi.huDirs(userData).backups, '1-dummy', 'x'), 'x');
  fs.writeFileSync(path.join(installRoot, 'hotupdate-baseline.json'), JSON.stringify({ baselineSeq: 200, appVersion: '7.0.0' }));
  const eng5 = makeEngine(installRoot, userData, sinks);
  eng5.init();
  const st5 = readState(userData);
  assert(st5.appliedSeq === 200 && st5.baselineSeq === 200, 'appliedSeq/baselineSeq 重置为 200');
  assert(st5.phase === 'IDLE' && !fs.existsSync(path.join(huApi.huDirs(userData).backups, '1-dummy')), 'staging/backups 清空（旧热更备份失效）');

  // ---- 仓库侧 generate.mjs 沙箱（--hotupdate / --check / 围栏拒收） --------
  console.log('\n[generate] 沙箱：--hotupdate 生成 + --check + 围栏拒收');
  const genRoot = path.join(TMP, 'gen');
  fs.mkdirSync(path.join(genRoot, 'updates', 'packages'), { recursive: true });
  fs.copyFileSync(GENERATE_MJS, path.join(genRoot, 'updates', 'generate.mjs'));
  const genPkgs = path.join(genRoot, 'updates', 'packages');
  const goodName = 'dsh-eac-hu-0001-sidecar-6.0.0-hu1.zip';
  fs.writeFileSync(path.join(genPkgs, goodName), pkg1.zip);
  const genRun = (args) => spawnSync(process.execPath, [path.join(genRoot, 'updates', 'generate.mjs'), ...args], { encoding: 'utf8' });
  let g = genRun(['--hotupdate', '--url-base', mock.base]);
  assert(g.status === 0, 'generate --hotupdate 成功（' + (g.stderr || '').trim() + '）');
  const huJson = JSON.parse(fs.readFileSync(path.join(genRoot, 'updates', 'hotupdate.json'), 'utf8'));
  assert(huJson.latestSeq === 1 && huJson.entries[0].components.sidecar.sha256 === sha256(pkg1.zip), 'hotupdate.json 写入且包级 sha256 一致');
  g = genRun(['--check']);
  assert(g.status === 0, 'generate --check 通过');
  // 围栏拒收：bridge.js 禁投
  const bad1 = buildPackage({ seq: 2, component: 'sidecar', version: 'bad', replaces: { 'sidecar/bridge.js': strToBuf('BRIDGE') } });
  fs.writeFileSync(path.join(genPkgs, 'dsh-eac-hu-0002-sidecar-bad.zip'), bad1.zip);
  g = genRun(['--hotupdate', '--url-base', mock.base]);
  assert(g.status !== 0 && /bridge\.js/.test(g.stderr), '围栏拒收 sidecar/bridge.js');
  fs.rmSync(path.join(genPkgs, 'dsh-eac-hu-0002-sidecar-bad.zip'), { force: true });
  // 围栏拒收：resources 夹带 package.json
  const bad2 = buildPackage({ seq: 3, component: 'resources', version: 'bad2', replaces: { 'dsh-desktop/package.json': strToBuf('{}') } });
  fs.writeFileSync(path.join(genPkgs, 'dsh-eac-hu-0003-resources-bad2.zip'), bad2.zip);
  g = genRun(['--hotupdate', '--url-base', mock.base]);
  assert(g.status !== 0 && /禁投|resources 包越界|package\.json/.test(g.stderr), '围栏拒收 resources/package.json');
  fs.rmSync(path.join(genPkgs, 'dsh-eac-hu-0003-resources-bad2.zip'), { force: true });
  // 篡改检测：zip 被改一字节 → 与已生成清单不一致 → --check 红
  fs.writeFileSync(path.join(genPkgs, goodName), Buffer.concat([pkg1.zip, Buffer.from('x')]));
  g = genRun(['--check']);
  assert(g.status !== 0, 'zip 篡改后 --check 红（清单-包体不一致）');
  // --hotupdate 拒收「包内内容与 hu-manifest 声明不符」的篡改包（文件级 sha256）
  const badName = 'dsh-eac-hu-0004-resources-6.0.0-hu4.zip';
  fs.writeFileSync(path.join(genPkgs, badName), tamperedZip);
  g = genRun(['--hotupdate', '--url-base', mock.base]);
  assert(g.status !== 0 && /sha256/.test(g.stderr), '篡改包被 --hotupdate 拒绝（文件级 sha256 不符）');
  fs.rmSync(path.join(genPkgs, badName), { force: true });
  fs.writeFileSync(path.join(genPkgs, goodName), pkg1.zip);

  await mock.close();
  console.log('\n[hotupdate-smoke] 全部通过 ✓（FF1–FF6 + 基础链路 + generate 沙箱）');
  console.log('[hotupdate-smoke] 沙箱保留于 ' + TMP + '（可复查，重跑自动重建）');
  process.exit(0);
})().catch((e) => {
  console.error('[hotupdate-smoke] 失败:', e);
  process.exit(1);
});
