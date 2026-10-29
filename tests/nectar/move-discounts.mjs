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
  const prices = [30000, 10000, 10000].map((amount, index) => ({
    id: reference('price', index), product: products[index === 1 ? 1 : 0].id, type: 'recurring', currency: 'usd',
    unit_amount: amount, recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, metadata: { nectar_kind: 'flat' },
  }))
  const customers = Array.from({ length: 4 }, (_, index) => ({ id: reference('customer', index), name: 'Synthetic imported discount ' + index, email: [reference('mail', index), 'example.test'].join('@') }))
  const subscriptions = customers.map((customer, index) => ({
    id: reference('subscription', index), object: 'subscription', customer: customer.id, status: 'active', start_date: start,
    billing_cycle_anchor: start, current_period_start: end, current_period_end: unix('2026-12-01'),
    items: { data: [prices[index === 1 ? 2 : 0], prices[1]].map((price, part) => ({ id: reference('item', index * 2 + part), price: { id: price.id }, quantity: 1 })), has_more: false },
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
        price: item.price, quantity: 1, amount: prices.find(price => price.id === item.price.id).unit_amount, period: { start, end } })), has_more: false } }
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
    s => { s.discounts[0].promotion_code = 'synthetic-nectar-unqualified-promotion' },
    s => { s.pause_collection = { behavior: 'void' } },
    s => { s.discounts[0].subscription = 'synthetic-nectar-other-subscription' },
    s => { s.discounts[0].customer = 'synthetic-nectar-other-customer' },
    s => { s.items.data[0].discounts = ['synthetic-nectar-item-discount'] },
  ]) {
    const invalid = structuredClone(capture); change(invalid.subscriptions.data[0])
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
      assert.equal(term.priceIds.length, 2, 'the eligible product retains all its captured price versions')
      assert.equal(invoice.lines.filter(line => line.kind === 'discount').reduce((sum, line) => sum + line.amount_cents, 0), expected[index] === 44000 ? 0 : index === 1 ? -10000 : -20000)
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
  console.log('MOVE-008 imported amount terms: original consumed month, exact expiry, once and forever, restrictions, cap, tax, replay, authority, atomic audit refusal, undo and immutable issued calculations passed')
  return { capture, files, customers: ordered, subscriptions, invoices: saved }
}
