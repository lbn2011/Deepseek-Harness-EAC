/**
 * lib/plugin-registry-data.ts — 内置配套插件清单与更新源（Task 5.2 提取）。
 *
 * 2026-09-06 上游对齐：COMPANION_PLUGINS / RETIRED_BUILTIN_PLUGINS /
 * PLUGIN_UPDATE_SOURCES 三表的行与注释采自上游 zouyuxuan122/main 的
 * lib/desktop/companion-sync.ts（grill 决议：插件与更新方向以上游为主）；
 * 上游退役的 dsh-stt / settings-nav-custom / tool-vision / file-drop 同步
 * 进入退役清单，由启动链清理老 profile 残留。
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
  { id: 'balance', name: '@deepseek-ai/dsh-balance' },
  { id: 'file-changes', name: '@deepseek-ai/dsh-file-changes' },
  { id: 'client-file-changes', name: '@deepseek-ai/dsh-client-file-changes' },
  { id: 'terminal', name: '@deepseek-ai/dsh-terminal' },
  // 统一插件市场（dsh-unified-market，内置）：聚合精选目录
  // （awesome-dsh-plugin.com）+ GitHub dsh-plugin 生态 + npm 检索三源；
  // EAC 特化（web-desktop profile），试装验证 + 冲突预检 + 后台自动更新 +
  // 自动更新排队与启动消费 + 市场自更新。取代曾被内置的 webui-market /
  // zat-market / 旧 npm 市场（各自 profile 定位错误或重复，已从清单移除）。
  { id: 'unified-market', name: 'dsh-unified-market', dir: 'dsh-unified-market' },
  { id: 'skin-switch', name: '@deepseek-ai/dsh-skin-switch' },
  { id: 'easy-setup', name: '@deepseek-ai/dsh-easy-setup' },
  // 旧版/社区客户端插件的英文兼容层：跟随官方 locale 状态翻译固定 UI
  // 文案，不触碰会话、代码、终端、编辑器或用户输入。作为界面底座始终启用。
  { id: 'eac-locale-compat', name: 'dsh-eac-locale-compat', dir: 'dsh-eac-locale-compat' },
  // VNext Core Bridge（受信组件，vnext-absorb Phase 2）：把隔离 SDK 插件的
  // 工具/上下文经回环端点桥接进 dsh Agent（DSH_EAC_BRIDGE_URL/TOKEN 由
  // sidecar 在拉起 dsh web 前注入）；必须随包分发并默认启用。
  { id: 'eac-core-bridge', name: 'dsh-eac-core-bridge', dir: 'dsh-eac-core-bridge' },
  // 社区功能插件（视觉 / 人设 / 长期记忆 / 移动端布局修复）：npm registry
  // 拉取后随应用内置分发。绝不能写进 profile package.json 依赖 ——
  // pnpm 安装会 hoist @deepseek-ai 核心包形成模块双实例（Symbol 冲突，
  // 插件命名空间注册失效，即 "设置命名空间不可用" 故障的根因）。
  { id: 'picturereader', name: 'picturereader', dir: 'picturereader' },
  // 读屏 + 鼠标键盘自动化（Codex-style computer use，配 picturereader；纯本地）。
  { id: 'computer-user', name: 'computer-user', dir: 'computer-user' },
  // config.path 必须随行写入：v2.0.0 只写了 id+name，而当时插件 schema 的
  // path 是 required 无默认值，全新安装校验失败拖垮整个插件树（dsh web
  // 退出码 1，应用持续闪退"启动失败"）。schema 现已带默认值，这里显式
  // 写 config 是双保险，healSoulMdPatchRow 另负责修复存量坏行。
  { id: 'soul-md', name: 'dsh-soul-md', dir: 'dsh-soul-md', config: { path: 'soul.md' } },
  { id: 'mobile-fix', name: 'dsh-web-mobile-fix', dir: 'dsh-web-mobile-fix' },
  // 视口钳制（文档级滚动根治）：html/body overflow:hidden + 稳定契约
  // （data-phase/data-conversation-scroll）hero 居中兜底。纯客户端 CSS，
  // 随内核页面加载 —— 桌面壳 / 浏览器 / 手机端三端同源生效。
  { id: 'viewport-lock', name: 'dsh-viewport-lock', dir: 'dsh-viewport-lock' },
  // 喵丝滑（Phant0Meow/dsh-meow-smooth 0.5.0，MIT）：手机端 UI 交互优化
  // （输入框折叠/侧边栏手势/窄屏适配）+ 通知系统（页面卡片 / Web Push /
  // webhook）。5.2 起取代自研 mobile-app.html 续聊客户端 —— 手机桥改为
  // 完整 Web UI 反向代理，手机直接获得真界面，本插件负责移动端体验。
  // host 半边依赖 web-push（缺省时优雅降级：仅系统推送不可用）。
  { id: 'meow-smooth', name: 'meow-smooth', dir: 'dsh-meow-smooth', config: { enabled: true } },
  // VSCode 风格右侧边栏（文件树 / 编辑器 / 终端 / Git，按会话隔离）。
  // lib/ 预编译自包含（codemirror、xterm 已内嵌）。config 只随缺失的新行
  // 写入；已有 profile 行会在同步时跳过，保留升级用户的现有默认与自定义。
  { id: 'better-sidebar', name: 'dsh-better-sidebar', dir: 'dsh-better-sidebar', config: { openByDefault: true } },
  // VCP 视觉通感协议（dsh-raw-html 0.6.1 EAC 托管版，源自 plolpl789，MIT）：
  // 消息 HTML 渲染为界面（卡片 / KaTeX / Mermaid / 内置 7 款 OFL 书法字体）。
  // 必须进 profile bundles（overlay 行会被 removeBundledRowDuplicates 去重，
  // 不可写 patch 行）。
  { id: 'dsh-raw-html', name: 'dsh-raw-html', dir: 'dsh-raw-html' },
  // Trae 风格对话回退：用户消息 hover 出「编辑并回退」，按上一完整回合
  // 分叉新会话（sessions.fork）并以编辑后内容重发（inputActions）。
  { id: 'message-rewind', name: 'dsh-message-rewind', dir: 'dsh-message-rewind' },
  // 页面桌宠（npm: dsh-pet 0.1.3）：28 个透明动画的悬浮宠物，即装即用。
  // 行必须带 config —— dsh-pet 的 apply 读 config.fullRoot，无 config 块的
  // 行会让 loader 传 undefined 直接拖垮插件树。默认禁用。
  { id: 'dsh-pet', name: 'dsh-pet', dir: 'dsh-pet', config: { size: 260, position: 'bottom-right' }, disabled: true },
  // 设置页「Skills 与 MCP」分区：Skills 目录浏览 + MCP 服务增删改 + 从
  // Claude Code / Codex 一键导入 MCP 配置。
  { id: 'dock-settings', name: 'dsh-dock-settings', dir: 'dsh-dock-settings' },
  // 外观自定义：字体家族/字号/文字与代码颜色的设置页分区，实时预览。
  { id: 'font-custom', name: 'dsh-font-custom', dir: 'dsh-font-custom' },
  // 请求路径自动压缩：在模型请求前按真实 Token 压力调用 DSH 原生压缩
  // 引擎；上下文溢出时最多压缩并重试原请求一次。
  { id: 'compact', name: 'dsh-compact', dir: 'dsh-compact' },
  // 插件保护中心 UI：快照列表/一键回滚/健康检查/事故报告，经桌面壳
  // IPC（guard:action）驱动 plugin-guard.js 引擎。
  { id: 'plugin-shield', name: 'dsh-plugin-shield', dir: 'dsh-plugin-shield' },
  // AI 变更审核（V4，用户建议⑤）：监控官方 fileChanges 投影，让模型复查
  // 自己刚做的改动，结论配合「文件」页一键还原。
  { id: 'change-review', name: 'dsh-change-review', dir: 'dsh-change-review' },
  // 会话浮窗（多窗口分屏）：会话头部「弹出到独立窗口」按钮。
  { id: 'float-window', name: '@deepseek-ai/dsh-float-window' },
  // 对话节点导航条（vlln/dsh-navbar，MIT）：对话区右缘节点串快速跳转。
  { id: 'dsh-navbar', name: '@vlln/dsh-navbar', dir: 'dsh-navbar' },
  // 对话删除与归档管理。前置依赖 scripts/patch-session-manage.js 的官方包
  // 运行时补丁（随启动幂等应用、覆盖 agent overlay）。
  { id: 'dsh-session-manager', name: 'dsh-session-manager' },
  // 对话界面微调：隐藏大量工具调用/结果/思考输出（保留每轮最终总结）。
  { id: 'conversation-tweaks', name: '@deepseek-ai/dsh-conversation-tweaks' },
  // 自定义注入提示词：整体替换/追加官方 persona，应用到 standard 预设。
  { id: 'prompt-custom', name: '@deepseek-ai/dsh-prompt-custom' },
  // 侧边临时会话：浮窗追问、不写主会话、多种回答引擎（Ctrl+Shift+S）。
  { id: 'side-session', name: '@dsh-external/dsh-side-session', dir: 'dsh-side-session' },
  // 手机连接（5.2 方案）：LAN 扫码配对 + 完整 Web UI 反向代理（设置页
  // 「连接手机」）。桥本体在 Tauri 壳 sidecar（phone-bridge.js）。
  { id: 'dsh-phone', name: 'dsh-phone', dir: 'dsh-phone' },
  // 新增强化功能入口分区（5.1.0 批次）：设置页「增强功能」——为默认关闭的
  // 内置插件提供一键启用/停用开关。
  { id: 'dsh-feature-toggles', name: 'dsh-feature-toggles', dir: 'dsh-feature-toggles' },
  // DeepSeek 余额小鲸鱼挂件（MeteorNOX/DeepSeek-Balance-Whale-Widget，MIT）。
  // 默认关闭（需 DEEPSEEK_API_KEY 凭据）。
  { id: 'dsh-whale-widget', name: 'dsh-whale-widget', dir: 'dsh-whale-widget', disabled: true },
  // 多智能体团队协作（NanmiCoder/dsh-agent-teams，MIT）：队长 + 子代理成员 +
  // 依赖感知任务 DAG + 活动面板。5.3.1 起默认启用。
  { id: 'agent-teams', name: '@nanmicoder/dsh-agent-teams', dir: 'dsh-agent-teams' },
  // 输入灵动岛（says693/dsh-composer-dynamic-island 2.1.0，MIT）：把输入区
  // 选定按钮收纳为向上展开的紧凑岛。
  { id: 'composer-dynamic-island', name: 'dsh-composer-dynamic-island', dir: 'dsh-composer-dynamic-island' },
  // 插件启停管理：设置页「插件 → 管理」标签，不重启切换插件启停。
  { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager' },
  // 插件选择向导入口：重新打开首次启动的内置插件选择向导。
  { id: 'plugin-wizard', name: 'dsh-plugin-wizard', dir: 'dsh-plugin-wizard' },
  // 微信 ClawBot / OpenClaw 桥（openclaw-dsh-bridge v0.7.0，MIT）。
  { id: 'openclaw-bridge', name: '@deepseek-ai/dsh-openclaw-bridge', dir: 'dsh-openclaw-bridge' },
  // 崩溃急救/撤销回退（dsh-undo-savepoint，lire1131，MIT）。GitHub 分发
  // 锁定拷贝（npm 未发布）。
  { id: 'dsh-undo', name: 'dsh-undo-savepoint', dir: 'dsh-undo-savepoint' },
  // 大肥鱼桌宠（dsh-dafeiyu，QCYTSN；代码 MIT）。默认开启 —— 可关闭。
  { id: 'dsh-dafeiyu', name: 'dsh-dafeiyu', dir: 'dsh-dafeiyu' },
  // 桌宠设置分区（V4.2）：集中管理页面桌宠与大肥鱼桌面伴侣。
  { id: 'dsh-pet-settings', name: 'dsh-pet-settings', dir: 'dsh-pet-settings' },
  // 峰谷价格卫士（dsh-offpeak，christophersmith2737-commits，MIT）：高峰时段
  // 发送前拦截提醒，可一键继续或定时到闲时价自动执行。
  { id: 'offpeak', name: 'dsh-offpeak', dir: 'dsh-offpeak' },
  // 拖入文件/文件夹到对话（EAC 特化版）：文件卡片 + 临时副本 + 紧凑路径
  // 引用；图片继续走官方缩略图链路。独立发布：jing-hy/dsh-file-drop-eac。
  { id: 'file-drop-eac', name: 'dsh-file-drop-eac', dir: 'dsh-file-drop-eac' },
  // 设置页「常规」页内高级选项折叠（V4.2，用户建议）。
  { id: 'settings-groups', name: 'dsh-settings-groups', dir: 'dsh-settings-groups' },
  // 设置页「设置滚动修复」（settings-scroll-fix）。
  { id: 'settings-scroll-fix', name: 'dsh-settings-scroll-fix', dir: 'dsh-settings-scroll-fix' },
  // 图片粘贴发送（V4.2，用户建议）。默认禁用 —— 与内置 picturereader 的
  // 「粘贴即用/图片桥自动分析」入口语义重叠。
  { id: 'image-paste', name: 'dsh-image-paste', dir: 'dsh-image-paste', disabled: true },
  { id: 'dsh-webui-prompt-optimizer', name: 'dsh-webui-prompt-optimizer', dir: 'dsh-webui-prompt-optimizer' },
];

/** 曾内置、现已从内置清单移除的插件。老用户 profile 可能残留其 patch 行、
 * node_modules 副本与 package.json 依赖：启动时统一清理这些精确的历史
 * 内置条目（retireRemovedBuiltinPlugins）。行/包清单与上游 5.3.5 对齐。 */
