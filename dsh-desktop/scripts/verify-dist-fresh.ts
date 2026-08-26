'use strict';

// Release freshness guard (v2.0.3 incident → issue #7).
//
// v2.0.3 shipped artifacts built BEFORE the last source edits. This script
// refuses to bless a dist/ directory when any tracked source file was
// modified after the packaged artifacts were built.
//
// Usage: node scripts/verify-dist-fresh.js [repoRoot]
// Exit 0 = fresh, exit 1 = stale or missing artifacts (with a report).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const IGNORED_PREFIXES = ['target/', 'node_modules/', 'vendor/', '.git/'];

export interface DistFreshResult {
  ok: boolean;
  offenders: string[];
  error?: string;
  artifactTime?: number;
}

/** 平台产物集（Task 11.1 / tdd.md T15）：win 额外要求便携 zip；linux 仅 bundle。 */
export type DistPlatform = 'win' | 'linux';

export interface DistFreshOptions {
  platform?: DistPlatform;
  /** 便携包目录（win 平台校验用），默认 repoRoot/target/release/portable。 */
  portableDir?: string;
}

function listSources(repoRoot: string): string[] {
  let out: string;
  try {
    out = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
  } catch {
    // Not a git repo (tests): fall back to a directory walk.
    const files: string[] = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const rel = path.relative(repoRoot, path.join(dir, e.name)).replace(/\\/g, '/');
        if (e.isDirectory()) {
          if (IGNORED_PREFIXES.some((p) => (p.endsWith('/') ? rel + '/' : rel).startsWith(p))) continue;
          walk(path.join(dir, e.name));
        } else {
          if (IGNORED_PREFIXES.some((p) => rel.startsWith(p))) continue;
          files.push(rel);
        }
      }
    };
    walk(repoRoot);
    return files;
  }
  return out.split(/\r?\n/).filter(Boolean).filter((f) => !IGNORED_PREFIXES.some((p) => f.startsWith(p)));
}

export function verifyDistFresh(
  repoRoot: string,
  bundleDir = path.join(repoRoot, 'target', 'release', 'bundle'),
  opts: DistFreshOptions = {},
): DistFreshResult {
  const artifacts: string[] = [];
  const walkArtifacts = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walkArtifacts(target);
      else if (/\.(?:exe|deb|appimage|zip)$/i.test(entry.name)) artifacts.push(target);
    }
  };
  walkArtifacts(bundleDir);
  // win 平台：便携包目录一并纳入（缺失 = 产物不全，拒绝放行）。
  const portableDir = opts.portableDir ?? path.join(repoRoot, 'target', 'release', 'portable');
  if (opts.platform === 'win') {
    const before = artifacts.length;
    walkArtifacts(portableDir);
    if (artifacts.length === before) {
      return { ok: false, offenders: [], error: `no portable artifacts (*.zip) found under ${portableDir} (platform=win)` };
    }
  }
  if (!artifacts.length) {
    return { ok: false, offenders: [], error: 'no packaged Tauri artifacts (*.exe, *.deb, *.AppImage, *.zip) found' };
  }
  const artifactTime = Math.min(...artifacts.map((p) => fs.statSync(p).mtimeMs));
  const offenders: string[] = [];
  for (const rel of listSources(repoRoot)) {
    const p = path.join(repoRoot, ...rel.split('/'));
    let st: fs.Stats;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.mtimeMs > artifactTime) offenders.push(rel);
  }
  return { ok: offenders.length === 0, offenders, artifactTime };
}

if (require.main === module) {
  // CLI: node verify-dist-fresh.js [repoRoot] [--bundle=<dir>] [--portable=<dir>] [--platform=win|linux]
  const argv = process.argv.slice(2);
  let repoRootArg: string | undefined;
  let bundleArg: string | undefined;
  let portableArg: string | undefined;
  let platform: DistPlatform | undefined;
  for (const a of argv) {
    if (a.startsWith('--bundle=')) bundleArg = path.resolve(a.slice('--bundle='.length));
    else if (a.startsWith('--portable=')) portableArg = path.resolve(a.slice('--portable='.length));
    else if (a === '--platform=win' || a === '--platform=linux') platform = a.slice('--platform='.length) as DistPlatform;
    else repoRootArg = a;
  }
  const repoRoot = repoRootArg ? path.resolve(repoRootArg) : path.resolve(__dirname, '..');
  const opts: DistFreshOptions = {};
  if (platform) opts.platform = platform;
  if (portableArg) opts.portableDir = portableArg;
  const r = verifyDistFresh(repoRoot, bundleArg ?? undefined, opts);
  if (r.ok) {
    console.log('verify-dist-fresh: OK — artifacts newer than every tracked source file');
    process.exit(0);
  }
  console.error('verify-dist-fresh: STALE — ' + (r.error ?? `${r.offenders.length} source file(s) modified after the artifacts were built:`));
  for (const o of r.offenders.slice(0, 40)) console.error('  ' + o);
  if (r.offenders.length > 40) console.error(`  … and ${r.offenders.length - 40} more`);
  console.error('Rebuild (npm run tauri:build) before publishing.');
  process.exit(1);
}
