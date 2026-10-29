// Sanity journey through uploaded preview, apply, shadow, adoption and billing.
import assert from 'node:assert/strict'
import { file } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'

const unix = date => Date.parse(date + 'T00:00:00Z') / 1000
export const harnessOptions = () => ({ localTime: '2027-02-05T12:00:00Z' })
export function amountDiscountCapture() {
  const reference = (kind, index) => 'synthetic-nectar-discount-' + kind + '-' + index
  const start = unix('2026-10-01'), end = unix('2026-11-01')
  const products = [{ id: reference('product', 1), name: 'Synthetic eligible' }, { id: reference('product', 2), name: 'Synthetic uncovered' }]
  const prices = [30000, 10000, 10000, 15000].map((amount, index) => ({
    id: reference('price', index), product: products[index === 1 ? 1 : 0].id, type: 'recurring', currency: 'usd',
    unit_amount: amount, recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, metadata: { nectar_kind: index === 3 ? 'seat' : 'flat' },
  }))
  const customers = Array.from({ length: 4 }, (_, index) => ({ id: reference('customer', index), name: 'Synthetic imported discount ' + index, email: [reference('mail', index), 'example.test'].join('@') }))
  const subscriptions = customers.map((customer, index) => ({
    id: reference('subscription', index), object: 'subscription', customer: customer.id, status: 'active', start_date: start,
    billing_cycle_anchor: start, current_period_start: end, current_period_end: unix('2026-12-01'),
    items: { data: [prices[index === 1 ? 2 : index === 3 ? 3 : 0], prices[1]].map((price, part) => ({ id: reference('item', index * 2 + part), price: { id: price.id }, quantity: index === 3 && part === 0 ? 2 : 1 })), has_more: false },
    discounts: [{ id: reference('discount', index), start: index === 2 ? end : start,
      end: index === 0 ? unix('2027-01-01') : null,
      coupon: { id: reference('coupon', index), amount_off: 20000, percent_off: null, currency: 'usd',
        duration: index === 0 ? 'repeating' : index === 1 ? 'forever' : 'once',
        ...(index === 0 ? { duration_in_months: 3 } : {}), applies_to: { products: [products[0].id] } } }],
  }))
  // October is already source-owned: one month of the repeating term is spent.
  const invoices = subscriptions.map((subscription, index) => {
    const gross = index === 1 ? 20000 : 40000, discount = index === 2 ? 0 : index === 1 ? 10000 : 20000
    const total = (gross - discount) * 11 / 10
    return { id: reference('invoice', index), object: 'invoice', number: 'SOURCE-' + index, customer: subscription.customer,
      subscription: subscription.id, status: 'paid', currency: 'usd', created: start, period_start: start, period_end: end,
      total, tax: (gross - discount) / 10, amount_paid: total, amount_remaining: 0,
      total_discount_amounts: discount ? [{ amount: discount }] : [],
      lines: { data: subscription.items.data.map((item, part) => ({ id: reference('line', index * 2 + part), type: 'subscription',
        price: item.price, quantity: item.quantity, amount: prices.find(price => price.id === item.price.id).unit_amount * item.quantity, period: { start, end } })), has_more: false } }
  })
  const lists = { customers, products, prices, subscriptions, invoices }
  return { manifest: { source: 'stripe', files: Object.fromEntries(Object.entries(lists).map(([name, rows]) => [name, { count: rows.length, has_more: false }])) },
    ...Object.fromEntries(Object.entries(lists).map(([name, data]) => [name, { object: 'list', data, has_more: false }])) }
}
export const discountFiles = capture => Object.fromEntries(Object.entries(capture).map(([name, value]) => [name, file(name + '.json', JSON.stringify(value), 'application/json')]))

