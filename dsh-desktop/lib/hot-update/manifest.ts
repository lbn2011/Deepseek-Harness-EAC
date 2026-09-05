/**
 * lib/hot-update/manifest.ts — 清单拉取（多源回退）与适用性解析。
 *
 * 源序（与现有代理语义一致，代理只改前缀不改校验）：
 *   1. raw.githubusercontent.com/lbn2011/main（首选，见 grill 决议 2026-09-05）
 *   2. gh.geekertao.top 代理前缀
 *   3. Gitee raw 镜像
 *
 * 解析算法（主设计 §4）：entries 新→旧扫描，对每个尚未取得结果的组件取
 * 第一个 ① appVersionRange 命中 ② seq > 已装 seq ③ 不在 blockedSeqs 的 entry。
 */

import type { HotupdateManifest, HuEntry, HuState, HotComponent, HuComponentRef } from './types.js';

/** 冒烟/测试覆盖：DSH_HOTUPDATE_MANIFEST_URL 指向本地 mock 清单。 */
const ENV_MANIFEST_URL = process.env.DSH_HOTUPDATE_MANIFEST_URL;

export const MANIFEST_URLS = ENV_MANIFEST_URL
  ? [ENV_MANIFEST_URL]
  : [
      'https://raw.githubusercontent.com/lbn2011/Deepseek-Harness-EAC/main/updates/hotupdate.json',
      'https://gh.geekertao.top/https://raw.githubusercontent.com/lbn2011/Deepseek-Harness-EAC/main/updates/hotupdate.json',
      'https://gitee.com/lbn2011/Deepseek-Harness-EAC/raw/main/updates/hotupdate.json',
    ];

/** gh.geekertao.top 代理前缀：仅拼前缀，完整性靠 sha256 强校验兜底。 */
export function proxiedUrls(url: string): string[] {
  const urls = [url];
  if (url.startsWith('https://raw.githubusercontent.com/')) {
    urls.push(`https://gh.geekertao.top/${url}`);
  } else if (url.startsWith('https://github.com/')) {
    urls.push(`https://gh.geekertao.top/${url}`);
  }
  return urls;
}

export async function fetchManifest(log: (msg: string) => void, timeoutMs = 15_000): Promise<HotupdateManifest> {
  let lastErr: unknown = null;
  for (const url of MANIFEST_URLS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'cache-control': 'no-cache' } });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as HotupdateManifest;
      if (!body || typeof body.latestSeq !== 'number' || !Array.isArray(body.entries)) {
        throw new Error('清单结构不识别');
      }
      if (body.schemaVersion > 1) throw new Error(`schemaVersion ${body.schemaVersion} 高于客户端支持（≤1）`);
      return body;
    } catch (err) {
      lastErr = err;
      log(`清单源失败 ${new URL(url).host}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('全部清单源拉取失败');
}

/** 语义化版本比较（依赖 updater.js 的 compareVersions，与正式更新同一实现）。 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { compareVersions } = require('../../updater.js') as { compareVersions(a: string, b: string): number };

function rangeHit(range: { min: string; max: string | null }, appVersion: string): boolean {
  if (compareVersions(appVersion, range.min) < 0) return false;
  if (range.max != null && compareVersions(appVersion, range.max) >= 0) return false;
  return true;
}

export interface Resolution {
  seq: number;
  title: string;
  notes: string;
  components: { name: HotComponent; ref: HuComponentRef }[];
  restartLevel: 'sidecar-restart' | 'app-restart';
}

/**
 * 从清单解析各组件的待应用 entry。组件全量快照（非差分），跨 entry 取
 * 各组件最新适用版本是安全的；同 entry 多组件 = 同发原则（接口契约一致）。
 */
export function resolveApplicable(
  manifest: HotupdateManifest,
  state: HuState,
  appVersion: string,
): Resolution | null {
  const blocked = new Set(state.blockedSeqs);
  const picked = new Map<HotComponent, { entry: HuEntry; ref: HuComponentRef }>();
  for (let i = manifest.entries.length - 1; i >= 0; i--) {
    const entry: HuEntry | undefined = manifest.entries[i];
    if (!entry) continue;
    if (blocked.has(entry.seq)) continue;
    for (const [name, ref] of Object.entries(entry.components || {}) as [HotComponent, HuComponentRef][]) {
      if (picked.has(name)) continue;
      const installed = state.components[name]?.seq ?? 0;
      if (entry.seq <= installed) continue;
      if (!rangeHit(entry.appVersionRange, appVersion)) continue;
      picked.set(name, { entry, ref });
    }
  }
  if (!picked.size) return null;
  // 同发原则：所有命中组件合并为一次应用单元，seq 取最大（展示用）
  let seq = 0;
  let title = '';
  let notes = '';
  for (const { entry } of picked.values()) {
    if (entry.seq >= seq) {
      seq = entry.seq;
      title = entry.title;
      notes = entry.notes;
    }
  }
  const restartLevel = [...picked.values()].some((v) => v.ref.restartLevel === 'app-restart')
    ? 'app-restart'
    : 'sidecar-restart';
  return {
    seq,
    title,
    notes,
    components: [...picked.entries()].map(([name, v]) => ({ name, ref: v.ref })),
    restartLevel,
  };
}
