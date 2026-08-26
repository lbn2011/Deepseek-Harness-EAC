// 注册表一致性（Task 2.3，vnext×Tauri 统一合并）：
//   1. COMPANION_PLUGINS 每个条目的 dir 都必须指向真实存在的资产目录
//      （合并时旧插件 webui-market/zat-dsh-engine/auto-compact/file-drop 已删除，
//       注册表残留条目会在同步/更新链路上指向不存在的目录）。
//   2. PLUGIN_UPDATE_SOURCES 不残留孤儿映射（key 不在 COMPANION_PLUGINS 里的
//      死映射 —— pluginUpdateSources 只遍历 COMPANION_PLUGINS，孤儿永远不被
//      消费，却让"已删插件仍受支持"的误导信息长存）。
//   3. market-modules 的 artifact-keep / allow-builds ESM 必须能从当前资产树
//      加载（dsh-webui-market 已删，承担者换成 dsh-unified-market；加载失败
//      时实现降级空对象，只有断言函数形状才能暴露静默失效）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPANION_PLUGINS, PLUGIN_UPDATE_SOURCES } from '../lib/plugin-registry-data.js';
import { artifactKeep, allowBuilds } from '../lib/market-modules.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 与 plugin-registry-data.pluginUpdateSources 同一推导：dir 显式优先，否则取包名尾段。 */
function dirOf(p: { dir?: string; name: string }): string {
  return p.dir ?? (p.name.includes('/') ? (p.name.split('/').pop() as string) : p.name);
}

test('注册表一致性：内置插件条目的 dir 全部指向真实资产目录', () => {
  const missing: string[] = [];
  for (const p of COMPANION_PLUGINS) {
    const dir = dirOf(p);
    if (!existsSync(join(ROOT, 'assets', 'plugins', dir, 'package.json'))) {
      missing.push(`${p.id} -> ${dir}`);
    }
  }
  assert.deepEqual(missing, [], '以下条目指向不存在的资产目录（插件已删但注册表未清理）');
});

test('注册表一致性：更新源映射无孤儿（key 必须是内置插件 id）', () => {
  const ids = new Set(COMPANION_PLUGINS.map((p) => p.id));
  const orphan = Object.keys(PLUGIN_UPDATE_SOURCES).filter((k) => !ids.has(k));
  assert.deepEqual(orphan, [], '以下更新源映射的 key 不在内置插件表里（已删插件死映射）');
});

test('market-modules：artifact-keep ESM 从当前资产树加载成功（函数形状齐全）', async () => {
  const ak = await artifactKeep();
  assert.equal(typeof ak.snapshotArtifacts, 'function', 'snapshotArtifacts 缺失（加载静默降级为空对象）');
  assert.equal(typeof ak.restoreArtifacts, 'function', 'restoreArtifacts 缺失（加载静默降级为空对象）');
});

test('market-modules：allow-builds ESM 从当前资产树加载成功（函数形状齐全）', async () => {
  const ab = await allowBuilds();
  assert.equal(typeof ab.parseBlockedBuildKeys, 'function', 'parseBlockedBuildKeys 缺失（加载静默降级为空对象）');
  assert.equal(typeof ab.ensureAllowBuilds, 'function', 'ensureAllowBuilds 缺失（加载静默降级为空对象）');
});
