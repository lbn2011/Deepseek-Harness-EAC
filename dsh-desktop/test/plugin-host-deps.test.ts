import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// a1569b3（真实 profile 首启插件宿主依赖缺失）：rc.2 的 dsh-app-boot 首启会
// pnpm 重建 <home>/profiles/node_modules 共享层，符号链接/手工副本被清，而
// web-app 闭包不传递 schemastery —— better-sidebar / dsh-side-session require
// 它即 ERR_MODULE_NOT_FOUND 拖垮整棵插件树。修复：syncCompanionPlugins 在
// 插件层 <profile>/node_modules 落位真实目录副本（版本戳幂等、依赖闭包递归），
// 共享层归内核管随时重建，插件层不受影响。lib/plugins.ts（Electron 链）从
// main 侧 companion-sync 移植同语义。

const require = createRequire(import.meta.url);
const plugins = require('../lib/plugins.js');

const schemasteryVersion = require('../node_modules/schemastery/package.json').version;

test('ensurePluginHostDeps：插件层落位 schemastery 真实目录 + 依赖闭包递归', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hostdep-'));
  try {
    const profileDir = join(tmp, 'profile');
    mkdirSync(profileDir, { recursive: true });
    plugins.ensurePluginHostDeps(profileDir);
    const dest = join(profileDir, 'node_modules', 'schemastery');
    assert.equal(existsSync(join(dest, 'package.json')), true, 'schemastery 真实目录已落位');
    const stamp = JSON.parse(readFileSync(join(dest, '.eac-host-dep.json'), 'utf8'));
    assert.equal(stamp.version, schemasteryVersion, '版本戳与源一致');
    // 依赖闭包递归：cosmokit / @standard-schema/spec 在 app node_modules 已提升。
    assert.equal(
      existsSync(join(profileDir, 'node_modules', 'cosmokit', 'package.json')),
      true,
      '依赖 cosmokit 递归落位',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ensurePluginHostDeps：版本戳幂等（同版本不重拷）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hostdep-'));
  try {
    const profileDir = join(tmp, 'profile');
    mkdirSync(profileDir, { recursive: true });
    plugins.ensurePluginHostDeps(profileDir);
    const stampFile = join(profileDir, 'node_modules', 'schemastery', '.eac-host-dep.json');
    const first = readFileSync(stampFile, 'utf8');
    plugins.ensurePluginHostDeps(profileDir);
    assert.equal(readFileSync(stampFile, 'utf8'), first, '同版本重放不重写戳记');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
