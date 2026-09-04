// 诊断 zip 平台化命令：darwin/linux 用系统 zip；win32 保持 PowerShell 行为零回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildZipCommand } from '../../tauri-shell/sidecar/rescue-integration.js';

test('darwin 诊断 zip 使用系统 zip 归档 logs 目录', () => {
  const cmd = buildZipCommand('darwin', '/tmp/logs', '/tmp/out.zip');
  assert.equal(cmd.program, 'zip');
  assert.deepEqual(cmd.args, ['-qr', '/tmp/out.zip', '/tmp/logs']);
});

test('linux 诊断 zip 使用系统 zip 归档 logs 目录', () => {
  const cmd = buildZipCommand('linux', '/tmp/logs', '/tmp/out.zip');
  assert.equal(cmd.program, 'zip');
  assert.deepEqual(cmd.args, ['-qr', '/tmp/out.zip', '/tmp/logs']);
});

test('win32 诊断 zip 保持 PowerShell Compress-Archive 原命令', () => {
  const cmd = buildZipCommand('win32', 'C:\\logs', 'C:\\out.zip');
  assert.equal(cmd.program, 'powershell');
  assert.deepEqual(cmd.args, [
    '-NoProfile',
    '-Command',
    'Compress-Archive -Path "C:\\logs\\*" -DestinationPath "C:\\out.zip" -Force',
  ]);
});
