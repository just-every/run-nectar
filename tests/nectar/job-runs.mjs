// One operational journey through real scheduled HTTP, Worker, D1 and sessions.
// Only the processor edge and audit-storage fault are substituted.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeCollectionEdge } from './native-collection.mjs'
import { totp } from './mfa.mjs'
import { file } from './harness.mjs'

let edge, gate, persistence, refuseReads
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
export function harnessOptions() {
  edge = nativeCollectionEdge()
  refuseReads = false
  persistence = mkdtempSync(join(tmpdir(), 'nectar-job-runs-'))
  return {
    persistence, localTime: '2026-10-22T10:00:00Z',
    stripeSecret: 'synthetic-nectar-1', stripeSecondarySecret: 'synthetic-nectar-2',
    stripeFetch: async request => {
      const path = new URL(request.url).pathname
      if (refuseReads && path.startsWith('/v1/payment_intents')) return Response.json({ error: { message: 'Synthetic private provider detail' } }, { status: 503 })
      if (gate?.mode === 'reconcile' && path === '/v1/payment_intents/search') {
        const active = gate, search = ++active.searches
        if (search === 2) active.bothSearching.resolve()
        await active.bothSearching.promise
        if (search === 2) await active.allowSecond.promise
      }
      if (gate?.mode === 'reconcile' && path === '/v1/charges') {
        const active = gate
        active.entered.resolve()
        await active.release.promise
      }
      if (gate && path.startsWith('/v1/payment_methods/')) {
        const active = gate
        active.reads++
        if (active.reads === 1 || active.mode === 'before') {
          if (active.reads === 2) active.entered.resolve()
          await active.release.promise
        }
      }
      const response = await edge.fetch(request)
      if (gate?.mode === 'after' && path === '/v1/payment_intents' && request.method === 'POST') {
        const active = gate
        active.entered.resolve()
        await active.release.promise
      }
      return response
    },
  }
}

