import test from 'node:test'
import assert from 'node:assert/strict'
import { createComputerTools } from '../assets/plugins/computer-user/src/tools.js'

// ---------------------------------------------------------------------------
// computer-user 5.1.1 手动批准流单测：
//   1) 优先弹官方批准问答（requestApproval → allowed-once 放行）
//   2) 拒绝 / 取消 / 服务不可用 时给出一致的错误标记
//   3) /computer 已批准会话直接放行
//   4) 只读工具在 manual 模式不要求批准
// ---------------------------------------------------------------------------

function makeTools({ mode = 'manual', approvedSessions, requestApproval } = {}) {
  const calls = []
  const runPs = async (script, payload) => {
    calls.push({ script, payload })
    return { ok: true, cursor: [1, 2] }
  }
  const getConfig = () => ({ mode, screenshot_dir: '', default_scale: 1, typing_interval_ms: 0, scroll_units: 120, debug: false })
  const tools = createComputerTools({ runPs, getConfig, approvedSessions, setMode: async () => {}, requestApproval })
  const byName = (name) => tools.find((t) => t.name === name)
  return { calls, byName, runPs }
}

function execFor(sid) {
  return {
    callId: 'call-1',
    arguments: { coordinate: [10, 20] },
    agent: { session: { header: { sessionId: sid } } },
    signal: new AbortController().signal,
  }
}

test('manual + approval 问答 allowed-once → 工具放行执行', async () => {
  const asks = []
  const t = makeTools({
    requestApproval: async (req) => { asks.push(req); return 'allowed-once' },
  })
  const res = await t.byName('computer_click').execute({ coordinate: [10, 20] }, execFor('s1'))
  assert.equal(res.clicked !== undefined, true)
  assert.equal(asks.length, 1)
  assert.equal(asks[0].toolName, 'computer_click')
  assert.equal(asks[0].callId, 'call-1')
  assert.match(asks[0].reason, /computer_click/)
  assert.ok(t.calls.some((c) => c.script === 'input.ps1'))
})

test('manual + approval 拒绝 → 抛 approvalRejected 且不执行', async () => {
  const t = makeTools({ requestApproval: async () => 'rejected' })
  await assert.rejects(
    () => t.byName('computer_click').execute({ coordinate: [10, 20] }, execFor('s1')),
    (err) => err.approvalRejected === true && /已拒绝/.test(err.message),
  )
  assert.equal(t.calls.length, 0)
})

test('manual + approval 取消 → 抛 approvalCancelled', async () => {
  const t = makeTools({ requestApproval: async () => 'cancelled' })
  await assert.rejects(
    () => t.byName('computer_click').execute({ coordinate: [10, 20] }, execFor('s1')),
    (err) => err.approvalCancelled === true,
  )
})

test('manual + 批准服务不可用（返回 unavailable 或未提供）→ 落回 /computer 指令路径', async () => {
  const cases = [
    makeTools({ requestApproval: async () => 'unavailable' }),
    makeTools({ requestApproval: undefined }),
  ]
  for (const t of cases) {
    await assert.rejects(
      () => t.byName('computer_click').execute({ coordinate: [10, 20] }, execFor('s1')),
      (err) => err.awaitingApproval === true && /\/computer/.test(err.message),
    )
    assert.equal(t.calls.length, 0)
  }
})

test('manual + /computer 已批准会话 → 直接放行（不再弹问答）', async () => {
  const asks = []
  const approvedSessions = new Set(['s1'])
  const t = makeTools({
    approvedSessions,
    requestApproval: async (req) => { asks.push(req); return 'allowed-once' },
  })
  await t.byName('computer_click').execute({ coordinate: [10, 20] }, execFor('s1'))
  assert.equal(asks.length, 0, '已批准会话不应再发批准请求')
  assert.ok(t.calls.some((c) => c.script === 'input.ps1'))
})

test('readonly 工具在 manual 模式不要求批准', async () => {
  const asks = []
  const t = makeTools({
    requestApproval: async (req) => { asks.push(req); return 'allowed-once' },
  })
  const res = await t.byName('computer_wait').execute({ ms: 1 }, execFor('s1'))
  assert.equal(res.waited, 1)
  assert.equal(asks.length, 0)
})

test('disabled 与 readonly 模式拒绝副作用工具', async () => {
  const disabled = makeTools({ mode: 'disabled' })
  await assert.rejects(() => disabled.byName('computer_click').execute({}, execFor('s1')), /已禁用/)
  const readonly = makeTools({ mode: 'readonly' })
  await assert.rejects(() => readonly.byName('computer_click').execute({}, execFor('s1')), /只读模式/)
  // 但截图类只读工具在 readonly 下放行
  await readonly.byName('computer_screenshot').execute({}, execFor('s1'))
  assert.ok(readonly.calls.some((c) => c.script === 'capture.ps1'))
})