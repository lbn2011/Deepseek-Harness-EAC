import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sidecarRoot = join(root, '..', 'tauri-shell', 'sidecar');
const { state, initVNextState } = require('../lib/state.js');
const { registerIpc } = require('../lib/ipc/index.js');
const { createSidecarIpcSurface } = require('../../tauri-shell/sidecar/ipc-surface.js');

const SNAPSHOT_CHANNELS = [
  'snapshot:overview', 'snapshot:create', 'snapshot:detail', 'snapshot:restore',
  'snapshot:branch-create', 'snapshot:branch-delete', 'snapshot:branch-set-current',
  'snapshot:config-save', 'snapshot:delete', 'snapshot:gc',
];

let base = '';
let home = '';

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'dsh-sidecar-snapshot-'));
  home = join(base, '.dsh');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'settings.yaml'), 'version: 1\n');
  initVNextState({ dshHome: home, userDataDir: join(base, 'user-data'), logsDir: join(base, 'logs') });
});

afterEach(() => {
  state.mainSession = null;
  rmSync(base, { recursive: true, force: true });
});

test('sidecar IpcSurface 注册全部统一 IPC 域并保留 invoke/send 语义', () => {
  const methods: Record<string, (params?: Record<string, unknown>) => unknown> = {};
  const surface = createSidecarIpcSurface(methods);
  registerIpc(surface);
  assert.equal(surface.channels().length, 42);
  assert.deepEqual(SNAPSHOT_CHANNELS.filter((channel) => !surface.channels().includes(channel)), []);
  assert.equal(surface.kindOf('dsh:page-error'), 'send');
  assert.equal(surface.kindOf('snapshot:overview'), 'invoke');
});

test('snapshot 域经 sidecar JSON-RPC 真实完成 overview/create/detail/restore/分支/配置/delete/gc', async (t) => {
  if (!existsSync(join(root, 'native', 'snapshot', 'index.node'))) {
    t.skip('native snapshot 未构建');
    return;
  }
  const methods: Record<string, (params?: Record<string, unknown>) => unknown> = {};
  const surface = createSidecarIpcSurface(methods);
  registerIpc(surface);
  state.mainSession = surface.session('main-token');

  const call = async (channel: string, payload: Record<string, unknown> = {}, token = 'main-token') =>
    methods[channel]!({ ...payload, __sessionToken: token });

  const overview = await call('snapshot:overview') as { ok: boolean };
  assert.equal(overview.ok, true);
  const created = await call('snapshot:create', { message: 'sidecar integration' }) as { ok: boolean; data: { id: string } };
  assert.equal(created.ok, true);
  const id = created.data.id;
  assert.equal((await call('snapshot:detail', { id }) as { ok: boolean }).ok, true);
  writeFileSync(join(home, 'settings.yaml'), 'version: 2\n');
  assert.equal((await call('snapshot:restore', { id, safety: false }) as { ok: boolean }).ok, true);
  assert.equal(readFileSync(join(home, 'settings.yaml'), 'utf8'), 'version: 1\n');
  assert.equal((await call('snapshot:branch-create', { name: 'task-7', fromId: id }) as { ok: boolean }).ok, true);
  assert.equal((await call('snapshot:branch-set-current', { name: 'task-7' }) as { ok: boolean }).ok, true);
  assert.equal((await call('snapshot:branch-set-current', { name: 'main' }) as { ok: boolean }).ok, true);
  assert.equal((await call('snapshot:branch-delete', { name: 'task-7' }) as { ok: boolean }).ok, true);
  assert.equal((await call('snapshot:config-save', { config: { exclusions: ['skills'], scheduleEnabled: false, scheduleMode: 'daily', intervalMinutes: 60, dailyTime: '03:00', currentBranch: 'main' } }) as { ok: boolean }).ok, true);
  assert.equal((await call('snapshot:create', { message: 'new head' }) as { ok: boolean }).ok, true);
  assert.equal((await call('snapshot:delete', { id }) as { ok: boolean }).ok, true);
  assert.equal((await call('snapshot:gc') as { ok: boolean }).ok, true);
});

test('sidecar 敏感域拒绝缺失或错误会话 token，正确主窗 token 放行', async () => {
  const methods: Record<string, (params?: Record<string, unknown>) => unknown> = {};
  const surface = createSidecarIpcSurface(methods);
  registerIpc(surface);
  state.mainSession = surface.session('main-token');
  const missing = await methods['snapshot:restore']!({ id: 'x' }) as { error: string };
  const rogue = await methods['snapshot:restore']!({ id: 'x', __sessionToken: 'rogue-token' }) as { error: string };
  const allowed = await methods['dsh:copy-text']!({ text: 'ok', __sessionToken: 'main-token' }) as { ok: boolean };
  assert.equal(missing.error, 'unauthorized');
  assert.equal(rogue.error, 'unauthorized');
  assert.equal(allowed.ok, true);
});

test('Tauri bridge 暴露与 preload 相同的 snapshot API，并使用统一冒号 channel', () => {
  const bridge = readFileSync(join(sidecarRoot, 'bridge.ts'), 'utf8');
  for (const channel of SNAPSHOT_CHANNELS) assert.match(bridge, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(bridge, /call\('(?:balance|plugins|files|clipboard|image-paste)\./);
});
