#!/usr/bin/env node
/**
 * updates/generate.mjs — 热更新/正式更新清单的生成与一致性校验（仓库侧）。
 *
 * 用法：
 *   node updates/generate.mjs --hotupdate [--url-base <包URL前缀>]
 *       扫描 updates/packages/dsh-eac-hu-<seq4>-<component>-<version>.zip，
 *       读包内 hu-manifest.json、校验围栏与文件对应关系、算包级 sha256，
 *       重写 hotupdate.json（latestSeq = 最大 seq）。git push 即发布。
 *
 *   node updates/generate.mjs --check
 *       CI 一致性校验：latestSeq 与 entries 最大值一致、包体存在且 sha256
 *       吻合、逐文件围栏、git 宿主包 ≤5MB。失败退出码 1。
 *
 *   node updates/generate.mjs --release --version 6.0.0 --tag v6.0.0 \
 *        --sums <SHA256SUMS.txt> [--notes "..."] [--notes-url <url>]
 *       从 Release 资产的 SHA256SUMS.txt 生成 release.json（正式更新清单）。
 *
 * 零依赖：zip 仅需读 central directory（EOCD → 条目 → inflateRaw/store），
 * 避免仓库根引入 node_modules。围栏规则见 docs/hot-update-design-addendum-2026-09-05.md §3。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UPDATES = join(ROOT, 'updates');
const PACKAGES = join(UPDATES, 'packages');
const HOTUPDATE_JSON = join(UPDATES, 'hotupdate.json');
const RELEASE_JSON = join(UPDATES, 'release.json');

const GIT_HOST_URL_MARKER = '/updates/packages/'; // 包 URL 含此片段 ⇒ git 入库 ⇒ 5MB 上限
const GIT_PACKAGE_LIMIT = 5 * 1024 * 1024;
const COMPONENTS = ['sidecar', 'resources', 'content', 'shell'];
const RESTART_BY_COMPONENT = { sidecar: 'sidecar-restart', resources: 'sidecar-restart', content: 'sidecar-restart', shell: 'app-restart' };

// ---------------------------------------------------------------------------
// 围栏（发布端校验；客户端 staging 侧在 lib/hot-update/fence.ts 双重复查）
// ---------------------------------------------------------------------------

function fail(msg) { throw new Error(`[fence] ${msg}`); }

/** 单路径围栏校验。path 为 zip 内 forward-slash 相对路径。 */
export function checkFence(component, p) {
  if (typeof p !== 'string' || p.length === 0) fail('空路径');
  if (p.includes('\\')) fail(`禁止反斜杠路径: ${p}`);
  if (/^[a-zA-Z]:/.test(p) || p.startsWith('/')) fail(`禁止绝对路径: ${p}`);
  const segs = p.split('/');
  if (segs.some((s) => s === '..' || s === '.')) fail(`禁止相对段: ${p}`);
  switch (component) {
    case 'sidecar':
      if (!p.startsWith('sidecar/')) fail(`sidecar 包越界: ${p}`);
      if (p === 'sidecar/bridge.js') fail('bridge.js 编译进 exe，禁止入 sidecar 包');
      return;
    case 'resources':
      if (!p.startsWith('dsh-desktop/')) fail(`resources 包越界: ${p}`);
      break;
    case 'content':
      if (!p.startsWith('dsh-desktop/assets/plugins/') && !p.startsWith('dsh-desktop/assets/skins/')) {
        fail(`content 包只允许 assets/plugins|skins: ${p}`);
      }
      return;
    case 'shell':
      fail(`shell 包仅允许 dsh-eac-shell.exe，出现: ${p}`);
    default:
      fail(`未知组件: ${component}`);
  }
  // resources 追加禁投清单（package/lock/vendor/node_modules 走正式更新；
  // native .node 绑定构建期 NODE_MODULE_VERSION；plugins/skins 归 content 组件）
  const rel = p.slice('dsh-desktop/'.length);
  const deny =
    rel === 'package.json' || rel === 'package-lock.json' || rel === '.npmrc' ||
    rel.startsWith('vendor/') || rel.startsWith('node_modules/') || rel.startsWith('native/') ||
    rel.startsWith('assets/plugins/') || rel.startsWith('assets/skins/');
  if (deny) fail(`resources 包禁投路径: ${p}`);
}

