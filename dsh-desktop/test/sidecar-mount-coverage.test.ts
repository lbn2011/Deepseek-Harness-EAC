import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, '..');
const serverPath = join(repo, 'tauri-shell', 'sidecar', 'server.ts');

const REQUIRED_MODULES = [
  'state', 'log', 'host-ctx', 'proc', 'paths', 'server', 'boot', 'watchdog-boot',
  'shortcuts', 'plugin-copy', 'plugins', 'plugin-manager-core', 'market-modules',
  'market-ops', 'preview', 'guard', 'balance-ui', 'bridge', 'migration', 'onboarding',
  'run-state', 'session-heal', 'terminal', 'tray', 'update-flow', 'window', 'ipc/index',
  'snapshot/manager', 'snapshot/scheduler', 'supervisor/registry',
  'supervisor/state-machine', 'supervisor/installer', 'supervisor/permissions',
  'supervisor/incidents', 'extension-host/manager', 'extension-host/bridge-server',
  'extension-host/job-fence', 'recovery-center/register-sidecar',
];

test('sidecar 统一模块挂载清单覆盖全部 37+ 运行模块', () => {
  const server = readFileSync(serverPath, 'utf8');
  for (const moduleName of REQUIRED_MODULES) {
    assert.match(server, new RegExp(`['\"]${moduleName.replace('/', '\\/')}['\"]`), `缺少统一模块挂载: ${moduleName}`);
  }
  assert.ok(REQUIRED_MODULES.length >= 37);
  assert.doesNotMatch(server, /lib['\"], ['\"]desktop|LIB_DESKTOP|mount\(['\"]proc['\"]\)/);
});

test('lib/desktop 过渡目录与 transition tsconfig 已退役', () => {
  assert.equal(existsSync(join(root, 'lib', 'desktop')), false);
  assert.equal(existsSync(join(root, 'tsconfig.transition.json')), false);
});

test('sidecar 全部 TypeScript 使用标准 import 且主 tsconfig 直接编译', () => {
  for (const name of ['server.ts', 'bridge.ts', 'ping.ts', 'rescue-integration.ts', 'ipc-surface.ts']) {
    const src = readFileSync(join(repo, 'tauri-shell', 'sidecar', name), 'utf8');
    assert.doesNotMatch(src, /import\s+[^\n=]+\s*=\s*require\(/, `${name} 仍有 import = require`);
  }
  const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8')) as { include: string[]; exclude: string[] };
  assert.ok(tsconfig.include.includes('../tauri-shell/sidecar/**/*.ts'));
  assert.ok(!tsconfig.exclude.includes('lib/desktop'));
});

test('Tauri 装配清单不再复制 lib/desktop，统一 lib 运行闭包齐全', () => {
  const stage = readFileSync(join(repo, 'tauri-shell', 'stage-resources.mjs'), 'utf8');
  assert.doesNotMatch(stage, /const LIB_DESKTOP/);
  // copyLibTree 整树递归装配 lib/ 运行产物——源闭包存在即随包（替代逐个
  // 手列 string literal，手维护曾漏装 lib/logger 等子目录）。
  assert.match(stage, /function copyLibTree\(\)/);
  for (const file of ['ipc/index.js', 'ipc/transport.js', 'snapshot/manager.js', 'snapshot/scheduler.js', 'server.js', 'paths.js', 'proc.js']) {
    const src = join(repo, 'dsh-desktop', 'lib', file);
    assert.equal(existsSync(src), true, `lib 源闭包缺少 ${file}（copyLibTree 整树装配会随之漏装）`);
  }
});
