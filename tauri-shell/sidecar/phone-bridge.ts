'use strict';
// DSH 手机连接桥（5.2：完整 Web UI 反向代理版，sidecar 层，Tauri 壳运行期）。
//
// 5.1.x 是「白名单 RPC + 自研 mobile-app.html 续聊客户端」；5.2 起替换为
// dsh-meow-smooth 方案：手机经本桥直接访问**完整内核 Web UI**，喵丝滑插件
// （内置随包分发）在手机浏览器里提供移动端交互优化与通知，本桥不再自带
// 任何自研客户端页。安全边界不变：
//   /pair?token=…        配对：一次性 token（5 分钟 TTL，timingSafeEqual 比对）
//   /api/pair-state?…    手机端轮询配对状态；approved 时下发 dsh_mobile cookie
//   /desktop/decide      桌面端批准（仅回环可达）
//   /desktop/disconnect  桌面端断开（仅回环可达；轮换 token，手机端立即失效）
//   其余一切路径          反向代理到内核 Web 服务（需 dsh_mobile cookie）：
//                        静态资源 / /api/* / /plugins/* / WebSocket 升级
//
// 代理细节：Host/Origin 头改写为内核自身 origin —— 内核的浏览器信任围栏
// 看到的始终是同源流量，无需把 LAN 地址登记进 trusted-host 白名单；
// POST /api/* 的 unary JSON 响应按 Accept-Encoding 加 gzip（手机蜂窝网络
// 拉大会话历史 1-8MB 的场景压缩 70-90%），SSE/WS/静态资源原样透传。
// 配对 token 一次性 + 5min TTL + 常量时间比对；approve/decide/disconnect
// 仅接受回环来源；dsh_mobile cookie HttpOnly + SameSite=Strict，一年有效期，
// 值 = 服务端随机会话密钥（持久化 userData）：断开连接即轮换，全部旧
// cookie 立即失效；应用重启密钥不变，手机端无需重新配对。

import * as http from 'node:http';
import type * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import zlib from 'node:zlib';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const PAIRING_TTL_MS = 5 * 60 * 1000;
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 一年

// LAN 明网（http://192.168.x.x）是非安全上下文：`crypto.randomUUID`（Chrome 92+
// 起）只在安全上下文暴露，手机端拿到的是 undefined。内核浏览器端用它生成
// RpcId / 消息 id（dsh-client-connection），一崩就是全部 RPC 失败 —— 会话与
// 工作区列表全空、退回「选择工作区」冷启动、目录选择弹「crypto.randomUUID
// is not a function」。桥在 HTML 响应最前面注入 polyfill（getRandomValues 在
// 非安全上下文可用），内核源码不动。仅注入未压缩的 text/html。
const RANDOMUUID_POLYFILL =
  '<script>if(typeof crypto!=="undefined"&&typeof crypto.randomUUID!=="function"){'
  + 'crypto.randomUUID=function(){var b=crypto.getRandomValues(new Uint8Array(16));'
  + 'b[6]=(b[6]&0x0f)|0x40;b[8]=(b[8]&0x3f)|0x80;'
  + 'var h="";for(var i=0;i<16;i++)h+=(b[i]+256).toString(16).slice(1);'
  + 'return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20);};}'
  + '</script>';

export interface PhoneBridgeOptions {
  getWebUrl: () => string | null;
  log: (message: string) => void;
  /** 会话密钥持久化文件（userData 下）：跨重启保持手机端配对有效，轮换即全部失效。 */
  sessionFile: string;
}

export interface PhoneStatus {
  running: boolean;
  port: number;
  lanUrl: string;
  mobileReady: boolean;
  pairing: {
    state: 'idle' | 'waiting' | 'approved' | 'rejected' | 'expired';
    expiresAt: number | null;
  };
}

interface PairingState {
  token: string;
  expiresAt: number;
  decided: boolean | null; // null=未决, true=批准, false=拒绝
}

