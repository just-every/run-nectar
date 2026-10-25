import assert from 'node:assert/strict'
import { publishPrice } from './price-helper.mjs'

// AGENT-001 seat and ramp detector: signed terms against issued invoices, through public doors only.
export async function assuranceRampsFlow(h, owner) {
  await h.advanceClock('2026-10-25T12:00:00Z')
  const api = (path, body, status) => h.api(path, owner, body, status)
  const ownerId = (await api('me')).id
  await api('access.give', { email: 'synthetic-nectar-ramp-finance@example.test', name: 'Synthetic ramp finance', role: 'finance' })
  const finance = await h.signIn('synthetic-nectar-ramp-finance@example.test', { requested: true })
  const agent = { bearer: (await api('credential.issue', { name: 'Synthetic ramp investigator', scopes: ['prepare'] })).key }
  const product = (await api('product.create', { code: 'ramp-seats', name: 'Ramp seats' })).id
  const p95 = (await publishPrice(h, owner, { product, kind: 'seat', unit_amount: '95', taxable: false })).id
  const p120 = (await publishPrice(h, owner, { product, kind: 'seat', unit_amount: '120', taxable: false })).id
  const fixture = async (suffix, price, seats) => {
    const customer = (await api('customer.create', { external_id: `ramp-${suffix}`, name: `Synthetic ramp ${suffix}`, billing_email: `ap@ramp-${suffix}.example.test` })).id
    const subscription = (await api('subscription.create', { customer, start_date: '2026-06-01', anchor_day: 1, price: [price], quantity: [String(seats)] })).id
    const read = await api(`subscriptions/${subscription}`)
    return { customer, subscription, item: read.items[0].id, revision: read.revision }
  }
  const prepare = async (f, quantity, label) => (await api('contract.prepare', { subscription: f.subscription, revision: f.revision, clause: `Signed order: ${label}`,
    ramps: [{ item: f.item, effective_date: '2026-07-01', price: p120, quantity }] })).contract
  // A signed $120 ramp never applied (unbilled step), a signed 10-seat reduction never applied (over-billed seat), and a ramp applied correctly.
  const under = await fixture('under', p95, 10), over = await fixture('over', p120, 12), agreed = await fixture('agreed', p95, 10)
  const underContract = await prepare(under, 10, 'seats ramp from $95 to $120 on 1 July 2026')
  await prepare(over, 10, 'seat count reduces from 12 to 10 on 1 July 2026')
  const agreedContract = await prepare(agreed, 10, 'seats ramp from $95 to $120 on 1 July 2026')
  await h.api('contract.decide', finance, { contract: agreedContract, decision: 'approved' })

  const issue = async period => {
    const run = await api('billrun.prepare', { period })
    const invoices = {}
    for (const invoice of (await api(`runs/${run.id}`)).invoices) {
      await api('invoice.approve', { invoice: invoice.id, acknowledge: true })
      await api('invoice.finalise', { invoice: invoice.id, issue_date: invoice.period_end })
      invoices[invoice.customer_id] = await api(`invoices/${invoice.id}`)
    }
    return invoices
  }
  await issue('2026-06')
  const july = await issue('2026-07')
  assert.equal(july[under.customer].subtotal_cents, 95000, 'the unapplied signed ramp bills the old price')
  assert.equal(july[over.customer].subtotal_cents, 144000, 'the unapplied seat reduction bills the old quantity')
  assert.equal(july[agreed.customer].subtotal_cents, 120000, 'the approved ramp bills the signed step')
  // The signed step cannot be applied retroactively through the contract door.
  assert.equal((await h.api('contract.decide', finance, { contract: underContract, decision: 'approved' }, 409)).error, 'period_already_invoiced')

  const runsBefore = await api('runs'), subscriptionBefore = await api(`subscriptions/${under.subscription}`)
  const scan = () => h.api('assurance.scan', agent, { period: '2026-07', owner: ownerId })
  const opened = await scan()
  assert.deepEqual(opened.coverage, ['usage_source_control', 'seat_ramp'])
  assert.equal(opened.compared, 3, 'every signed ramp with issued service is compared, including the one that agrees')
  assert.equal(opened.opened.length, 2, 'only the two mismatches open cases')
  assert.deepEqual((await scan()).opened, [], 'repeated scans do not duplicate cases')
  assert.deepEqual(await api('runs'), runsBefore, 'a scan prepares no bill run')
  assert.deepEqual(await api(`subscriptions/${under.subscription}`), subscriptionBefore, 'a scan leaves signed terms and items unchanged')
  const cases = await h.api('assurance-cases', agent)
  const underCase = cases.find(c => c.customer_id === under.customer), overCase = cases.find(c => c.customer_id === over.customer)
  assert.equal(cases.length, 2)
  assert.deepEqual([underCase.kind, underCase.owner_id, underCase.status], ['seat_ramp', ownerId, 'open'])
  const e = underCase.evidence
  assert.deepEqual([e.direction, e.expectedCents, e.billedCents, e.differenceCents, e.effectiveDate, e.contractStatus, e.signed], ['under_billed', 120000, 95000, 25000, '2026-07-01', 'proposed', { price: p120, unit: '120.00', quantity: 10 }])
  assert.deepEqual(e.billed.map(b => [b.number, b.price, b.quantity, b.unit, b.from, b.to]), [[july[under.customer].number, p95, '10', '95.00', '2026-07-01', '2026-08-01']])
  assert.deepEqual([overCase.evidence.direction, overCase.evidence.expectedCents, overCase.evidence.billedCents, overCase.evidence.differenceCents], ['over_billed', 120000, 144000, -24000])
  assert.doesNotMatch(JSON.stringify(cases), /@example\.test|Synthetic ramp/, 'case evidence carries no contact details or names')

  // Over-billed seat: only a credit against that case's own invoice may be linked, and approval alone never closes it.
  const overInvoice = july[over.customer]
  const credit = (invoice, amount) => ({ invoice_credit: true, invoice: invoice.id, amount, reason: 'Seat reduction not applied', subject: `Seat correction for ${invoice.number}`,
    explanation: 'The signed order reduced seats from 12 to 10 on 1 July; the extra 2 seats at $120.00 are credited.',
    body: `The signed order reduced seats from 12 to 10 on 1 July. A credit of $${amount} reduces the amount owed on ${invoice.number}; the original invoice stays unchanged.`,
    citations: [{ line_id: invoice.lines[0].id, source: `/app/invoices/${invoice.id}/lines/${invoice.lines[0].id}`, quote: invoice.lines[0].description }] })
  const link = (c, payload, status) => h.api('proposal.create', agent, { assurance_case: c.id, kind: 'amendment', title: 'Seat reduction credit', payload }, status)
  const refuse = async (c, payload, error) => assert.equal((await link(c, payload, 409)).error, error)
  await refuse(underCase, credit(july[under.customer], '10.00'), 'assurance_fix_source_mismatch')
  await refuse(overCase, credit(july[under.customer], '10.00'), 'assurance_fix_source_mismatch')
  await refuse(overCase, credit(overInvoice, '240.01'), 'assurance_fix_exceeds_difference')
  const proposal = await link(overCase, credit(overInvoice, '240.00'))
  assert.equal((await api(`proposals/${proposal.id}`)).evidence.assurance.case, overCase.id)
  await api('proposal.decide', { proposal: proposal.id, decision: 'approved' })
  assert.equal((await api(`invoices/${overInvoice.id}`)).creditedCents, 24000)
  assert.equal((await h.api(`assurance-cases/${overCase.id}`, agent)).status, 'open', 'approving the credit never closes the case')
  const overRecheck = await h.api('assurance.recheck', agent, { case: overCase.id })
  assert.deepEqual([overRecheck.status, overRecheck.evidence.mismatch, overRecheck.evidence.creditedCents, overRecheck.evidence.differenceCents], ['open', false, 24000, 0], 'agreement alone waits for human confirmation')
  await h.api('assurance.approve', agent, { case: overCase.id, basis: overRecheck.evidence.basis }, 403)
  await api('assurance.approve', { case: overCase.id, basis: overCase.basis_hash }, 409)
  await api('assurance.approve', { case: overCase.id, basis: overRecheck.evidence.basis })
  assert.equal((await h.api('assurance.recheck', agent, { case: overCase.id })).status, 'resolved')

  // Unbilled ramp step: a member prepares the catch-up charge, a person approves the invoice that bills it.
  const charge = (who, c, fields, status = 200) => h.api('charge.add', who, { customer: under.customer, subscription: under.subscription, amount: '250', description: 'Seat ramp catch-up for July 2026',
    effective_date: '2026-07-31', assurance_case: c.id, ...fields }, status)
  await charge(agent, underCase, {}, 403)
  assert.equal((await charge(finance, underCase, { amount: '250.01' }, 409)).error, 'assurance_fix_exceeds_difference')
  assert.equal((await charge(finance, overCase, {}, 409)).error, 'assurance_fix_source_mismatch')
  assert.equal((await charge(finance, underCase, { customer: over.customer, subscription: over.subscription }, 409)).error, 'assurance_fix_source_mismatch')
  const catchUp = await charge(finance, underCase, {})
  assert.deepEqual((await h.api('assurance.recheck', agent, { case: underCase.id })).evidence.differenceCents, 25000, 'an unbilled charge corrects nothing')
  assert.equal((await charge(finance, underCase, { amount: '0.01' }, 409)).error, 'assurance_fix_exceeds_difference', 'pending charges count against the difference')
  const manual = await api('invoice.manual', { customer: under.customer, service_date: '2026-10-25', charges: [catchUp.charge] })
  assert.equal((await h.api('assurance.recheck', agent, { case: underCase.id })).evidence.differenceCents, 25000, 'a draft invoice corrects nothing')
  await api('invoice.approve', { invoice: manual.id, acknowledge: true })
  await api('invoice.finalise', { invoice: manual.id, issue_date: '2026-10-25' })
  const underRecheck = await h.api('assurance.recheck', agent, { case: underCase.id })
  assert.deepEqual([underRecheck.status, underRecheck.evidence.mismatch, underRecheck.evidence.chargedCents, underRecheck.evidence.netBilledCents, underRecheck.evidence.direction], ['open', false, 25000, 120000, 'agrees'])
  await api('assurance.approve', { case: underCase.id, basis: underRecheck.evidence.basis })
  assert.equal((await h.api('assurance.recheck', agent, { case: underCase.id })).status, 'resolved')
  const resolved = await h.api(`assurance-cases/${underCase.id}`, agent)
  assert.equal(resolved.observations[0].evidence.differenceCents, 25000, 'the original discrepancy is retained')
  assert.deepEqual((await scan()).opened, [], 'resolved cases are not reopened while records agree')
  console.log('AGENT-001 seat ramp and over-billed seat detectors, linked fixes and human-confirmed closure passed')
}
