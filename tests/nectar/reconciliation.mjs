import assert from 'node:assert/strict'

export async function reconciliationFlow(h, owner) {
  const customer = (await h.api('customer.create', owner, { external_id: 'source-control', name: 'Cedar Source Systems', billing_email: 'ap@cedar.example' })).id
  const product = (await h.api('product.create', owner, { code: 'source-product', name: 'Source processing' })).id
  await h.api('meter.create', owner, { code: 'source-events', name: 'Source events', unit_label: 'events' })
  const price = (await h.api('price.create', owner, { product, kind: 'unit', meter: 'source-events', unit_amount: '2' })).id
  await h.api('subscription.create', owner, { customer, start_date: '2026-06-01', price: [price], quantity: [''] })
  const send = async events => {
    const result = await h.api('usage.submit', owner, { events: events.map(([event_id, quantity, day]) => ({ event_id, quantity, occurred_at: `${day}T12:00:00-07:00`, customer: 'source-control', meter: 'source-events' })) })
    assert.equal(result.accepted, events.length)
  }
  await send([['source-a', '3', '2026-06-01'], ['source-b', '2', '2026-06-02']])
  const control = async (day, count, quantity) => h.api('usage.control', owner, { customer, meter: 'source-events', day, expected_count: count, expected_quantity: quantity })
  const first = await control('2026-06-01', 2, '5')
  const second = await control('2026-06-02', 0, '0')
  const prepare = async () => {
    const run = await h.api('billrun.prepare', owner, { period: '2026-06' })
    const invoice = (await h.api(`runs/${run.id}`, owner)).invoices.find(i => i.customer_id === customer)
    return { run: run.id, invoice }
  }
  let draft = await prepare()
  const mismatches = draft.invoice.exceptions.filter(e => e.code === 'usage_reconciliation')
  assert.equal(mismatches.length, 2)
  assert.deepEqual(mismatches.map(e => [e.detail.day, e.detail.meter, e.detail.countDifference, e.detail.quantityDifference]), [['2026-06-01', 'source-events', -1, '-2.00'], ['2026-06-02', 'source-events', 1, '2.00']])
  assert.equal((await h.api('invoice.approve', owner, { invoice: draft.invoice.id, acknowledge: true }, 409)).error, 'blocking_exception')
  await send([['source-replay', '2', '2026-06-01']])
  let view = await h.api('usage/inspect?period=2026-06', owner)
  assert.equal(view.controls.find(c => c.id === first.id).mismatch, false)
  const surplus = view.controls.find(c => c.id === second.id)
  const usageKey = await h.api('credential.issue', owner, { name: 'source-control-ingester', scopes: ['usage'] })
  await h.api('usage.acknowledge', { bearer: usageKey.key }, { control: second.id, basis: surplus.basis, reason: 'Source counted only completed work' }, 403)
  await h.api('usage.acknowledge', owner, { control: second.id, basis: surplus.basis, reason: 'Source counted only completed work' })
  draft = await prepare()
  assert.equal(draft.invoice.exceptions.some(e => e.code === 'usage_reconciliation'), false)
  await h.api('invoice.approve', owner, { invoice: draft.invoice.id, acknowledge: true })
  // A control update after approval invalidates the exact inputs at issue.
  await control('2026-06-01', 3, '6')
  assert.equal((await h.api('invoice.finalise', owner, { invoice: draft.invoice.id }, 409)).error, 'source_changed')
  await send([['source-later', '1', '2026-06-01'], ['source-surplus', '1', '2026-06-02']])
  view = await h.api('usage/inspect?period=2026-06', owner)
  assert.equal(view.controls.find(c => c.id === second.id).acknowledged, false, 'new events revoke acknowledgement')
  await h.api('usage.acknowledge', owner, { control: second.id, basis: surplus.basis, reason: 'Stale view' }, 409)
  // Reconcile the remaining source assertion, then approve and issue once.
  await control('2026-06-02', 2, '3')
  draft = await prepare()
  assert.equal(draft.invoice.exceptions.some(e => e.code === 'usage_reconciliation'), false)
  assert.equal(draft.invoice.subtotal_cents, 1800)
  await h.api('invoice.approve', owner, { invoice: draft.invoice.id, acknowledge: true })
  await h.api('invoice.finalise', owner, { invoice: draft.invoice.id })
  assert.equal((await h.api(`invoices/${draft.invoice.id}`, owner)).status, 'issued')
  await h.page('/app/usage?period=2026-06', owner)
  await h.page(`/app/billing/${draft.run}`, owner)
  // A late event changes the source day, so the next invoice must reconcile it too.
  await send([['source-late-after-issue', '1', '2026-06-02']])
  const july = (await h.api('billrun.prepare', owner, { period: '2026-07' })).id
  const late = (await h.api(`runs/${july}`, owner)).invoices.find(i => i.customer_id === customer)
  assert.equal(late.exceptions.filter(e => e.code === 'usage_reconciliation').length, 1)
  assert.equal((await h.api('invoice.approve', owner, { invoice: late.id, acknowledge: true }, 409)).error, 'blocking_exception')
  await control('2026-06-02', 3, '4')
  const cleanJuly = (await h.api('billrun.prepare', owner, { period: '2026-07' })).id
  const cleanLate = (await h.api(`runs/${cleanJuly}`, owner)).invoices.find(i => i.customer_id === customer)
  assert.equal(cleanLate.exceptions.some(e => e.code === 'usage_reconciliation'), false)
  assert.equal(cleanLate.subtotal_cents, 200)
  assert.equal((await h.api(`invoices/${draft.invoice.id}`, owner)).subtotal_cents, 1800, 'the issued historical invoice stays unchanged')
  console.log('USE-007 source control totals, replay, surplus acknowledgement and exact approval passed')
}
