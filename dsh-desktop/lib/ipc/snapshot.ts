/**
 * lib/ipc/snapshot.ts — 快照管理器域 IPC。
 *
 * channel：snapshot:overview / snapshot:create / snapshot:detail /
 * snapshot:restore / snapshot:branch-create / snapshot:branch-delete /
 * snapshot:branch-set-current / snapshot:config-save / snapshot:delete /
 * snapshot:gc。全部经 fromMainSession 鉴权；业务实现在 lib/snapshot/manager.ts。
 */

import { fromMainSession } from './sender.js';
import type { IpcSurface } from './transport.js';
import * as manager from '../snapshot/manager.js';

/** 注册快照域全部 channel（boot 时经 lib/ipc/index.ts 统一调用）。 */
export function registerSnapshotIpc(surface: IpcSurface): void {
  surface.handle('snapshot:overview', (_payload, ev) => {
    if (!fromMainSession(ev)) return { ok: false, error: 'unauthorized' };
    return manager.overview();
  });

  surface.handle('snapshot:create', (payload, ev) => {
    const {message} = (payload ?? {}) as Record<string, unknown>;

    if (!fromMainSession(ev)) return { ok: false, error: 'unauthorized' };
    const msg = message === undefined ? undefined : String(message).slice(0, 200);
    return manager.createSnapshot(msg);
  });

  surface.handle('snapshot:detail', (payload, ev) => {
    const {id} = (payload ?? {}) as Record<string, unknown>;

    if (!fromMainSession(ev)) return { ok: false, error: 'unauthorized' };
    return manager.snapshotDetail(String(id ?? ''));
  });

  surface.handle('snapshot:restore', (payload, ev) => {
    const {id, safety} = (payload ?? {}) as Record<string, unknown>;

    if (!fromMainSession(ev)) return { ok: false, error: 'unauthorized' };
    return manager.restoreSnapshot(String(id ?? ''), safety !== false);
  });

  surface.handle('snapshot:branch-create', (payload, ev) => {
    const {name, fromId} = (payload ?? {}) as Record<string, unknown>;

    if (!fromMainSession(ev)) return { ok: false, error: 'unauthorized' };
    return manager.createBranch(String(name ?? ''), fromId ? String(fromId) : undefined);
  });

  surface.handle('snapshot:branch-delete', (payload, ev) => {
    const {name} = (payload ?? {}) as Record<string, unknown>;

    if (!fromMainSession(ev)) return { ok: false, error: 'unauthorized' };
    return manager.deleteBranch(String(name ?? ''));
  });

  surface.handle('snapshot:branch-set-current', (payload, ev) => {
    const {name} = (payload ?? {}) as Record<string, unknown>;

    if (!fromMainSession(ev)) return { ok: false, error: 'unauthorized' };
    return manager.setCurrentBranch(String(name ?? ''));
  });

  surface.handle('snapshot:config-save', (payload, ev) => {
    const {config} = (payload ?? {}) as Record<string, unknown>;

    if (!fromMainSession(ev)) return { ok: false, error: 'unauthorized' };
    if (!config || typeof config !== 'object') return { ok: false, error: 'bad-config' };
    return manager.saveConfig(config as Record<string, never>);
  });

  surface.handle('snapshot:delete', (payload, ev) => {
    const {id} = (payload ?? {}) as Record<string, unknown>;

    if (!fromMainSession(ev)) return { ok: false, error: 'unauthorized' };
    return manager.deleteSnapshot(String(id ?? ''));
  });

  surface.handle('snapshot:gc', (_payload, ev) => {
    if (!fromMainSession(ev)) return { ok: false, error: 'unauthorized' };
    return manager.gc();
  });
}
