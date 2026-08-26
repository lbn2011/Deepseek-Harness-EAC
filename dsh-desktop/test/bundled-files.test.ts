import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktop = join(repo, 'dsh-desktop');
const stage = readFileSync(join(repo, 'tauri-shell', 'stage-resources.mjs'), 'utf8');
const config = JSON.parse(readFileSync(join(repo, 'tauri-shell', 'tauri.conf.json'), 'utf8')) as {
  bundle: { resources: Record<string, string> };
};

test('Tauri 资源映射包含 sidecar 与 dsh-desktop 完整运行树', () => {
  assert.equal(config.bundle.resources['staged-resources/sidecar/'], 'sidecar/');
  assert.equal(config.bundle.resources['staged-resources/dsh-desktop/'], 'dsh-desktop/');
});

test('sidecar 五个入口与快照面板都进入装配清单', () => {
  for (const file of ['server.js', 'bridge.js', 'ping.js', 'rescue-integration.js', 'ipc-surface.js']) {
    assert.match(stage, new RegExp(`['"]${file.replace('.', '\\.')}['"]`));
  }
  assert.match(stage, /SIDECAR_UI_FILES\s*=\s*\['snapshot-ui\.js'\]/);
});

test('统一模块运行闭包中的关键文件都进入装配清单', () => {
  // 根模块走 ROOT_FILES 清单；lib 闭包走 copyLibTree 整树递归装配——
  // 手维护清单曾漏装子目录（lib/logger 等），整树装配保证源存在即随包。
  assert.match(stage, /function copyLibTree\(\)/);
  assert.match(stage, /srcRoot = path\.join\(dd, 'lib'\)/);
  for (const file of ['host-bootstrap.js']) {
    assert.match(stage, new RegExp(`['"]${file.replace('.', '\\.')}['"]`), `装配清单缺少 ${file}`);
  }
  for (const file of ['host-ctx.js', 'server.js', 'ipc/index.js', 'snapshot/manager.js', 'recovery-center/register-sidecar.js']) {
    const src = join(desktop, 'lib', file);
    assert.equal(existsSync(src), true, `lib 源闭包缺少 ${file}（copyLibTree 整树装配会随之漏装）`);
  }
});

test('原生模块、共享协议与 package lock 都进入装配链', () => {
  for (const fragment of ['supervisor/index.node', 'snapshot/index.node', 'shared/protocol.js', 'package-lock.json']) {
    assert.match(stage, new RegExp(fragment.replace('/', '\\/').replace('.', '\\.')));
  }
});

test('Electron 入口与配置已从运行树退役', () => {
  for (const rel of ['main.ts', 'main.js', 'preload.ts', 'preload.js', 'electron-builder.yml']) {
    assert.equal(existsSync(join(desktop, rel)), false, `${rel} 不应存在`);
  }
});
