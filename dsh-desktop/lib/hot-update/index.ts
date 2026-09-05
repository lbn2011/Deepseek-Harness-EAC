/**
 * lib/hot-update/index.ts — 组件级热更新模块门面。
 *
 * 装配入口 createHotUpdate(ctx) 由 tauri-shell/sidecar/server.ts 调用（ctx
 * 注入，本模块不依赖桌面宿主框架）；recovery-center/register-sidecar
 * 经 setHotUpdateApi 复用同一实例。编译产物 .js 不入库（仓库惯例），运行前
 * 由 `npx tsc -p tsconfig.json` 原地生成。
 */

export { createHotUpdate, type HotUpdateApi } from './engine.js';
export { fetchManifest, resolveApplicable, MANIFEST_URLS, proxiedUrls } from './manifest.js';
export { checkFence, checkManifestFence, FenceError } from './fence.js';
export { huDirs, loadState, saveState, defaultState } from './store.js';
export { unpackAndVerify, snapshotBeforeApply, exchangeFiles, restoreFromBackup } from './apply.js';
export { spawnShellSwap } from './shell-swap.js';
export type {
  HotComponent,
  HotupdateManifest,
  HuBackupManifest,
  HuComponentRef,
  HuEntry,
  HuFileOp,
  HuManifest,
  HuPhase,
  HuState,
  HotUpdateCtx,
  RestartLevel,
} from './types.js';
