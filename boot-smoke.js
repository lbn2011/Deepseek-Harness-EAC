'use strict';
// P2 boot.start 冒烟驱动（一次性）：临时 DSH_HOME 下完整走
// 前置准备 → spawn dsh web → webUrl → HTTP 探活 → 优雅关停。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const repo = path.resolve(__dirname);
const tmpHome = path.join(repo, 'tmp-p2boot', 'dsh-home');
fs.mkdirSync(tmpHome, { recursive: true });

const node = process.execPath;
const sidecar = path.join(repo, 'tauri-shell', 'sidecar', 'server.js');
const child = spawn(node, [sidecar], {
  env: { ...process.env, DSH_HOME: tmpHome },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
let sentShutdown = false; // shutdown 已发出：此后 sidecar 自然退出属预期，不再 fail-fast
let finished = false;
const t0 = Date.now();
const fail = (msg) => { console.error('[boot-smoke] FAIL:', msg); finished = true; child.kill(); process.exit(1); };
const timer = setTimeout(() => fail('总超时 300s'), 300000);
// BUG-A-001：sidecar 早死后写 stdin 会 EPIPE —— 挂 error 监听防崩溃栈，实际失败由 exit fail-fast 兜底
child.stdin.on('error', (e) => console.error('[boot-smoke] stdin write error:', e.message));

child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === 1 && msg.result && msg.result.webUrl) {
      const url = msg.result.webUrl;
      console.log('[boot-smoke] boot.start ok in', Math.round((Date.now() - t0) / 1000) + 's →', url);
      // 探活
      const probe = http.get(url + '/', { timeout: 5000 }, (r) => {
        r.resume();
        console.log('[boot-smoke] probe status =', r.statusCode);
        clearTimeout(timer);
        sentShutdown = true; // shutdown 已发出：此后 sidecar 自然退出属预期
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: {} }) + '\n');
        setTimeout(() => { console.log('[boot-smoke] PASS'); child.kill(); process.exit(0); }, 9000);
      }).on('error', (e) => fail('probe error: ' + e.message));
      // BUG-A-002：timeout 选项仅 socket 级 —— 监听 'timeout' 并中止，防止对端挂起时探活永不回调
      probe.on('timeout', () => probe.destroy(new Error('probe socket timeout 5s')));
    } else if (msg.id === 1 && msg.error) {
      fail('boot.start error: ' + JSON.stringify(msg.error));
    } else if (msg.method === 'boot.web-ready') {
      console.log('[boot-smoke] notify boot.web-ready:', JSON.stringify(msg.params));
    }
  }
});

setTimeout(() => {
  console.log('[boot-smoke] sending boot.start (DSH_HOME=' + tmpHome + ')');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'boot.start', params: {} }) + '\n');
}, 500);
// BUG-A-001：sidecar 早死（shutdown 发出前退出）→ 干净 FAIL 收场，而非无防护地写 stdin
child.on('exit', (code) => {
  console.log('[boot-smoke] sidecar exited code=' + code);
  if (!finished && !sentShutdown) fail('sidecar 提前退出（code=' + code + '）');
});
