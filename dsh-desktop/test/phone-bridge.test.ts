import test from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as https from 'node:https'
import { once } from 'node:events'
// 项目约定：测试 import 编译产物 .js（tsc 就地产物）。
import { createPhoneBridge } from '../../tauri-shell/sidecar/phone-bridge.js'

// ---------------------------------------------------------------------------
// 手机连接桥（5.1.1）回路测试：真实 LAN HTTP 服务 + 配对 → 批准 → cookie →
// 白名单 RPC 转发。手机端 UI 为占位页（接口契约保留）。
// 用 node:http 裸连接（agent:false）代替 fetch：undici 的 keep-alive 池会
// 让测试进程挂住不退出（test-runner 不传 --test-force-exit）。
// ---------------------------------------------------------------------------

interface HttpResponse { status: number; headers: http.IncomingHttpHeaders; body: any; raw: string }

function request(rawUrl: string, options: { method?: string; body?: unknown; cookie?: string } = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl)
    const client = url.protocol === 'https:' ? https : http
    const req = client.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method ?? 'GET',
        agent: false,
        headers: {
          ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(options.cookie ? { cookie: options.cookie } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let body: unknown = null
          try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, raw })
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    if (options.body !== undefined) req.write(JSON.stringify(options.body))
    req.end()
  })
}

function launch(kernel: http.Server | null) {
  const logs: string[] = []
  const bridge = createPhoneBridge({
    getWebUrl: () => (kernel ? `http://127.0.0.1:${(kernel.address() as { port: number }).port}` : null),
    log: (m) => logs.push(m),
  })
  return { bridge, logs }
}

test('phone bridge: start → 配对页/占位页/状态，错误 token 被拒', async () => {
  const { bridge } = launch(null)
  const info = await bridge.start()
  assert.equal(bridge.status().running, true)
  assert.match(info.url, /\/pair\?token=/)
  const token = new URL(info.url).searchParams.get('token') as string
  assert.ok(token.length >= 40, 'token 应为随机长串')

  const base = `http://127.0.0.1:${info.port}`
  // 占位页：手机端开发中
  const home = await request(base + '/')
  assert.equal(home.status, 200)
  assert.match(home.raw, /开发中/)

  // 正确 token → 配对等待页
  const pair = await request(base + '/pair?token=' + encodeURIComponent(token))
  assert.equal(pair.status, 200)
  assert.match(pair.raw, /配对/)

  // 错误 token → 403
  const bad = await request(base + '/pair?token=wrong')
  assert.equal(bad.status, 403)

  // 配对状态轮询：waiting
  const state = await request(base + '/api/pair-state?token=' + encodeURIComponent(token))
  assert.equal(state.body.state, 'waiting')

  await bridge.stop()
  assert.equal(bridge.status().running, false)
})

test('phone bridge: 桌面批准 → 状态 approved + 下发 cookie + 白名单 RPC 转发', async () => {
  // 模拟内核 /api/* 端点（agent:false 不发 keep-alive，close 立即返回）。
  const kernel = http.createServer((req, res) => {
    const body: Buffer[] = []
    req.on('data', (c) => body.push(c as Buffer))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify({ ok: true, method: req.url, forwarded: JSON.parse(Buffer.concat(body).toString('utf8') || '{}') }))
    })
  })
  kernel.listen(0, '127.0.0.1')
  await once(kernel, 'listening')

  try {
    const { bridge } = launch(kernel)
    const info = await bridge.start()
    const base = `http://127.0.0.1:${info.port}`
    const token = new URL(info.url).searchParams.get('token') as string

    // 批准前 /api/rpc 无 cookie → 401
    const unauth = await request(base + '/api/rpc', { method: 'POST', body: { method: 'session.list' } })
    assert.equal(unauth.status, 401)

    // 桌面批准（RPC 面）
    const decided = bridge.decide(true)
    assert.equal(decided.ok, true)
    assert.equal(decided.approved, true)

    // 配对状态 approved + Set-Cookie
    const poll = await request(base + '/api/pair-state?token=' + encodeURIComponent(token))
    assert.equal(poll.body.state, 'approved')
    const rawCookie = poll.headers['set-cookie']
    const setCookie = Array.isArray(rawCookie) ? rawCookie.join('; ') : (rawCookie ?? '')
    assert.match(setCookie, /dsh_mobile=1/)
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Strict/)

    // 白名单内方法 → 转发成功（桥把内核响应原样透传，不包 result 层）
    const ok = await request(base + '/api/rpc', { method: 'POST', body: { method: 'session.list', params: { a: 1 } }, cookie: 'dsh_mobile=1' })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.ok, true)
    assert.equal(ok.body.method, '/api/session.list')

    // 白名单外方法 → 400
    const denied = await request(base + '/api/rpc', { method: 'POST', body: { method: 'fs.read', params: {} }, cookie: 'dsh_mobile=1' })
    assert.equal(denied.status, 400)

    // disconnect RPC → token 轮换，旧 token 失效
    const disc = bridge.disconnect()
    assert.equal(disc.ok, true)
    const oldToken = await request(base + '/api/pair-state?token=' + encodeURIComponent(token))
    assert.equal(oldToken.status, 403)

    await bridge.stop()
  } finally {
    kernel.close()
  }
})

test('phone bridge: 服务未就绪时 RPC 转发返回 503', async () => {
  const { bridge } = launch(null)
  const info = await bridge.start()
  const base = `http://127.0.0.1:${info.port}`
  bridge.decide(true)
  const res = await request(base + '/api/rpc', { method: 'POST', body: { method: 'session.list' }, cookie: 'dsh_mobile=1' })
  assert.equal(res.status, 503)
  await bridge.stop()
})

test('phone bridge: /desktop/decide HTTP 面与状态一致', async () => {
  const { bridge } = launch(null)
  const info = await bridge.start()
  const base = `http://127.0.0.1:${info.port}`
  const r = await request(base + '/desktop/decide', { method: 'POST', body: { approved: true } })
  assert.equal(r.status, 200)
  assert.equal(bridge.status().pairing.state, 'approved')
  // 重复 decide → 409
  const again = await request(base + '/desktop/decide', { method: 'POST', body: { approved: true } })
  assert.equal(again.status, 409)
  await bridge.stop()
})