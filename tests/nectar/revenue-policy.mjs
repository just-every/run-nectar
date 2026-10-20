import assert from 'node:assert/strict'

const entries = schedule => schedule.entries.map(row => [row.period, row.amountCents])

// Policy cases which materially differ from ordinary calendar-day service:
// consumed allowance overage, unused minimum at expiry, cancellation evidence,
// and a nonadditive metric split across two calendar months.
export async function revenuePolicyFlow(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  await api('access.give', { email: 'rev001-finance@example.test', name: 'Revenue Finance', role: 'finance' })
  const finance = await h.signIn('rev001-finance@example.test', { requested: true })
  const customerFor = async suffix => (await api('customer.create', { external_id: `REV001-${suffix}`, name: `Revenue ${suffix}`, billing_email: 'policy@revenue.example' })).id
  const priceFor = async (code, fields) => {
    const product = (await api('product.create', { code: `rev001-policy-${code}`, name: `Revenue policy ${code}` })).id
    return (await api('price.create', { product, taxable: false, ...fields })).id
  }
  const issue = async (customer, period, issue_date) => {
    const run = await api('billrun.prepare', { period })
    const draft = (await api(`runs/${run.id}`)).invoices.find(row => row.customer_id === customer)
    assert.ok(draft)
    await api('invoice.approve', { invoice: draft.id, acknowledge: true })
    await api('invoice.finalise', { invoice: draft.id, issue_date })
    const invoice = await api(`invoices/${draft.id}`)
    const source = await api(`revenue/${draft.id}`)
    assert.equal(source.custody, 'issue-snapshot')
    assert.equal(source.schedules.reduce((n, row) => n + row.amountCents, 0), invoice.subtotal_cents)
    for (const schedule of source.schedules) {
      assert.equal(schedule.entries.reduce((n, row) => n + row.amountCents, 0), schedule.amountCents)
      assert.ok(invoice.lines.some(line => line.id === schedule.lineId))
    }
    return { invoice, source }
  }
  const meter = (await api('meter.create', { code: 'rev001-policy-calls', name: 'Revenue commitment calls', unit_label: 'calls' })).id
  const usage = await priceFor('calls', { kind: 'unit', unit_amount: '1', meter })
  const customer = await customerFor('COMMITMENT')
  const subscription = (await api('subscription.create', { customer, start_date: '2026-04-01', anchor_day: 1, price: [usage] })).id
  const contract = await api('contract.prepare', { subscription, revision: (await api(`subscriptions/${subscription}`)).revision,
    clause: 'April minimum is $10, with one included call; unused minimum settles at expiry on May 1.',
    commitments: [{ from: '2026-04-01', to: '2026-05-01', minimum: '10', taxable: false }],
    included: [{ price: usage, quantity: '1', from: '2026-04-01', to: '2026-05-01' }], ramps: [] })
  await h.api('contract.decide', finance, { contract: contract.contract, decision: 'approved' })
  await api('usage.submit', { events: [{ event_id: 'rev001-included', customer: 'REV001-COMMITMENT', meter: 'rev001-policy-calls', quantity: '2', occurred_at: '2026-04-20T12:00:00-07:00' }] })
  const committed = await issue(customer, '2026-04', '2026-05-01')
  assert.equal(committed.invoice.subtotal_cents, 1000)
  assert.deepEqual(entries(committed.source.schedules.find(row => row.kind === 'overage')), [['2026-04', 100]])
  assert.deepEqual(entries(committed.source.schedules.find(row => row.kind === 'commitment_trueup')), [['2026-05', 900]], 'unused minimum is earned at the exclusive expiry date, not before')
  const roll = await api(`revenue?from=2026-04&to=2026-05&customer=${customer}`)
  assert.deepEqual(roll.months.map(row => [row.netBillingsCents, row.recognizedCents, row.closingCents]), [[0, 100, -100], [1000, 900, 0]])

  const cancelCustomer = await customerFor('CANCEL')
  const flat = await priceFor('cancel', { kind: 'flat', unit_amount: '30' })
  const cancelSub = (await api('subscription.create', { customer: cancelCustomer, start_date: '2026-06-01', anchor_day: 1, price: [flat] })).id
  await api('subscription.cancel', { subscription: cancelSub, revision: (await api(`subscriptions/${cancelSub}`)).revision, mode: 'immediate', effective_date: '2026-06-16', reason: 'Service ended after fifteen of thirty days' })
  const cancelled = await issue(cancelCustomer, '2026-06', '2026-07-01')
  assert.equal(cancelled.invoice.subtotal_cents, 1500)
  const cancellation = cancelled.source.schedules.find(row => row.kind === 'cancellation_credit')
  assert.deepEqual(entries(cancellation), [['2026-06', -1500]])
  assert.ok(cancellation.entries[0].basis.components.some(row => row.side === 'earned'))
  assert.ok(cancellation.entries[0].basis.components.some(row => row.side === 'gross'))
  assert.equal((await api(`revenue?period=2026-06&customer=${cancelCustomer}`)).recognizedCents, 1500, 'earned-minus-gross recognition avoids counting unused service')

  const zeroCustomer = await customerFor('ZERO')
  const zeroSub = (await api('subscription.create', { customer: zeroCustomer, start_date: '2026-06-01', trial_end: '2026-06-05', anchor_day: 1, price: [flat, usage] })).id
  await api('subscription.pause', { subscription: zeroSub, revision: (await api(`subscriptions/${zeroSub}`)).revision, effective_date: '2026-06-10', resume_date: '2026-06-15', access: 'retain', reason: 'No paid service during research pause' })
  await api('usage.submit', { events: [2, 12, 20].map(day => ({ event_id: `rev001-zero-${day}`, customer: 'REV001-ZERO', meter: 'rev001-policy-calls', quantity: '1', occurred_at: `2026-06-${String(day).padStart(2, '0')}T12:00:00-07:00` })) })
  const zero = await issue(zeroCustomer, '2026-06', '2026-07-01')
  for (const kind of ['trial', 'trial_usage', 'paused_usage']) {
    const schedule = zero.source.schedules.find(row => row.kind === kind)
    assert.ok(schedule, `actual ${kind} evidence produces a schedule`)
    assert.equal(schedule.amountCents, 0)
    assert.deepEqual(entries(schedule), [['2026-06', 0]], `${kind} never invents revenue`)
  }

  const metricCustomer = await customerFor('METRIC')
  const source = (await api('meter.create', { code: 'rev001-maximum-source', name: 'Revenue metric observations', unit_label: 'units' })).id
  const prepared = await api('meter.prepare', { code: 'rev001-maximum', name: 'Revenue maximum', unit_label: 'units', source_meter: source, definition: { aggregation: 'maximum', group_by: [] } })
  for (const period of ['2026-01', '2026-02', '2026-03']) await api('meter.preview', { request: prepared.request, customer: metricCustomer, period })
  const maximum = await api('meter.activate', { request: prepared.request })
  const metricPrice = await priceFor('maximum', { kind: 'unit', unit_amount: '0.01', meter: maximum.id })
  await api('subscription.create', { customer: metricCustomer, start_date: '2026-03-15', anchor_day: 15, price: [metricPrice] })
  await api('usage.submit', { events: [
    { event_id: 'rev001-max-march', customer: 'REV001-METRIC', meter: 'rev001-maximum-source', quantity: '3', occurred_at: '2026-03-20T12:00:00-07:00' },
    { event_id: 'rev001-max-april', customer: 'REV001-METRIC', meter: 'rev001-maximum-source', quantity: '7', occurred_at: '2026-04-05T12:00:00-07:00' },
  ] })
  const measured = await issue(metricCustomer, '2026-03', '2026-04-15')
  assert.equal(measured.invoice.subtotal_cents, 7, 'nonadditive maximum is billed once, never summed across months')
  const metricSchedule = measured.source.schedules.find(row => row.kind === 'metric_usage')
  assert.deepEqual(entries(metricSchedule), [['2026-03', 2], ['2026-04', 5]], '3:7 monthly weights allocate seven already-rounded cents by largest remainder')
  assert.deepEqual(metricSchedule.entries.flatMap(row => row.basis.weight.eventIds), ['rev001-max-march', 'rev001-max-april'])
  return { commitment: committed.invoice.id, cancellation: cancelled.invoice.id, metric: measured.invoice.id }
}
