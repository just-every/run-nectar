// REV-002 through public doors: finance closes months; each close freezes the
// roll-forward, journals and billings/collections/revenue packet and posts
// summarized journals to the ledger at a synthetic QuickBooks edge. Credits and
// invoices that arrive for a closed month are reported in the open month, and
// the closed month's revenue, journal and CSV stay byte-for-byte unchanged.
import assert from 'node:assert/strict'
import { quickbooksEdge } from './quickbooks-edge.mjs'

let edge
export const harnessOptions = () => { edge = quickbooksEdge(); return { quickbooksFetch: edge.fetch, localTime: '2026-10-05T20:00:00Z' } }

export async function periodCloseFlow(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  await h.api('access.give', owner, { email: 'close-finance@example.test', name: 'Casey Close', role: 'finance' })
  await h.api('access.give', owner, { email: 'close-accountant@example.test', name: 'Alex Close', role: 'accountant' })
  await h.api('access.give', owner, { email: 'close-collections@example.test', name: 'Cory Close', role: 'collections' })
  const finance = await h.signIn('close-finance@example.test', { requested: true })
  const accountant = await h.signIn('close-accountant@example.test', { requested: true })
  const collections = await h.signIn('close-collections@example.test', { requested: true })
  const agent = { bearer: (await api('credential.issue', { name: 'Close agent', scopes: ['prepare'] })).key }
  const customer = (await api('customer.create', { external_id: 'REV002', name: 'Fieldstone Analytics', billing_email: 'ap@fieldstone.example' })).id
  const product = (await api('product.create', { code: 'rev002-platform', name: 'Close platform' })).id
  const price = (await api('price.create', { product, kind: 'flat', unit_amount: '2000.00', taxable: false })).id
  await api('subscription.create', { customer, start_date: '2026-08-01', anchor_day: '1', price: [price] })
  const issue = async (period, issue_date) => {
    const run = await api('billrun.prepare', { period })
    const draft = (await api(`runs/${run.id}`)).invoices.find(row => row.customer_id === customer)
    await api('invoice.approve', { invoice: draft.id, acknowledge: true })
    await api('invoice.finalise', { invoice: draft.id, issue_date })
    return draft.id
  }
  const august = await issue('2026-08', '2026-09-01')
  await issue('2026-09', '2026-10-01')
  const paid = (await api('payment.record', { customer, amount: '1500.00', received_on: '2026-09-15', method: 'bank_transfer', reference: 'REV002-WIRE' })).payment
  await api('payment.allocate', { payment: paid, invoice: august, amount: '1500.00' })
  const months = async (query = 'from=2026-08&to=2026-11') => (await api(`revenue?${query}`)).months
  const row = m => [m.period, m.openingCents, m.billingsCents, m.creditsCents, m.recognizedCents, m.closingCents]
  const text = async path => (await h.raw(path, { cookie: owner })).text()
  const ties = list => list.forEach(m => assert.equal(m.openingCents + m.netBillingsCents - m.recognizedCents, m.closingCents, `${m.period} opening + billings - revenue = closing`))
  const before = await months(); ties(before)
  const augustSchedules = (await api(`revenue/${august}`)).schedules
  assert.deepEqual(before.slice(0, 3).map(row), [['2026-08', 0, 0, 0, 200000, -200000], ['2026-09', -200000, 200000, 0, 200000, -200000], ['2026-10', -200000, 200000, 0, 0, 0]])
  assert.ok(before.every(m => m.closed === false))
  const septJournalBefore = await text('/app/exports/revenue-journal.csv?period=2026-09'), septCsvBefore = await text('/app/exports/revenue.csv?period=2026-09')

  // Who may close, and which months.
  for (const who of [accountant, collections, agent]) await h.api('revenue.close', who, { period: '2026-08' }, 403)
  await h.api('revenue.close', undefined, { period: '2026-08' }, 401)
  await api('revenue.close', { period: '2026-10' }, 409)
  await api('revenue.close', { period: '2027-01' }, 409)
  await api('revenue.close', { period: 'September' }, 400)
  assert.deepEqual((await api('period-closes')).closes, [])
  assert.deepEqual(edge.summary(), [])

  const closedAugust = await api('revenue.close', { period: '2026-08' })
  assert.deepEqual(closedAugust.postings.map(p => p.status), ['posted'])
  await h.api('revenue.close', finance, { period: '2026-08' }, 409)
  await api('revenue.close', { period: '2026-10' }, 409)
  const closedSeptember = await h.api('revenue.close', finance, { period: '2026-09' })
  assert.deepEqual(closedSeptember.rollforward, { openingCents: -200000, billingsCents: 200000, creditsCents: 0, netBillingsCents: 200000, recognizedCents: 200000, closingCents: -200000, accruedContractAssetCents: 200000, deferredLiabilityCents: 0 })
  assert.deepEqual(edge.summary(), ['D:91:2000.00 C:93:2000.00', 'D:90:2000.00 C:93:2000.00'], 'each close posts its balanced summarized journal')
  assert.equal(edge.entries[1].TxnDate, '2026-09-30')

  const packet = (await api('period-closes/2026-09')).closes[0]
  assert.equal(packet.packet.journals[0].entries.length, 2)
  assert.deepEqual([packet.packet.reports.billings.totalCents, packet.packet.reports.collections.totalCents], [200000, 150000], 'the packet freezes the billings and collections reports')
  assert.deepEqual((await api('period-closes')).closes.map(c => c.period), ['2026-08', '2026-09'])
  assert.deepEqual([(await api('period-closes')).through, (await api('period-closes')).open], ['2026-09', '2026-10'])
  assert.equal((await months()).filter(m => m.closed).length, 2)
  assert.equal(await text('/app/exports/revenue-journal.csv?period=2026-09'), septJournalBefore, 'closing changes no journal')

  // Later changes post to the open month: a credit on a closed month's invoice, and an invoice dated inside it.
  const credit = await api('credit.issue', { invoice: august, amount: '100.00', reason: 'Late service credit for a closed month' })
  const charge = (await api('charge.add', { customer, amount: '300', description: 'Late September workshop', taxable: false, effective_date: '2026-09-10' })).charge
  const late = (await api('invoice.manual', { customer, charges: [charge], service_date: '2026-09-10' })).id
  await api('invoice.approve', { invoice: late, acknowledge: true })
  await api('invoice.finalise', { invoice: late, issue_date: '2026-09-20' })
  const after = await months(); ties(after)
  assert.deepEqual(after.slice(0, 2).map(row), before.slice(0, 2).map(row), 'closed months are unchanged')
  assert.equal(await text('/app/exports/revenue-journal.csv?period=2026-09'), septJournalBefore, 'the closed journal CSV is byte-identical')
  assert.equal(await text('/app/exports/revenue.csv?period=2026-09'), septCsvBefore, 'the closed revenue CSV is byte-identical')
  assert.deepEqual(row(after[2]), ['2026-10', -200000, 230000, -10000, 20000, 0], 'October carries the late invoice and the credit')
  assert.equal(after[2].openingCents, before[1].closingCents, 'the open month opens at the closed month')
  const contributions = (await api('revenue?period=2026-10')).contributions
  assert.deepEqual(contributions.filter(c => c.adjustedFrom).map(c => [c.kind, c.adjustedFrom, c.amountCents]), [['billing', '2026-09', 30000], ['recognition', '2026-09', 30000]])
  assert.deepEqual(contributions.filter(c => c.kind.startsWith('credit')).map(c => [c.period, c.number, c.amountCents]), [['2026-10', credit.number, -10000], ['2026-10', credit.number, -10000]], 'the credit posts in October')
  const source = await api(`revenue/${late}`)
  assert.ok(source.contributions.every(c => c.period === '2026-10' && c.adjustedFrom === '2026-09'), 'the source shows the open month and the month it was dated in')
  const octCsv = await text('/app/exports/revenue.csv?period=2026-10')
  assert.match(octCsv, /credit-billing,2026-10/)
  assert.deepEqual(edge.summary().length, 2, 'later changes post nothing into closed months')

  // AGENT-002: a reviewed credit on a closed month's invoice previews and approves into the open month only.
  const original = await api(`invoices/${august}`), line = original.lines[0]
  const input = { invoice_credit: true, invoice: august, amount: '50.00', reason: 'Seat correction after close',
    explanation: 'The reviewed requirement was 1 seat fewer; the excess is $50.00.', subject: `Correction for ${original.number}`,
    body: `The reviewed requirement was 1 seat fewer; the excess is $50.00.\nA $50.00 credit reduces the amount owed. The original invoice remains unchanged.`,
    citations: [{ line_id: line.id, source: `/app/invoices/${august}/lines/${line.id}`, quote: line.description }] }
  const proposal = (await h.api('proposal.create', agent, { kind: 'amendment', title: input.reason, payload: input })).id
  const preview = (await api(`proposals/${proposal}`)).impact.revenue
  assert.equal(preview.issueMonth, '2026-10', 'the correction posts in the open month')
  assert.deepEqual(preview.periods.filter(row => row.deltaCents !== 0).map(row => [row.period, row.deltaCents]), [['2026-10', -5000]])
  await h.api('proposal.decide', agent, { proposal, decision: 'approved' }, 403)
  await api('proposal.decide', { proposal, decision: 'approved' })
  const corrected = await months(); ties(corrected)
  assert.deepEqual(corrected.slice(0, 2).map(row), before.slice(0, 2).map(row), 'closed months survive the approved correction')
  assert.equal(corrected[2].creditsCents, -15000)
  assert.equal(await text('/app/exports/revenue-journal.csv?period=2026-09'), septJournalBefore)
  assert.deepEqual((await api(`revenue/${august}`)).schedules, augustSchedules, 'REV-001 issued schedules are immutable across close, credits and corrections')

  // The open month closes with its adjustments; an outage queues the posting and a retry posts it once.
  await h.advanceClock('2026-11-05T20:00:00Z')
  edge.setOutage('down')
  const closedOctober = await api('revenue.close', { period: '2026-10' })
  assert.deepEqual(closedOctober.postings.map(p => [p.status, p.error]), [['pending', 'ledger_unavailable']])
  assert.deepEqual(closedOctober.rollforward, { openingCents: -200000, billingsCents: 230000, creditsCents: -15000, netBillingsCents: 215000, recognizedCents: 15000, closingCents: 0, accruedContractAssetCents: 0, deferredLiabilityCents: 0 })
  edge.setOutage('lost')
  assert.equal((await api('ledger.post', {})).postings[0].status, 'pending')
  edge.setOutage(null)
  assert.deepEqual((await api('ledger.post', {})).postings.map(p => p.status), ['posted'])
  assert.deepEqual(edge.summary(), ['D:91:2000.00 C:93:2000.00', 'D:90:2000.00 C:93:2000.00', 'D:90:2150.00 C:91:2000.00 C:93:150.00'], 'the October close posts once, with the late invoice and both credits')
  assert.equal((await api('period-closes/2026-10')).closes[0].postings[0].ledgerRef, 'synthetic-je-3')
  // After October closed, a new credit posts in November and October stays put.
  const octoberFrozen = (await months()).find(m => m.period === '2026-10')
  await api('credit.issue', { invoice: august, amount: '10.00', reason: 'November credit' })
  const november = await months()
  assert.deepEqual(row(november.find(m => m.period === '2026-10')), row(octoberFrozen))
  assert.deepEqual([november.find(m => m.period === '2026-11').creditsCents], [-1000])
  // AGENT-002: a draft correction of the closed October names the open month it will post in.
  const subscription = (await api('customers/' + customer)).subscriptions[0].id
  const amendment = (await h.api('proposal.create', agent, { kind: 'amendment', title: 'Discount for closed October', payload: { subscription, kind: 'discount_percent', value: '10', effective_from: '2026-10-01', effective_to: '2026-11-01', note: 'Reviewed October discount' }, evidence: { clauses: [{ quote: 'From 1 October 2026 the recurring platform fee is reduced by ten percent.', reference: 'Executed renewal, section 2' }] } })).id
  const draftImpact = (await api(`proposals/${amendment}`)).impact
  assert.deepEqual(draftImpact[0].revenueDeltas, [{ period: '2026-10', beforeCents: 200000, afterCents: 180000, deltaCents: -20000, postsIn: '2026-11' }], 'the reviewed correction names the open month it posts in')
  await api('proposal.decide', { proposal: amendment, decision: 'approved' })
  const lateOctober = await issue('2026-10', '2026-11-01')
  const settled = await months(); ties(settled)
  assert.deepEqual(row(settled.find(m => m.period === '2026-10')), row(octoberFrozen), 'the closed October is unchanged by its own late invoice')
  const novemberRow = settled.find(m => m.period === '2026-11')
  assert.deepEqual([novemberRow.billingsCents, novemberRow.recognizedCents], [180000, 180000 - 1000], 'the late October service is recognized in November')
  assert.ok((await api('revenue?period=2026-11')).contributions.some(c => c.invoiceId === lateOctober && c.adjustedFrom === '2026-10'))
  const page = await h.page('/app/revenue?from=2026-08&to=2026-11', owner)
  assert.match(page, /Period close/)
  assert.deepEqual((await api('period-closes')).closes.map(c => c.period), ['2026-08', '2026-09', '2026-10'])
}

