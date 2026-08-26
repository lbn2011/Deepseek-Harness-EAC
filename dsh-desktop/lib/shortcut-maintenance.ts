/**
 * lib/shortcut-maintenance.ts — 桌面快捷方式去重的纯逻辑（自 main #91 移植）。
 *
 * 问题背景：安装版桌面快捷方式历史上有两个创建者 —— NSIS 安装器与运行时
 * （便携版启动逻辑），两边元数据不同，导致安装后桌面出现两份指向同一 exe
 * 的 .lnk。本模块把「哪些 .lnk 是软件原样生成的、重复时保留哪份、删哪份」
 * 的判定抽成无副作用纯函数，供 lib/shortcuts.ts 调用并单测覆盖。
 *
 * 安全原则：用户改名 / 换图标 / 加参数的快捷方式一律识别不出来（视为
 * 用户私产），绝自动删除；仅删除「安装器生成的」与「运行时生成的」两份
 * 原样 .lnk 交叉出现的重复项。
 */

import * as path from 'node:path';

/** 标准快捷方式文件名（两个创建者共用）。 */
export const STANDARD_SHORTCUT_NAME = 'Deepseek Harness EAC.lnk';

/** 运行时创建的快捷方式描述。 */
export const RUNTIME_SHORTCUT_DESCRIPTION = 'DeepSeek Harness 桌面客户端';

/** NSIS 安装器创建的快捷方式描述（legacy-shell-builder.nsh 中的中文描述原文）。 */
export const INSTALLER_SHORTCUT_DESCRIPTIONS = new Set([
  'DeepSeek Harness (dsh) 开箱即用的 Windows 桌面客户端：内置 dsh CLI 与 Node 运行时，一键启动 Web UI',
]);

/** .lnk 元数据（shell.readShortcutLink 的子集；损坏读取返回 null）。 */
export interface LnkLike {
  target?: string;
  icon?: string;
  args?: string;
  arguments?: string;
  description?: string;
}

/** 桌面目录行（scope 区分个人/公共桌面）。 */
export interface DesktopDirRow {
  scope: 'user' | 'public';
  dir: string;
}

/** 扫描到的桌面 .lnk 条目。 */
export interface ShortcutEntry {
  scope: 'user' | 'public';
  dir?: string;
  filePath: string;
  link: LnkLike | null;
}

/** 归属分类：指向当前 exe / 上次记录的 exe 位置。 */
export type TargetKind = 'current' | 'previous' | null;

/** 生成器分类：运行时原样生成 / 安装器原样生成 / 非软件原样。 */
export type ManagedKind = 'runtime' | 'installer' | null;

/** 桌面去重计划。 */
export interface DesktopShortcutPlan {
  create: boolean;
  removals: string[];
  preferred: string | null;
}

/** 归一化 Windows 路径（去引号/尾分隔符，统一小写；可去图标序号后缀）。 */
export function normalizeWindowsPath(value: unknown, stripIconIndex = false): string {
  let text = String(value ?? '').trim();
  if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  if (stripIconIndex) text = text.replace(/,\s*-?\d+\s*$/, '');
  if (!text) return '';
  return path.win32.normalize(text).replace(/[\\/]+$/, '').toLowerCase();
}

/** 两个 Windows 路径是否等价（归一化后比较）。 */
export function sameWindowsPath(a: unknown, b: unknown, stripIconIndex = false): boolean {
  const left = normalizeWindowsPath(a, stripIconIndex);
  const right = normalizeWindowsPath(b, stripIconIndex);
  return Boolean(left && right && left === right);
}

/** .lnk target 指向当前 exe、上次 exe，还是无关程序。 */
export function shortcutTargetKind(
  link: LnkLike | null,
  target: string,
  previousTarget?: string | null,
): TargetKind {
  if (!link || !link.target) return null;
  if (sameWindowsPath(link.target, target)) return 'current';
  if (previousTarget && sameWindowsPath(link.target, previousTarget)) return 'previous';
  return null;
}

/** .lnk 是否指向本应用（当前或上次 exe 位置）。 */
export function shortcutTargetsApp(
  link: LnkLike | null,
  target: string,
  previousTarget?: string | null,
): boolean {
  return shortcutTargetKind(link, target, previousTarget) !== null;
}

/** 个人桌面 + 公共桌面目录列表（去重）。 */
export function desktopShortcutDirs(userDesktop: string, publicRoot?: string): DesktopDirRow[] {
  const rows: DesktopDirRow[] = [];
  const seen = new Set<string>();
  const add = (scope: 'user' | 'public', dir: string): void => {
    const normalized = normalizeWindowsPath(dir);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    rows.push({ scope, dir });
  };
  add('user', userDesktop);
  if (publicRoot) add('public', path.win32.join(publicRoot, 'Desktop'));
  return rows;
}

