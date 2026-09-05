/**
 * lib/hot-update/fence.ts — 客户端侧路径围栏（staging 复查）。
 *
 * 与 updates/generate.mjs checkFence 保持语义一致（发布端 + 客户端双重校验，
 * 见 docs/hot-update-design-addendum-2026-09-05.md §3）。任何不匹配 → 应用中止。
 */

import type { HotComponent } from './types.js';

export class FenceError extends Error {
  constructor(msg: string) {
    super(`[fence] ${msg}`);
  }
}

/** 校验包内单路径是否落在组件围栏内。path 为 forward-slash 相对路径。 */
export function checkFence(component: HotComponent, p: string): void {
  const bad = (m: string): never => { throw new FenceError(m); };
  if (typeof p !== 'string' || p.length === 0) bad('空路径');
  if (p.includes('\\')) bad(`禁止反斜杠路径: ${p}`);
  if (/^[a-zA-Z]:/.test(p) || p.startsWith('/')) bad(`禁止绝对路径: ${p}`);
  const segs = p.split('/');
  if (segs.some((s) => s === '..' || s === '.')) bad(`禁止相对段: ${p}`);
  switch (component) {
    case 'sidecar':
      if (!p.startsWith('sidecar/')) bad(`sidecar 包越界: ${p}`);
      if (p === 'sidecar/bridge.js') bad('bridge.js 编译进 exe，禁止入 sidecar 包');
      return;
    case 'content':
      if (!p.startsWith('dsh-desktop/assets/plugins/') && !p.startsWith('dsh-desktop/assets/skins/')) {
        bad(`content 包只允许 assets/plugins|skins: ${p}`);
      }
      return;
    case 'shell':
      bad(`shell 包仅允许 dsh-eac-shell.exe，出现: ${p}`);
      return;
    case 'resources':
      if (!p.startsWith('dsh-desktop/')) bad(`resources 包越界: ${p}`);
      break;
    default:
      bad(`未知组件: ${component}`);
  }
  const rel = p.slice('dsh-desktop/'.length);
  const deny =
    rel === 'package.json' || rel === 'package-lock.json' || rel === '.npmrc' ||
    rel.startsWith('vendor/') || rel.startsWith('node_modules/') || rel.startsWith('native/') ||
    rel.startsWith('assets/plugins/') || rel.startsWith('assets/skins/');
  if (deny) bad(`resources 包禁投路径: ${p}`);
}

/** staging 复查整包：replace+delete 条目全部过围栏；shell 特例单文件。 */
export function checkManifestFence(component: HotComponent, paths: string[]): void {
  for (const p of paths) checkFence(component, p);
  if (component === 'shell') {
    const ok = paths.filter((x) => x !== 'dsh-eac-shell.exe').length === 0 && paths.length >= 1;
    if (!ok) throw new FenceError('shell 包必须恰好只含 dsh-eac-shell.exe');
  }
}