// REV-001 inheritance with a nonzero deferred position: an annual advance fee is
// closed month by month; the deferred journal, roll-forward and frozen packet tie.
export async function periodCloseDeferredFlow(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const customer = (await api('customer.create', { external_id: 'REV002-ANNUAL', name: 'Longfield Annual Prepay', billing_email: 'ap@longfield.example' })).id
  const product = (await api('product.create', { code: 'rev002-annual', name: 'Annual platform' })).id
  const price = (await api('price.create', { product, kind: 'flat', unit_amount: '1200.00', taxable: false, billing_interval: 'annual', billing_timing: 'advance' })).id
  await api('subscription.create', { customer, start_date: '2026-08-01', billing_anchor_date: '2026-08-01', price: [price] })
  const run = await api('billrun.prepare', { period: '2026-08' })
  const draft = (await api(`runs/${run.id}`)).invoices.find(row => row.customer_id === customer)
  await api('invoice.approve', { invoice: draft.id, acknowledge: true })
  await api('invoice.finalise', { invoice: draft.id, issue_date: '2026-08-01' })
  const months = async () => (await api('revenue?from=2026-08&to=2026-10')).months
  const row = m => [m.period, m.openingCents, m.billingsCents, m.creditsCents, m.recognizedCents, m.closingCents, m.deferredLiabilityCents]
  const before = await months()
  assert.deepEqual(before.map(row), [['2026-08', 0, 120000, 0, 10000, 110000, 110000], ['2026-09', 110000, 0, 0, 10000, 100000, 100000], ['2026-10', 100000, 0, 0, 10000, 90000, 90000]])
  const schedules = (await api(`revenue/${draft.id}`)).schedules
  const journalBefore = await (await h.raw('/app/exports/revenue-journal.csv?period=2026-09', { cookie: owner })).text()
  await api('revenue.close', { period: '2026-08' })
  await api('revenue.close', { period: '2026-09' })
  assert.deepEqual(edge.summary(), ['D:90:1200.00 C:92:1100.00 C:93:100.00', 'D:92:100.00 C:93:100.00'], 'deferred revenue posts to the ledger and releases month by month')
  const closed = (await api('period-closes/2026-09')).closes[0].packet
  assert.deepEqual([closed.rollforward.closingCents, closed.rollforward.deferredLiabilityCents], [100000, 100000])
  // A credit against the closed annual fee posts in October; closed months and the issued schedule stay put.
  await api('credit.issue', { invoice: draft.id, amount: '60.00', reason: 'Annual fee goodwill after close' })
  const after = await months()
  assert.deepEqual(after.slice(0, 2).map(row), before.slice(0, 2).map(row))
  assert.deepEqual([after[2].creditsCents, after[2].openingCents], [-6000, 100000])
  for (const m of after) assert.equal(m.openingCents + m.netBillingsCents - m.recognizedCents, m.closingCents)
  assert.equal(await (await h.raw('/app/exports/revenue-journal.csv?period=2026-09', { cookie: owner })).text(), journalBefore)
  assert.deepEqual((await api(`revenue/${draft.id}`)).schedules, schedules)
}