// 挑一个手机可达的 LAN IPv4：优先 RFC1918 私网地址（192.168/10./172.16-31，
// 普通家用/办公 Wi-Fi 网段），其次任意非回环地址（含 169.254 链路本地——DHCP
// 失败时的兜底，本机可达、同网段手机通常也可达），最后回环。旧实现直接取第一
// 个非回环地址，经常选中虚拟网卡/APIPA 的 169.254.x，手机扫出来的地址连不上。
// interfaces 参数仅为测试注入 fake 网卡表（生产调用不传，走 os.networkInterfaces）。
export function lanAddress(interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string {
  const ifaces = interfaces ?? os.networkInterfaces();
  let fallback: string | null = null;
  for (const name of Object.keys(ifaces)) {
    for (const entry of ifaces[name] ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const ip = entry.address;
      if (fallback === null) fallback = ip;
      const p = ip.split('.').map((s) => Number(s));
      if (p.length !== 4 || p.some((n) => Number.isNaN(n))) continue;
      const a = p[0] ?? -1;
      const b = p[1] ?? -1;
      const rfc1918 =
        a === 10 ||
        (a === 192 && b === 168) ||
        (a === 172 && b >= 16 && b <= 31);
      if (rfc1918) return ip;
    }
  }
  return fallback ?? '127.0.0.1';
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function tokenEquals(a: string, b: string): boolean {
  try {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function html(res: http.ServerResponse, status: number, page: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    ...extraHeaders,
    'content-length': Buffer.byteLength(page),
  });
  res.end(page);
}

/** 未配对/配对失效时给手机看的门页（不是客户端，只指路）。 */
function gatePage(): string {
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
    '<title>DSH 需要配对</title>',
    '<style>body{margin:0;background:#111418;color:#e8eaed;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;box-sizing:border-box}.card{max-width:380px;background:#1c2128;border:1px solid #2b333d;border-radius:16px;padding:28px 22px;text-align:center}h1{font-size:18px;margin:0 0 10px}p{font-size:14px;color:#aab2bd;line-height:1.7;margin:0}</style>',
    '</head><body><div class="card"><h1>需要重新配对</h1>',
    '<p>本设备的配对已失效。请在电脑端 DSH「设置 → 连接手机」重新发起配对，扫码批准后即可继续使用。</p>',
    '</div></body></html>',
  ].join('');
}

function pairingWaitPage(): string {
  const script = [
    'var token=location.search.match(/[?&]token=([^&]+)/)[1];',
    'var timer=setInterval(poll,1200);poll();',
    "function poll(){fetch('/api/pair-state?token='+encodeURIComponent(token))",
    ".then(function(r){return r.json()})",
    ".then(function(s){if(s.state==='approved'){clearInterval(timer);location.href='/'}else if(s.state==='rejected'){clearInterval(timer);",
    "document.getElementById('st').textContent='配对被拒绝，请在电脑端重新发起配对。'}else if(s.state==='expired'){clearInterval(timer);",
    "document.getElementById('st').textContent='配对已过期，请在电脑端重新发起配对。'}})",
    ".catch(function(){})",
    '};',
  ].join('');
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>配对验证</title>',
    '<style>body{margin:0;background:#111418;color:#e8eaed;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{max-width:360px;background:#1c2128;border:1px solid #2b333d;border-radius:16px;padding:28px 22px;text-align:center}h1{font-size:18px;margin:0 0 10px}p{font-size:14px;color:#aab2bd;line-height:1.7;margin:0}</style>',
    `</head><body><div class="card"><h1>正在建立配对</h1><p id="st">请在电脑端确认配对后，本页将自动跳转。</p></div><script>${script}</script></body></html>`,
  ].join('');
}

