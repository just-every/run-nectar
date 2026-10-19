import assert from 'node:assert/strict'

// Runs in its own installation: changing the billing timezone precedes every invoice.
export async function metricZones(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  await api('business.configure', { ...await api('business'), timezone: 'America/Los_Angeles' })
  const external = 'USE002-DST-STORAGE'
  const customer = (await api('customer.create', { external_id: external, name: 'Pacific storage', billing_email: 'ap@pacific.example' })).id
  const source = await api('meter.create', { code: 'use002-pacific-raw', name: 'Pacific storage snapshots', unit_label: 'GB' })
  const snapshot = { event_id: 'use002-pacific-predecessor', customer: external, meter: source.code, quantity: '1', occurred_at: '2026-02-28T00:00:00-08:00', properties: { resource: 'storage' } }
  assert.equal((await api('usage.submit', { events: [snapshot] })).accepted, 1, 'USE-002 records the predecessor before service starts')
  const plans = {}
  for (const unit of ['month', 'hour']) {
    const prepared = await api('meter.prepare', { code: `use002-pacific-${unit}`, name: `Pacific storage ${unit}`, unit_label: `GB-${unit}`, source_meter: source.id,
      definition: { aggregation: 'time_weighted', entity_property: 'resource', time_unit: unit, group_by: [] } })
    const values = unit === 'month' ? [['0', '1'], ['1', '28'], ['1', '1']] : [['0', '1'], ['24', '1'], ['743', '1']]
    for (const [index, period] of ['2026-01', '2026-02', '2026-03'].entries()) {
      const preview = await api('meter.preview', { request: prepared.request, customer, period })
      assert.equal(preview.results.length, 1, `USE-002 ${period} ${unit} returns the ungrouped quantity`)
      assert.deepEqual(preview.results[0].exact, { numerator: values[index][0], denominator: values[index][1] }, `USE-002 ${period} ${unit} uses Los Angeles elapsed time`)
      if (period === '2026-03') assert.deepEqual(preview.results[0].contextEventIds, [snapshot.event_id], `USE-002 March ${unit} carries the February predecessor`)
    }
    plans[unit] = { ...prepared, ...await api('meter.activate', { request: prepared.request }) }
    assert.ok(plans[unit].id, `USE-002 ${unit} meter activates after three past-month previews`)
  }
  const negative = await api('meter.prepare', { code: 'use002-pacific-negative', name: 'Signed expression preview', unit_label: 'GB', source_meter: source.id,
    sql: 'SELECT SUM(quantity * -1.25) AS quantity FROM usage_events' })
  const signed = await api('meter.preview', { request: negative.request, customer, period: '2026-02' })
  assert.deepEqual(signed.results[0].exact, { numerator: '-5', denominator: '4' }, 'USE-002 SQL preview preserves a negative fractional result without a billing policy')
  assert.equal(signed.results[0].quantity, '-1.25', 'USE-002 negative preview display agrees with its exact signed quantity')
  const product = (await api('product.create', { code: 'use002-pacific-storage', name: 'Pacific storage hours' })).id
  const price = (await api('price.create', { product, kind: 'unit', meter: plans.hour.id, unit_amount: '0.01', taxable: false })).id
  const subscription = (await api('subscription.create', { customer, start_date: '2026-03-01', price: [price] })).id
  const issue = async (period, hours) => {
    const upcoming = await api(`subscriptions/${subscription}/upcoming?period=${period}`)
    assert.equal(upcoming.calculation.totalCents, hours, `USE-002 ${period} upcoming bills one cent per active GB-hour`)
    const run = await api('billrun.prepare', { period })
    const candidate = (await api(`runs/${run.id}`)).invoices.find(row => row.customer_id === customer)
    assert.ok(candidate, `USE-002 ${period} prepares the Pacific subscription`)
    const draft = await api(`invoices/${candidate.id}`)
    assert.equal(draft.subscription_id, subscription, `USE-002 ${period} selects the intended subscription`)
    assert.equal(draft.source_fingerprint, upcoming.calculation.fingerprint, `USE-002 ${period} draft retains the upcoming source basis`)
    assert.equal(draft.total_cents, hours, `USE-002 ${period} draft agrees with independently calculated hours`)
    await api('invoice.approve', { invoice: draft.id, acknowledge: true })
    await api('invoice.finalise', { invoice: draft.id, issue_date: draft.period_end })
    const invoice = await api(`invoices/${draft.id}`)
    assert.equal(invoice.status, 'issued', `USE-002 ${period} reaches the issued ledger`)
    assert.deepEqual([invoice.subtotal_cents, invoice.tax_cents, invoice.total_cents], [hours, 0, hours], `USE-002 ${period} issues the independently calculated cent total`)
    assert.equal(invoice.lines.length, 1, `USE-002 ${period} bills the selected metric once`)
    const line = invoice.lines[0]
    assert.deepEqual(line.evidence.exactQuantity, { numerator: String(hours), denominator: '1' }, `USE-002 ${period} freezes exact active hours`)
    assert.deepEqual(line.evidence.contextEventIds, [snapshot.event_id], `USE-002 ${period} retains the pre-service snapshot as context`)
    assert.deepEqual(invoice.calculation.consumedEvents, [], `USE-002 ${period} never consumes predecessor context as new usage`)
    const drill = await api(`invoices/${invoice.id}/lines/${line.id}`)
    assert.deepEqual(drill.events.map(event => [event.eventId, event.properties]), [[snapshot.event_id, snapshot.properties]], `USE-002 ${period} report drill preserves the predecessor and scalar properties`)
    return invoice
  }
  // March has 31 calendar days but loses one elapsed hour at the DST transition.
  const march = await issue('2026-03', 743)
  await api('subscription.pause', { subscription, revision: (await api(`subscriptions/${subscription}`)).revision,
    effective_date: '2026-04-10', resume_date: '2026-04-20', access: 'retain', reason: 'Pacific storage service paused for ten days' })
  for (const [unit, numerator] of [['hour', '720'], ['month', '1']]) {
    const april = await api('meter.preview', { request: plans[unit].request, customer, period: '2026-04' })
    assert.deepEqual(april.results[0].exact, { numerator, denominator: '1' }, `USE-002 April raw ${unit} preview covers the full calendar month independently of service pauses`)
  }
  // April has 720 elapsed hours, of which ten paused days remove exactly 240.
  const april = await issue('2026-04', 480)
  assert.deepEqual((await api(`invoices/${march.id}`)).calculation, march.calculation, 'USE-002 later service pauses preserve the issued DST-month calculation')
  console.log('USE-002 Los Angeles DST hours/months, predecessor carry, signed SQL preview and paused-service exact billing passed')
  return { customer, source, subscription, meters: plans, invoices: [march.id, april.id] }
}