/** 校验 hu-manifest.files 全量 + shell 单文件特例。 */
export function checkManifestFence(manifest, zipEntries) {
  const comp = manifest.component;
  if (!COMPONENTS.includes(comp)) fail(`未知组件 ${comp}`);
  for (const f of manifest.files || []) {
    if (f.mode === 'replace') checkFence(comp, f.path);
    // delete 条目同样受围栏约束（防借 delete 拆包），但目标可不存在（幂等）
    else if (f.mode === 'delete') checkFence(comp, f.path);
    else fail(`未知 mode: ${f.mode}`);
  }
  if (comp === 'shell') {
    const reps = (manifest.files || []).filter((f) => f.mode === 'replace');
    if (reps.length !== 1 || reps[0].path !== 'dsh-eac-shell.exe') {
      fail('shell 包必须恰好含一个 replace 条目 dsh-eac-shell.exe');
    }
  }
  // 包内实际文件（去除目录条目与清单自身）须与 replace 条目一一对应
  const real = new Set(zipEntries.filter((e) => !e.isDir && e.name !== 'hu-manifest.json').map((e) => e.name));
  const declared = new Set((manifest.files || []).filter((f) => f.mode === 'replace').map((f) => f.path));
  for (const name of real) if (!declared.has(name)) fail(`包内夹带未声明文件: ${name}`);
  for (const p of declared) if (!real.has(p)) fail(`replace 条目缺包内文件: ${p}`);
}

// ---------------------------------------------------------------------------
// 零依赖 zip 读取（central directory；仅支持 store/deflate，拒 zip64 遇到再说）
// ---------------------------------------------------------------------------

function u16(b, o) { return b.readUInt16LE(o); }
function u32(b, o) { return b.readUInt32LE(o); }