export async function moveDiscountsFlow(h, owner, { onState = async () => {} } = {}) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  await api('business.configure', { ...await api('business'), timezone: 'UTC' })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: '10', tax_note: 'Reviewed synthetic move-in tax' })
  await api('tax.review', { revision: (await api('business')).revision })
  const capture = amountDiscountCapture(), files = discountFiles(capture)
  const baseline = await api('customers'), preview = await api('import.preview', files)
  assert.deepEqual(preview.rejected, [])
  assert.ok(!preview.attention.some(row => /coupon/.test(row.reason)))
  assert.deepEqual(await api('customers'), baseline, 'preview writes no customer or discount')
  // Every unsupported capture is refused before any import record is created.
  for (const change of [
    s => { s.discounts[0].coupon.currency = 'eur' },
    s => { s.discounts[0].coupon.duration_in_months = null },
    s => { s.discounts[0].end = unix('2027-02-01') },
    s => { s.discounts[0].start += 3600 },
    s => { s.discounts[0].coupon.applies_to.products = ['synthetic-nectar-missing-product'] },
    s => { s.discounts = [s.discounts[0].id] },
    s => { s.discounts.push({ ...s.discounts[0], id: 'synthetic-nectar-extra-discount' }) },
    s => { s.discounts[0].coupon = s.discounts[0].coupon.id },
    s => { s.discounts[0].coupon = { id: s.discounts[0].coupon.id } },
    s => { s.discounts[0].promotion_code = 'synthetic-nectar-unqualified-promotion' },
    s => { s.pause_collection = { behavior: 'void' } },
    s => { s.discounts[0].subscription = 'synthetic-nectar-other-subscription' },
    s => { s.discounts[0].customer = 'synthetic-nectar-other-customer' },
    s => { s.items.data[0].discounts = ['synthetic-nectar-item-discount'] },
    (s, capture) => { capture.subscriptions.data[1].discounts[0].id = s.discounts[0].id },
  ]) {
    const invalid = structuredClone(capture); change(invalid.subscriptions.data[0], invalid)
    assert.equal((await api('import.apply', { ...discountFiles(invalid), fingerprint: preview.fingerprint }, 400)).error, 'unsupported_imported_discount')
    assert.deepEqual(await api('customers'), baseline)
  }
  const altered = structuredClone(capture); altered.subscriptions.data[0].discounts[0].coupon.amount_off = 19900
  assert.equal((await api('import.apply', { ...discountFiles(altered), fingerprint: preview.fingerprint }, 409)).error, 'reviewed_fingerprint_changed')
  const readerMail = ['synthetic-nectar-discount-reader', 'example.test'].join('@')
  await api('access.give', { email: readerMail, name: 'Synthetic discount reader', role: 'accountant' })
  const reader = await h.signIn(readerMail, { requested: true })
  const credential = await api('credential.issue', { name: 'Synthetic move-in agent', scopes: ['prepare'] })
  const agent = { bearer: credential.key }
  for (const who of [reader, agent]) await h.api('import.apply', who, { ...files, fingerprint: preview.fingerprint }, 403)
  await api('credential.revoke', { key: credential.id })
  await h.api('import.apply', agent, { ...files, fingerprint: preview.fingerprint }, 401)
  assert.deepEqual(await api('customers'), baseline)
  await h.rejectAudit('import.record.write')
  try {
    const response = await h.raw('/api/nectar/import.apply', { cookie: owner, body: { ...files, fingerprint: preview.fingerprint } })
    assert.ok(response.status >= 400, 'audit failure refuses the batch')
    assert.deepEqual(await api('customers'), baseline, 'audit failure rolls back imported discount custody')
  } finally { await h.rejectAudit() }
  const applied = await api('import.apply', { ...files, fingerprint: preview.fingerprint })
  assert.equal(applied.state, 'completed')
  await api('import.job', { job: applied.job, action: 'undo' })
  assert.deepEqual(await api('customers'), baseline, 'untouched discount terms undo with their subscription')
  const imported = await api('import.apply', { ...files, fingerprint: preview.fingerprint })
  const customers = await api('customers')
  const ordered = capture.customers.data.map(source => customers.find(row => row.external_id === source.id))
  const subscriptions = await Promise.all(ordered.map(async customer => (await api('customers/' + customer.id)).subscriptions[0]))
  const before = await Promise.all(subscriptions.map(sub => api('subscriptions/' + sub.id)))
  assert.equal((await api('import.apply', { ...files, fingerprint: preview.fingerprint })).job, imported.job)
  assert.deepEqual(await Promise.all(subscriptions.map(sub => api('subscriptions/' + sub.id))), before, 'reimport changes no native custody')
  const shadow = await api('billrun.prepare', { period: '2026-10' })
  const shadowInvoices = (await api('runs/' + shadow.id)).invoices
  assert.deepEqual(shadowInvoices.map(row => row.status), Array(4).fill('shadow'))
  assert.ok(shadowInvoices.every(row => row.comparison.incumbent.reconciled), 'historical source invoices reconcile including consumed discounts')
  await onState({ label: 'shadow', path: '/app/billing/' + shadow.id })
  for (const sub of subscriptions) {
    await h.api('subscription.adopt', reader, { subscription: sub.id, cutover_start: '2026-11-01' }, 403)
    await api('subscription.adopt', { subscription: sub.id, cutover_start: '2026-10-01' }, 409)
    await api('subscription.adopt', { subscription: sub.id, cutover_start: '2026-11-01' })
  }
  const saved = []
  for (const [period, expected] of [
    ['2026-11', [22000, 11000, 22000, 44000]],
    ['2026-12', [22000, 11000, 44000, 44000]],
    ['2027-01', [44000, 11000, 44000, 44000]],
  ]) {
    const run = await api('billrun.prepare', { period }), invoices = (await api('runs/' + run.id)).invoices
    for (let index = 0; index < ordered.length; index++) {
      const invoice = await api('invoices/' + invoices.find(row => row.customer_id === ordered[index].id).id)
      assert.equal(invoice.total_cents, expected[index], period + ' independent capped discount and tax')
      const term = invoice.calculation.inputs.amountCoupons[0]
      assert.equal(term.from, index === 2 ? '2026-11-01' : '2026-10-01')
      assert.equal(term.to, index === 0 ? '2027-01-01' : index === 1 ? null : index === 2 ? '2026-12-01' : '2026-11-01')
      assert.equal(term.source.discount, capture.subscriptions.data[index].discounts[0].id)
      assert.equal(term.value, '200.00')
      assert.equal(term.months, index === 0 ? 3 : null)
      assert.equal(term.priceIds.length, 3, 'the eligible product retains all its captured price versions')
      assert.equal(invoice.lines.filter(line => line.kind === 'discount').reduce((sum, line) => sum + line.amount_cents, 0), expected[index] === 44000 ? 0 : index === 1 ? -10000 : -20000)
      if (index === 3) assert.deepEqual(invoice.lines.filter(line => line.kind === 'seat').map(line => [line.quantity, line.amount_cents]), [['2', 30000]], 'consumed once terms do not restart on a seat subscription')
      if (index === 1) assert.equal(invoice.lines.find(line => line.kind === 'flat' && /uncovered/.test(line.description)).amount_cents, 10000)
      await api('invoice.approve', { invoice: invoice.id, acknowledge: true })
      await api('invoice.finalise', { invoice: invoice.id, issue_date: invoice.period_end })
      saved.push(await api('invoices/' + invoice.id))
      if (index === 0) await onState({ label: period + '-issued', path: '/app/invoices/' + invoice.id })
    }
  }
  assert.equal((await api('import.job', { job: imported.job, action: 'undo' }, 409)).error, 'undo_blocked')
  await api('import.apply', { ...discountFiles(altered), fingerprint: (await api('import.preview', discountFiles(altered))).fingerprint }, 409)
  assert.deepEqual(await Promise.all(saved.map(invoice => api('invoices/' + invoice.id))), saved, 'replay, changed source and unsafe undo leave issued calculations immutable')
  await movePendingItemsFlow(h, owner, { onState, reader })
  // Erasure retires captured identities while retaining anonymous money facts.
  const request = await api('erasure.request', { customer: ordered[0].id })
  await api('erasure.verify', { request: request.id, reason: 'Independently verified imported discount owner', evidence: file('synthetic-nectar-owner.txt', 'Signed source owner request', 'text/plain') })
  const erased = await api('erasure.approve', { request: request.id, confirm: true })
  assert.equal(erased.receipt.changed.find(row => row.kind === 'nc_coupon_amount_terms').records, 1)
  const anonymous = await api('customers/' + ordered[0].id)
  assert.equal(anonymous.name, 'Erased customer')
  const replay = await api('import.preview', files)
  assert.equal((await api('import.apply', { ...files, fingerprint: replay.fingerprint }, 409)).error, 'reviewed_fingerprint_changed')
  assert.deepEqual(await api('customers/' + ordered[0].id), anonymous, 'retired capture cannot resurrect the erased person')
  for (const original of saved.filter(invoice => invoice.customer_id === ordered[0].id)) {
    const retained = await api('invoices/' + original.id)
    assert.deepEqual([retained.number, retained.total_cents, retained.tax_cents], [original.number, original.total_cents, original.tax_cents], 'erasure and replay preserve anonymous issued money')
  }
  await onState({ label: 'erased-source', path: '/app/customers/' + ordered[0].id })
  console.log('MOVE-008 imported amount terms: original consumed month, exact expiry, once and forever, restrictions, cap, tax, replay, authority, atomic audit refusal, undo and immutable issued calculations passed')
  return { capture, files, customers: ordered, subscriptions, invoices: saved }
}

