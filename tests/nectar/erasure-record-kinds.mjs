import assert from 'node:assert/strict'
import { file } from './harness.mjs'
import { reviewer } from './policy-helper.mjs'

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
