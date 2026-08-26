import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktop = join(repo, 'dsh-desktop');
const main = readFileSync(join(repo, 'tauri-shell', 'src', 'main.rs'), 'utf8');
const navFence = readFileSync(join(repo, 'tauri-shell', 'src', 'nav_fence.rs'), 'utf8');
const bridge = readFileSync(join(repo, 'tauri-shell', 'sidecar', 'bridge.ts'), 'utf8');
const stage = readFileSync(join(repo, 'tauri-shell', 'stage-resources.mjs'), 'utf8');

test('Task 8.1 Tauri 托盘提供 Web 服务重启、完全重启和退出', () => {
  const restart = main.indexOf('"restart", "重启 Web 服务"');
  const relaunch = main.indexOf('"relaunch", "完全重启"');
  const quit = main.indexOf('"quit", "退出"');
  assert.ok(restart >= 0);
  assert.ok(relaunch > restart);
  assert.ok(quit > relaunch);
  assert.match(main, /"relaunch"\s*=>\s*app\.restart\(\)/);
});

test('Task 8.2 主窗导航只放行当前 dsh origin 与本地壳白名单', () => {
  assert.match(main, /fn is_allowed_main_navigation\(/);
  assert.match(main, /nav_fence::is_allowed_navigation\(target, current_web_url\(\)\.as_deref\(\), WS_PORT\)/);
  assert.match(main, /\.on_navigation\(is_allowed_main_navigation\)/);
  // 同源放行 + 回环端口白名单逻辑已抽取到 nav_fence.rs（Task 12⑥ 表驱动单测落点）
  assert.match(navFence, /target\.origin\(\)\s*==\s*base\.origin\(\)/);
  assert.match(navFence, /127\.0\.0\.1|localhost|::1/);
});

test('Task 8.3 Tauri 菜单在重启与重新加载之间拉起快照面板', () => {
  const restart = bridge.indexOf('data-act="restart-service"');
  const snapshot = bridge.indexOf('data-act="open-snapshot-manager"');
  const reload = bridge.indexOf('data-act="reload"');
  assert.ok(restart >= 0);
  assert.ok(snapshot > restart);
  assert.ok(reload > snapshot);
  assert.match(bridge, /openSnapshotPanel/);
  assert.match(main, /\/inject\/snapshot-ui\.js/);
  assert.match(stage, /SIDECAR_UI_FILES\s*=\s*\['snapshot-ui\.js'\]/);
});

test('Task 8.4 Tauri splash 跟随系统主题且恢复中心三入口可达', () => {
  assert.match(main, /color-scheme:\s*light dark/);
  assert.match(main, /prefers-color-scheme:\s*dark/);
  assert.match(main, /"recovery"\s*=>[\s\S]*?open_recovery_center_window\(app\)/);
  assert.match(main, /rc\.open/);
  assert.match(main, /DSH_DESKTOP_RECOVERY/);
});

test('Task 10.1 Electron 壳源码、配置与安装夹具全部退役', () => {
  for (const rel of ['main.ts', 'main.js', 'preload.ts', 'preload.js', 'electron-builder.yml', join('build', 'installer.nsh')]) {
    assert.equal(existsSync(join(desktop, rel)), false, `${rel} 应已删除`);
  }
});

test('Task 10.2 package 脚本与依赖只保留 Node、native 和 Tauri 链', () => {
  const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')) as {
    main?: string;
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.equal(pkg.main, undefined);
  assert.equal(pkg.devDependencies.electron, undefined);
  assert.equal(pkg.devDependencies['electron-builder'], undefined);
  for (const name of ['build', 'typecheck', 'test', 'test:native', 'build:native', 'clippy:native', 'tauri:stage', 'tauri:build']) {
    assert.equal(typeof pkg.scripts[name], 'string', `缺少脚本 ${name}`);
  }
  for (const name of ['start', 'pack', 'dist', 'electron:fetch']) assert.equal(pkg.scripts[name], undefined);
});

test('Task 10.3 CI 使用 Windows 与 Linux 双平台 Tauri matrix', () => {
  const ci = readFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /os:\s*\[windows-latest, ubuntu-latest\]/);
  assert.match(ci, /npm run typecheck/);
  assert.match(ci, /npm run test:native/);
  assert.match(ci, /cargo test --manifest-path \.\.\/tauri-shell\/Cargo\.toml/);
  assert.match(ci, /npm test/);
  assert.match(ci, /npm run tauri:build/);
  assert.equal(existsSync(join(repo, '.github', 'workflows', 'release.yml')), false);
});

test('Task 10.4 Tauri release 注入双版本并按平台上传资产', () => {
  const release = readFileSync(join(repo, '.github', 'workflows', 'release-tauri.yml'), 'utf8');
  assert.match(release, /os:\s*\[windows-latest, ubuntu-latest\]/);
  assert.match(release, /npm version \$\{\{ steps\.tag\.outputs\.version \}\}/);
  assert.match(release, /tauri\.conf\.json/);
  assert.match(release, /cargo test --manifest-path \.\.\/tauri-shell\/Cargo\.toml/);
  assert.match(release, /npm run build:native/);
  assert.match(release, /if: runner\.os == 'Windows'[\s\S]*bundle\/nsis\/\*\.exe/);
  assert.match(release, /if: runner\.os == 'Linux'[\s\S]*bundle\/deb\/\*\.deb[\s\S]*bundle\/appimage\/\*\.AppImage/);
});

test('Task 10.5 受检运行链中不再含 Electron 标识', () => {
  const roots = [join(desktop, 'package.json'), join(desktop, 'lib'), join(repo, 'tauri-shell')];
  const files: string[] = [];
  const walk = (target: string): void => {
    const stat = statSync(target);
    if (stat.isFile()) {
      files.push(target);
      return;
    }
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (entry.name === 'target' || entry.name === 'staged-resources') continue;
      walk(join(target, entry.name));
    }
  };
  roots.forEach(walk);
  const matches = files.filter((file) => /electron/i.test(readFileSync(file, 'utf8')));
  assert.deepEqual(matches, []);
});