export function pendingItemsCapture() {
  const capture = JSON.parse(JSON.stringify(amountDiscountCapture()).replaceAll('synthetic-nectar-discount-', 'synthetic-nectar-pending-'))
  capture.customers.data = capture.customers.data.slice(0, 3)
  capture.subscriptions.data = capture.subscriptions.data.slice(0, 3)
  capture.invoices.data = capture.invoices.data.slice(0, 1)
  capture.customers.data[0].tax_ids = { object: 'list', has_more: false, data: [{ id: 'synthetic-nectar-pending-tax-id',
    customer: capture.customers.data[0].id, type: 'us_ein', value: '00-0000001' }] }
  for (const [index, sub] of capture.subscriptions.data.entries()) {
    delete sub.discounts
    sub.items.data = [{ ...sub.items.data[0], price: { id: capture.prices.data[0].id }, quantity: 1 }]
    if (index === 0) sub.cancel_at_period_end = true
    else if (index === 1) { sub.status = 'trialing'; sub.trial_end = unix('2026-11-16') }
    else sub.schedule = { id: 'synthetic-nectar-pending-schedule', status: 'active', end_behavior: 'release',
      subscription: sub.id, customer: sub.customer, current_phase: { start_date: unix('2026-11-01'), end_date: unix('2026-12-01') },
      phases: [
        { start_date: unix('2026-11-01'), end_date: unix('2026-12-01'), items: [{ price: capture.prices.data[0].id, quantity: 1 }] },
        { start_date: unix('2026-12-01'), end_date: unix('2027-01-01'), items: [{ price: capture.prices.data[2].id, quantity: 1 }] },
        { start_date: unix('2027-01-01'), end_date: unix('2027-02-01'), items: [{ price: capture.prices.data[3].id, quantity: 1 }] },
      ] }
  }
  const invoice = capture.invoices.data[0]
  Object.assign(invoice, { total: 33000, tax: 3000, amount_paid: 33000, total_discount_amounts: [] })
  invoice.lines.data = [invoice.lines.data[0]]
  capture.invoice_items = { object: 'list', has_more: false, data: [{ id: 'synthetic-nectar-pending-item-1',
    object: 'invoiceitem', customer: capture.customers.data[0].id, subscription: capture.subscriptions.data[0].id,
    invoice: null, currency: 'usd', amount: 7500, quantity: 3, discountable: false, tax_rates: [],
    period: { start: unix('2026-11-01'), end: unix('2026-12-01') } }] }
  for (const [name, value] of Object.entries(capture)) if (name !== 'manifest') capture.manifest.files[name] = { count: value.data.length, has_more: false }
  return capture
}

