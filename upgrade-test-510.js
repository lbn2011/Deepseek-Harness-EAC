'use strict';
// 5.1.0（Tauri）→ 6.0.0（Tauri）升级路径端到端验证：
//   1) 静默装 5.1.0 → Tauri 布局就位（dsh-eac-shell.exe + sidecar 树）
//   2) 启动 5.1.0 模拟「升级时应用还在运行」
//   3) 静默装 6.0.0 → PREINSTALL 杀进程树 + 接管旧卸载器（继承原安装目录）
//   4) 断言：DisplayVersion 6.0.0、新壳/sidecar 树新旧覆盖一致、内核 rc.2、快捷方式、无进程残留。
//   （与 441 差异：5.1.0 已是 Tauri 布局，无「旧 Electron resources\app 清除」断言）
// 用法：node upgrade-test-510.js <5.1.0-setup> <6.0.0-setup> [期望版本，默认 6.0.0]
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const OLD_SETUP = process.argv[2];
const NEW_SETUP = process.argv[3];
const EXPECT_NEW = process.argv[4] || '6.0.0';
if (!OLD_SETUP || !NEW_SETUP) { console.error('用法: node upgrade-test-510.js <5.1.0-setup> <6.0.0-setup> [期望版本]'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

// BUG-A-009：查询失败必须返回 null 与「成功返回 0」区分（原 catch 返回 e.stdout，
// 空串经 Number('') === 0 令进程残留断言假阳性）
const ps = (script) => {
  try {
    return execSync(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, { encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    const out = e.stdout == null ? '' : String(e.stdout).trim();
    return out !== '' ? out : null;
  }
};
const keyProp = (prop) => ps(`(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Deepseek Harness EAC' -ErrorAction SilentlyContinue).${prop}`);
const unquote = (s) => String(s || '').trim().replace(/^"|"$/g, '');

async function run(setup) {
  return new Promise((resolve) => {
    const p = spawn(setup, ['/S'], { stdio: 'ignore' });
    p.on('exit', (code) => resolve(code));
    p.on('error', () => resolve(-1));
  });
}

async function main() {
  console.log('[upgrade-test-510] 前置检查');
  const preKey = unquote(keyProp('UninstallString'));
  check('初始无旧安装键', preKey === '', preKey.slice(0, 70));
  if (failures) { console.log('[upgrade-test-510] 环境不干净，中止'); process.exit(1); }

  console.log('[upgrade-test-510] 阶段 1：静默安装 5.1.0');
  await run(OLD_SETUP);
  let ok = false;
  for (let i = 0; i < 45 && !ok; i++) {
    const loc = unquote(keyProp('InstallLocation'));
    const un = unquote(keyProp('UninstallString'));
    ok = !!loc && !!un && fs.existsSync(loc) && fs.existsSync(path.join(loc, 'dsh-eac-shell.exe'));
    await sleep(2000);
  }
  const OLD_LOC = unquote(keyProp('InstallLocation'));
  check('5.1.0 卸载键 + Tauri 布局就位', ok, `loc=${OLD_LOC}`);
  const v510 = keyProp('DisplayVersion');
  check('5.1.0 版本键', /^5\./.test(v510), 'v=' + v510);

  console.log('[upgrade-test-510] 阶段 2：启动 5.1.0（模拟升级时应用运行中）');
  const oldExe = path.join(OLD_LOC, 'dsh-eac-shell.exe');
  if (fs.existsSync(oldExe)) { try { spawn(oldExe, [], { detached: true, stdio: 'ignore' }).unref(); } catch {} }
  await sleep(9000);
  const running = ps(`(Get-Process 'dsh-eac-shell' -ErrorAction SilentlyContinue | Measure-Object).Count`);
  console.log('  (旧壳进程数: ' + running + ')');

  console.log('[upgrade-test-510] 阶段 3：静默安装 ' + EXPECT_NEW + '（杀进程 + 接管）');
  const t0 = Date.now();
  const c3 = await run(NEW_SETUP);
  console.log('  (新安装器退出码 ' + c3 + '，耗时 ' + Math.round((Date.now() - t0) / 1000) + 's)');

  console.log('[upgrade-test-510] 阶段 4：断言（期望目录 = 继承的 ' + OLD_LOC + '）');
  await sleep(4000);
  const EXP = OLD_LOC;
  const un = unquote(keyProp('UninstallString'));
  const ver = keyProp('DisplayVersion');
  check('卸载键已接管为 ' + EXPECT_NEW, ver === EXPECT_NEW, 'v=' + ver);
  check('卸载器指向新目录', un.includes(EXP) && /uninstall/i.test(un), un.slice(0, 90));
  check('新壳 exe 就位', fs.existsSync(path.join(EXP, 'dsh-eac-shell.exe')));
  check('新 sidecar 布局就位', fs.existsSync(path.join(EXP, 'sidecar', 'server.js')));
  const dshPkg = path.join(EXP, 'dsh-desktop', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  let kern = '';
  try { kern = JSON.parse(fs.readFileSync(dshPkg, 'utf8')).version; } catch {}
  check('安装树内核 = 0.1.1-rc.2', kern === '0.1.1-rc.2', 'got=' + kern);
  const sc = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Deepseek Harness EAC.lnk');
  check('开始菜单快捷方式存在', fs.existsSync(sc));
  const procLeft = ps(`(Get-Process 'Deepseek Harness EAC','dsh-eac-shell' -ErrorAction SilentlyContinue | Measure-Object).Count`);
  check('旧/新进程无残留运行冲突', procLeft !== null && Number(procLeft) === 0, procLeft === null ? '进程查询失败' : 'procs=' + procLeft);

  console.log(failures === 0 ? '[upgrade-test-510] ALL PASS' : `[upgrade-test-510] ${failures} FAILURES`);
  process.exit(failures ? 1 : 0);
}

void main();
