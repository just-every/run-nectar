import assert from 'node:assert/strict'

// USE-002 inherits GOV-002 pricing approval through the existing public doors.
export async function metricChanges(h, owner, { source, timeWeightedMeter }) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const finance = await h.signIn('use002-rational-finance@example.test')
  const customer = (await api('customer.create', { external_id: 'USE002-PRICE-CHANGES', name: 'Metric price changes', billing_email: 'ap@metric-changes.example' })).id
  const product = (await api('product.create', { code: 'use002-price-changes', name: 'Metric price changes' })).id
  const priceTerms = { product, kind: 'unit', meter: timeWeightedMeter.id, dimensions: { model: 'alpha' }, taxable: false }
  const price = (await api('price.create', { ...priceTerms, unit_amount: '31' })).id
  const subscription = (await api('subscription.create', { customer, start_date: '2024-03-01', price: [price] })).id
  const read = () => api(`subscriptions/${subscription}`)
  const preview = month => api(`subscriptions/${subscription}/upcoming?period=${month}`)
  assert.equal((await api('usage.submit', { events: [{ event_id: 'use002-price-change-snapshot', customer: 'USE002-PRICE-CHANGES', meter: source.code, quantity: '1', occurred_at: '2024-03-01T00:00:00Z', properties: { model: 'alpha', resource: 'one', active: true, user: 'u', weight: '1' } }] })).accepted, 1, 'USE-002 price-change fixture records one full-month resource snapshot')
  const override = await api('amendment.propose', { subscription, kind: 'price_override', price, value: '62', effective_from: '2024-03-16', effective_to: '2024-04-01', clause: 'From March 16 through March 31 the resource costs $62 per GB-month.' })
  await api('amendment.decide', { amendment: override.amendment, decision: 'approved' }, 409)
  assert.equal((await preview('2024-03')).calculation.totalCents, 3100, 'USE-002 an unapproved metric unit override cannot change billing')
  await h.api('amendment.decide', finance, { amendment: override.amendment, decision: 'approved' })
  assert.equal((await preview('2024-03')).calculation.totalCents, 4700, 'USE-002 approved override rates 15 days at $31 and 16 days at $62')
  const issue = async month => {
    const run = await api('billrun.prepare', { period: month })
    const candidates = (await api(`runs/${run.id}`)).invoices.filter(row => row.customer_id === customer)
    const details = await Promise.all(candidates.map(row => api(`invoices/${row.id}`)))
    const draft = details.find(row => row.subscription_id === subscription)
    assert.ok(draft, `USE-002 ${month} selects the governed metric subscription`)
    await api('invoice.approve', { invoice: draft.id, acknowledge: true })
    await api('invoice.finalise', { invoice: draft.id, issue_date: draft.period_end })
    return api(`invoices/${draft.id}`)
  }
  const march = await issue('2024-03')
  assert.equal(march.total_cents, 4700, 'USE-002 issued March charges match the approved split-period preview')
  assert.deepEqual(march.lines.map(line => [line.evidence.exactQuantity, line.amount_cents]).sort((a, b) => a[1] - b[1]), [
    [{ numerator: '15', denominator: '31' }, 1500], [{ numerator: '16', denominator: '31' }, 3200],
  ], 'USE-002 a mid-period override splits exact time-weighted quantity before money rounding')
  const payload = { ...priceTerms, unit_amount: '93', effective_date: '2024-04-01', subscriptions: [subscription] }
  const proposal = await api('proposal.create', { kind: 'price_change', title: 'Metric resource April price', payload, evidence: { reason: 'Approved annual resource price schedule' } })
  const proposed = await api(`proposals/${proposal.id}`)
  assert.ok(proposed.impact[0].periods.every(period => period.after.totalCents === 9300), 'USE-002 native new-price proposal preserves the metric plan in both billing previews')
  await api('proposal.decide', { proposal: proposal.id, decision: 'approved' }, 409)
  assert.equal((await preview('2024-04')).calculation.totalCents, 3100, 'USE-002 a self-refused metric price proposal leaves the old April rate live')
  await h.api('proposal.decide', finance, { proposal: proposal.id, decision: 'approved' })
  await h.api('proposal.decide', finance, { proposal: proposal.id, decision: 'approved' }, 409)
  const current = (await read()).items.find(row => row.effective_from === '2024-04-01')
  const newPrice = (await api('catalog')).prices.find(row => row.id === current.price_id)
  assert.equal(newPrice.meter_id, timeWeightedMeter.id, 'USE-002 new-price migration preserves the immutable metric binding')
  assert.deepEqual(JSON.parse(newPrice.dimensions_json), { model: 'alpha' }, 'USE-002 new-price migration preserves the typed dimension selection')
  assert.equal((await preview('2024-04')).calculation.totalCents, 9300, 'USE-002 approved new-price migration bills one complete GB-month at $93')
  const april = await issue('2024-04')
  assert.equal(april.total_cents, 9300, 'USE-002 issued April invoice matches the governed price proposal')
  assert.deepEqual(april.lines[0].evidence.exactQuantity, { numerator: '1', denominator: '1' }, 'USE-002 later months carry the raw snapshot forward as one full GB-month')
  const request = await api('price.create', { ...priceTerms, unit_amount: '124' })
  const target = await h.api('price.decide', finance, { request: request.request, decision: 'approved' })
  const migration = await api('proposal.create', { kind: 'price_change', title: 'Metric existing target renewal', payload: { target_price: target.id, source_price: newPrice.id, effective_date: '2024-05-01', timing: 'renewal', subscriptions: [subscription] }, evidence: { reason: 'Choose an already approved metric catalogue version' } })
  assert.ok((await api(`proposals/${migration.id}`)).impact[0].periods.every(period => period.after.totalCents === 12400), 'USE-002 exact-target metric migration preserves the selected rate in both previews')
  await api('proposal.decide', { proposal: migration.id, decision: 'approved' }, 409)
  await h.api('proposal.decide', finance, { proposal: migration.id, decision: 'approved' })
  const scheduled = await read()
  assert.equal(scheduled.items.filter(row => row.price_id === target.id).length, 1, 'USE-002 source-price filtering schedules the existing target exactly once')
  const may = await issue('2024-05')
  assert.equal(may.total_cents, 12400, 'USE-002 issued target migration bills the exact approved $124 rate')
  // Distinct model selections can coexist; collapsing both to alpha must fail.
  const betaRequest = await api('price.create', { ...priceTerms, dimensions: { model: 'beta' }, unit_amount: '155' })
  const beta = await h.api('price.decide', finance, { request: betaRequest.request, decision: 'approved' })
  const other = (await api('customer.create', { external_id: 'USE002-MIGRATION-OVERLAP', name: 'Metric overlap migration', billing_email: 'ap@metric-overlap.example' })).id
  const overlapping = (await api('subscription.create', { customer: other, start_date: '2024-06-01', price: [newPrice.id, beta.id] })).id
  const before = await api(`subscriptions/${overlapping}`)
  await api('proposal.create', { kind: 'price_change', title: 'Invalid collapsed model selection', payload: { target_price: target.id, effective_date: '2024-06-16', subscriptions: [overlapping] } }, 409)
  const after = await api(`subscriptions/${overlapping}`)
  assert.deepEqual(after.items, before.items, 'USE-002 refused duplicate metric selection preserves both distinct model items')
  assert.equal(after.revision, before.revision, 'USE-002 invalid metric migration cannot advance the subscription revision')
  for (const invoice of [march, april]) assert.deepEqual((await api(`invoices/${invoice.id}`)).calculation, invoice.calculation, 'USE-002 later price migrations preserve issued override and metric calculation history')
  console.log('USE-002 metric overrides and native/existing-target migrations inherit separate approval, exact previews, immutable dimensions and duplicate-selection refusal')
  return { customer, subscription, price, target: target.id, proposals: [proposal.id, migration.id], invoices: [march.id, april.id, may.id], overlapping }
}
