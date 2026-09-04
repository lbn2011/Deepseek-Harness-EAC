'use strict';
// 通用 sidecar boot 探活（Task 11.3 / 12② 复用）：用当前 node（CI 里为
// 产物树内 vendored node）拉起 sidecar/server.js → 发 boot.start JSON-RPC →
// 解析 webUrl → HTTP 探活期望 200 → 优雅关停。
//
// 用法：node sidecar-boot-probe.js <sidecar/server.js 绝对路径> [超时秒]
// 退出码 0 = 探活成功（并打印启动耗时 ms）；非 0 = 失败。

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const serverJs = process.argv[2];
if (!serverJs || !fs.existsSync(serverJs)) {
  console.error('[sidecar-probe] 用法: node sidecar-boot-probe.js <server.js> [timeoutSec]');
  process.exit(2);
}
const timeoutSec = Number(process.argv[3] || 300);
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-probe-'));

const child = spawn(process.execPath, [serverJs], {
  env: { ...process.env, DSH_HOME: tmpHome },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const t0 = Date.now();
let buf = '';
let sentShutdown = false; // shutdown 已发出：此后 sidecar 自然退出属预期，不再 fail-fast
const fail = (msg) => { console.error('[sidecar-probe] FAIL:', msg); child.kill(); process.exit(1); };
const timer = setTimeout(() => fail(`总超时 ${timeoutSec}s`), timeoutSec * 1000);
// BUG-A-020：sidecar 早死后写 stdin 会 EPIPE —— 挂 error 监听防崩溃栈，实际失败由 exit fail-fast 兜底
child.stdin.on('error', (e) => console.error('[sidecar-probe] stdin write error:', e.message));

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
      const ms = Date.now() - t0;
      console.log(`[sidecar-probe] boot.start ok in ${ms}ms → ${url}`);
      const probe = http.get(url + '/', { timeout: 10000 }, (r) => {
        let body = '';
        r.on('data', (c) => { body += c; });
        r.on('end', () => {
          clearTimeout(timer);
          console.log(`[sidecar-probe] GET / → ${r.statusCode} (${body.length} bytes)`);
          if (r.statusCode !== 200) { fail(`HTTP ${r.statusCode}`); return; }
          // 对话界面验证（Task 11.3 增强）：首页必须是完整对话 UI，
          // 而非空白/错误页。SPA 入口含 app 挂载点 + 聊天相关标记。
          const lower = body.toLowerCase();
          const ui = lower.includes('</html>') && body.length > 512;
          const chatish = /chat|conversation|message|对话|#app|id="app"/i.test(body);
          console.log(`[sidecar-probe] ui-html=${ui} chat-marker=${chatish}`);
          if (body.length > 400) console.log('[sidecar-probe] html head: ' + body.slice(0, 400).replace(/\s+/g, ' '));
          if (!ui || !chatish) { fail('首页未呈现对话界面（非完整 HTML 或缺聊天标记）'); return; }
          sentShutdown = true; // shutdown 已发出：此后 sidecar 自然退出属预期
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: {} }) + '\n');
          setTimeout(() => { console.log(`[sidecar-probe] PASS (${ms}ms)`); child.kill(); process.exit(0); }, 9000);
        });
      }).on('error', (e) => fail('probe error: ' + e.message));
      // BUG-A-020：timeout 选项仅 socket 级 —— 监听 'timeout' 并中止，防止对端挂起时探活永不回调
      probe.on('timeout', () => probe.destroy(new Error('probe socket timeout 10s')));
    } else if (msg.id === 1 && msg.error) {
      fail('boot.start error: ' + JSON.stringify(msg.error));
    }
  }
});

setTimeout(() => {
  console.log('[sidecar-probe] sending boot.start (DSH_HOME=' + tmpHome + ')');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'boot.start', params: {} }) + '\n');
}, 500);
// BUG-A-020：sidecar 早死（shutdown 发出前退出）→ 干净 FAIL 收场，而非无防护地写 stdin
child.on('exit', (code) => {
  console.log('[sidecar-probe] sidecar exited code=' + code);
  if (!sentShutdown) fail(`sidecar 提前退出（code=${code}）`);
});