export async function jobRunsFlow(h, owner) {
  const close = h.close
  h.close = async () => { try { await close() } finally { await rm(persistence, { recursive: true, force: true }) } }
  const api = (path, body, status) => h.api(path, owner, body, status)
  const read = async () => (await api('job-runs')).runs
  let instant = Date.parse('2026-10-22T10:00:00Z')
  const tick = (cron = '* * * * *') => h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent(cron)}`)
  const writes = () => edge.calls.filter(call => call.method === 'POST' && call.path === '/payment_intents').length
  await api('business.configure', { ...await api('business'), timezone: 'UTC' })
  const factor = await api('mfa.totp.start', {})
  await api('mfa.totp.confirm', { factor: factor.factor, code: totp(factor.secret, instant) })
  await api('portal.configure', { hosts: [h.origin], parents: [] })
  const agent = { bearer: (await api('credential.issue', { name: 'Synthetic operational reader', scopes: ['prepare'] })).key }
  const email = `synthetic-nectar-operations-1${h.vars.OWNER_EMAIL.slice(h.vars.OWNER_EMAIL.indexOf('@'))}`
  await api('access.give', { email, name: 'Synthetic finance reader', role: 'finance' })
  const finance = await h.signIn(email, { requested: true })
  const financeFactor = await h.api('mfa.totp.start', finance, {})
  await h.api('mfa.totp.confirm', finance, { factor: financeFactor.factor, code: totp(financeFactor.secret, instant) })
  assert.equal((await h.raw('/api/nectar/job-runs')).status, 401)
  await h.api('job-runs', finance, undefined, 403)
  await h.api('job-runs', agent, undefined, 403)
  await api('credential.revoke', { key: (await api('credentials')).find(row => row.name === 'Synthetic operational reader').id })
  await h.api('job-runs', agent, undefined, 401)
  assert.deepEqual(await read(), [])

  // The default-off real jobs run, but observation activates no financial work.
  const before = JSON.stringify([await api('runs'), await api('payments'), await api('audit'), h.mails.length])
  assert.equal((await tick()).status, 200)
  let [first] = await read()
  assert.equal(first.status, 'completed')
  assert.deepEqual(first.jobs.map(job => job.job), ['subscription-states-before', 'webhooks', 'payment-link-expiry', 'automatic-collections', 'payment-retries', 'invoice-automation', 'subscription-states-after-invoices'])
  assert.ok(first.jobs.every(job => job.status === 'completed' && job.started_at === instant && job.finished_at === instant && job.error_code === null))
  assert.equal(first.cron, '* * * * *'); assert.equal(first.scheduled_at, instant)
  assert.equal(JSON.stringify([await api('runs'), await api('payments'), await api('audit'), h.mails.length]), before)
  assert.equal(writes(), 0)

  // A real job's refused audit fails the dispatcher, leaving its downstream
  // jobs visibly unstarted; a subsequent ordinary tick recovers.
  await h.rejectAudit('assurance.run.start')
  try {
    assert.equal((await tick('0 14 * * *')).status, 500)
    const [failed] = await read(), assurance = failed.jobs.find(job => job.job === 'assurance')
    assert.equal(failed.status, 'failed'); assert.equal(failed.error_code, 'storage_failure')
    assert.equal(assurance.status, 'failed'); assert.equal(assurance.error_code, 'storage_failure')
    assert.deepEqual(failed.jobs.at(-1), { ordinal: 22, job: 'subscription-states-final', status: 'not_started', started_at: null, finished_at: null, error_code: null })
    assert.deepEqual(await api('assurance-runs'), [])
  } finally { await h.rejectAudit() }
  assert.equal((await tick('0 14 * * *')).status, 200)
  assert.equal((await read())[0].jobs.length, 23)
  assert.equal((await api('assurance-runs'))[0].status, 'completed')

  await h.rejectAudit('assurance.scan')
  try {
    assert.equal((await tick('0 14 * * *')).status, 200, 'handled failure preserves existing continuation')
    const [reported] = await read()
    assert.equal(reported.status, 'failed'); assert.equal(reported.error_code, 'job_reported_failure')
    assert.equal(reported.jobs.find(job => job.job === 'assurance').status, 'failed')
    assert.equal(reported.jobs.at(-1).status, 'completed')
  } finally { await h.rejectAudit() }

  const customer = (await api('customer.create', { external_id: 'synthetic-nectar-operations-1', name: 'Synthetic private customer', billing_email: email })).id
  await api('collection.customer.bind', { customer, account_ref: 'synthetic-nectar-native-account-1', stripe_customer_ref: 'synthetic-nectar-native-customer-1', confirm: true })
  const prepare = async suffix => {
    edge.capturedAt(new Date(instant).toISOString())
    const day = new Date(instant).toISOString().slice(0, 10)
    const charge = await api('charge.add', { customer, amount: '100', description: `Synthetic private service ${suffix}`, effective_date: day, taxable: false })
    const invoice = (await api('invoice.manual', { customer, charges: [charge.charge], service_date: day })).id
    const request = await api('automatic.collection.prepare', { invoice, issue_date: day })
    const session = await api('portal.session.issue', { customer, origin: h.origin, audience: 'hosted' })
    assert.equal((await h.raw(`/portal/automatic-collections/${request.id}?session=${encodeURIComponent(session.token)}`, { body: { request: request.id, basis_hash: request.basis, accept: true } })).status, 200)
    await h.api('automatic.collection.decide', finance, { request: request.id, basis_hash: request.basis, decision: 'approved', confirm: true })
    await api('invoice.approve', { invoice, acknowledge: true })
    return { invoice, request, day }
  }
  const settled = []
  for (const mode of ['before', 'after']) {
    const { invoice, request, day } = await prepare(mode), count = writes()
    gate = { mode, reads: 0, entered: deferred(), release: deferred() }
    const active = gate
    // Issuance commits first, then waits at its existing processor read.
    const issuing = api('invoice.finalise', { invoice, issue_date: day }).catch(() => null)
    // Observe committed issuance through its public door before invoking cron.
    for (let attempts = 0; ; attempts++) {
      if ((await api(`invoices/${invoice}`)).status === 'issued') break
      assert.ok(attempts < 100, 'ordinary issue reaches its committed state')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const scheduled = tick().catch(() => null)
    await Promise.race([active.entered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('collection edge did not pause')), 15000))])
    const [running] = await read()
    assert.equal(running.status, 'running')
    assert.equal(running.jobs.find(job => job.job === 'automatic-collections').status, 'running')
    assert.ok(running.jobs.slice(4).every(job => job.status === 'not_started'))
    const collection = (await api('automatic-collections')).find(row => row.id === request.id)
    assert.equal(collection.status, mode === 'before' ? 'active' : 'claimed')
    assert.equal(writes(), count + (mode === 'after' ? 1 : 0))
    assert.equal((await api(`invoices/${invoice}`)).paidCents, 0)

    // Kill and recreate the actual workerd runtime, retaining only durable D1
    // and installation settings; no test writes execution or financial rows.
    instant += 31 * 60_000
    const restarting = h.restart(new Date(instant).toISOString())
    await restarting
    gate = null
    active.release.resolve()
    await Promise.all([issuing, scheduled])
    edge.capturedAt(new Date(instant).toISOString())
    assert.equal((await tick()).status, 200)
    const history = await read(), interrupted = history.find(row => row.id === running.id)
    assert.equal(interrupted.status, 'interrupted')
    assert.equal(interrupted.error_code, 'execution_lease_expired')
    assert.equal(interrupted.jobs.find(job => job.job === 'automatic-collections').status, 'interrupted')
    assert.ok(interrupted.jobs.slice(4).every(job => job.status === 'not_started'))
    assert.equal(writes(), count + 1, 'restart never replaces an existing collection claim')
    const paid = await api(`invoices/${invoice}`)
    assert.equal(paid.paidCents, 10000); assert.equal(paid.balanceCents, 0)
    assert.equal(paid.allocations.length, 1)
    settled.push(invoice)
    await api('mfa.verify', { code: totp(factor.secret, instant) })
    await h.api('mfa.verify', finance, { code: totp(financeFactor.secret, instant) })
  }

  // A lost provider response is handled by the shipped collection job: its
  // execution can return normally while the source records an uncertain item.
  const uncertain = await prepare('provider-failure')
  edge.losePayment()
  await api('invoice.finalise', { invoice: uncertain.invoice, issue_date: uncertain.day })
  assert.equal((await api('automatic-collections')).find(row => row.id === uncertain.request.id).status, 'uncertain')
  const count = writes()
  refuseReads = true
  try {
    assert.equal((await tick()).status, 200)
    assert.equal((await api('automatic-collections')).find(row => row.id === uncertain.request.id).status, 'uncertain')
    assert.equal((await api(`invoices/${uncertain.invoice}`)).paidCents, 0)
    assert.equal(writes(), count, 'processor outage cannot authorize a replacement payment')
  } finally { refuseReads = false }
  // Both ticks read the same uncertain revision. The first pauses while
  // validating captured cash; the second loses the intent-binding guard.
  gate = { mode: 'reconcile', searches: 0, bothSearching: deferred(), allowSecond: deferred(), entered: deferred(), release: deferred() }
  const reconciling = gate, pending = [tick(), tick()]
  try {
    await Promise.race([reconciling.entered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('reconciliation edge did not pause')), 15000))])
    reconciling.allowSecond.resolve()
    await Promise.race(pending)
  } finally {
    gate = null
    reconciling.allowSecond.resolve()
    reconciling.release.resolve()
  }
  const concurrent = await Promise.all(pending)
  for (const response of concurrent) assert.equal(response.status, 200)
  assert.equal(writes(), count, 'concurrent reconciliation sends only provider reads')
  settled.push(uncertain.invoice)
  const history = await read()
  assert.notEqual(history[0].id, history[1].id, 'concurrent ticks retain distinct identities')
  assert.ok(history.slice(0, 2).every(row => row.status === 'completed'))
  const payments = await api('payments'), audit = await api('audit')
  assert.equal(edge.intents.size, 3); assert.equal(edge.charges.size, 3)
  assert.equal(payments.length, 3, JSON.stringify((await api('automatic-collections')).map(row => ({status: row.status, errorCode: row.errorCode}))))
  assert.equal(payments.reduce((sum, payment) => sum + payment.amount_cents, 0), 30000)
  for (const invoice of settled) {
    const paid = await api(`invoices/${invoice}`), collection = (await api('automatic-collections')).find(row => row.invoice === invoice)
    assert.equal(paid.total_cents, 10000); assert.equal(paid.paidCents, 10000); assert.equal(paid.allocations.length, 1)
    assert.equal(audit.filter(event => event.action === 'automatic.collection.claim' && event.subject === collection.id).length, 1)
    assert.equal(audit.filter(event => event.action === 'automatic.collection.collected' && event.subject === collection.id).length, 1)
    assert.equal(payments.filter(payment => payment.id === collection.payment).length, 1)
  }
  const operational = JSON.stringify(await api('job-runs'))
  for (const value of [email, customer, 'Synthetic private', 'synthetic-nectar-1', factor.secret, h.vars.SESSION_SECRET, 'synthetic-nectar-native-intent'])
    assert.ok(!operational.includes(value), 'operational metadata excludes private payloads and credentials')
  await h.api('job-runs', agent, undefined, 401)
  const erasure = await api('erasure.request', { customer })
  await api('erasure.verify', { request: erasure.id, reason: 'Synthetic independent identity verification', evidence: file('identity.txt', 'Synthetic verification evidence', 'text/plain') })
  await api('erasure.approve', { request: erasure.id, confirm: true })
  assert.equal(JSON.stringify(await api('job-runs')), operational, 'erasure has no customer payload to resurrect from observations')
  assert.equal((await tick()).status, 200)
  assert.equal(writes(), count, 'a future tick cannot collect an erased source')
  assert.equal((await api('payments')).reduce((sum, payment) => sum + payment.amount_cents, 0), 30000)
  await api('job-runs', {}, 404)
  console.log('jobRunsFlow: durable dispatch, real restart before and after collection claim, sanitized failures, concurrent once-only recovery and owner-only metadata passed')
}