async function movePendingItemsFlow(h, owner, { onState, reader }) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const capture = pendingItemsCapture(), files = discountFiles(capture)
  const before = await api('customers'), preview = await api('import.preview', files)
  assert.deepEqual(preview.rejected, [])
  assert.equal(preview.create.pending_item, 1)
  for (const change of [
    c => { c.invoice_items.data[0].invoice = 'synthetic-nectar-already-invoiced' },
    c => { c.invoice_items.data[0].subscription = null },
    c => { c.invoice_items.data[0].customer = c.customers.data[1].id },
    c => { c.invoice_items.data[0].discountable = true },
    c => { c.invoice_items.data[0].currency = 'eur' },
    c => { c.invoice_items.data[0].amount = -7500 },
    c => { c.invoice_items.data[0].tax_rates = [{ percentage: 10 }] },
    c => { c.invoice_items.data[0].proration = true },
    c => { c.invoice_items.data[0].automatic_tax = { enabled: true } },
    c => { c.subscriptions.data[0].cancel_at = unix('2026-12-02') },
    c => { delete c.subscriptions.data[0].current_period_end },
    c => { c.subscriptions.data[0].current_period_end += 3600 },
    c => { c.subscriptions.data[2].schedule.phases[1].start_date = unix('2026-12-02') },
    c => { c.subscriptions.data[2].schedule.phases[1].items[0].price = 'synthetic-nectar-missing-phase-price' },
    c => { c.subscriptions.data[2].schedule.phases[0].items[0].quantity = 2 },
    c => { c.subscriptions.data[2].schedule.phases[1].add_invoice_items = [{ price: c.prices.data[2].id }] },
    c => { c.subscriptions.data[2].schedule.customer = c.customers.data[1].id },
    c => { c.subscriptions.data[2].schedule.end_behavior = 'unknown' },
    c => { c.customers.data[0].tax_ids.has_more = true },
    c => { c.customers.data[0].tax_ids.data[0].customer = c.customers.data[1].id },
    c => { c.customers.data[0].tax_ids.data[0].type = 'unqualified' },
    c => { delete c.invoice_items },
  ]) {
    const invalid = structuredClone(capture); change(invalid)
    await api('import.apply', { ...discountFiles(invalid), fingerprint: preview.fingerprint }, 400)
    assert.deepEqual(await api('customers'), before, 'unsupported live state refuses before any native write')
  }
  const changed = structuredClone(capture); changed.invoice_items.data[0].amount = 7200
  await api('import.apply', { ...discountFiles(changed), fingerprint: preview.fingerprint }, 409)
  await h.api('import.apply', reader, { ...files, fingerprint: preview.fingerprint }, 403)
  await h.rejectAudit('import.record.write')
  try {
    const response = await h.raw('/api/nectar/import.apply', { cookie: owner, body: { ...files, fingerprint: preview.fingerprint } })
    assert.ok(response.status >= 400)
    assert.deepEqual(await api('customers'), before, 'audit refusal leaves neither a subscription nor a pending charge')
  } finally { await h.rejectAudit() }
  const undone = await api('import.apply', { ...files, fingerprint: preview.fingerprint })
  await api('import.job', { job: undone.job, action: 'undo' })
  assert.deepEqual(await api('customers'), before, 'untouched undo removes native pending items before their customer')
  const imported = await api('import.apply', { ...files, fingerprint: preview.fingerprint })
  const customers = await api('customers')
  const ordered = await Promise.all(capture.customers.data.map(source => api('customers/' + customers.find(row => row.external_id === source.id).id)))
  const subs = ordered.map(customer => customer.subscriptions[0]), charge = ordered[0].charges[0]
  assert.deepEqual([charge.amount_cents, charge.quantity, charge.unit_amount, charge.effective_date], [7500, '3', '25.00', '2026-11-01'])
  assert.deepEqual([subs[0].end_date, subs[1].trial_end], ['2026-12-01', '2026-11-16'])
  assert.equal(JSON.parse(ordered[0].invoice_settings_json).customFields['Imported US tax ID'], '00-0000001')
  assert.equal(ordered[0].tax_exempt, 0, 'a displayed source tax ID grants no exemption')
  assert.equal((await api('import.apply', { ...files, fingerprint: preview.fingerprint })).job, imported.job)
  assert.deepEqual(await api('customers/' + ordered[0].id), ordered[0], 'reimport does not recreate pending items')
  const manual = { customer: ordered[0].id, charges: [charge.id], service_date: '2026-11-01' }
  assert.equal((await api('invoice.manual', manual, 409)).error, 'imported_charge_requires_subscription_billing')
  const shadow = await api('billrun.prepare', { period: '2026-10' })
  const prior = (await api('runs/' + shadow.id)).invoices.find(invoice => invoice.subscription_id === subs[0].id)
  assert.equal(prior.total_cents, 33000, 'pending source item never enters an earlier source-owned period')
  assert.ok(prior.comparison.incumbent.reconciled)
  await api('subscription.adopt', { subscription: subs[0].id, cutover_start: '2026-12-01', acknowledge_unreconciled: true }, 409)
  for (const sub of subs) await api('subscription.adopt', { subscription: sub.id, cutover_start: '2026-11-01', acknowledge_unreconciled: true })
  const run = await api('billrun.prepare', { period: '2026-11' })
  const november = (await api('runs/' + run.id)).invoices
  const issued = []
  for (const [index, sub] of subs.entries()) {
    const invoice = await api('invoices/' + november.find(invoice => invoice.subscription_id === sub.id).id)
    assert.equal(invoice.total_cents, [40500, 16500, 33000][index], 'independent charge, trial and schedule calculation with declared tax')
    if (index === 0) {
      assert.equal(invoice.tax_cents, 3000, 'explicitly untaxed pending item adds no tax')
      assert.equal(invoice.calculation.inputs.invoiceContent.customerFields['Imported US tax ID'], '00-0000001')
      const line = invoice.lines.find(line => line.kind === 'one_time')
      assert.deepEqual([line.amount_cents, line.quantity, line.evidence.invoiceItem], [7500, '3', capture.invoice_items.data[0].id])
    }
    await api('invoice.approve', { invoice: invoice.id, acknowledge: true })
    await api('invoice.finalise', { invoice: invoice.id, issue_date: '2026-12-01' })
    issued.push(await api('invoices/' + invoice.id))
    await onState({ label: ['pending-item-issued', 'remaining-trial-issued', 'schedule-first-phase'][index], path: '/app/invoices/' + invoice.id })
  }
  assert.equal((await api('customers/' + ordered[0].id)).charges[0].invoice_id, issued[0].id)
  await api('portal.configure', { hosts: [h.origin], parents: [] })
  const session = await api('portal.session.issue', { customer: ordered[0].id, origin: h.origin, audience: 'hosted' })
  const ownInvoice = '/portal/invoices/' + issued[0].id + '?session=' + session.token
  const pdf = await h.raw(ownInvoice + '&format=pdf')
  assert.equal(pdf.status, 200)
  const bytes = Buffer.from(await pdf.arrayBuffer())
  const pdfText = [...bytes.toString('latin1').matchAll(/<([0-9a-f]+)> Tj/g)].map(match => Buffer.from(match[1], 'hex').toString('latin1')).join('\n')
  assert.ok(pdfText.includes('00-0000001'), 'the downloaded issued PDF retains the captured tax ID')
  assert.ok((await (await h.raw(ownInvoice)).text()).includes('00-0000001'))
  assert.ok((await (await h.raw('/app/customers/' + ordered[0].id, { cookie: owner })).text()).includes('00-0000001'), 'the native customer record retains the captured tax ID')
  const foreign = await api('portal.session.issue', { customer: ordered[1].id, origin: h.origin, audience: 'hosted' })
  assert.equal((await h.raw('/portal/invoices/' + issued[0].id + '?session=' + foreign.token)).status, 404, 'another customer cannot read the imported tax ID')
  await onState({ label: 'pending-tax-id-portal', path: ownInvoice })
  const next = await api('billrun.prepare', { period: '2026-12' })
  const december = (await api('runs/' + next.id)).invoices
  assert.ok(!december.some(invoice => invoice.subscription_id === subs[0].id), 'boundary cancellation prevents the next invoice')
  assert.equal(december.find(invoice => invoice.subscription_id === subs[1].id).total_cents, 33000, 'the remaining trial never restarts after its original end')
  assert.equal(december.find(invoice => invoice.subscription_id === subs[2].id).total_cents, 11000, 'second phase switches price on its original boundary')
  const scheduleInvoices = []
  await h.advanceClock('2027-04-05T12:00:00Z')
  for (const period of ['2026-12', '2027-01', '2027-02']) {
    const result = period === '2026-12' ? next : await api('billrun.prepare', { period })
    const candidate = (await api('runs/' + result.id)).invoices.find(invoice => invoice.subscription_id === subs[2].id)
    const invoice = await api('invoices/' + candidate.id)
    assert.equal(invoice.total_cents, period === '2026-12' ? 11000 : 16500, 'dated schedule and released final price keep exact cents')
    assert.deepEqual(invoice.lines.filter(line => ['flat', 'seat'].includes(line.kind)).map(line => [line.period_start, line.period_end]),
      [[period + '-01', { '2026-12': '2027-01-01', '2027-01': '2027-02-01', '2027-02': '2027-03-01' }[period]]])
    await api('invoice.approve', { invoice: invoice.id, acknowledge: true })
    await api('invoice.finalise', { invoice: invoice.id, issue_date: invoice.period_end })
    scheduleInvoices.push(await api('invoices/' + invoice.id))
    await onState({ label: 'schedule-' + period, path: '/app/invoices/' + invoice.id })
  }
  assert.equal((await api('import.job', { job: imported.job, action: 'undo' }, 409)).error, 'undo_blocked')
  await api('import.apply', { ...discountFiles(changed), fingerprint: (await api('import.preview', discountFiles(changed))).fingerprint }, 409)
  assert.deepEqual(await Promise.all(issued.map(invoice => api('invoices/' + invoice.id))), issued, 'changed source and unsafe undo preserve issued money')
  assert.deepEqual(await Promise.all(scheduleInvoices.map(invoice => api('invoices/' + invoice.id))), scheduleInvoices, 'replay cannot alter issued schedule phases')
  const request = await api('erasure.request', { customer: ordered[0].id })
  await api('erasure.verify', { request: request.id, reason: 'Independently verified pending-item account owner', evidence: file('synthetic-nectar-pending-owner.txt', 'Signed owner request', 'text/plain') })
  await api('erasure.approve', { request: request.id, confirm: true })
  assert.equal((await h.raw(ownInvoice + '&format=pdf')).status, 401, 'erasure withdraws the tax-bearing customer PDF capability')
  const anonymous = await api('customers/' + ordered[0].id)
  assert.equal(anonymous.invoice_settings_json, '{}', 'erasure withdraws the captured tax identifier')
  const retained = await api('invoices/' + issued[0].id)
  assert.deepEqual([retained.number, retained.total_cents, retained.tax_cents], [issued[0].number, 40500, 3000], 'anonymous invoice retains exact issued custody')
  const retainedCharge = retained.lines.find(line => line.kind === 'one_time')
  assert.equal(retainedCharge.amount_cents, 7500, 'anonymous issued charge retains its exact amount')
  assert.deepEqual(retainedCharge.evidence, {}, 'erasure withdraws original source references')
  const retired = await api('import.preview', files)
  await api('import.apply', { ...files, fingerprint: retired.fingerprint }, 409)
  assert.deepEqual(await api('customers/' + ordered[0].id), anonymous, 'replay cannot restore erased tax or pending-item source identity')
  await onState({ label: 'pending-item-import', path: '/app/import' })
  console.log('MOVE-008 pending item billed once, untaxed source cents, remaining trial, boundary cancellation, replay, undo and atomic refusal passed')
}
