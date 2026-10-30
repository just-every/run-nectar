import assert from 'node:assert/strict'
import { publishPrice } from './price-helper.mjs'
import { totp } from './mfa.mjs'

// Only Stripe is faked. Local sandbox records, clocks, invoice calculations,
// claims, audit and authorization use the actual Worker and D1.
export function testModeProcessorEdge() {
  const customers = new Map(), looseMethods = new Map(), intents = new Map(), charges = [], writes = []
  let live = false, account = 'synthetic-nectar-sandbox-account', lost = false, succeeds = false, beforeConfirmation = false
  const provision = async (customer, catalog) => {
    const id = `synthetic-nectar-sandbox-provider-${customers.size + 1}`, method = `${id}-method`
    customers.set(id, { object: 'customer', id, livemode: false, metadata: { nectar_sandbox_customer: customer, nectar_sandbox_catalog: catalog }, invoice_settings: { default_payment_method: method } })
    return id
  }
  const fetch = async request => {
    assert.equal(request.headers.get('authorization'), 'Bearer synthetic-nectar-sandbox-secret')
    const url = new URL(request.url), path = url.pathname.slice(3)
    if (request.method === 'GET' && path === '/balance') return Response.json({ object: 'balance', livemode: live })
    if (request.method === 'GET' && path === '/account') return Response.json({ object: 'account', id: account })
    if (request.method === 'GET' && path.startsWith('/customers/')) return Response.json(customers.get(path.split('/').at(-1)) ?? {}, { status: customers.has(path.split('/').at(-1)) ? 200 : 404 })
    if (request.method === 'GET' && path.startsWith('/payment_methods/')) {
      const id = path.split('/').at(-1), customer = [...customers.values()].find(c => c.invoice_settings.default_payment_method === id)
      if (looseMethods.has(id)) return Response.json(looseMethods.get(id))
      return Response.json({ object: 'payment_method', id, customer: customer?.id, type: 'card', livemode: false, card: { brand: 'visa', last4: '9995', exp_month: 12, exp_year: 2035 } })
    }
    if (request.method === 'GET' && path === '/payment_intents') return Response.json({ object: 'list', has_more: false, data: [...intents.values()].filter(i => i.customer === url.searchParams.get('customer')) })
    if (request.method === 'GET' && path.startsWith('/payment_intents/')) return Response.json(intents.get(path.split('/').at(-1)))
    if (request.method === 'GET' && path === '/charges') return Response.json({ object: 'list', has_more: false, data: charges.filter(c => c.payment_intent === url.searchParams.get('payment_intent')) })
    assert.equal(request.method, 'POST')
    assert.ok(path === '/payment_intents' || /^\/payment_intents\/[^/]+\/confirm$/.test(path), 'The sandbox never writes a live catalog, subscription, invoice or mail provider')
    const form = new URLSearchParams(await request.text()), key = request.headers.get('idempotency-key')
    assert.ok(key && !writes.some(w => w.key === key), 'Each durable test claim makes one provider write')
    assert.equal(form.get('receipt_email'), null)
    const prior = path.endsWith('/confirm') ? intents.get(path.split('/')[2]) : null
    const customer = customers.get(prior?.customer ?? form.get('customer'))
    assert.ok(customer)
    const loose = looseMethods.get(form.get('payment_method'))
    if (loose) assert.equal(loose.metadata.nectar_sandbox_customer, customer.metadata.nectar_sandbox_customer)
    else assert.equal(form.get('payment_method'), customer.invoice_settings.default_payment_method)
    if (prior) for (const field of ['amount', 'currency', 'customer']) assert.equal(form.get(field), null, 'A retry preserves the original test intent economics')
    writes.push({ key, path, ...Object.fromEntries(form) })
    if (prior && loose) return Response.json({ error: { code: 'payment_method_unexpected_state' } }, { status: 400 })
    if (prior && beforeConfirmation) { beforeConfirmation = false; return new Response('', { status: 503 }) }
    const id = prior?.id ?? `synthetic-nectar-sandbox-intent-${writes.length}`, amount = prior?.amount ?? Number(form.get('amount'))
    const intent = { object: 'payment_intent', id, customer: customer.id, currency: 'usd', amount, amount_received: succeeds ? amount : 0,
      status: succeeds ? 'succeeded' : 'requires_payment_method', livemode: false, payment_method: succeeds ? form.get('payment_method') : null,
      metadata: prior?.metadata ?? { nectar_sandbox_attempt: form.get('metadata[nectar_sandbox_attempt]'), nectar_sandbox_invoice: form.get('metadata[nectar_sandbox_invoice]') },
      ...(!succeeds ? { last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds', payment_method: { id: form.get('payment_method') } } } : {}) }
    intents.set(id, intent)
    charges.push({ object: 'charge', id: `synthetic-nectar-sandbox-charge-${writes.length}`, payment_intent: id, customer: customer.id, amount, currency: 'usd', livemode: false,
      status: succeeds ? 'succeeded' : 'failed', paid: succeeds, captured: succeeds, amount_captured: succeeds ? amount : 0 })
    if (lost) { lost = false; return new Response('', { status: 503 }) }
    return succeeds ? Response.json(intent) : Response.json({ error: { payment_intent: intent } }, { status: 402 })
  }
  return { fetch, provision, customers, looseMethods, intents, writes,
    async provisionLoose(customer, catalog) {
      const remote = await provision(customer, catalog), id = `${remote}-standalone-card`
      looseMethods.set(id, { object: 'payment_method', id, type: 'card', livemode: false, customer: null, metadata: { nectar_sandbox_customer: customer, nectar_sandbox_catalog: catalog } })
      return { customer: remote, method: id }
    },
    live(value) { live = value }, account(value) { account = value }, lose() { lost = true }, loseConfirmation() { beforeConfirmation = true }, succeed(value) { succeeds = value } }
}

export const sandboxProcessor = testModeProcessorEdge()
export const harnessOptions = () => ({ localTime: '2026-10-01T12:00:00Z', stripeFetch: sandboxProcessor.fetch, stripeSecret: 'synthetic-nectar-sandbox-secret' })

export async function testModeBillingFlow(h, owner, { provision = sandboxProcessor.provision, edge = sandboxProcessor, onState = async () => {}, bindProcessor, attemptsPerInvoice = 3, declineCode = 'insufficient_funds' } = {}) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const factor = await api('mfa.totp.start', {})
  await api('mfa.totp.confirm', { factor: factor.factor, code: totp(factor.secret, Date.parse(h.vars.NECTAR_LOCAL_TIME)) })
  await api('retry.policy.configure', { max_attempts: 3, window_days: 14, confirm: true })
  const product = (await api('product.create', { code: 'synthetic-nectar-820', name: 'Synthetic sandbox annual' })).id
  const price = (await publishPrice(h, owner, { product, kind: 'flat', unit_amount: '12', taxable: false, billing_interval: 'annual', billing_timing: 'advance' })).id
  await api('tax.review', { revision: (await api('business')).revision })
  const source = (await api('sandbox')).source
  const copied = await api('sandbox.catalog.copy', { source_fingerprint: source.sourceFingerprint, confirm: true })
  const catalog = (await api('sandbox')).catalogs.find(c => c.id === copied.id), copiedPrice = catalog.prices.find(p => p.sourceId === price).id
  const fields = { catalog: catalog.id, label: 'Synthetic sandbox annual billing', clock: '2027-01-01T08:00:00Z', trial_end: '2027-02-01', price: [copiedPrice], quantity: ['1'] }
  const c = await api('sandbox.customer.create', fields), idle = await api('sandbox.customer.create', { ...fields, label: 'Synthetic independent sandbox' })
  const read = id => api(`sandbox/customers/${id}`), idleBefore = await read(idle.id)
  const provisioned = await provision(c.id, catalog.id), remote = typeof provisioned === 'string' ? provisioned : provisioned.customer
  const methodField = typeof provisioned === 'string' ? {} : { test_method_ref: provisioned.method }
  if (edge) {
    const original = edge.customers.get(remote)
    original.metadata.nectar_sandbox_customer = idle.id
    await api('sandbox.processor.bind', { customer: c.id, stripe_customer_ref: remote, ...methodField, confirm: true }, 409)
    original.metadata.nectar_sandbox_customer = c.id
    edge.live(true)
    await api('sandbox.processor.bind', { customer: c.id, stripe_customer_ref: remote, ...methodField, confirm: true }, 409)
    edge.live(false)
  }
  await api('sandbox.processor.bind', { customer: c.id, stripe_customer_ref: remote, ...methodField, confirm: false }, 400)
  await h.rejectAudit('sandbox.processor.bind')
  await api('sandbox.processor.bind', { customer: c.id, stripe_customer_ref: remote, ...methodField, confirm: true }, 500)
  await h.rejectAudit()
  assert.equal((await read(c.id)).billing.enabled, false)
  const developerAddress = ['synthetic-nectar-822', 'example.test'].join(String.fromCharCode(64))
  await api('access.give', { email: developerAddress, name: 'Synthetic sandbox developer', role: 'developer' })
  const developer = await h.signIn(developerAddress, { requested: true })
  const bindFields = { customer: c.id, stripe_customer_ref: remote, ...methodField, confirm: true }
  if (bindProcessor) await bindProcessor(bindFields, developer)
  else await h.api('sandbox.processor.bind', developer, bindFields)
  for (const action of ['collection.customer.bind', 'collection.prepare', 'collection.confirm', 'invoice.finalise']) await h.api(action, developer, {}, 403)
  await api('sandbox.processor.bind', { customer: idle.id, stripe_customer_ref: remote, confirm: true }, 409)
  const liveCustomer = (await api('customer.create', { external_id: 'synthetic-nectar-821', name: 'Synthetic live isolation', billing_email: ['synthetic-nectar-821', 'example.test'].join(String.fromCharCode(64)) })).id
  const liveSubscription = (await api('subscription.create', { customer: liveCustomer, start_date: '2026-10-01', trial_end: '2026-10-10', price: [price], quantity: ['1'] })).id
  if (edge) {
    const before = await api(`customers/${liveCustomer}`)
    await api('collection.customer.bind', { customer: liveCustomer, account_ref: 'synthetic-nectar-sandbox-account', stripe_customer_ref: remote, confirm: true }, 409)
    assert.deepEqual(await api(`customers/${liveCustomer}`), before, 'A refused identifier crossover changes no live customer record')
  }
  const live = async () => Promise.all(['business', 'catalog', 'customers', `subscriptions/${liveSubscription}?include_state=true`, 'invoices', 'payments', 'runs', 'notices'].map(path => api(path)))
  const unchanged = await live(), beforeMail = h.mails.length
  const advanced = await api('sandbox.clock.advance', { customer: c.id, revision: 1, clock: '2028-02-01T08:00:00Z', confirm: true })
  assert.equal(advanced.execution.status, 'complete')
  const state = await read(c.id)
  assert.equal(state.billing.invoices.length, 2)
  const invoices = state.billing.invoices
  // Calendar and cents are independent of the engine's returned operands.
  const first = Number((1200n * 334n + 365n / 2n) / 365n)
  assert.deepEqual(invoices.map(i => i.invoice.rating.totalCents), [first, 1200])
  assert.deepEqual(invoices.map(i => i.invoice.period), [{ start: '2027-02-01', end: '2028-01-01' }, { start: '2028-01-01', end: '2029-01-01' }])
  assert.ok(invoices.every(i => i.status === 'unpaid'))
  assert.equal(state.billing.attempts.length, attemptsPerInvoice * 2)
  assert.equal(new Set(state.billing.attempts.map(a => a.intent_ref)).size, 2, 'Every invoice keeps its one original test intent through retries')
  const expectedDates = attemptsPerInvoice === 3 ? ['2027-02-01', '2027-02-04', '2027-02-07', '2028-01-01', '2028-01-04', '2028-01-07'] : ['2027-02-01', '2028-01-01']
  assert.deepEqual(state.billing.attempts.map(a => new Date(a.due_at).toISOString().slice(0, 10)), expectedDates)
  assert.ok(state.billing.attempts.every(a => a.status === 'declined' && a.result.declineCode === declineCode && a.result.receivedCents === 0))
  assert.equal(state.billing.timeline.filter(e => e.kind === 'invoice_issued').length, 2)
  assert.equal(state.billing.timeline.filter(e => e.kind === 'renewed').length, 1)
  assert.equal(state.billing.timeline.filter(e => e.kind === 'failure_notice_preview').length, attemptsPerInvoice * 2)
  assert.ok(state.billing.timeline.filter(e => e.kind === 'failure_notice_preview').every(e => e.detail.delivered === false))
  const expectedStates = attemptsPerInvoice === 3 ? ['trialing', 'active', 'past_due', 'past_due', 'unpaid', 'past_due', 'past_due', 'unpaid'] : ['trialing', 'active', 'unpaid', 'unpaid']
  assert.deepEqual(state.billing.timeline.filter(e => ['trialing', 'active', 'past_due', 'unpaid'].includes(e.kind)).map(e => e.kind), expectedStates)
  assert.deepEqual(await read(idle.id), idleBefore)
  await api('sandbox.clock.advance', { customer: c.id, revision: 1, clock: '2028-02-01T08:00:00Z', confirm: true }, 409)
  assert.deepEqual((await read(c.id)).billing, state.billing, 'Replay neither reissues test invoices nor sends another test debit')
  assert.deepEqual(await live(), unchanged, 'Test billing has no live ledger, catalog, customer or production-clock effect')
  assert.equal((await api(`subscriptions/${liveSubscription}?include_state=true`)).state, 'trialing')
  assert.equal(h.mails.length, beforeMail, 'Sandbox notice previews never send external mail')
  await onState({ label: 'sandbox-annual-failures', path: `/app/settings/test-mode/${c.id}`, owner })

  if (edge) {
    // A lost response is an unknown outcome, never a reason for another write.
    const lost = await api('sandbox.customer.create', fields), lostRemote = await provision(lost.id, catalog.id)
    await api('sandbox.processor.bind', { customer: lost.id, stripe_customer_ref: lostRemote, confirm: true })
    edge.lose()
    const count = edge.writes.length
    const unknown = await api('sandbox.clock.advance', { customer: lost.id, revision: 1, clock: '2027-02-02T08:00:00Z', confirm: true })
    assert.equal(unknown.execution.status, 'unconfirmed')
    await api('sandbox.clock.advance', { customer: lost.id, revision: 2, clock: '2027-02-03T08:00:00Z', confirm: true })
    assert.equal(edge.writes.length, count + 1)
    await api('sandbox.billing.reconcile', { customer: lost.id, confirm: true })
    assert.equal(edge.writes.length, count + 1, 'Reconciliation performs reads only')
    await api('sandbox.clock.advance', { customer: lost.id, revision: 3, clock: '2027-02-10T08:00:00Z', confirm: true })
    assert.equal(edge.writes.length, count + 3)
    const interrupted = await api('sandbox.customer.create', fields), interruptedRemote = await provision(interrupted.id, catalog.id)
    await api('sandbox.processor.bind', { customer: interrupted.id, stripe_customer_ref: interruptedRemote, confirm: true })
    await api('sandbox.clock.advance', { customer: interrupted.id, revision: 1, clock: '2027-02-02T08:00:00Z', confirm: true })
    edge.loseConfirmation()
    await api('sandbox.clock.advance', { customer: interrupted.id, revision: 2, clock: '2027-02-05T08:00:00Z', confirm: true })
    assert.equal((await api('sandbox.billing.reconcile', { customer: interrupted.id, confirm: true })).status, 'unconfirmed')
    const interruptedState = await read(interrupted.id)
    assert.deepEqual(interruptedState.billing.attempts.map(a => a.status), ['declined', 'unconfirmed'], 'The old intent error never becomes a second fabricated failure')
    assert.equal(interruptedState.billing.timeline.filter(e => e.kind === 'payment_failed').length, 1)
    await onState({ label: 'sandbox-unconfirmed', path: `/app/settings/test-mode/${interrupted.id}`, owner })
    const loose = await api('sandbox.customer.create', fields), looseRemote = await edge.provisionLoose(loose.id, catalog.id)
    const looseCard = edge.looseMethods.get(looseRemote.method)
    looseCard.metadata.nectar_sandbox_customer = c.id
    const looseFields = { customer: loose.id, stripe_customer_ref: looseRemote.customer, test_method_ref: looseRemote.method, confirm: true }
    await api('sandbox.processor.bind', looseFields, 409)
    looseCard.metadata.nectar_sandbox_customer = loose.id
    await api('sandbox.processor.bind', looseFields)
    await api('sandbox.clock.advance', { customer: loose.id, revision: 1, clock: '2027-02-05T08:00:00Z', confirm: true })
    assert.equal((await api('sandbox.billing.reconcile', { customer: loose.id, confirm: true })).status, 'unconfirmed')
    assert.deepEqual((await read(loose.id)).billing.attempts.map(a => a.status), ['declined', 'unconfirmed'], 'A single-use provider fixture does not fabricate a repeated charge')
    // A test capture and its receipt are also served, without live allocation.
    const paid = await api('sandbox.customer.create', fields), paidRemote = await provision(paid.id, catalog.id)
    await api('sandbox.processor.bind', { customer: paid.id, stripe_customer_ref: paidRemote, confirm: true })
    edge.succeed(true)
    await api('sandbox.clock.advance', { customer: paid.id, revision: 1, clock: '2027-02-02T08:00:00Z', confirm: true })
    edge.succeed(false)
    const captured = await read(paid.id)
    assert.equal(captured.billing.invoices[0].status, 'paid')
    assert.equal(captured.billing.attempts.length, 1)
    assert.equal(captured.billing.attempts[0].result.receivedCents, first)
    assert.equal(captured.billing.timeline.filter(e => e.kind === 'receipt_preview').length, 1)
    const countBefore = edge.writes.length
    edge.account('synthetic-nectar-other-account')
    await api('sandbox.clock.advance', { customer: paid.id, revision: 2, clock: '2028-02-01T08:00:00Z', confirm: true }, 409)
    edge.account('synthetic-nectar-sandbox-account')
    assert.equal(edge.writes.length, countBefore, 'An account change permits no processor write')
  }
  console.log(`DEV-004 sandbox billing: thirteen-month annual invoices, independent cents, ${attemptsPerInvoice * 2} test declines, copied retry policy, inbox-only notices, state history, replay and live isolation passed`)
  return { customer: c.id, catalog: catalog.id, remote, invoices: invoices.map(i => ({ id: i.id, amountCents: i.invoice.rating.totalCents })), attempts: state.billing.attempts.map(a => ({ id: a.id, intent: a.intent_ref, dueAt: a.due_at, status: a.status })), clock: state.clock_at }
}