export function createPhoneBridge(options: PhoneBridgeOptions) {
  const { getWebUrl, log, sessionFile } = options;
  let server: http.Server | null = null;
  let port = 0;
  let lanUrl = '';
  let pairing: PairingState | null = null;
  let mobileReady = false; // 手机端客户端尚未开发
  // BUG-B-010：会话凭证与配对口令分离——配对批准后签发随机会话串，
  // disconnect/重新配对即失效；不再使用静态常量 cookie（静态值任何人
  // 可伪造，且 disconnect 后旧 cookie 一年内仍有效）。
  let sessionToken: string | null = null;

  function rotatePairing(): void {
    sessionToken = null; // 新配对流程开启时，既有会话凭证一并作废
    pairing = {
      token: randomBytes(32).toString('base64url'),
      expiresAt: Date.now() + PAIRING_TTL_MS,
      decided: null,
    };
  }

  /** 桌面端断开：轮换会话密钥（既有手机端 cookie 立即失效）+ 配对 token。 */
  function disconnectAll(): void {
    sessionSecret = randomBytes(32).toString('base64url');
    persistSessionSecret(sessionSecret);
    rotatePairing();
  }

  function currentPairingState(): 'idle' | 'waiting' | 'approved' | 'rejected' | 'expired' {
    if (!server || pairing === null) return 'idle';
    if (pairing.decided === true) return 'approved';
    if (pairing.decided === false) return 'rejected';
    if (Date.now() > pairing.expiresAt) return 'expired';
    return 'waiting';
  }

  function hasPairedCookie(req: http.IncomingMessage): boolean {
    const cookies = (req.headers.cookie ?? '').split(';').map((c) => c.trim());
    return cookies.some((c) => tokenEquals(c, `dsh_mobile=${sessionSecret}`));
  }

  /** 上游目标（host/port/token）。服务未运行返回 null。 */
  function upstreamOf(): { host: string; port: number; origin: string; token: string } | null {
    const base = getWebUrl();
    if (!base) return null;
    try {
      const url = new URL(base);
      return {
        host: url.hostname,
        port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
        origin: url.origin,
        token: url.searchParams.get('token') ?? '',
      };
    } catch {
      return null;
    }
  }

  // ---- 内核鉴权自兑（0.1.2 token 鉴权适配）----
  // 内核 Web 首屏为「一次性 token → 兑换 dsh-auth-* 签名 cookie」模型：裸 /
  // 401，/?token= 303 + Set-Cookie（30 天、Host 绑定、token 可重复兑换）。
  // 手机桥代理必须携带该 cookie。此处缓存一份（token 变化 = 内核重启轮换，
  // 自动重兑）；手机浏览器自带的 dsh-auth-* cookie（上次透传存下的）在
  // proxyHeaders spread 里原样透传，优先于缓存。
  let kernelCookieCache: { token: string; cookie: string } | null = null;
  async function ensureKernelCookie(force: boolean): Promise<string | null> {
    const upstream = upstreamOf();
    if (!upstream || !upstream.token) return null;
    if (!force && kernelCookieCache && kernelCookieCache.token === upstream.token) {
      return kernelCookieCache.cookie;
    }
    return new Promise((resolve) => {
      const req = http.request(
        { host: upstream.host, port: upstream.port, path: '/?token=' + encodeURIComponent(upstream.token), method: 'GET' },
        (res) => {
          res.resume();
          const raw = res.headers['set-cookie'] ?? [];
          const auth = raw
            .filter((c) => c.startsWith('dsh-auth-'))
            .map((c) => c.split(';', 1)[0] ?? '');
          const cookie = auth.filter(Boolean).join('; ');
          if (res.statusCode === 303 && cookie) {
            kernelCookieCache = { token: upstream.token, cookie };
            resolve(cookie);
          } else {
            resolve(null);
          }
        },
      );
      req.on('error', () => resolve(null));
      // 内核 accept 后不应答（挂起）时该 Promise 永不 settle，所有手机请求
      // 卡死在 await 上、桥整体不可用。有界超时按兑换失败处理（缓存留旧值）。
      req.setTimeout(8000, () => req.destroy(new Error('kernel cookie timeout')));
      req.end();
    });
  }

  /** 合并 cookie 头：手机自带的 dsh-auth-* 优先（透传语义），否则用缓存。 */
  function withKernelCookie(headers: Record<string, string | string[] | undefined>, kernelCookie: string | null): void {
    if (!kernelCookie) return;
    const existing = typeof headers.cookie === 'string' ? headers.cookie : '';
    if (/dsh-auth-[^=]+=/i.test(existing)) return;
    headers.cookie = existing ? existing + '; ' + kernelCookie : kernelCookie;
  }

  /** 请求头改写：Host/Origin 指向内核自身 origin（信任围栏视为同源）。 */
  function proxyHeaders(req: http.IncomingMessage, origin: string): Record<string, string | string[] | undefined> {
    const headers = { ...req.headers };
    const target = new URL(origin);
    headers.host = target.host;
    if (typeof headers.origin === 'string' && headers.origin !== '') headers.origin = target.origin;
    if (typeof headers.referer === 'string' && headers.referer !== '') {
      try { headers.referer = new URL(new URL(headers.referer).pathname + new URL(headers.referer).search, origin).toString(); } catch { /* 保留原值 */ }
    }
    return headers;
  }

  function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const pathName = url.pathname;

    if (req.method === 'GET' && path === '/api/pair-state') {
      if (pairing === null || !tokenEquals(url.searchParams.get('token') ?? '', pairing.token)) {
        json(res, 403, { error: 'invalid token' });
        return;
      }
      const state = currentPairingState();
      const headers: Record<string, string> = {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-frame-options': 'DENY',
      };
      if (state === 'approved') {
        // 配对成功即签发一年期 dsh_mobile 会话 cookie（移动端随后继访问携带）。
        // BUG-B-010：cookie 值为本次配对签发的随机会话串（非常量），
        // disconnect/重新配对后由 sessionToken=null 立即失效。
        if (sessionToken === null) sessionToken = randomBytes(32).toString('base64url');
        headers['set-cookie'] =
          `dsh_mobile=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`;
      }
      const payload = JSON.stringify({ state, expiresAt: pairing.expiresAt });
      res.writeHead(200, headers);
      res.end(payload);
      return;
    }

    if (req.method === 'POST' && path === '/api/rpc') {
      const cookies = (req.headers.cookie ?? '').split(';').map((c) => c.trim());
      // BUG-B-010：校验随机会话串（timingSafeEqual 防时序侧信道），
      // 未配对/已断开签发的旧 cookie 一律 401。
      if (sessionToken === null || !cookies.some((c) => tokenEquals(c, `dsh_mobile=${sessionToken}`))) {
        json(res, 401, { error: 'not paired' });
        return;
      }
      let body: { method?: unknown; params?: unknown };
      try {
        body = (await readJson()) as { method?: unknown; params?: unknown };
      } catch {
        json(res, 400, { error: 'invalid json body' });
        return;
      }
      if (typeof body.method !== 'string' || !RPC_ALLOWLIST.has(body.method)) {
        json(res, 400, { error: 'method not allowed' });
        return;
      }
      const forwarded = await forwardRpc(body.method, body.params);
      json(res, forwarded.status, forwarded.body);
      return;
    }

    if (path === '/desktop/decide' || path === '/desktop/disconnect') {
      if (!isLoopback(req.socket?.remoteAddress)) {
        json(res, 403, { error: 'loopback only' });
        return;
      }
      if (path === '/desktop/decide') {
        if (pairing === null || pairing.decided !== null || Date.now() > pairing.expiresAt) {
          // BUG-B-011：过期配对不可再批准（否则过期 token 仍能换发会话 cookie，
          // 5 分钟 TTL 边界失效）。
          json(res, 409, { error: 'no pending pairing' });
          return;
        }
        if (Date.now() > pairing.expiresAt) {
          html(res, 410, '<h3>配对已过期</h3><p>请在电脑端重新发起配对。</p>');
          return;
        }
        html(res, 200, pairingWaitPage());
        return;
      }

      if (req.method === 'GET' && pathName === '/api/pair-state') {
        if (pairing === null || !tokenEquals(url.searchParams.get('token') ?? '', pairing.token)) {
          json(res, 403, { error: 'invalid token' });
          return;
        }
        const state = currentPairingState();
        const headers: Record<string, string> = {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-frame-options': 'DENY',
        };
        if (state === 'approved') {
          // 配对成功即签发一年期 dsh_mobile 会话 cookie（值 = 服务端会话密钥，
          // 移动端随后继访问携带；disconnect 轮换密钥即全部失效）。
          headers['set-cookie'] =
            `dsh_mobile=${sessionSecret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`;
        }
        const payload = JSON.stringify({ state, expiresAt: pairing.expiresAt });
        res.writeHead(200, headers);
        res.end(payload);
        return;
      }

      if (pathName === '/desktop/decide' || pathName === '/desktop/disconnect') {
        if (!isLoopback(req.socket?.remoteAddress)) {
          json(res, 403, { error: 'loopback only' });
          return;
        }
        // 回环不够：浏览器里任意网页都能 <img src="http://127.0.0.1:P/...">
        // 打进来。decide/disconnect 是有副作用的 CSRF 面 —— 仅收 POST 且
        // 要求 Sec-Fetch-Site 为 same-origin（浏览器自动附带，跨站请求为
        // cross-site；非浏览器本地工具不带该头也放行）。
        if (req.method !== 'POST') {
          json(res, 405, { error: 'POST only', allow: 'POST' });
          return;
        }
        const fetchSite = String(req.headers['sec-fetch-site'] ?? '');
        if (fetchSite === 'cross-site') {
          json(res, 403, { error: 'cross-site request rejected' });
          return;
        }
        if (pathName === '/desktop/decide') {
          if (pairing === null || pairing.decided !== null) {
            json(res, 409, { error: 'no pending pairing' });
            return;
          }
          // 读 body 会 await 让出事件循环：期间 stop()/disconnect() 可能轮换
          // token（pairing 换成新对象）。先捕获本请求看到的对象，写回前复核
          // 身份，避免把决定落在别人刚扫到的新 token 上（TOCTOU）。
          const pending = pairing;
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          let body: { approved?: unknown };
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { approved?: unknown };
          } catch {
            json(res, 400, { error: 'invalid json body' });
            return;
          }
          if (pairing !== pending || pending.decided !== null) {
            json(res, 409, { error: 'no pending pairing' });
            return;
          }
          pending.decided = body.approved === true;
          log(`phone bridge: pairing ${pending.decided ? 'approved' : 'rejected'} by desktop`);
          json(res, 200, { ok: true, approved: pending.decided });
          return;
        }
        disconnectAll();
        log('phone bridge: disconnected; pairing token rotated');
        json(res, 200, { ok: true });
        return;
      }

      // ---- 以下全部走代理（需 dsh_mobile cookie）----
      if (!hasPairedCookie(req)) {
        html(res, 401, gatePage());
        return;
      }
      const upstream = upstreamOf();
      if (!upstream) {
        json(res, 503, { error: 'harness web service is not running' });
        return;
      }
      // 内核 Web 恒为回环 http（boot-server 以 --host 127.0.0.1 拉起）。
      // 手机自带的 dsh-auth-* 优先透传（withKernelCookie 语义：内核侧自行
      // 裁决）。旧 cookie 因内核重启轮换而失效时上游回 401 —— 强制重兑一次
      // 并以桥缓存重放（丢弃手机侧 stale cookie），手机侧无需重配对即恢复。
      let retried401 = false;
      // 手机是否自带内核 dsh-auth-*（透传优先语义，见 withKernelCookie）。
      const phoneCarriedAuthCookie =
        typeof req.headers.cookie === 'string' && /dsh-auth-[^=]+=/i.test(req.headers.cookie);
      // 请求体必须先缓冲再转发：req 流只能消费一次，401 重放需要原体重发
      //（旧实现重放时对已 ended 的 req 再 pipe —— content-length 照带、
      // 体为空，内核按空载荷裁决并以 200 收场，手机侧静默丢请求体）。
      // 超过上限直接 413，不做「部分缓冲后降级流式」（部分体已读，流式
      // 只会发出截断体）。GET/HEAD 无体跳过缓冲。
      const BODY_CAP = 64 * 1024 * 1024;
      let bufferedBody: Buffer | null = null;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks: Buffer[] = [];
        let total = 0;
        try {
          for await (const chunk of req) {
            const b = chunk as Buffer;
            total += b.length;
            if (total > BODY_CAP) {
              json(res, 413, { error: 'payload too large' });
              return;
            }
            chunks.push(b);
          }
        } catch {
          try { res.destroy(); } catch { /* noop */ }
          return;
        }
        bufferedBody = Buffer.concat(chunks);
      }
      const proxyOnce = async (kernelCookie: string | null, forceFreshCookie: boolean): Promise<void> => {
        const headers = proxyHeaders(req, upstream.origin);
        if (forceFreshCookie && typeof headers.cookie === 'string') {
          const kept = headers.cookie
            .split(/;\s*/)
            .filter((c) => c && !/^dsh-auth-[^=]+=/i.test(c))
            .join('; ');
          if (kept) headers.cookie = kept;
          else delete headers.cookie;
        }
        withKernelCookie(headers, kernelCookie);
        if (bufferedBody !== null) {
          // 体已重建（缓冲）：长度以缓冲为准并丢弃原 transfer-encoding，
          // 否则 chunked + content-length 双 framing 非法（HPE 拒收）。
          delete headers['transfer-encoding'];
          headers['content-length'] = String(bufferedBody.length);
        }
        const upstreamReq = http.request(
          {
            host: upstream.host,
            port: upstream.port,
            path: (req.url ?? '/'),
            method: req.method,
            headers,
          },
          (up: http.IncomingMessage) => {
          // 上游响应流中途出错（服务重启/连接重置）：三个分支都挂同一兜底，
          // 否则缓冲分支 end 永不触发（请求挂死 + 缓冲内存滞留）、pipe 分支
          // 半开连接悬挂。destroy res 连带清掉 gzip/缓冲链。
          up.on('error', () => { try { res.destroy(); } catch { /* noop */ } });
          // 响应已开始：撤销 120s 空闲超时。SSE/长流式响应的间隔可以超过
          // 120s（该文件契约就是 SSE/WS/静态资源原样透传），掐断会断流；
          // 客户端放弃有下方 res close 兜底销毁，不会悬挂。
          upstreamReq.setTimeout(0);
          // 401 重兑：仅在【本次请求实际发的是桥注入的缓存 cookie】时重试 ——
          // 手机自带 dsh-auth-* 优先透传是内核裁决语义（stale 时 401 原样
          // 透传给手机，由其重配对/清 cookie），不越权重写。桥缓存因内核
          // 重启轮换失效（forceFreshCookie=false 且未透传手机 cookie）才
          // 强制重兑一次并以新缓存重放。
          if (
            up.statusCode === 401 && !res.headersSent && !retried401 && kernelCookie &&
            !phoneCarriedAuthCookie
          ) {
            up.resume();
            retried401 = true;
            void (async () => {
              const fresh = await ensureKernelCookie(true);
              await proxyOnce(fresh, true);
            })().catch(() => { try { res.destroy(); } catch { /* noop */ } });
            return;
          }
          const contentType = String(up.headers['content-type'] ?? '');
          const wantsGzip = (req.headers['accept-encoding'] ?? '').includes('gzip');
          const isUnaryJson =
            req.method === 'POST' && pathName.startsWith('/api/') && contentType.includes('application/json');
          if (isUnaryJson && wantsGzip) {
            const headers = { ...up.headers };
            // 上游 chunked 头不能带着转发：重编码后由 Node 依 content-length
            // 自选 framing，保留会与显式 content-length 冲突（非法响应，
            // Node http client 直接 HPE_INVALID_CONTENT_LENGTH 拒收）。
            delete headers['content-length'];
            delete headers['content-encoding'];
            delete headers['transfer-encoding'];
            res.writeHead(up.statusCode ?? 200, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' });
            up.pipe(zlib.createGzip()).pipe(res);
          } else if (!isUnaryJson && contentType.includes('text/html') && up.headers['content-encoding'] === undefined) {
            // HTML 页面：注入 crypto.randomUUID polyfill（见 RANDOMUUID_POLYFILL 注释）。
            const chunks: Buffer[] = [];
            up.on('data', (chunk: Buffer) => chunks.push(chunk));
            up.on('end', () => {
              let body = Buffer.concat(chunks).toString('utf8');
              const headMatch = /<head[^>]*>/i.exec(body);
              const injectAt = headMatch ? (headMatch.index + headMatch[0].length) : 0;
              body = body.slice(0, injectAt) + RANDOMUUID_POLYFILL + body.slice(injectAt);
              const payload = Buffer.from(body, 'utf8');
              const headers = { ...up.headers };
              // 同上：体已重建（polyfill 注入）且显式声明 content-length，
              // 必须丢弃上游 transfer-encoding，否则双 framing 非法。
              delete headers['transfer-encoding'];
              headers['content-length'] = String(Buffer.byteLength(payload));
              res.writeHead(up.statusCode ?? 200, headers);
              res.end(payload);
            });
          } else {
            res.writeHead(up.statusCode ?? 200, up.headers);
            up.pipe(res);
          }
        },
        );
        upstreamReq.setTimeout(120_000, () => upstreamReq.destroy(new Error('proxy timeout')));
        upstreamReq.on('error', (error: Error) => {
          if (!res.headersSent) {
            json(res, 502, { error: `proxy failed: ${error.message}` });
          } else {
            res.destroy();
          }
        });
        // 手机端中途放弃（刷新/关页）：销毁上游连接，否则上游挂到 120s 超时、
        // 反复刷新堆积半开连接。res 未写完即 close = 客户端已走。
        res.on('close', () => {
          if (!res.writableEnded) upstreamReq.destroy();
        });
        // 体走缓冲（可无限次重放）；无体请求直接 end。
        if (bufferedBody !== null) upstreamReq.end(bufferedBody);
        else upstreamReq.end();
      };
      // 内核鉴权自兑（前置）：缓存缺失/内核重启轮换时先兑换 dsh-auth-* cookie。
      const kernelCookie = await ensureKernelCookie(false);
      await proxyOnce(kernelCookie, false);
    })().catch((error: unknown) => {
      try {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      } catch {
        res.destroy();
      }
    });
  }

  return {
    /** 启动 LAN 桥并轮换配对 token。幂等：已运行则返回当前状态。 */
    start(): Promise<{ url: string; port: number }> {
      if (server !== null) {
        const pending = pairing;
        // 幂等重入也轮换失效 token：过期/已决定的旧 pairing 再返回旧二维码，
        // 手机只会看到过期页。重开「连接手机」应拿到新 token。
        if (!pending || pending.decided !== null || Date.now() > pending.expiresAt) rotatePairing();
        return Promise.resolve({ url: lanUrl + '/pair?token=' + (pairing?.token ?? ''), port });
      }
      rotatePairing();
      return new Promise((resolve, reject) => {
        const s = http.createServer((req, res) => {
          void handle(req, res);
        });
        // WebSocket 升级透传（dsh 前端用 WS 连 events.mux/host）：需配对 cookie；
        // Host/Origin 同样改写，双向 pipe 不缓冲。
        s.on('upgrade', (req, socket, head) => {
          if (!hasPairedCookie(req)) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
            socket.destroy();
            return;
          }
          const upstream = upstreamOf();
          if (!upstream) {
            socket.destroy();
            return;
          }
          // WS 升级同样需要内核 dsh-auth-* cookie：缓存命中同步走；缺失时
          // 先兑换再升级（升级头必须在 http.request 发出前定稿，无法 401
          // 后重试 —— 兑换失败按无 cookie 尝试，上游 401 透传给手机）。
          void ensureKernelCookie(false)
            .catch(() => null)
            .then((kernelCookie) => {
              const upstreamReq = http.request({
                host: upstream.host,
                port: upstream.port,
                path: req.url,
                method: req.method,
                headers: (() => {
                  const h = {
                    ...proxyHeaders(req, upstream.origin),
                    connection: 'Upgrade',
                    upgrade: 'websocket',
                  };
                  withKernelCookie(h, kernelCookie);
                  return h;
                })(),
              });
          upstreamReq.on('upgrade', (upRes, upSocket, upHead) => {
            socket.write(
              `HTTP/1.1 101 Switching Protocols\r\n${
                Object.entries(upRes.headers)
                  .map(([key, value]) => `${key}: ${value}`)
                  .join('\r\n')
              }\r\n\r\n`,
            );
            // 上游 101 后已到达的初始数据必须写回【浏览器】方向（误写上游会丢帧断流）。
            if (upHead.length > 0) socket.write(upHead);
            liveWsSockets.add(socket as net.Socket);
            liveWsSockets.add(upSocket as net.Socket);
            // TCP keepalive：手机切网/休眠常无 FIN/RST（静默丢包），两端都不发
            // close 时 pipe/drop 永远不会触发。keepalive 探测（30s 空闲起探，
            // 对端死亡约数十秒内本端 close/error）→ drop() 销毁对端 —— 内核侧
            // WS 会话与桥两侧 socket 才能真正回收。
            (socket as net.Socket).setKeepAlive(true, 30_000);
            (upSocket as net.Socket).setKeepAlive(true, 30_000);
            const drop = (): void => {
              liveWsSockets.delete(socket as net.Socket);
              liveWsSockets.delete(upSocket as net.Socket);
              // 一端关闭必须销毁对端：手机断网/杀进程常无 FIN（RST/静默丢包，
              // 无 keepalive），pipe 只在收到 'end' 时才 end 对端 —— 不销毁则
              // 桥→内核 upSocket 半开悬挂，内核侧 WS 会话永不回收。
              try { (socket as net.Socket).destroy(); } catch { /* noop */ }
              try { (upSocket as net.Socket).destroy(); } catch { /* noop */ }
            };
            socket.on('close', drop);
            upSocket.on('close', drop);
            socket.pipe(upSocket).pipe(socket);
            socket.on('error', () => upSocket.destroy());
            upSocket.on('error', () => socket.destroy());
          });
          // 上游拒绝（如 426 Upgrade Required）：把状态码透传给浏览器并关闭。
          upstreamReq.on('response', (upRes) => {
            socket.write(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage ?? ''}\r\n\r\n`);
            socket.end();
            upRes.resume();
          });
          upstreamReq.on('error', () => socket.destroy());
          if (head.length > 0) upstreamReq.write(head);
          upstreamReq.end();
            });
        });
        s.on('error', (error) => reject(error));
        s.listen(0, '0.0.0.0', () => {
          const address = s.address();
          if (address === null || typeof address === 'string') {
            reject(new Error('phone bridge: failed to bind'));
            return;
          }
          server = s;
          port = address.port;
          lanUrl = `http://${lanAddress()}:${port}`;
          log(`phone bridge: listening on ${lanUrl} (pairing token TTL 5min, full-UI proxy)`);
          resolve({ url: `${lanUrl}/pair?token=${pairing?.token ?? ''}`, port });
        });
      });
    },
    /** 停止 LAN 桥并清空配对状态。 */
    stop(): Promise<void> {
      return new Promise((resolve) => {
        const s = server;
        server = null;
        port = 0;
        lanUrl = '';
        pairing = null;
        if (!s) {
          resolve();
          return;
        }
        // 断开全部 keep-alive 连接 + 显式销毁活跃 WS 代理 socket（升级后的
        // socket 脱离 http.Server 连接计数，close/closeAllConnections 不覆盖）。
        if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
        for (const sock of liveWsSockets) sock.destroy();
        liveWsSockets.clear();
        s.close(() => resolve());
      });
    },
    status(): PhoneStatus {
      return {
        running: server !== null,
        port,
        lanUrl,
        mobileReady,
        pairing: {
          state: currentPairingState(),
          expiresAt: pairing ? pairing.expiresAt : null,
        },
      };
    },
    /** 桌面端批准/拒绝一次待决配对（RPC 面，WS 桥本身回环）。 */
    decide(approved: boolean): { ok: boolean; error?: string; approved?: boolean } {
      if (pairing === null || pairing.decided !== null || Date.now() > pairing.expiresAt) {
        // BUG-B-011：过期配对不可再批准（同 /desktop/decide 的 TTL 闸门）。
        return { ok: false, error: 'no pending pairing' };
      }
      pairing.decided = approved === true;
      log(`phone bridge: pairing ${pairing.decided ? 'approved' : 'rejected'} via desktop RPC`);
      return { ok: true, approved: pairing.decided };
    },
    /** 桌面端断开：轮换会话密钥并清空决定，手机端既有 cookie 立即失效。 */
    disconnect(): { ok: boolean } {
      disconnectAll();
      log('phone bridge: disconnected via desktop RPC; session secret + pairing token rotated');
      return { ok: true };
    },
  };
}

export default createPhoneBridge;
