/**
 * compareVersions 版本比较测试（自 main e7c74ff 的 updater-version.test.mjs
 * 移植）：
 *   - v 前缀剥离 + 缺省段补 0：4.4 与 4.4.0 相等（#112 修复 NaN 误比）；
 *   - 预发布段：rc 排在正式版之前，rc.N 按数字排。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compareVersions } from '../updater.js';

test('版本号缺少第三段时按 0 补齐', () => {
  assert.equal(compareVersions('4.4', '4.4.0'), 0);
  assert.equal(compareVersions('v4.4', '4.4.0'), 0);
  assert.equal(compareVersions('4.4.1', '4.4'), 1);
  assert.equal(compareVersions('4.3.9', '4.4'), -1);
});

test('预发布版本仍排在正式版本之前', () => {
  assert.equal(compareVersions('4.4.0-rc.1', '4.4.0'), -1);
  assert.equal(compareVersions('4.4.0', '4.4.0-rc.1'), 1);
  assert.equal(compareVersions('4.4.0-rc.2', '4.4.0-rc.1'), 1);
});