/**
 * 判断 .lnk 是否「软件原样生成」（可被去重清理）：
 *   - 标准文件名、指向本应用、无启动参数；
 *   - 元数据与运行时或安装器的原样输出完全一致（描述 + 图标）。
 * 用户改名 / 换图标 / 加参数的都会返回 null（不可自动删除）。
 */
export function classifyManagedShortcut(
  entry: ShortcutEntry,
  opts: {
    target: string;
    previousTarget?: string | null;
    managedIcon?: string;
  } = {} as { target: string },
): ManagedKind {
  const { target, previousTarget = null, managedIcon = '' } = opts;
  if (!entry || path.win32.basename(String(entry.filePath ?? '')).toLowerCase()
    !== STANDARD_SHORTCUT_NAME.toLowerCase()) return null;
  const link = entry.link;
  if (!shortcutTargetsApp(link, target, previousTarget)) return null;
  if (String((link && (link.args ?? link.arguments)) ?? '').trim() !== '') return null;

  const description = String((link && link.description) ?? '');
  const icon = String((link && link.icon) ?? '');
  if (description === RUNTIME_SHORTCUT_DESCRIPTION
    && (!icon || sameWindowsPath(icon, managedIcon, true))) {
    return 'runtime';
  }
  if (INSTALLER_SHORTCUT_DESCRIPTIONS.has(description)
    && (!icon
      || sameWindowsPath(icon, link!.target, true)
      || sameWindowsPath(icon, target, true)
      || (previousTarget ? sameWindowsPath(icon, previousTarget, true) : false))) {
    return 'installer';
  }
  return null;
}

/** 重复项中优先保留哪份：当前可用目标 > 便携保运行时 / 安装保安装器 > scope。 */
function preferredManagedEntry(
  entries: Array<ShortcutEntry & { managedKind?: ManagedKind }>,
  portable: boolean,
  target: string,
): (ShortcutEntry & { managedKind?: ManagedKind }) | null {
  const score = (row: ShortcutEntry & { managedKind?: ManagedKind }): number => {
    // 当前可用目标的优先级最高；不能为了偏爱某个创建者而保留一份仍指向
    // 旧 exe 的快捷方式，并删除已经指向当前 exe 的那份。
    let value = shortcutTargetKind(row.link, target, null) === 'current' ? 1000 : 0;
    if (portable) {
      if (row.managedKind === 'runtime') value += 100;
      if (row.scope === 'user') value += 10;
    } else {
      if (row.managedKind === 'installer') value += 100;
      if (row.scope === 'public') value += 10;
    }
    return value;
  };
  return [...entries].sort((a, b) => {
    const byScore = score(b) - score(a);
    if (byScore !== 0) return byScore;
    return String(a.filePath).localeCompare(String(b.filePath));
  })[0] ?? null;
}

/**
 * 生成桌面快捷方式维护计划：
 *   - create：便携版且桌面无任何指向本应用的 .lnk 时补建一份；
 *     安装版永不补建（单一创建者原则：桌面交给 NSIS）。
 *   - removals：仅当「安装器生成」与「运行时生成」两份原样 .lnk 交叉出现
 *     时，删除除首选外的其余项。相同创建者的两份元数据完全一致，无法
 *     区分「软件重复」与「用户手动复制」，因此不删。
 */
export function planDesktopShortcutMaintenance(opts: {
  entries: ShortcutEntry[];
  target: string;
  previousTarget?: string | null;
  managedIcon?: string;
  portable: boolean;
  policy?: 'auto' | 'never';
}): DesktopShortcutPlan {
  const { entries, target, previousTarget = null, managedIcon = '', portable } = opts;
  const policy = opts.policy ?? 'auto';
  if (policy === 'never') return { create: false, removals: [], preferred: null };

  const classified = entries.map((entry) => ({
    ...entry,
    targetKind: shortcutTargetKind(entry.link, target, previousTarget),
    managedKind: classifyManagedShortcut(entry, { target, previousTarget, managedIcon }),
  }));
  const appEntries = classified.filter((entry) => entry.targetKind);
  const managedEntries = classified.filter((entry) => entry.managedKind);
  const preferred = preferredManagedEntry(managedEntries, portable, target);
  const managedKinds = new Set(managedEntries.map((entry) => entry.managedKind));
  const removals = preferred && managedKinds.has('installer') && managedKinds.has('runtime')
    ? managedEntries
      .filter((entry) => entry.filePath !== preferred.filePath)
      .map((entry) => entry.filePath)
    : [];

  return {
    create: Boolean(portable) && appEntries.length === 0,
    removals,
    preferred: preferred ? preferred.filePath : null,
  };
}
