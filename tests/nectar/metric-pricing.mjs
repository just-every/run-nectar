import assert from 'node:assert/strict'

function csvRows(text) {
  const rows = []; let row = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++ } else quoted = !quoted
    } else if (char === ',' && !quoted) { row.push(cell); cell = '' }
    else if (char === '\n' && !quoted) { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = '' }
    else cell += char
  }
  return rows
}

// One GB held for January's final day is 1/31 GB-month, rather than the
// six-place display 0.032258. These prices make premature rounding observable.
export async function metricPricing(h, owner, { source, timeWeightedMeter }) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const bands = [
    { up_to: '0.02', unit_amount: '100000', flat_amount: '0.005' },
    { up_to: null, unit_amount: '200000', flat_amount: '0.005' },
  ]
  const specs = [
    { model: 'graduated', tiers: bands, cents: 445162, exactDollars: ['13800031', '3100'] },
    { model: 'volume', tiers: bands, cents: 645162, exactDollars: ['40000031', '6200'] },
    { model: 'package', package_size: '0.01', tiers: [{ up_to: null, unit_amount: '50000', flat_amount: '0.005' }], cents: 20000001, exactDollars: ['40000001', '200'] },
    { model: 'stair_step', tiers: [{ up_to: '0.02', flat_amount: '100' }, { up_to: null, flat_amount: '200.005' }], cents: 20001, exactDollars: ['40001', '200'] },
    { model: 'included', unit_amount: '100000', cents: 222581 },
  ]
  const fixtures = []
  for (const spec of specs) {
    const external = `USE002-RATIONAL-${spec.model}`
    const customer = (await api('customer.create', { external_id: external, name: `Rational ${spec.model}`, billing_email: 'ap@rational.example' })).id
    const product = (await api('product.create', { code: `use002-rational-${spec.model}`, name: `Rational ${spec.model}` })).id
    const price = (await api('price.create', { product, kind: 'unit', meter: timeWeightedMeter.id, dimensions: { model: 'alpha' }, taxable: false,
      ...(spec.model === 'included' ? { unit_amount: spec.unit_amount } : { pricing_model: spec.model, tiers: spec.tiers, ...(spec.package_size ? { package_size: spec.package_size } : {}) }) })).id
    const subscription = (await api('subscription.create', { customer, start_date: '2024-01-01', price: [price] })).id
    const event = { event_id: `use002-rational-${spec.model}`, customer: external, meter: source.code, quantity: '1', occurred_at: '2024-01-31T00:00:00Z', properties: { model: 'alpha', resource: 'only', active: true, user: '7', weight: '0.123456', seats: 7, optional: null } }
    assert.equal((await api('usage.submit', { events: [event] })).accepted, 1, `USE-002 ${spec.model} ingests a single final-day snapshot`)
    fixtures.push({ ...spec, customer, subscription, price, event })
  }
  const included = fixtures.find(row => row.model === 'included')
  await api('access.give', { email: 'use002-rational-finance@example.test', name: 'Rational Finance', role: 'finance' })
  const finance = await h.signIn('use002-rational-finance@example.test', { requested: true })
  const contract = await api('contract.prepare', { subscription: included.subscription, revision: (await api(`subscriptions/${included.subscription}`)).revision,
    clause: 'January includes 0.01 GB-month; remaining usage costs $100,000 per GB-month.', commitments: [], ramps: [], included: [{ price: included.price, quantity: '0.01', from: '2024-01-01', to: '2024-02-01' }] })
  await h.api('contract.decide', finance, { contract: contract.contract, decision: 'approved' })
  const control = { customer: fixtures[0].customer, meter: source.id, day: '2024-01-31', expected_count: 0, expected_quantity: '0' }
  await api('usage.control', control)
  const blockedRun = await api('billrun.prepare', { period: '2024-01' })
  const blocked = (await api(`runs/${blockedRun.id}`)).invoices.find(row => row.customer_id === control.customer)
  assert.ok(blocked, 'USE-002 source reconciliation prepares the metric subscription draft')
  assert.ok(blocked.exceptions.some(row => row.code === 'usage_reconciliation'), 'USE-002 a raw-source control mismatch blocks derived billing')
  await api('invoice.approve', { invoice: blocked.id, acknowledge: true }, 409)
  await api('usage.control', { ...control, expected_count: 1, expected_quantity: '1' })
  const run = await api('billrun.prepare', { period: '2024-01' })
  const drafts = (await api(`runs/${run.id}`)).invoices
  for (const fixture of fixtures) {
    const candidates = drafts.filter(row => row.customer_id === fixture.customer)
    const details = await Promise.all(candidates.map(row => api(`invoices/${row.id}`)))
    const draft = details.find(row => row.subscription_id === fixture.subscription)
    assert.ok(draft, `USE-002 ${fixture.model} run identifies the exact subscription`)
    assert.ok(!draft.exceptions.some(row => row.code === 'usage_reconciliation'), `USE-002 ${fixture.model} draft clears corrected source totals`)
    await api('invoice.approve', { invoice: draft.id, acknowledge: true })
    await api('invoice.finalise', { invoice: draft.id, issue_date: '2024-02-01' })
    const invoice = await api(`invoices/${draft.id}`)
    assert.equal(invoice.status, 'issued', `USE-002 ${fixture.model} reaches the issued ledger`)
    assert.deepEqual([invoice.subtotal_cents, invoice.tax_cents, invoice.total_cents], [fixture.cents, 0, fixture.cents], `USE-002 ${fixture.model} rates 1/31 exactly through its pricing model`)
    assert.equal(invoice.lines.length, 1, `USE-002 ${fixture.model} bills its selected dimension once`)
    const line = invoice.lines[0]
    assert.equal(line.price_id, fixture.price, `USE-002 ${fixture.model} retains the subscribed immutable price`)
    assert.equal(line.kind, 'metric_usage', `USE-002 ${fixture.model} retains metric evidence on the financial line`)
    assert.deepEqual(line.evidence.rawExactQuantity, { numerator: '1', denominator: '31' }, `USE-002 ${fixture.model} preserves the unrounded time-weighted source quantity`)
    if (fixture.model === 'included') {
      assert.deepEqual(line.evidence.includedExact, { numerator: '1', denominator: '100' }, 'USE-002 included quantities retain exact contract units')
      assert.deepEqual(line.evidence.exactQuantity, { numerator: '69', denominator: '3100' }, 'USE-002 included allowance is subtracted from the rational before pricing')
      assert.equal(line.amount_cents, 222581, 'USE-002 fractional allowance produces independently calculated $2,225.81 overage')
    } else {
      assert.deepEqual(line.evidence.exactQuantity, { numerator: '1', denominator: '31' }, `USE-002 ${fixture.model} never substitutes its rounded display quantity`)
      assert.equal(line.evidence.metricPricingModel, fixture.model, `USE-002 ${fixture.model} saves the pricing rule used at issue`)
      assert.deepEqual(line.evidence.exactDollars, { numerator: fixture.exactDollars[0], denominator: fixture.exactDollars[1] }, `USE-002 ${fixture.model} retains the independently calculated exact charge before cent rounding`)
    }
    fixture.invoice = invoice.id
  }
  const exported = await h.raw('/app/exports/usage.csv', { cookie: owner })
  assert.equal(exported.status, 200, 'USE-002 ordinary usage download retains source-event properties')
  const [columns, ...rows] = csvRows(await exported.text())
  for (const fixture of fixtures) {
    const row = rows.find(row => row[columns.indexOf('event_id')] === fixture.event.event_id)
    assert.ok(row, `USE-002 ${fixture.model} raw event remains in the usage CSV`)
    assert.deepEqual(JSON.parse(row[columns.indexOf('properties_json')]), fixture.event.properties, `USE-002 ${fixture.model} CSV preserves exact strings, numbers, booleans and null properties`)
  }
  console.log('USE-002 exact rational metrics compose graduated, volume, package, stair-step and included-unit pricing; source reconciliation and property export passed')
  return { run: run.id, fixtures: fixtures.map(({ model, customer, subscription, invoice }) => ({ model, customer, subscription, invoice })) }
}