/** 返回 [{name, isDir, method, compressedSize, localHeaderOffset, isSymlink}] */
export function zipEntries(buf) {
  // EOCD：从尾部找 PK\x05\x06
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) fail('不是 zip（找不到 EOCD）');
  const count = u16(buf, eocd + 10);
  let off = u32(buf, eocd + 16); // central directory offset
  const out = [];
  for (let i = 0; i < count; i++) {
    if (u32(buf, off) !== 0x02014b50) fail(`central directory 损坏 @${off}`);
    const method = u16(buf, off + 10);
    const csize = u32(buf, off + 20);
    const nameLen = u16(buf, off + 28);
    const extraLen = u16(buf, off + 30);
    const commentLen = u16(buf, off + 32);
    const lho = u32(buf, off + 42);
    const extAttrs = u32(buf, off + 38);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const unixMode = (extAttrs >>> 16) & 0xffff;
    out.push({
      name,
      isDir: name.endsWith('/'),
      method,
      compressedSize: csize,
      localHeaderOffset: lho,
      isSymlink: (unixMode & 0xf000) === 0xa000,
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function extractFile(buf, entry) {
  if (entry.isSymlink) fail(`禁止符号链接条目: ${entry.name}`);
  const lho = entry.localHeaderOffset;
  if (u32(buf, lho) !== 0x04034b50) fail(`local header 损坏: ${entry.name}`);
  const nameLen = u16(buf, lho + 26);
  const extraLen = u16(buf, lho + 28);
  const dataStart = lho + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  fail(`不支持的压缩方法 ${entry.method}: ${entry.name}`);
}

function readZipFile(zipPath, wantedName) {
  const buf = readFileSync(zipPath);
  for (const e of zipEntries(buf)) {
    if (e.name === wantedName && !e.isDir) return extractFile(buf, e);
  }
  return null;
}

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

// ---------------------------------------------------------------------------
// --hotupdate：扫描 packages/ 重写 hotupdate.json
// ---------------------------------------------------------------------------

const PKG_RE = /^dsh-eac-hu-(\d{4})-(sidecar|resources|content|shell)-(.+)\.zip$/;

function scanPackages(urlBase) {
  const entries = [];
  for (const name of readdirSync(PACKAGES)) {
    const m = PKG_RE.exec(name);
    if (!m) continue;
    const zipPath = join(PACKAGES, name);
    const seq = parseInt(m[1], 10);
    const component = m[2];
    const version = m[3];
    const huRaw = readZipFile(zipPath, 'hu-manifest.json');
    if (!huRaw) fail(`${name}: 缺 hu-manifest.json`);
    const hu = JSON.parse(huRaw.toString('utf8'));
    if (hu.seq !== seq) fail(`${name}: 包内 seq ${hu.seq} ≠ 文件名 ${seq}`);
    if (hu.component !== component) fail(`${name}: 包内组件 ${hu.component} ≠ 文件名 ${component}`);
    const zbuf = readFileSync(zipPath);
    checkManifestFence(hu, zipEntries(zbuf));
    // 包级 sha256 复核 hu-manifest 的逐文件声明（包内自洽）
    for (const f of hu.files || []) {
      if (f.mode !== 'replace') continue;
      const data = readZipFile(zipPath, f.path);
      if (!data) fail(`${name}: 缺文件 ${f.path}`);
      const got = createHash('sha256').update(data).digest('hex');
      if (f.sha256 && got !== f.sha256) fail(`${name}: ${f.path} sha256 不符（清单 ${f.sha256} vs 实际 ${got}）`);
    }
    const url = `${urlBase}/updates/packages/${name}`;
    const entry = {
      seq,
      title: hu.title || `${component} 热更新 ${version}`,
      publishedAt: hu.publishedAt || new Date().toISOString(),
      appVersionRange: hu.appVersionRange || { min: '0.0.0', max: null },
      notes: hu.notes || '',
      components: {
        [component]: {
          version,
          url,
          sha256: sha256File(zipPath),
          size: statSync(zipPath).size,
          restartLevel: RESTART_BY_COMPONENT[component],
        },
      },
    };
    if (url.includes(GIT_HOST_URL_MARKER) && entry.components[component].size > GIT_PACKAGE_LIMIT) {
      fail(`${name}: ${entry.components[component].size} 字节超 git 入库上限 5MB，请改走 Release 资产宿主`);
    }
    entries.push(entry);
  }
  entries.sort((a, b) => a.seq - b.seq);
  return entries;
}

function cmdHotupdate(argv) {
  const urlBase = argv['url-base'] || 'https://raw.githubusercontent.com/lbn2011/Deepseek-Harness-EAC/main';
  const entries = scanPackages(urlBase);
  const manifest = {
    schemaVersion: 1,
    channel: 'stable',
    generatedAt: new Date().toISOString(),
    latestSeq: entries.reduce((mx, e) => Math.max(mx, e.seq), 0),
    signature: null,
    entries,
  };
  writeFileSync(HOTUPDATE_JSON, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[generate] hotupdate.json 已写入：${entries.length} 个 entry，latestSeq=${manifest.latestSeq}`);
}

// ---------------------------------------------------------------------------
// --check：CI 一致性校验
// ---------------------------------------------------------------------------

function cmdCheck() {
  const manifest = JSON.parse(readFileSync(HOTUPDATE_JSON, 'utf8'));
  let bad = 0;
  const err = (m) => { console.error(`[check] ✗ ${m}`); bad++; };
  if (manifest.schemaVersion !== 1) err(`schemaVersion=${manifest.schemaVersion}`);
  const maxSeq = manifest.entries.reduce((mx, e) => Math.max(mx, e.seq), 0);
  if (manifest.latestSeq !== maxSeq) err(`latestSeq=${manifest.latestSeq} 与 entries 最大 seq=${maxSeq} 不一致`);
  const seen = new Set();
  for (const e of manifest.entries) {
    if (seen.has(e.seq)) err(`seq 重复: ${e.seq}`);
    seen.add(e.seq);
    for (const [comp, c] of Object.entries(e.components || {})) {
      if (!COMPONENTS.includes(comp)) err(`entry ${e.seq} 未知组件 ${comp}`);
      const name = c.url.split('/').pop();
      const local = join(PACKAGES, name);
      if (!existsSync(local)) {
        if (c.url.includes(GIT_HOST_URL_MARKER)) err(`entry ${e.seq} git 宿主包缺失: ${name}`);
        else console.log(`[check] · entry ${e.seq} ${comp} 外部宿主包（本地不校验）: ${name}`);
        continue;
      }
      const got = sha256File(local);
      if (got !== c.sha256) err(`entry ${e.seq} ${comp} 包 sha256 不符`);
      const size = statSync(local).size;
      if (size !== c.size) err(`entry ${e.seq} ${comp} 包 size 不符（清单 ${c.size} vs 实际 ${size}）`);
      if (c.url.includes(GIT_HOST_URL_MARKER) && size > GIT_PACKAGE_LIMIT) err(`entry ${e.seq} ${comp} 超 5MB git 上限`);
      // 包体本身重过围栏（防手改 zip 绕过 generate --hotupdate）
      const zbuf = readFileSync(local);
      try {
        const huRaw = readZipFile(local, 'hu-manifest.json');
        if (!huRaw) throw new Error('缺 hu-manifest.json');
        const hu = JSON.parse(huRaw.toString('utf8'));
        checkManifestFence(hu, zipEntries(zbuf));
        if (hu.seq !== e.seq) err(`entry ${e.seq} 包内 seq ${hu.seq} 不一致`);
        if (hu.component !== comp) err(`entry ${e.seq} 包内组件 ${hu.component} 不一致`);
      } catch (ex) {
        err(`entry ${e.seq} ${comp} 包体校验失败: ${ex.message}`);
      }
    }
  }
  if (bad) process.exit(1);
  console.log(`[check] ✓ hotupdate.json 一致（${manifest.entries.length} entries, latestSeq=${manifest.latestSeq}）`);
}

// ---------------------------------------------------------------------------
// --release：从 SHA256SUMS.txt 生成 release.json
// ---------------------------------------------------------------------------

function detectKind(name) {
  if (/x64-setup\.exe$/i.test(name)) return { platform: 'windows', arch: 'x64', kind: 'setup' };
  if (/portable\.zip$/i.test(name)) return { platform: 'windows', arch: 'x64', kind: 'portable' };
  if (/x64-setup\.deb$/i.test(name) || /\.deb$/i.test(name)) return { platform: 'linux', arch: 'x64', kind: 'setup' };
  if (/\.app\.tar\.gz$/i.test(name)) return { platform: 'darwin', arch: 'x64', kind: 'portable' };
  return null;
}

function cmdRelease(argv) {
  const version = argv.version;
  if (!version) fail('--release 需要 --version');
  const tag = argv.tag || `v${version}`;
  const sums = argv.sums;
  if (!sums || !existsSync(sums)) fail('--release 需要 --sums <SHA256SUMS.txt>');
  const repo = 'lbn2011/Deepseek-Harness-EAC';
  const dlBase = `https://github.com/${repo}/releases/download/${tag}`;
  const downloads = [];
  for (const line of readFileSync(sums, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (!m) continue;
    const name = m[2].split('/').pop();
    const kind = detectKind(name);
    if (!kind) continue;
    downloads.push({
      id: `${kind.platform}-${kind.arch}-${kind.kind}`,
      platform: kind.platform,
      arch: kind.arch,
      kind: kind.kind,
      url: `${dlBase}/${name}`,
      sha256: m[1].toLowerCase(),
      size: 0, // SHA256SUMS 无大小；release-manifest.yml 会用 API 资产大小回填
    });
  }
  if (!downloads.length) fail('SHA256SUMS.txt 未解析出可识别资产（setup/portable）');
  const prev = existsSync(RELEASE_JSON) ? JSON.parse(readFileSync(RELEASE_JSON, 'utf8')) : {};
  const manifest = {
    schemaVersion: 1,
    channel: 'stable',
    version,
    releasedAt: new Date().toISOString(),
    notesUrl: argv['notes-url'] || `https://github.com/${repo}/releases/tag/${tag}`,
    notes: argv.notes || '',
    minUpgradeFrom: prev.minUpgradeFrom || '4.4.1',
    mandatory: false,
    downloads,
    mirrors: prev.mirrors || [{ id: 'gh-proxy', urlPrefix: 'https://gh.geekertao.top/' }],
  };
  writeFileSync(RELEASE_JSON, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[generate] release.json 已写入：${version}，${downloads.length} 个下载资产`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const argv = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a, i, arr) => {
    const key = a.slice(2);
    const next = arr[i + 1];
    return [key, next && !next.startsWith('--') ? next : true];
  }),
);

try {
  if (argv.hotupdate) cmdHotupdate(argv);
  else if (argv.check) cmdCheck();
  else if (argv.release) cmdRelease(argv);
  else {
    console.error('用法: node updates/generate.mjs --hotupdate | --check | --release --version X --sums <file>');
    process.exit(2);
  }
} catch (ex) {
  console.error(`[generate] ${ex.message}`);
  process.exit(1);
}
