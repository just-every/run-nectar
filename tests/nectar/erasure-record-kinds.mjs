import assert from 'node:assert/strict'
import { file } from './harness.mjs'
import { applyPolicy, reviewer } from './policy-helper.mjs'

// Populate current customer record families through their ordinary HTTP doors.
// The caller owns erasure assertions and the final archive/restore proof.
export async function populateErasureKinds(h, owner, customer) {
  const customerRecord = await h.api(`customers/${customer}`, owner)
  const privateValues = [
    'Gov005 usage person Aurelia Privateusage',
    'Gov005 signed amendment privateagreement',
    'Gov005 certificate person Berenice Privatecertificate',
    'Gov005 proposed discount privateproposal',
    'Gov005 executed source person Celeste Privatesource',
    'Gov005 renewal contact Daphne Privaterenewal',
    'Gov005 pause reason Estelle Privatelifecycle',
  ]
  const api = (path, payload) => h.api(path, owner, payload)
  const meterCode = 'gov005-family-events'
  const meter = (await api('meter.create', { code: meterCode, name: 'Erasure family events', unit_label: 'events' })).id
  const prices = []
  for (const [code, kind, unit_amount] of [['platform', 'flat', '50'], ['events', 'unit', '0.01']]) {
    const product = (await api('product.create', { code: `gov005-family-${code}`, name: `Erasure family ${code}` })).id
    prices.push((await api('price.create', { product, kind, unit_amount, taxable: false, ...(kind === 'unit' ? { meter } : {}) })).id)
  }
  const subscription = (await api('subscription.create', { customer, start_date: '2026-01-01', price: prices })).id
  const event = 'gov005-family-private-event'
  const submitted = await api('usage.submit', { events: [{
    event_id: event, customer: customerRecord.external_id, meter: meterCode, quantity: '7.5', occurred_at: '2026-01-15T12:00:00-08:00',
    properties: { person: privateValues[0], email: customerRecord.billing_email, account: customerRecord.external_id },
  }] })
  assert.equal(submitted.accepted, 1, 'GOV-005 family fixture stores real personal usage properties')

  const amendment = (await api('amendment.propose', {
    subscription, kind: 'discount_percent', value: '5', effective_from: '2026-01-01', effective_to: '2026-02-01', note: privateValues[1], clause: privateValues[1],
  })).amendment
  await api('amendment.decide', { amendment, decision: 'approved' })

  const certificateText = `%PDF-1.4\nTax exemption certificate\n${privateValues[2]}\n${customerRecord.billing_email}\n%%EOF`
  const certificate = (await api('certificate.collect', {
    customer, state: 'CA', reference: 'GOV005-PRIVATE-CERTIFICATE', valid_from: '2026-01-01', expires_on: '2026-12-31',
    file: file('gov005-private-certificate.pdf', certificateText, 'application/pdf'),
  })).certificate
  await api('certificate.review', { certificate, decision: 'validated', review_note: privateValues[2] })
  privateValues.push(Buffer.from(certificateText).toString('base64'))

  const pendingAmendment = (await api('proposal.create', {
    kind: 'amendment', title: privateValues[3], payload: { subscription, kind: 'discount_percent', value: '10', effective_from: '2026-03-01', note: privateValues[3] },
    evidence: { clauses: [{ quote: privateValues[3], reference: 'Buyer-recorded agreement, section 2' }] },
  })).id
  const sourceText = `${privateValues[4]}. ${customerRecord.name}, billing email ${customerRecord.billing_email}, requests a separate monthly service from 2026-03-01 through 2026-04-01. Platform costs USD 50 per month, monthly in arrears, Net 30. Signed buyer record GOV005.`
  const sourceProposal = (await api('proposal.create', {
    kind: 'amendment', title: 'Erasure source-custody example', payload: {
      setup: true,
      source: { name: 'executed-erasure-order.txt', text: sourceText, execution_reference: 'Buyer-recorded GOV005 signature', original: file('executed-erasure-order.txt', sourceText, 'text/plain') },
      customer: { id: customer, quote: sourceText },
      catalog: [{ key: 'platform', existing: prices[0], quote: sourceText }],
      subscription: { external_id: 'GOV005-PENDING-SERVICE', start_date: '2026-03-01', months: 1, quote: sourceText },
      items: [{ key: 'platform', price: 'platform', quantity: 1, quote: sourceText }],
      ambiguities: [],
    },
  })).id
  privateValues.push(Buffer.from(sourceText).toString('base64'))

  const term = (await api('term.prepare', {
    subscription, revision: (await api(`subscriptions/${subscription}`)).revision, term_start: '2026-01-01', months: 12,
    auto_renew: true, notice_days: 30, uplift_percent: '0', quote: privateValues[5],
  })).term
  const me = await api('me')
  const hasOtherApprover = (await api('members')).some(member => member.id !== me.id && member.status === 'active' && ['owner', 'finance'].includes(member.role))
  const approver = await reviewer(h, owner, !hasOtherApprover)
  await h.api('term.decide', approver, { term, decision: 'approved', confirm_single: !hasOtherApprover })
  const renewalPath = new URL((await api('term.link', { term })).cancelUrl).pathname
  const lifecycle = (await api('subscription.pause', {
    subscription, revision: (await api(`subscriptions/${subscription}`)).revision, effective_date: '2026-02-01', resume_date: '2026-03-01', access: 'suspend', reason: privateValues[6],
  })).transition

  // A frozen report carries source names, usage facts and the caller's issued
  // January invoice/payment; leave the disposable installation on February 1.
  await api('report.schedule', { enabled: true, day: 1 })
  const tick = await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse('2026-02-01T16:00:00Z')}&cron=${encodeURIComponent('0 14 * * *')}`)
  assert.equal(tick.status, 200, 'GOV-005 family fixture generates a real scheduled report')
  const report = (await api('report-schedule')).deliveries.find(delivery => delivery.period === '2026-01')
  assert.ok(report, 'GOV-005 family fixture has a frozen January report')
  await api('report.schedule', { enabled: false, day: 1 })

  return {
    privateValues, subscription, meter, prices, event, usageBatch: submitted.batch,
    amendment, certificate, pendingAmendment, sourceProposal, term, renewalPath, lifecycle, report: report.id,
    receiptKinds: ['nc_subscriptions', 'nc_usage_events', 'nc_amendments', 'nc_certificates', 'nc_proposals', 'nc_renewal_terms', 'nc_subscription_lifecycle', 'nc_report_deliveries'],
  }
}

// Native CAT-001 / SET-001 / SUB-003/005 records must inherit GOV-005 through
// real offer acceptance, issued money, privacy custody and statutory removal.
export async function nativeIntervalErasureFlow(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const marker = 'synthetic-nectar-private-interval-1'
  await h.advanceClock('2026-01-01T16:00:00Z')
  await api('business.configure', { ...(await api('business')), timezone: 'UTC' })
  await api('access.give', { email: 'synthetic-nectar-interval-finance@example.test', name: 'Synthetic interval finance', role: 'finance' })
  const finance = await h.signIn('synthetic-nectar-interval-finance@example.test', { requested: true })
  await applyPolicy(h, owner, 'credit.policy', { two_person_above: '100' })
  await applyPolicy(h, owner, 'lifecycle.policy', { credit_unused: true, reactivation_days: 30 })
  const entity = (await api('entity.create', { revision: (await api('business')).revision,
    legal_name: 'Synthetic Interval Issuer LLC', address: '192 Synthetic Business Way, CA, US', ein: '92-3456789',
    invoice_prefix: 'SYNINTERVAL', invoice_number_width: 4, payment_terms_days: 45,
    processor_account_ref: 'synthetic-nectar-interval-processor', ledger_company_ref: 'synthetic-nectar-interval-ledger', tax_registration: 'Synthetic business tax registration' })).id
  const customer = (await api('customer.create', { external_id: marker, name: 'Synthetic Interval Legal Customer LLC',
    billing_email: `${marker}@example.test`, address: `${marker} personal address`,
    invoice_settings: { memo: marker, customFields: { 'Private reference': marker } } })).id
  await api('customer.entity', { revision: (await api('business')).revision, customer, entity, confirm: true })
  const entityBefore = (await api('billing-entities')).entities.find(row => row.id === entity)
  const platform = (await api('product.create', { code: 'synthetic-nectar-interval-privacy-platform', name: 'Synthetic annual privacy platform' })).id
  const annual = (await api('price.create', { product: platform, kind: 'flat', unit_amount: '1200', taxable: false, billing_interval: 'annual', billing_timing: 'advance' })).id
  const meter = (await api('meter.create', { code: 'synthetic-nectar-interval-privacy-usage', name: 'Synthetic interval privacy calls', unit_label: 'calls' })).id
  const usageProduct = (await api('product.create', { code: 'synthetic-nectar-interval-privacy-usage', name: 'Synthetic monthly privacy usage' })).id
  const usage = (await api('price.create', { product: usageProduct, kind: 'unit', meter, unit_amount: '2', taxable: false })).id
  const subscription = (await api('subscription.create', { customer, start_date: '2025-01-01', billing_anchor_date: '2025-01-01', price: [annual, usage] })).id
  const detail = () => api(`subscriptions/${subscription}`)
  assert.equal((await detail()).billing_anchor_date, '2025-01-01')
  assert.equal((await detail()).items.length, 2)
  assert.equal((await api('usage.submit', { events: [
    { event_id: `${marker}-november`, customer: marker, meter, quantity: '7', occurred_at: '2025-11-15T12:00:00Z', properties: { person: marker } },
    { event_id: `${marker}-december`, customer: marker, meter, quantity: '10', occurred_at: '2025-12-15T12:00:00Z', properties: { person: marker } },
  ] })).accepted, 2)
  const issueDue = async month => {
    const run = await api('billrun.prepare', { period: month }), issued = []
    for (const draft of (await api(`runs/${run.id}`)).invoices.filter(row => row.customer_id === customer)) {
      const before = await api(`invoices/${draft.id}`)
      await api('invoice.approve', { invoice: draft.id, acknowledge: true })
      await api('invoice.finalise', { invoice: draft.id, issue_date: before.calculation.inputs.billing.dueDate })
      issued.push(await api(`invoices/${draft.id}`))
    }
    return issued
  }
  const firstUsage = await issueDue('2025-12')
  assert.deepEqual(firstUsage.map(invoice => invoice.total_cents), [1400])
  const currentPolicy = (await api('retention')).policy
  const retention = await api('retention.policy.prepare', { ...currentPolicy, revision: currentPolicy.revision,
    enabled: true, save_kind: 'discount', save_percent: 50, save_months: 1, save_price_id: annual, winback_enabled: false })
  await h.api('retention.policy.decide', finance, { request: retention.request, decision: 'approved' })
  const term = (await api('term.prepare', { subscription, revision: (await detail()).revision, term_start: '2025-01-01', months: 36,
    auto_renew: true, notice_days: 30, uplift_percent: '0', quote: marker })).term
  await h.api('term.decide', finance, { term, decision: 'approved' })
  const savePath = new URL((await api('term.link', { term })).cancelUrl).pathname
  const offer = (await api('retention')).offers.find(row => row.subscription_id === subscription && row.kind === 'save')
  assert.ok(offer)
  assert.deepEqual([JSON.parse(offer.terms_json).from, JSON.parse(offer.terms_json).to, JSON.parse(offer.terms_json).priceId], ['2026-01-01', '2027-01-01', annual])
  assert.equal((await h.raw(savePath, { form: new URLSearchParams({ confirm: 'save', offer: offer.id, reason: marker }) })).status, 200)
  const january = await issueDue('2026-01'), annualInvoice = january.find(invoice => invoice.lines.some(line => line.price_id === annual))
  assert.ok(annualInvoice)
  assert.equal(annualInvoice.total_cents, 60000)
  assert.equal(annualInvoice.due_date, '2026-02-15', 'The assigned entity supplies actual issued payment terms')
  assert.equal(annualInvoice.billing_entity_id, entity)
  assert.ok(annualInvoice.calculation.inputs.amendments.some(amendment => amendment.priceId === annual && amendment.value === '50'), 'Accepted retention is scoped to the annual price')
  assert.deepEqual(january.filter(invoice => invoice.id !== annualInvoice.id).map(invoice => invoice.total_cents), [2000], 'The annual discount leaves monthly usage fully priced')
  const invoices = [...firstUsage, ...january]
  for (const invoice of invoices) {
    const payment = (await api('payment.record', { customer, amount: (invoice.total_cents / 100).toFixed(2), received_on: '2026-01-02', method: 'bank_transfer', reference: `${marker}-${invoice.id}`, evidence: marker })).payment
    await api('payment.allocate', { payment, invoice: invoice.id, amount: (invoice.total_cents / 100).toFixed(2) })
  }
  await h.advanceClock('2026-07-20T16:00:00Z')
  const cancellation = await api('subscription.cancel', { subscription, revision: (await detail()).revision, mode: 'immediate', effective_date: '2026-07-01', reason: marker })
  assert.equal(cancellation.status, 'pending')
  assert.equal(cancellation.amountCents, 30247, 'The half-year cancellation credits unused service from the actual discounted $600 annual invoice')
  await api('subscription.cancel.decide', { cancellation: cancellation.cancellation, decision: 'approved' }, 409)
  await h.api('subscription.cancel.decide', finance, { cancellation: cancellation.cancellation, decision: 'approved' })
  const before = await Promise.all(invoices.map(invoice => api(`invoices/${invoice.id}`)))
  const credited = before.find(invoice => invoice.id === annualInvoice.id)
  assert.deepEqual(credited.credits.map(note => [note.amount_cents, note.applied_cents]), [[30247, 0]])
  assert.equal((await api(`customers/${customer}`)).ledger.carriedUsageCredits.reduce((sum, credit) => sum + credit.availableCents, 0), 30247)
  const subscriptionBefore = await detail()
  assert.ok(subscriptionBefore.cancellations.some(row => row.id === cancellation.cancellation && row.status === 'approved'))
  assert.ok(before.every(invoice => invoice.calculation.inputs.billing.components.every(component => subscriptionBefore.items.some(item => item.id === component.itemId))), 'Each issued component names a real native subscription item')
  const repeatedRun = await api('billrun.prepare', { period: '2026-01' })
  assert.ok(!(await api(`runs/${repeatedRun.id}`)).invoices.some(invoice => invoice.customer_id === customer), 'Existing component claims prevent duplicate interval invoices')
  const financial = invoice => ({ id: invoice.id, number: invoice.number, status: invoice.status, issue: invoice.issue_date, due: invoice.due_date,
    subtotal: invoice.subtotal_cents, tax: invoice.tax_cents, total: invoice.total_cents, paid: invoice.paidCents, balance: invoice.balanceCents,
    lines: invoice.lines.map(line => [line.id, line.price_id, line.amount_cents, line.period_start, line.period_end]),
    credits: invoice.credits.map(note => [note.id, note.number, note.amount_cents, note.subtotal_cents, note.tax_cents, note.applied_cents, note.issued_at]) })
  const request = await api('erasure.request', { customer })
  await api('erasure.verify', { request: request.id, reason: 'Synthetic independently verified identity', evidence: file('synthetic-identity.txt', marker) })
  const erased = await api('erasure.approve', { request: request.id, confirm: true })
  for (const kind of ['nc_subscriptions', 'nc_usage_events', 'nc_amendments', 'nc_retention_offers', 'nc_renewal_terms', 'nc_interval_cancellations', 'nc_credit_requests', 'nc_credit_notes', 'nc_invoices', 'nc_invoice_lines'])
    assert.ok(erased.receipt.changed.some(row => row.kind === kind && row.records > 0), `Native interval privacy receipt accounts for ${kind}`)
  assert.equal(erased.receipt.retained.until, '2033-07-20')
  const after = await Promise.all(invoices.map(invoice => api(`invoices/${invoice.id}`)))
  assert.deepEqual(after.map(financial), before.map(financial), 'Issued amounts, dates, line/item identity, service periods, allocations and cancellation credit money remain exact')
  const entityAfter = (await api('billing-entities')).entities.find(row => row.id === entity)
  for (const key of ['legal_name', 'address', 'ein', 'payment_terms_days', 'processor_account_ref', 'ledger_company_ref'])
    assert.equal(entityAfter[key], entityBefore[key], 'Workspace issuer identity remains outside customer erasure')
  const projections = [after, await api(`customers/${customer}`), await api('customers'), await api('payments'), await api('retention'), await api('billing-entities'), await api('audit'), await api('erasures')]
  for (const projection of projections) assert.ok(!JSON.stringify(projection).includes(marker), 'Native JSON and audit contain no private interval marker')
  await api(`subscriptions/${subscription}`, undefined, 410)
  await h.page(`/app/subscriptions/${subscription}`, owner, 410)
  assert.equal((await h.raw(savePath)).status, 404)
  for (const path of [`/app/customers/${customer}`, '/app/retention', '/app/numbering', '/app/audit', '/app/erasures', ...invoices.map(invoice => `/app/invoices/${invoice.id}`)])
    assert.ok(!(await h.page(path, owner)).replaceAll('<wbr>', '').includes(marker), 'Native pages omit erased offer/cancellation/invoice data')
  for (const kind of ['customers', 'subscriptions', 'invoices', 'usage']) {
    const response = await h.raw(`/app/exports/${kind}.csv`, { cookie: owner })
    assert.equal(response.status, 200)
    assert.ok(!(await response.text()).includes(marker), 'Native CSV exports omit erased private fields')
  }
  assert.deepEqual((await api('erasure.purge', {})).removed, [])
  await h.advanceClock('2033-07-19T16:00:00Z')
  assert.deepEqual((await api('erasure.purge', {})).removed, [])
  await h.advanceClock('2033-07-20T16:00:00Z')
  assert.deepEqual((await api('erasure.purge', {})).removed, [request.id])
  for (const invoice of invoices) await api(`invoices/${invoice.id}`, undefined, 404)
  assert.equal((await api('payments')).filter(payment => payment.customer_id === customer).length, 0)
  assert.equal((await api(`customers/${customer}`)).ledger.carriedUsageCredits.length, 0)
  const receipt = JSON.parse((await api('erasures')).find(row => row.id === request.id).receipt_json)
  for (const kind of ['nc_billing_components', 'nc_interval_cancel_requests', 'nc_credit_requests', 'nc_credit_notes', 'nc_invoices'])
    assert.ok(receipt.removal.records.some(row => row.kind === kind && row.records > 0), `Due removal removes dependent ${kind}`)
  assert.deepEqual((await api('erasure.purge', {})).removed, [], 'Financial interval removal occurs once')
  assert.equal((await api('audit')).filter(row => row.action === 'erasure.financial.remove' && row.subject === request.id).length, 1)
  console.log('GOV-005 native entity/annual+monthly/scoped retention/cancellation erasure, exact paid custody and once-only due dependency removal passed')
}
