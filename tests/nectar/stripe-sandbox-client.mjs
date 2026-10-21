// Real Stripe test-mode transport. Errors expose only safe status/code fields.
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

export class SandboxFailure extends Error {
  constructor(code, status = null, param = null) { super(code); this.code = code; this.status = status; this.param=param }
}
export const check = (condition, code) => { if (!condition) throw new SandboxFailure(code) }
export const safeError = error => ({
  code: typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(error.code) ? error.code : 'sandbox_failure',
  status: Number.isInteger(error?.status) ? error.status : null,
  param: typeof error?.param==='string' && /^[A-Za-z0-9_\[\].]{1,100}$/.test(error.param) ? error.param : null,
})
export const reference = value => typeof value === 'string' ? value : value?.id ?? null
export const monthTime = index => Date.UTC(2025, index, 1) / 1000
export const monthName = index => new Date(monthTime(index) * 1000).toISOString().slice(0, 7)

export function stripeSandbox(secret) {
  check(typeof secret === 'string' && /^(?:sk|rk)_test_[A-Za-z0-9]+$/.test(secret), 'stripe_test_key_required')
  const run = randomUUID(), authorization = `Basic ${Buffer.from(`${secret}:`).toString('base64')}`
  const counts = { GET: 0, POST: 0, DELETE: 0 }
  let sequence = 0
  async function request(method, path, fields = {}, timeout = 20_000) {
    check(/^\/v1\/[A-Za-z0-9_/-]+$/.test(path), 'invalid_stripe_path')
    const params = new URLSearchParams()
    for (const [name, values] of Object.entries(fields)) for (const value of [values].flat()) if (value !== undefined && value !== null) params.append(name, String(value))
    counts[method]++
    let response
    try {
      response = await fetch(`https://api.stripe.com${path}${method === 'GET' && params.size ? `?${params}` : ''}`, {
        method, signal: AbortSignal.timeout(Math.max(1, timeout)),
        headers: { authorization, 'Stripe-Version': '2025-09-30.clover',
          ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `nectar-history-${run}-${++sequence}` } : {}) },
        ...(method === 'POST' ? { body: params } : {}),
      })
    } catch { throw new SandboxFailure('stripe_transport_failed') }
    let value
    try { value = await response.json() } catch { throw new SandboxFailure('stripe_invalid_json', response.status) }
    if (!response.ok) throw new SandboxFailure(safeError({ code: value?.error?.code ?? value?.error?.type }).code, response.status, value?.error?.param)
    check(value?.livemode !== true, 'stripe_live_object_refused')
    return value
  }
  async function list(path, fields = {}) {
    const data = [], seen = new Set()
    let cursor
    for (let page = 0; page < 100; page++) {
      const value = await request('GET', path, { ...fields, limit: 100, ...(cursor ? { starting_after: cursor } : {}) })
      check(value?.object === 'list' && Array.isArray(value.data) && typeof value.has_more === 'boolean', 'stripe_invalid_list')
      for (const row of value.data) {
        check(typeof row.id === 'string' && !seen.has(row.id) && row.livemode !== true, 'stripe_duplicate_or_live_object')
        seen.add(row.id); data.push(row)
      }
      if (!value.has_more) return { object: 'list', url: path, has_more: false, data }
      check(value.data.length > 0, 'stripe_empty_continuation')
      cursor = value.data.at(-1).id
    }
    throw new SandboxFailure('stripe_capture_page_limit')
  }
  /** Pass the real Worker's Stripe requests to the real test account unchanged.
   * The observer receives only non-secret protocol fields, never credentials. */
  async function forward(incoming, observe = () => {}) {
    const url = new URL(incoming.url), method = incoming.method
    check(url.origin === 'https://api.stripe.com' && url.pathname.startsWith('/v1/'), 'stripe_worker_origin_refused')
    check(incoming.headers.get('authorization') === `Bearer ${secret}`, 'stripe_worker_binding_mismatch')
    check(['GET','POST'].includes(method), 'stripe_worker_method_refused')
    const body = method === 'POST' ? await incoming.arrayBuffer() : undefined
    const fields = body ? new URLSearchParams(new TextDecoder().decode(body)) : new URLSearchParams(url.search)
    observe({ method, path: url.pathname, fields, idempotencyKey: incoming.headers.get('Idempotency-Key') })
    counts[method]++
    try {
      return await fetch(incoming.url, { method, headers: Object.fromEntries(incoming.headers), ...(body ? { body } : {}),
        redirect: 'error', signal: AbortSignal.timeout(20000) })
    } catch { throw new SandboxFailure('stripe_worker_transport_failed') }
  }
  async function advance(clock, target, label) {
    console.log(`Stripe history: advance ${label}`)
    const deadline = Date.now() + 60_000
    await request('POST', `/v1/test_helpers/test_clocks/${clock}/advance`, { frozen_time: target }, 15_000)
    let lastLog = Date.now()
    while (Date.now() < deadline) {
      const state = await request('GET', `/v1/test_helpers/test_clocks/${clock}`, {}, Math.min(15_000, deadline - Date.now()))
      check(state.status !== 'internal_failure', 'stripe_clock_internal_failure')
      if (state.status === 'ready') { check(state.frozen_time === target, 'stripe_clock_wrong_time'); return state }
      check(state.status === 'advancing', 'stripe_clock_unknown_status')
      if (Date.now() - lastLog >= 10_000) { console.log(`Stripe history: waiting ${label}`); lastLog = Date.now() }
      await delay(Math.min(1000, Math.max(1, deadline - Date.now())))
    }
    throw new SandboxFailure('stripe_clock_timeout')
  }
  return { run, counts, request, list, forward, advance, apiVersion: '2025-09-30.clover' }
}
