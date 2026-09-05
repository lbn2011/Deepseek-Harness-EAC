/**
 * lib/hot-update/types.ts — 组件级热更新类型定义（L2，无 Electron/Tauri import）。
 *
 * 清单/状态结构与 updates/generate.mjs（发布端）、
 * docs/hot-update-design-addendum-2026-09-05.md §3 组件矩阵保持一致。
 */

/** 组件身份：sidecar/resources/content/shell（围栏见 fence.ts）。 */
export type HotComponent = 'sidecar' | 'resources' | 'content' | 'shell';

export type RestartLevel = 'sidecar-restart' | 'app-restart';

export type ApplyMode = 'replace' | 'delete';

/** 热更新状态机阶段（每次转移先落盘再行动，崩溃安全）。 */
export type HuPhase =
  | 'IDLE'
  | 'RESOLVED'
  | 'DOWNLOADED'
  | 'SNAPSHOTTED'
  | 'STAGED'
  | 'APPLYING'
  | 'APPLIED'
  | 'RESTART'
  | 'VERIFIED'
  | 'COMMITTED'
  | 'ROLLED_BACK';

/** 包内文件操作条目（hu-manifest.json files[]）。 */
export interface HuFileOp {
  path: string;
  sha256: string | null;
  size: number;
  mode: ApplyMode;
}

/** 包内清单（updates/packages/*.zip 内的 hu-manifest.json）。 */
export interface HuManifest {
  schemaVersion: number;
  seq: number;
  component: HotComponent;
  version: string;
  appVersionRange: { min: string; max: string | null };
  restartLevel: RestartLevel;
  files: HuFileOp[];
  title?: string;
  publishedAt?: string;
  notes?: string;
}

/** 单组件下载/校验描述（hotupdate.json entries[].components.<name>）。 */
export interface HuComponentRef {
  version: string;
  url: string;
  sha256: string;
  size: number;
  restartLevel: RestartLevel;
}

/** 清单 entry：一次热更新发布（可携带多个组件）。 */
export interface HuEntry {
  seq: number;
  title: string;
  publishedAt: string;
  appVersionRange: { min: string; max: string | null };
  notes: string;
  components: Partial<Record<HotComponent, HuComponentRef>>;
}

/** 热更新清单（updates/hotupdate.json）。 */
export interface HotupdateManifest {
  schemaVersion: number;
  channel: string;
  generatedAt: string;
  latestSeq: number;
  signature: string | null;
  entries: HuEntry[];
}

/** userData/hotupdate/state.json（状态机持久化）。 */
export interface HuState {
  schemaVersion: number;
  appliedSeq: number;
  components: Partial<Record<HotComponent, { seq: number; version: string }>>;
  baselineSeq: number;
  phase: HuPhase;
  /** 进行中的应用（phase ≠ IDLE 时的现场）。 */
  pending: {
    seq: number;
    components: Partial<Record<HotComponent, HuComponentRef>>;
    restartLevel: RestartLevel;
    /** 已建快照目录名（backups/<name>），按组件记录；回滚依据。 */
    backups: Partial<Record<HotComponent, string>>;
  } | null;
  blockedSeqs: number[];
  verifyAttempts: number;
  lastCheckAt: string | null;
}

/** 快照清单（backups/<seq>-<ts>/hu-backup-manifest.json）。 */
export interface HuBackupManifest {
  kind: 'hotupdate';
  seq: number;
  component: HotComponent;
  fromVersion: string | null;
  toVersion: string;
  appVersion: string;
  createdAt: string;
  files: Array<{ path: string; sha256: string | null; existed: boolean }>;
  reason: string;
}

/** 宿主注入能力（sidecar server.ts 装配；引擎自身不碰 Tauri/Electron）。 */
export interface HotUpdateCtx {
  /** 安装根：含 sidecar/ 与 dsh-desktop/ 兄弟目录。 */
  installRoot: string;
  dshDesktopRoot: string;
  /** userData 根（Rust 经 DSH_USER_DATA 注入；状态机目录 <userData>/hotupdate/）。 */
  userDataDir: string;
  appVersion: string;
  log: (tag: string, msg: string) => void;
  notify: (event: string, params: Record<string, unknown>) => void;
  /** 同意弹窗（server.ts 用 showBoxFallback 装配）；缺省视为同意。 */
  confirm?: (info: { seq: number; title: string; notes: string }) => Promise<boolean>;
  /** sidecar-restart：notify shell.restart-sidecar 后有界退出，Rust 重生。 */
  restartSidecar: () => void;
  /** app-restart：shell 组件 detached 交换脚本已 spawn 后调用。 */
  quitForUpdate: () => void;
}
