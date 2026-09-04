/**
 * lib/shortcuts.ts — 快捷方式维护（Task 5b 自 main.js 提取，含 main #91 去重）。
 *
 * 修复「没有桌面快捷方式 / 快捷方式指向的文件消失」，并让图标跟随设计
 * 更新（.lnk 单独指定 icon.ico）。桌面快捷方式采用单一创建者原则：
 * 安装版只由 NSIS 创建，便携版才由运行时创建；启动时扫描个人 + 公共桌面，
 * 清理旧版本「NSIS + 运行时」双创建者交叉产生的重复项（判定逻辑见
 * lib/shortcut-maintenance.ts）。settings.shortcutPolicy='never' 完全不碰桌面。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as updater from '../updater.js';
import { state } from './state.js';
import { log } from './log.js';
import { hostCtx } from './host-ctx.js';
import { updCtx } from './proc.js';
import {
  STANDARD_SHORTCUT_NAME,
  RUNTIME_SHORTCUT_DESCRIPTION,
  shortcutTargetsApp,
  desktopShortcutDirs,
  classifyManagedShortcut,
  planDesktopShortcutMaintenance,
  type LnkLike,
  type ShortcutEntry,
} from './shortcut-maintenance.js';

/** 图标设计版本：更换图标时 +1，触发所有快捷方式图标刷新。 */
export const SHORTCUT_ICON_VERSION = 'whale-2';