export const RETIRED_BUILTIN_PLUGINS: { id: string; name: string }[] = [
  { id: 'auto-compact', name: 'dsh-auto-compact' },
  { id: 'plugin-marketplace', name: '@deepseek-ai/dsh-plugin-marketplace' },
  { id: 'dsh-market-plugin', name: '@sanqi-normal/dsh-webui-market-plugin' },
  { id: 'zat-market', name: 'zat-dsh-engine' },
  // 5.1.1：按用户要求移除内置「第三方模型思考强度」插件。
  { id: 'third-party-thinking', name: '@deepseek-ai/dsh-third-party-thinking' },
  // dsh-tool-vision 自 4.5.0 起被 picturereader 取代但此前未列入退役清单。
  { id: 'tool-vision', name: 'dsh-tool-vision' },
  // 按用户要求移除「普通/高级」分栏（nav-custom 是该分栏唯一写入者）。
  { id: 'settings-nav-custom', name: 'dsh-settings-nav-custom' },
  // 5.3.0：按用户要求移除内置「语音转文字」插件（本地 sherpa-onnx ASR 模型
  // ~1.1G 不再随包分发）。老 profile 残留由退役清理兜底；~/.dsh/models/
  // dsh-stt/ 模型缓存属用户数据，安装器不自动删除。
  { id: 'dsh-stt', name: '@deepseek-ai/dsh-stt' },
  // 旧 dsh-file-drop 与 EAC 特化版并存时会重复注入内容，由 file-drop-eac 取代。
  { id: 'file-drop', name: 'dsh-file-drop' },
];

/** 内置插件上游更新源（V4.3，plugin-updater.js 消费；npm 404 优雅降级）。
 * 与上游 5.4 对齐：统一市场纳入官方更新源；raw-html 为 EAC 托管适配版，
 * 不登记上游源（避免被原版 bundle 覆盖）。 */
export const PLUGIN_UPDATE_SOURCES: Record<string, { npm?: string; github?: string }> = {
  picturereader: { npm: 'picturereader' },
  'computer-user': { npm: 'computer-user' },
  'soul-md': { npm: 'dsh-soul-md' },
  'dsh-pet': { npm: 'dsh-pet' },
  'better-sidebar': { npm: 'dsh-better-sidebar' },
  'dsh-navbar': { npm: '@vlln/dsh-navbar' },
  'mobile-fix': { npm: 'dsh-web-mobile-fix' },
  offpeak: { npm: 'dsh-offpeak' },
  // 统一市场（unified-market）：npm 已发布，正式纳入官方内置插件更新。
  'unified-market': { npm: 'dsh-unified-market' },
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
