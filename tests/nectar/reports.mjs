// RPT-003: public-door report -> invoice contribution -> line -> saved events.
import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'

export async function reportsFlow(h, owner) {
  const before = await h.api('business', owner)
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: '8.25', tax_note: 'Reviewed report reconciliation scenario' })
  await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
  const customer = (await h.api('customer.create', owner, { external_id: 'RPT003-RIVER', name: 'Riverstone Analytics', billing_email: 'ap@riverstone.example', address: '400 Market Street, San Francisco, CA' })).id
  const other = (await h.api('customer.create', owner, { external_id: 'RPT003-OTHER', name: 'Seabrook Research', billing_email: 'billing@seabrook.example' })).id
  const meter = (await h.api('meter.create', owner, { code: 'rpt003-events', name: 'Analytics events', unit_label: 'events' })).id
  const price = async (code, name, kind, amount) => {
    const product = (await h.api('product.create', owner, { code, name })).id
    return (await h.api('price.create', owner, { product, kind, unit_amount: amount, ...(kind === 'unit' ? { meter } : {}), taxable: true })).id
  }
  const flat = await price('rpt003-base', 'Analytics platform', 'flat', '100')
  const seats = await price('rpt003-seats', 'Analyst seats', 'seat', '20')
  const usage = await price('rpt003-usage', 'Analytics processing', 'unit', '0.012345')
  const subscription = (await h.api('subscription.create', owner, { customer, start_date: '2026-01-01', price: [flat, seats, usage], quantity: ['', '2', ''] })).id
  await h.api('subscription.create', owner, { customer: other, start_date: '2026-01-01', price: [usage] })
  for (const [kind, value] of [['discount_percent', '10'], ['fixed_credit', '5']]) {
    const amendment = await h.api('amendment.propose', owner, { subscription, kind, value, effective_from: '2026-01-01', note: 'Signed annual agreement', clause: 'Discount and launch credit under the order form' })
    await h.api('amendment.decide', owner, { amendment: amendment.amendment, decision: 'approved' })
  }
  await h.api('charge.add', owner, { customer, subscription, amount: '25', description: 'Data onboarding', effective_date: '2026-01-01', taxable: true })
  await h.api('usage.submit', owner, { events: [
    { event_id: 'RPT003-1000', customer: 'RPT003-RIVER', meter: 'rpt003-events', quantity: '1000', occurred_at: '2026-01-09T10:00:00-08:00' },
    { event_id: 'RPT003-HALF', customer: 'RPT003-RIVER', meter: 'rpt003-events', quantity: '0.5', occurred_at: '2026-01-31T23:30:00-08:00' },
    { event_id: 'RPT003-FOREIGN', customer: 'RPT003-OTHER', meter: 'rpt003-events', quantity: '9000', occurred_at: '2026-01-09T10:00:00-08:00' },
  ] })
  const run = await h.api('billrun.prepare', owner, { period: '2026-01' })
  const runView = await h.api(`runs/${run.id}`, owner)
  const invoiceId = runView.invoices.find(i => i.customer_id === customer).id
  const otherDraft = runView.invoices.find(i => i.customer_id === other).id
  assert.equal((await h.api(`reports/mrr?period=2026-01&customer=${customer}`, owner)).totalCents, 0, 'drafts contribute nothing')
  await h.api('invoice.approve', owner, { invoice: invoiceId, acknowledge: true })
  await h.api('invoice.finalise', owner, { invoice: invoiceId, issue_date: '2026-02-01' })
  const invoice = await h.api(`invoices/${invoiceId}`, owner)
  // Independent expected cents: 100 + 40 + round(1000.5 * .012345) - 14 - 5 + 25.
  assert.deepEqual([invoice.subtotal_cents, invoice.tax_cents, invoice.total_cents], [15835, 1306, 17141])
  // DEV-002: expansions return the same scoped records in place of relationship ids.
  assert.equal(invoice.customer, customer)
  assert.equal(invoice.lines.find(l => l.kind === 'usage').price, usage)
  const expanded = await h.api(`invoices/${invoiceId}?expand=customer,lines.price`, owner)
  assert.equal(expanded.customer.id, customer)
  assert.equal(expanded.customer.external_id, 'RPT003-RIVER')
  assert.equal(expanded.lines.find(l => l.kind === 'usage').price.id, usage)
  assert.equal(expanded.lines.find(l => l.kind === 'usage').price.unit_amount, '0.012345')
  assert.equal(expanded.lines.find(l => l.kind === 'seat').price.id, seats)
  assert.equal(expanded.lines.find(l => l.kind === 'credit').price, null)
  assert.deepEqual(expanded.calculation, invoice.calculation)
  assert.equal(expanded.total_cents, invoice.total_cents)
  const customerOnly = await h.api(`invoices/${invoiceId}?expand=customer`, owner)
  assert.equal(customerOnly.customer.id, customer)
  assert.equal(customerOnly.lines.find(l => l.kind === 'usage').price, usage)
  await h.api(`invoices/${invoiceId}?expand=customer,private`, owner, undefined, 400)
  await h.api(`invoices/${invoiceId}?expand=lines.price`, undefined, undefined, 401)
  await h.api(`invoices/no-such-invoice?expand=customer`, owner, undefined, 404)
  const original = structuredClone(invoice.calculation)
  await h.api('credit.issue', owner, { invoice: invoiceId, amount: '10', reason: 'January service adjustment' })
  const payment = await h.api('payment.record', owner, { customer, amount: '20', received_on: '2026-02-05', method: 'bank_transfer', reference: 'RPT003-WIRE', evidence: 'Bank statement February 5' })
  await h.api('payment.allocate', owner, { invoice: invoiceId, payment: payment.payment, amount: '20' })
  const paths = [], linePaths = []
  for (const [metric, month, expected] of [['mrr', '2026-01', 13835], ['billings', '2026-02', 17141], ['ar', '2026-02', 14141]]) {
    const path = `/app/reports/${metric}?period=${month}&customer=${customer}`
    paths.push(path)
    const r = await h.api(path.replace('/app/', ''), owner)
    assert.equal(r.totalCents, expected, `${metric} independent expected cents`)
    assert.equal(r.entries.reduce((sum, entry) => sum + entry.amountCents, 0), expected)
    assert.deepEqual(r.entries.map(entry => entry.invoiceId), [invoiceId])
    const html = await h.page(path, owner)
    assert.ok(html.includes(r.entries[0].href.replaceAll('&', '&amp;')))
    const contributionPath = r.entries[0].href
    paths.push(contributionPath)
    const contribution = await h.api(contributionPath.replace('/app/', ''), owner)
    assert.equal(contribution.totalCents, expected)
    assert.equal(contribution.components.reduce((sum, c) => sum + c.amountCents, 0), expected)
    const contributionHtml = await h.page(contributionPath, owner)
    const metered = contribution.components.find(c => c.lineId === invoice.lines.find(l => l.kind === 'usage').id)
    assert.ok(metered.href && contributionHtml.includes(metered.href))
    const evidence = await h.api(metered.href.replace('/app/', ''), owner)
    assert.equal(evidence.line.amount_cents, 1235)
    assert.equal(evidence.quantity, '1000.50')
    assert.deepEqual(evidence.events.map(e => e.eventId), ['RPT003-1000', 'RPT003-HALF'])
    assert.equal(evidence.events.some(e => e.eventId === 'RPT003-FOREIGN'), false)
    assert.deepEqual(evidence.calculation.inputs, original.inputs)
    assert.equal(evidence.calculation.fingerprint, invoice.source_fingerprint)
    linePaths.push(metered.href)
    await h.page(metered.href, owner)
    const flatComponent = contribution.components.find(c => c.lineId === invoice.lines.find(l => l.kind === 'flat').id)
    const fixed = await h.api(flatComponent.href.replace('/app/', ''), owner)
    assert.deepEqual(fixed.events, [])
    assert.ok(fixed.relatedLines.some(l => l.href === metered.href))
    linePaths.push(flatComponent.href)
    if (metric === 'ar') {
      assert.deepEqual(contribution.components.filter(c => ['credit_note', 'allocation'].includes(c.kind)).map(c => c.amountCents).sort((a, b) => a - b), [-2000, -1000])
    }
  }
  const unallocated = await h.api('payment.record', owner, { customer, amount: '7', received_on: '2026-02-06', method: 'check', reference: 'RPT003-UNALLOCATED', evidence: 'Check awaiting invoice allocation' })
  const collectionPath = `/app/reports/collections?period=2026-02&customer=${customer}`
  const collected = await h.api(collectionPath.replace('/app/', ''), owner)
  assert.equal(collected.totalCents, 2700)
  assert.equal(collected.entries.reduce((sum, e) => sum + e.amountCents, 0), 2700)
  assert.equal(collected.entries.length, 2)
  paths.push(collectionPath)
  for (const entry of collected.entries) {
    paths.push(entry.href)
    const source = await h.api(entry.href.replace('/app/', ''), owner)
    assert.equal(source.components.reduce((sum, c) => sum + c.amountCents, 0), source.totalCents)
    assert.equal(source.totalCents, entry.amountCents)
    assert.equal(source.payment.reference, entry.number)
    assert.ok(source.payment.evidence)
    const sourcePage = await h.page(entry.href, owner)
    for (const component of source.components) assert.ok(sourcePage.includes(component.href.replaceAll('&', '&amp;')))
    if (entry.paymentId === payment.payment) assert.ok(source.components.some(c => c.href.includes(invoiceId)))
    if (entry.paymentId === unallocated.payment) assert.equal(source.components[0].amountCents, 700)
  }
  assert.equal((await h.api(`reports/billings?period=2026-01&customer=${customer}`, owner)).totalCents, 0, 'billings use issue month')
  assert.equal((await h.api(`reports/mrr?period=2026-02&customer=${customer}`, owner)).totalCents, 0, 'MRR uses service-period start month')
  const age = await h.api('ageing', owner)
  const ownAge = age.invoices.find(i => i.id === invoiceId)
  assert.equal((await h.api(`reports/ar?customer=${customer}&bucket=${encodeURIComponent(ownAge.bucket)}`, owner)).totalCents, ownAge.balance_cents)
  assert.equal((await h.api(`reports/ar?customer=${customer}&bucket=current`, owner)).totalCents, 0)
  await h.api(`reports/ar/${otherDraft}`, owner, undefined, 404)
  await h.api(`reports/mrr/${invoiceId}?period=2026-01&customer=${other}`, owner, undefined, 404)
  await h.api(`invoices/${otherDraft}/lines/${invoice.lines[0].id}`, owner, undefined, 404)
  await h.api('reports/unknown', owner, undefined, 400)
  await h.api('reports/mrr?period=2026-13', owner, undefined, 400)
  await h.api('reports/ar?bucket=invalid', owner, undefined, 400)
  for (const path of [...paths, ...new Set(linePaths)]) {
    assert.equal((await h.raw(path)).status, 303)
    assert.equal((await h.raw(path.replace('/app/', '/api/nectar/'))).status, 401)
  }
  // Each aggregate agrees with its source invoices, not only this customer's row.
  const arPage = await h.page('/app/receivables', owner)
  assert.ok(arPage.includes('/app/reports/ar?customer='))
  const runPage = await h.page(`/app/billing/${run.id}`, owner)
  assert.ok(runPage.includes('href="#drafts"'))
  assert.ok(runPage.includes(`/app/invoices/${invoiceId}#lines`))
  const billingPage = await h.page('/app/billing', owner)
  for (const metric of ['mrr', 'billings', 'ar']) assert.ok(billingPage.includes(`/app/reports/${metric}`))
  const month = (await h.api('reports/ar', owner)).period.slice(0, 7)
  const currentCollections = await h.api(`reports/collections?period=${month}`, owner)
  const allPayments = await h.api('payments', owner)
  assert.equal(currentCollections.totalCents, allPayments.filter(p => p.received_on.startsWith(month) && p.received_on <= (new Date().toLocaleDateString('en-CA', { timeZone: before.timezone }))).reduce((sum, p) => sum + p.amount_cents, 0))
  const allAr = await h.api('reports/ar', owner)
  assert.equal(allAr.totalCents, (await h.api('ageing', owner)).totals.total)
  assert.equal(allAr.entries.some(i => i.invoiceId === otherDraft), false)
  await h.api('usage.submit', owner, { events: [{ event_id: 'RPT003-LATER', customer: 'RPT003-RIVER', meter: 'rpt003-events', quantity: '100', occurred_at: '2026-02-09T10:00:00-08:00' }] })
  const frozen = await h.api(linePaths[0].replace('/app/', ''), owner)
  assert.deepEqual(frozen.events.map(e => e.eventId), ['RPT003-1000', 'RPT003-HALF'])
  assert.deepEqual(frozen.calculation.inputs, original.inputs)
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: before.tax_jurisdiction, tax_mode: before.tax_mode, tax_rate: before.tax_rate, tax_note: before.tax_note })
  await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
  console.log('RPT-003 MRR, billings and AR reconcile through invoice lines to immutable usage evidence passed')
  return { customer, invoiceId, run: run.id, paths: [...paths, ...new Set(linePaths)] }
}
