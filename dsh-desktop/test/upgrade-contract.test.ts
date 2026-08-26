import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const repo = join(root, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
const config = JSON.parse(readFileSync(join(repo, 'tauri-shell', 'tauri.conf.json'), 'utf8')) as {
  bundle: { targets: string[]; windows: { nsis: { installerHooks: string } } };
};
const hooks = readFileSync(join(repo, 'tauri-shell', 'installer-hooks.nsh'), 'utf8');
const release = readFileSync(join(repo, '.github', 'workflows', 'release-tauri.yml'), 'utf8');

const MAIN_LAST_VERSION = '4.6.0';

function macroBlock(name: string): string {
  const lines = hooks.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes(`!macro ${name}`));
  const end = lines.findIndex((line, index) => index > start && line.trim() === '!macroend');
  assert.ok(start >= 0, `${name} 宏应存在`);
  assert.ok(end > start, `${name} 宏应有结束`);
  return lines.slice(start, end + 1).join('\n');
}

test('当前版本高于旧主线最后版本，升级能被触发', async () => {
  const { compareVersions } = await import(new URL('../updater.js', import.meta.url));
  assert.ok(compareVersions(pkg.version, MAIN_LAST_VERSION) > 0);
});

test('Tauri 同时声明 Windows 与 Linux 安装目标', () => {
  assert.deepEqual(config.bundle.targets, ['nsis', 'deb', 'appimage']);
  assert.equal(config.bundle.windows.nsis.installerHooks, 'installer-hooks.nsh');
});

test('Tauri 安装钩子接管旧壳且不触碰用户数据', () => {
  assert.match(hooks, /DSH_TakeoverOldShell/);
  assert.match(hooks, /Deepseek Harness EAC/);
  assert.match(hooks, /com\.deepseek\.dsh\.desktop/);
  for (const line of hooks.split(/\r?\n/).filter((value) => /^\s*(Delete|RMDir)\b/i.test(value))) {
    assert.doesNotMatch(line, /\.dsh|APPDATA/i);
  }
});

test('Tauri 旧壳接管读取卸载器与安装目录注册表值', () => {
  const block = macroBlock('DSH_TakeoverOldShell HIVE KEYNAME');
  assert.match(block, /ReadRegStr \$0[\s\S]*"UninstallString"/);
  assert.match(block, /ReadRegStr \$1[\s\S]*"InstallLocation"/);
});

test('Tauri 旧壳接管剥离卸载器路径的整串引号', () => {
  const block = macroBlock('DSH_TakeoverOldShell HIVE KEYNAME');
  assert.match(block, /\$\{If\} \$4 == '\"'[\s\S]*StrCpy \$3 \$3 "" 1[\s\S]*StrCpy \$3 \$3 -1/);
});

test('Tauri 旧壳接管剥离安装目录的整串引号', () => {
  const block = macroBlock('DSH_TakeoverOldShell HIVE KEYNAME');
  assert.match(block, /\$\{If\} \$2 == '\"'[\s\S]*StrCpy \$1 \$1 "" 1[\s\S]*StrCpy \$1 \$1 -1/);
});

test('Tauri 旧壳接管仅对非盘符根目录剥离尾反斜杠', () => {
  const block = macroBlock('DSH_TakeoverOldShell HIVE KEYNAME');
  assert.match(block, /\$\{If\} \$2 > 3[\s\S]*\$\{If\} \$2 == '\\'[\s\S]*StrCpy \$1 \$1 -1/);
});

test('Tauri 旧壳接管仅执行真实存在的卸载器', () => {
  const block = macroBlock('DSH_TakeoverOldShell HIVE KEYNAME');
  assert.match(block, /\$\{If\} \$\{FileExists\} "\$3"[\s\S]*ExecWait/);
  assert.match(block, /\$\{Else\}[\s\S]*卸载器缺失/);
});

test('Tauri 旧壳卸载命令使用清洗路径与裸 _?= 安装目录', () => {
  const block = macroBlock('DSH_TakeoverOldShell HIVE KEYNAME');
  assert.match(block, /ExecWait '\"\$3\" \/S _\?=\$1'/);
  assert.doesNotMatch(block, /_\?="\$1"/);
});

test('Tauri 旧壳接管无论卸载器状态都会清理旧卸载键', () => {
  const block = macroBlock('DSH_TakeoverOldShell HIVE KEYNAME');
  assert.match(block, /DeleteRegKey \$\{HIVE\}[\s\S]*\$\{KEYNAME\}/);
});

test('Tauri 进程终止宏按镜像名强制回收完整进程树', () => {
  const block = macroBlock('DSH_KillAppExe EXENAME');
  assert.match(block, /taskkill \/F \/T \/IM "\$\{EXENAME\}"/);
});

test('Tauri 预安装终止新旧壳并使用原生有界等待', () => {
  const block = macroBlock('NSIS_HOOK_PREINSTALL');
  assert.match(block, /DSH_KillAppExe "dsh-eac-shell\.exe"/);
  assert.match(block, /DSH_KillAppExe "Deepseek Harness EAC\.exe"/);
  assert.match(block, /Sleep 2000/);
});

test('Tauri 预安装不使用 cmd 管道、网络等待或缺失插件', () => {
  const block = macroBlock('NSIS_HOOK_PREINSTALL');
  assert.doesNotMatch(block, /cmd\s*\/c|\||\bfind\b|nsProcess::|ping\b/i);
});

test('Tauri 预安装接管产品名与应用标识两个旧卸载键', () => {
  const block = macroBlock('NSIS_HOOK_PREINSTALL');
  assert.match(block, /DSH_TakeoverOldShell (?:HKCU|HKLM) "Deepseek Harness EAC"/);
  assert.match(block, /DSH_TakeoverOldShell (?:HKCU|HKLM) "com\.deepseek\.dsh\.desktop"/);
});

test('Tauri 安装钩子的删除动作不触碰用户数据目录', () => {
  assert.doesNotMatch(hooks, /(?:Delete|RMDir)[^\n]*(?:\.dsh|APPDATA)/i);
});

test('Tauri 发布上传 Windows 与 Linux x64 资产（dist 汇总 + SHA256）', () => {
  assert.match(release, /mkdir -p dist/);
  assert.match(release, /bundle\/nsis\/\*\.exe/);
  assert.match(release, /portable\/\*\.zip/);
  assert.match(release, /bundle\/deb\/\*\.deb/);
  assert.match(release, /bundle\/appimage\/\*\.AppImage/);
  assert.match(release, /node scripts\/make-release-hashes\.js dist/);
  assert.match(release, /dsh-desktop\/dist\/\*/);
  assert.match(release, /artifacts\/\*/);
});
