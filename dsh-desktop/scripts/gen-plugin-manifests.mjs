#!/usr/bin/env node
/**
 * dsh-std v0.15 manifest 生成器（阶段 2，批次式）。
 *
 * 为 main 线 origin=upstream 的插件生成 dsh-plugin.json（身份 + 来源钉址 +
 * 最小 facets）。manifest 当前是**描述性元数据**：EAC 插件仍经 companion-sync /
 * 注册表加载，不走 @dsh-std/adapter-dsh（其与内核 0.1.3 的兼容性未验证）；
 * manifest 让每个插件可被生态工具识别，并为将来切换适配层备好静态清单。
 *
 * 诚实性约束：facets/permissions 留空 = 尚未参与 std 协商，不编造能力声明；
 * 上游为 monorepo 时在 x-eac.sourceNote 注明。皮肤不生成（走 skin wiring，
 * host facet 语义不实）。
 *
 * 用法：node scripts/gen-plugin-manifests.mjs [--ids C001,C004] [--dry]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ddRoot = join(repoRoot, 'dsh-desktop');
const ledger = JSON.parse(readFileSync(join(ddRoot, 'assets', 'SOURCES.json'), 'utf8'));

const SCHEMA_PIN = 'https://raw.githubusercontent.com/Yan-Zero/dsh-std/614dfa1ac168db79fcf4577cf0ebb34e2e3b944b/packages/manifest/schema/dsh-plugin-0.15.schema.json';
const DRY = process.argv.includes('--dry');
const idsArg = process.argv.findIndex((a) => a === '--ids');
const onlyIds = idsArg >= 0 ? new Set(process.argv[idsArg + 1].split(',')) : null;

function manifestId(repository) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/#]+)/.exec(String(repository || ''));
  if (!m) return null;
  return `io.github.${m[1]}.${m[2]}`.toLowerCase();
}

let written = 0;
for (const entry of ledger.components) {
  if (entry.line !== 'main' || entry.origin !== 'upstream') continue;
  if (entry.type !== 'plugin') continue; // 皮肤走 skin wiring；source-copy 非独立身份
  if (onlyIds && !onlyIds.has(entry.id)) continue;
  const dir = join(repoRoot, entry.path);
  if (existsSync(join(dir, 'dsh-plugin.json'))) {
    console.log(`[manifest] ${entry.id} ${entry.name}: 已有 manifest，不覆盖（手工文件优先）`);
    continue;
  }
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const upstream = entry.upstream || {};
  const repo = upstream.repository || pkg.repository?.url || null;
  if (!repo) {
    console.warn(`[manifest] ${entry.id} ${entry.name}: 无 repository，跳过`);
    continue;
  }
  const main = String(pkg.main || 'index.js').replace(/^\.\//, '');
  if (!existsSync(join(dir, main))) {
    console.error(`[manifest] ${entry.id} ${entry.name}: entry 不存在 ${main}`);
    process.exitCode = 1;
    continue;
  }
  const isMonorepo = /dsh_desktop|dsh-web/.test(repo);
  const manifest = {
    $schema: SCHEMA_PIN,
    manifestVersion: '0.15',
    id: manifestId(repo) || entry.name,
    name: pkg.name,
    version: pkg.version,
    facets: { host: { entry: main, apiVersion: 'v1alpha1' } },
    requires: { contracts: [] },
    permissions: [],
    contributes: { commands: [] },
    subscriptions: [],
    license: pkg.license || 'MIT',
    source: { repository: repo },
    overrides: [],
    'x-eac': {
      role: 'identity-metadata',
      note: 'EAC 经 companion-sync 注册表加载（非 std adapter）；facets 留空 = 尚未参与 std 协商',
      ledger: `assets/SOURCES.json#${entry.id}`,
      ...(isMonorepo ? { sourceNote: '上游为 monorepo（伴侣插件套件子目录）' } : {}),
      ...(entry.audit?.compare && entry.audit.compare !== 'byte-identical'
        ? { patched: true, patchNote: entry.audit.compare }
        : { patched: false }),
    },
  };
  if (DRY) {
    console.log(`[manifest:dry] ${entry.id} ${entry.name} -> ${manifest.id}`);
  } else {
    writeFileSync(join(dir, 'dsh-plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
  written++;
}
console.log(`[manifest] 生成 ${written} 份${DRY ? '（dry run）' : ''}`);
