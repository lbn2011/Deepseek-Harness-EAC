/**
 * lib/plugin-registry-data.ts — 内置配套插件清单与更新源（Task 5.2 提取）。
 * COMPANION_PLUGINS 表的逐条注释（插件用途/历史修复）见 git 历史（迁移自
 * main.js 1329-1456）；关键行内注释原样保留。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as updater from '../updater.js';
import * as pluginUpdater from '../plugin-updater.js';
import { state } from './state.js';

/** 单个配套插件登记项。 */
export interface CompanionPlugin {
  id: string;
  name: string;
  /** assets/plugins 下的目录名（无 scope 或目录名≠包名尾段时必须显式给）。 */
  dir?: string;
  /** 随 patch 行写入的初始 config（schema required 字段的双保险）。 */
  config?: Record<string, unknown>;
  /** 默认禁用（用户可在插件管理里启用）。 */
  disabled?: boolean;
}

export const COMPANION_PLUGINS: CompanionPlugin[] = [
  // VNext Phase 2 Core Bridge（受信组件）：把隔离 SDK 插件的工具/上下文
  // 桥接进 dsh Agent（回环端点见 lib/extension-host/bridge-server.ts）。
  // 必须先于其余伴生插件同步（它们不依赖它，但保持 bridge 常驻可用）。
  { id: 'eac-core-bridge', name: 'dsh-eac-core-bridge' },
  // dsh-compact（main v4.6 并入）：复合 agent 插件 —— 托管 preset 直接引用
  // dsh-compact/engine，属核心依赖（onboarding CORE 锁定，不可取消勾选）；
  // 接替已退役的 dsh-auto-compact（浏览器触发式压缩，见 RETIRED 表）。
  { id: 'compact', name: 'dsh-compact', dir: 'dsh-compact' },
  { id: 'balance', name: '@deepseek-ai/dsh-balance' },
  { id: 'file-changes', name: '@deepseek-ai/dsh-file-changes' },
  { id: 'client-file-changes', name: '@deepseek-ai/dsh-client-file-changes' },
  { id: 'terminal', name: '@deepseek-ai/dsh-terminal' },
  { id: 'unified-market', name: 'dsh-unified-market', dir: 'dsh-unified-market' },
  { id: 'skin-switch', name: '@deepseek-ai/dsh-skin-switch' },
  { id: 'easy-setup', name: '@deepseek-ai/dsh-easy-setup' },
  { id: 'computer-user', name: 'computer-user', dir: 'computer-user' },
  // 社区功能插件（视觉 / 人设 / 移动端布局修复）：npm registry
  // 拉取后随应用内置分发。绝不能写进 profile package.json 依赖 ——
  // pnpm 安装会 hoist @deepseek-ai 核心包形成模块双实例（Symbol 冲突，
  // 插件命名空间注册失效，即 "设置命名空间不可用" 故障的根因）。
  // v4.5 起内置图像理解插件（替换已退役的旧视觉插件）。
  { id: 'picturereader', name: 'picturereader', dir: 'picturereader' },
  // config.path 必须随行写入：v2.0.0 只写了 id+name，schema required 无默认值，
  // 全新安装校验失败拖垮整个插件树（详见 patch-row-heal 的存量修复）。
  { id: 'soul-md', name: 'dsh-soul-md', dir: 'dsh-soul-md', config: { path: 'soul.md' } },
  { id: 'mobile-fix', name: 'dsh-web-mobile-fix', dir: 'dsh-web-mobile-fix' },
  { id: 'better-sidebar', name: 'dsh-better-sidebar', dir: 'dsh-better-sidebar' },
  { id: 'message-rewind', name: 'dsh-message-rewind', dir: 'dsh-message-rewind' },
  // 行必须带 config：dsh-pet 的 apply 读 config.fullRoot，无 config 块的行会让
  // loader 传 undefined 直接拖垮插件树（v3.1.0 全新安装即「启动失败」根因）。
  { id: 'dsh-pet', name: 'dsh-pet', dir: 'dsh-pet', config: { size: 260, position: 'bottom-right' }, disabled: true },
  { id: 'dock-settings', name: 'dsh-dock-settings', dir: 'dsh-dock-settings' },
  { id: 'font-custom', name: 'dsh-font-custom', dir: 'dsh-font-custom' },
  { id: 'plugin-shield', name: 'dsh-plugin-shield', dir: 'dsh-plugin-shield' },
  { id: 'change-review', name: 'dsh-change-review', dir: 'dsh-change-review' },
  { id: 'float-window', name: '@deepseek-ai/dsh-float-window' },
  { id: 'dsh-navbar', name: '@vlln/dsh-navbar', dir: 'dsh-navbar' },
  { id: 'dsh-session-manager', name: 'dsh-session-manager' },
  { id: 'conversation-tweaks', name: '@deepseek-ai/dsh-conversation-tweaks' },
  { id: 'prompt-custom', name: '@deepseek-ai/dsh-prompt-custom' },
  // third-party-thinking 插件已随上游退役（assets 目录移除），注册表条目
  // 同步清理（否则「注册表一致性」检查报 dir 指向不存在资产）。
  { id: 'side-session', name: '@dsh-external/dsh-side-session', dir: 'dsh-side-session' },
  { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager' },
  { id: 'plugin-wizard', name: 'dsh-plugin-wizard', dir: 'dsh-plugin-wizard' },
  { id: 'openclaw-bridge', name: '@deepseek-ai/dsh-openclaw-bridge', dir: 'dsh-openclaw-bridge' },
  { id: 'dsh-undo', name: 'dsh-undo-savepoint', dir: 'dsh-undo-savepoint' },
  { id: 'dsh-dafeiyu', name: 'dsh-dafeiyu', dir: 'dsh-dafeiyu' },
  { id: 'dsh-pet-settings', name: 'dsh-pet-settings', dir: 'dsh-pet-settings' },
  { id: 'offpeak', name: 'dsh-offpeak', dir: 'dsh-offpeak' },
  { id: 'file-drop-eac', name: 'dsh-file-drop-eac', dir: 'dsh-file-drop-eac' },
  // 设置页左侧边栏自定义（V4.1，用户建议）：设置面板导航底部「自定义
  // 边栏」按钮，按需显示/隐藏与排序 settings.section 导航项，
  // localStorage 持久化，默认全显；纯客户端实现（host 半边 no-op）。
  { id: 'settings-nav-custom', name: 'dsh-settings-nav-custom', dir: 'dsh-settings-nav-custom' },
  // 设置页「常规」页内高级选项折叠（V4.2，用户建议）：按行标题关键词把
  // 低频选项行（外观/语言/权限预设等）收进底部「高级选项」折叠组，
  // localStorage 持久化展开状态；纯客户端实现（host 半边 no-op）。
  { id: 'settings-groups', name: 'dsh-settings-groups', dir: 'dsh-settings-groups' },
  { id: 'settings-scroll-fix', name: 'dsh-settings-scroll-fix', dir: 'dsh-settings-scroll-fix' },
  // 图片粘贴发送（V4.2，用户建议）：Ctrl/Cmd+V 粘贴剪贴板图片 → 保存到
  // 临时目录 → 注入完整路径提示。默认禁用 —— 与内置 picturereader 的
  // 「粘贴即用/图片桥自动分析」入口语义重叠，避免粘贴图片时重复注入。
  { id: 'image-paste', name: 'dsh-image-paste', dir: 'dsh-image-paste', disabled: true },
  { id: 'dsh-webui-prompt-optimizer', name: 'dsh-webui-prompt-optimizer', dir: 'dsh-webui-prompt-optimizer' },
  // 上游同步（671e87ec：#237 功能包 / #238 市场 0.3.0 / macOS 管线配套插件）。
  { id: 'dsh-agent-teams', name: '@nanmicoder/dsh-agent-teams', dir: 'dsh-agent-teams' },
  { id: 'dsh-feature-toggles', name: 'dsh-feature-toggles', dir: 'dsh-feature-toggles' },
  { id: 'dsh-phone', name: 'dsh-phone', dir: 'dsh-phone' },
  { id: 'dsh-stt', name: '@deepseek-ai/dsh-stt', dir: 'dsh-stt' },
  { id: 'dsh-whale-widget', name: 'dsh-whale-widget', dir: 'dsh-whale-widget' },
];

/** 曾内置、现已从内置清单移除的插件（vnext 同步自 main v4.5）。 */
export const RETIRED_BUILTIN_PLUGINS: { id: string; name: string }[] = [
  // tdai-memory：唯一携带 node_modules 的内置插件，v4.5 起退役 —— 体积
  // ~310MB 占安装包近半，且 vendor 任一小缺失即 import 失败拖垮插件树。
  { id: 'tdai-memory', name: 'dsh-tdai-memory' },
  // main v4.6 退役批次（2.5 并入）：auto-compact 由 dsh-compact 复合 agent
  // 接替；其余三个市场类插件随 unified-market 收敛移除。老安装（main 线
  // 升级上来）profile 里残留的 patch 行/包副本由 retireRemovedBuiltinPlugins
  // 清理 —— 不登记则残留行会在插件树加载时拖垮启动。
  { id: 'auto-compact', name: 'dsh-auto-compact' },
  { id: 'plugin-marketplace', name: '@deepseek-ai/dsh-plugin-marketplace' },
  { id: 'dsh-market-plugin', name: '@sanqi-normal/dsh-webui-market-plugin' },
  { id: 'zat-market', name: 'zat-dsh-engine' },
];

/** 内置插件上游更新源（V4.3，plugin-updater.js 消费；npm 404 优雅降级）。 */
export const PLUGIN_UPDATE_SOURCES: Record<string, { npm?: string; github?: string }> = {
  'soul-md': { npm: 'dsh-soul-md' },
  'dsh-pet': { npm: 'dsh-pet' },
  'better-sidebar': { npm: 'dsh-better-sidebar' },
  'dsh-navbar': { npm: '@vlln/dsh-navbar' },
  'mobile-fix': { npm: 'dsh-web-mobile-fix' },
  offpeak: { npm: 'dsh-offpeak' },
  'dsh-session-manager': { npm: 'dsh-session-manager' },
  // GitHub 分发（npm 未发布）：dsh-undo-savepoint。
  'dsh-undo': { github: 'lire1131/dsh-undo-savepoint' },
};

/** 内置插件更新源条目（plugin-updater 的 sources 输入）。 */
export interface PluginUpdateSourceEntry {
  id: string;
  name: string;
  assetsDir: string;
  update: { npm?: string; github?: string };
}

/** 把内置插件表 + 更新源注册表合并成 plugin-updater 的 sources 输入。 */
export function pluginUpdateSources(
  removedIds: Set<string>,
): PluginUpdateSourceEntry[] {
  const out: PluginUpdateSourceEntry[] = [];
  for (const p of COMPANION_PLUGINS) {
    const update = PLUGIN_UPDATE_SOURCES[p.id];
    if (!update) continue;
    if (removedIds.has(p.id)) continue;
    const dirName = p.dir ?? (p.name.includes('/') ? (p.name.split('/').pop() as string) : p.name);
    const assetsDir = path.join(__dirname, '..', 'assets', 'plugins', dirName);
    if (!fs.existsSync(path.join(assetsDir, 'package.json'))) continue;
    out.push({ id: p.id, name: p.name, assetsDir, update });
  }
  return out;
}

/** 内置插件当前生效的源目录：覆盖层（已更新版本）优先，资产版本回退。 */
export function builtinPluginSourceDir(dirName: string): string {
  const assets = path.join(__dirname, '..', 'assets', 'plugins', dirName);
  const overlay = path.join(state.userDataDir, 'builtin-plugin-updates', dirName);
  if (!fs.existsSync(path.join(overlay, 'package.json'))) return assets;
  if (!fs.existsSync(path.join(assets, 'package.json'))) return overlay;
  // 覆盖层版本 >= 资产版本才优先：应用自身升级后，新资产自动接管覆盖层。
  const vOverlay = pluginUpdater.versionOfDir(overlay);
  const vAssets = pluginUpdater.versionOfDir(assets);
  if (vOverlay && vAssets && updater.compareVersions(vOverlay, vAssets) < 0) return assets;
  return overlay;
}
