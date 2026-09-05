import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const GROUPS_SRC = readFileSync(new URL('../assets/plugins/dsh-settings-groups/lib/client.js', import.meta.url), 'utf8');
// dsh-settings-nav-custom 已随上游 5.3.5 退役（见 RETIRED_BUILTIN_PLUGINS），
// 其 NAV_SRC 断言随之移除；groups 的「不触碰侧边栏」静态契约保留。

// V4.6.1 架构：groups 不再触碰侧边栏 — 避免两个 MutationObserver 对同一批
// 行拉锯导致抽搐。旧的共存标记/豁免/指纹耦合全部删除，groups 只保留页内折叠。

test('groups no longer touches the sidebar (single writer)', () => {
  assert.ok(!GROUPS_SRC.includes("'eac:settings-nav:v1'"), 'groups must not reference nav-custom storage');
  assert.ok(!GROUPS_SRC.includes('applyNav'), 'groups must not contain sidebar applyNav');
  assert.ok(!GROUPS_SRC.includes('eac-settings-groups-navhead'), 'groups must not contain sidebar heads');
  assert.ok(!GROUPS_SRC.includes('data-eac-adv-fold'), 'groups must not contain fold markers');
});

test('groups still folds the general page items', () => {
  assert.ok(GROUPS_SRC.includes('applySection'), 'general-page folding must remain');
  assert.ok(GROUPS_SRC.includes('DEFAULT_ADVANCED_KEYWORDS'), 'general-page keywords must remain');
  assert.ok(GROUPS_SRC.match(/function scan[^]*?applySection/), 'scan must still drive general-page folding');
});
