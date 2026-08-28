'use strict';

// L2 Node sidecar PoC —— stdio JSON-RPC（行分隔帧）。
// sidecar 承载统一 lib 业务模块；本文件演示协议与 L3 内核定位。

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as readline from 'node:readline';

interface RpcMessage {
  jsonrpc: string;
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

function respond(msg: RpcMessage): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line: string) => {
  const text = line.trim();
  if (!text) return;
  let req: { id: unknown; method: string; params?: unknown };
  try {
    req = JSON.parse(text);
  } catch {
    return respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  const { id, method, params } = req;
  try {
    if (method === 'ping') {
      return respond({ jsonrpc: '2.0', id, result: { pong: true, ts: Date.now(), gotParams: params || null } });
    }
    if (method === 'shell.info') {
      return respond({
        jsonrpc: '2.0',
        id,
        result: {
          sidecar: 'ping.js',
          node: process.version,
          platform: process.platform,
          pid: process.pid,
        },
      });
    }
    if (method === 'dsh.probe') {
      // L2 → L3：定位随 dsh-desktop 分发的内核 CLI（零改动验证）。
      // sidecar 与 dsh-desktop 同级的任意布局：upTwo 优先（开发态
      // tauri-shell/sidecar → 仓库根），upOne fallback（打包态同级）。
      try {
        const upTwo = path.resolve(__dirname, '..', '..', 'dsh-desktop');
        const root = fs.existsSync(path.join(upTwo, 'package.json'))
          ? upTwo
          : path.resolve(__dirname, '..', 'dsh-desktop');
        const bin = require.resolve('@deepseek-ai/dsh/lib/bin.js', {
          paths: [root],
        });
        return respond({ jsonrpc: '2.0', id, result: { found: true, bin } });
      } catch (e) {
        return respond({ jsonrpc: '2.0', id, result: { found: false, error: (e as Error).message } });
      }
    }
    respond({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
  } catch (e) {
    respond({ jsonrpc: '2.0', id, error: { code: -32000, message: String(((e as Error) && (e as Error).message) || e) } });
  }
});
rl.on('close', () => process.exit(0));
