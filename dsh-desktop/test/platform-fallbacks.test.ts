import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const watchdog = require('../lib/watchdog-boot.js');
const shortcuts = require('../lib/shortcuts.js');
const updateFlow = require('../lib/update-flow.js');

test('Task 9.4 Linux 下 junction 巡检静默 no-op', () => {
  assert.equal(watchdog.junctionWatchdogSupported('linux'), false);
  assert.equal(watchdog.junctionWatchdogSupported('win32'), true);
});

test('Task 9.4 Linux 下 .lnk 快捷方式维护静默 no-op', () => {
  assert.equal(shortcuts.shortcutMaintenanceSupported('linux'), false);
  assert.equal(shortcuts.shortcutMaintenanceSupported('win32'), true);
});

test('Task 9.4 Linux 客户端更新入口禁用并提示包管理器升级', () => {
  assert.deepEqual(updateFlow.clientUpdatePlatformPolicy('linux'), {
    enabled: false,
    message: 'Linux 版本由系统包管理器升级。',
  });
  assert.equal(updateFlow.clientUpdatePlatformPolicy('win32').enabled, true);
});

test('Task 9.4 非 Windows 不生成含注册表与 NSIS 命令的应用内更新脚本', () => {
  assert.equal(updateFlow.clientUpdatePlatformPolicy('darwin').enabled, false);
});