export function shortcutMaintenanceSupported(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

/** 快捷方式目标/图标选项（shell.writeShortcutLink 入参）。 */
interface ShortcutOpts {
  target: string;
  description: string;
  icon?: string;
  iconIndex?: number;
  appUserModelId: string;
}

function shortcutIconPath(): string {
  // 复制到 userData 保证路径稳定（便携版 exe 解压目录每次启动都会变）。
  const ico = path.join(state.userDataDir, 'icon.ico');
  try {
    const src = path.join(__dirname, '..', 'assets', 'icon.ico');
    if (!fs.existsSync(src)) return '';
    if (!fs.existsSync(ico) || fs.statSync(src).size !== fs.statSync(ico).size) {
      fs.copyFileSync(src, ico);
    }
    return ico;
  } catch (err) {
    log('boot', '复制快捷方式图标失败: ' + String((err as Error).message));
    return path.join(__dirname, '..', 'assets', 'icon.ico');
  }
}

/** 列目录下全部 .lnk 文件路径。 */
function listLnkFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.lnk'))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** 安全读 .lnk（损坏/宿主无 .lnk 能力返回 null）。宿主实现为异步（sidecar 走
 *  PowerShell 子进程），读链路整体 await 化。 */
async function readLnkSafe(p: string): Promise<LnkLike | null> {
  try {
    // Task 5.2：.lnk 读写经宿主上下文注入（sidecar PowerShell WScript.Shell
    // 实现，见 sidecar/server.ts）；无能力宿主返回 null。
    return ((await hostCtx().shortcuts?.readLink(p)) ?? null) as LnkLike | null;
  } catch {
    return null;
  }
}

/** .lnk 是否使用我们自管的图标（无自定义图标也视为可接管）。 */
async function lnkUsesManagedIcon(lnkPath: string, ico: string): Promise<boolean> {
  if (!ico) return false;
  const link = await readLnkSafe(lnkPath);
  if (!link) return false;
  // 无自定义图标（icon 为空，用 target 自带）视为可接管。
  if (!link.icon) return true;
  return path.resolve(String(link.icon)).toLowerCase() === path.resolve(ico).toLowerCase();
}

/** 扫描各桌面目录，收集 .lnk 条目（scope + 元数据）供去重判定。 */
async function collectDesktopShortcutEntries(
  dirs: Array<{ scope: 'user' | 'public'; dir: string }>,
): Promise<ShortcutEntry[]> {
  const rows: ShortcutEntry[] = [];
  for (const { scope, dir } of dirs) {
    for (const filePath of listLnkFiles(dir)) {
      rows.push({ scope, dir, filePath, link: await readLnkSafe(filePath) });
    }
  }
  return rows;
}

/**
 * 开始菜单/桌面快捷方式维护（仅打包版 Windows；幂等）：清理旧名称残留、
 * 按设置策略（auto/never）创建缺失链接、把指向旧 exe 的链接改指当前安装
 * 位置，并对桌面做双创建者去重。E2E 环境用 DSH_DESKTOP_TEST_NO_SHORTCUTS=1
 * 跳过。
 */
export async function maintainShortcuts(): Promise<void> {
  const host = hostCtx();
  if (!host.isPackaged() || !shortcutMaintenanceSupported(process.platform)) return;
  // Task 5.2：.lnk 能力由宿主注入（legacy-shell shell / sidecar PowerShell）；
  // 宿主不提供（如 Linux壳）时整体静默跳过维护。
  const lnk = host.shortcuts;
  if (!lnk) return;
  // E2E / 自动化：跳过快捷方式维护（临时 exe 不得改写真实开始菜单/桌面
  // 快捷方式的指向）。与 DSH_DESKTOP_TEST_FORCE_UNSAFE 同一约定。
  if (process.env.DSH_DESKTOP_TEST_NO_SHORTCUTS === '1') return;
  try {
    const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const settings = updater.loadSettings(updCtx());
    const policy = settings.shortcutPolicy === 'never' ? 'never' : 'auto';
    const linksDir = path.join(host.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const APP_TITLE = 'Deepseek Harness EAC';
    const userDesktopDir = host.getPath('desktop');
    const desktopDirs = desktopShortcutDirs(userDesktopDir, process.env.PUBLIC);
    const startMenu = path.join(linksDir, APP_TITLE + '.lnk');
    const desktop = path.join(userDesktopDir, STANDARD_SHORTCUT_NAME);
    const ico = shortcutIconPath();
    const opts: ShortcutOpts = {
      target,
      description: RUNTIME_SHORTCUT_DESCRIPTION,
      ...(ico ? { icon: ico, iconIndex: 0 } : {}),
      appUserModelId: 'com.deepseek.dsh.desktop',
    };
    const portable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
    let changed = false;
    // 清理旧名称（DSH Desktop）快捷方式：改名后它们指向的 exe 已不存在。
    const legacyShortcuts = [path.join(linksDir, 'DSH Desktop.lnk')];
    for (const { dir } of desktopDirs) legacyShortcuts.push(path.join(dir, 'DSH Desktop.lnk'));
    for (const legacy of legacyShortcuts) {
      try {
        if (fs.existsSync(legacy)) {
          fs.rmSync(legacy);
          changed = true;
        }
      } catch {
        /* 单文件删除失败继续 */
      }
    }
    let desktopEntries = await collectDesktopShortcutEntries(desktopDirs);
    // exe 被移动过或图标设计更新：开始菜单照常维护；桌面仅刷新便携版
    // 运行时原样生成的快捷方式。安装版桌面快捷方式统一交给 NSIS，用户
    // 改名/换图标/加参数后的快捷方式也不再覆盖。
    const targetMoved =
      typeof settings.shortcutTarget === 'string' && settings.shortcutTarget !== target;
    const iconOutdated = settings.shortcutIcon !== SHORTCUT_ICON_VERSION;
    if (targetMoved || iconOutdated) {
      const prevTarget = typeof settings.shortcutTarget === 'string' ? settings.shortcutTarget : null;
      const startMenuOwn = fs.existsSync(startMenu)
        && shortcutTargetsApp(await readLnkSafe(startMenu), target, targetMoved ? prevTarget : null);
      if (startMenuOwn && (targetMoved || (await lnkUsesManagedIcon(startMenu, ico)))) {
        try {
          lnk.writeLink(startMenu, 'replace', opts);
          changed = true;
        } catch {
          /* 单链接写失败继续 */
        }
      }
      if (portable && policy !== 'never') {
        let desktopRefreshed = false;
        for (const entry of desktopEntries) {
          const kind = classifyManagedShortcut(entry, {
            target,
            previousTarget: targetMoved ? prevTarget : null,
            managedIcon: ico,
          });
          if (kind !== 'runtime') continue;
          try {
            lnk.writeLink(entry.filePath, 'replace', opts);
            changed = true;
            desktopRefreshed = true;
          } catch {
            /* 单链接写失败继续 */
          }
        }
        if (desktopRefreshed) desktopEntries = await collectDesktopShortcutEntries(desktopDirs);
      }
    }
    // 开始菜单快捷方式：系统通知（Toast）的前置条件，按 target 匹配维护。
    const startMenuOk = fs.existsSync(startMenu)
      && shortcutTargetsApp(await readLnkSafe(startMenu), target);
    if (!startMenuOk) {
      try {
        lnk.writeLink(startMenu, 'create', opts);
        changed = true;
      } catch {
        /* 创建失败不阻塞启动 */
      }
    }
    // 桌面快捷方式采用单一创建者：安装版只由 NSIS 创建，便携版才由
    // 运行时创建。扫描个人桌面 + 公共桌面，旧版留下的重复项只删除可
    // 明确识别为软件原样生成的 .lnk；用户改名/换图标/加参数的一律保留。
    const desktopPlan = planDesktopShortcutMaintenance({
      entries: desktopEntries,
      target,
      previousTarget: targetMoved
        ? (typeof settings.shortcutTarget === 'string' ? settings.shortcutTarget : null)
        : null,
      managedIcon: ico,
      portable,
      policy,
    });
    for (const duplicate of desktopPlan.removals) {
      try {
        fs.rmSync(duplicate);
        changed = true;
        log('boot', '已清理软件生成的重复桌面快捷方式: ' + duplicate);
      } catch (err) {
        log('boot', '清理重复桌面快捷方式失败（已保留）: ' + duplicate + ': ' + String((err as Error).message));
      }
    }
    if (desktopPlan.create) {
      try {
        lnk.writeLink(desktop, 'create', opts);
        changed = true;
      } catch {
        /* 创建失败不阻塞启动 */
      }
    }
    if (changed) {
      settings.shortcutTarget = target;
      settings.shortcutIcon = SHORTCUT_ICON_VERSION;
      updater.saveSettings(updCtx(), settings);
      log('boot', '快捷方式已维护（开始菜单/桌面 → ' + target + '，图标 ' + SHORTCUT_ICON_VERSION + '）');
    }
  } catch (err) {
    log('boot', '快捷方式维护失败: ' + String((err as Error).message));
  }
}
