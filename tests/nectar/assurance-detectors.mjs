import assert from 'node:assert/strict'
import { publishPrice } from './price-helper.mjs'
import { applyPolicy } from './policy-helper.mjs'

// AGENT-001: five planted mismatches, found by comparing signed terms with issued invoices, payments and
// access, then corrected only through ordinary human-approved doors and closed only after a confirmed recheck.
export async function assuranceDetectorsFlow(h, owner) {
  await h.advanceClock('2026-10-25T12:00:00Z')
  const api = (path, body, status) => h.api(path, owner, body, status)
  const ownerId = (await api('me')).id
  await api('access.give', { email: 'synthetic-nectar-ramp-finance@example.test', name: 'Synthetic ramp finance', role: 'finance' })
  const finance = await h.signIn('synthetic-nectar-ramp-finance@example.test', { requested: true })
  const agent = { bearer: (await api('credential.issue', { name: 'Synthetic ramp investigator', scopes: ['prepare'] })).key }
  const product = (await api('product.create', { code: 'ramp-seats', name: 'Ramp seats' })).id
  const p95 = (await publishPrice(h, owner, { product, kind: 'seat', unit_amount: '95', taxable: false })).id
  const p120 = (await publishPrice(h, owner, { product, kind: 'seat', unit_amount: '120', taxable: false })).id
  const tiered = (await publishPrice(h, owner, { product, kind: 'seat', pricing_model: 'graduated', tiers: [{ up_to: '10', unit_amount: '120' }, { up_to: null, unit_amount: '100' }], taxable: false })).id
  const platform = (await api('product.create', { code: 'ramp-platform', name: 'Ramp platform' })).id
  const flat = (await publishPrice(h, owner, { product: platform, kind: 'flat', unit_amount: '1000', taxable: false })).id
  const annual = (await publishPrice(h, owner, { product: platform, kind: 'flat', unit_amount: '12000', taxable: false, billing_interval: 'annual', billing_timing: 'advance' })).id
  const exportProduct = (await api('product.create', { code: 'ramp-export', name: 'Ramp export' })).id
  await api('feature.grant', { product: exportProduct, feature: 'ramp-export' })
  const exportPrice = (await publishPrice(h, owner, { product: exportProduct, kind: 'seat', unit_amount: '10', taxable: false })).id
  const fixture = async (suffix, price, seats, start = '2026-06-01') => {
    const customer = (await api('customer.create', { external_id: `ramp-${suffix}`, name: `Synthetic ramp ${suffix}`, billing_email: `ap@ramp-${suffix}.example.test` })).id
    const subscription = (await api('subscription.create', { customer, start_date: start, anchor_day: 1, price: [price], quantity: [seats === null ? '' : String(seats)] })).id
    const read = await api(`subscriptions/${subscription}`)
    return { customer, subscription, item: read.items[0].id, revision: read.revision }
  }
  const prepareRamp = async (f, quantity, label, price = p120) => (await api('contract.prepare', { subscription: f.subscription, revision: f.revision, clause: `Signed order: ${label}`,
    ramps: [{ item: f.item, effective_date: '2026-07-01', price, quantity }] })).contract

  // 1 and 5: a signed $120 ramp never applied (unbilled step), a signed seat reduction never applied (over-billed seat),
  // and a ramp applied correctly. 2: a signed minimum whose final period was never invoiced. 3: a settled payment never
  // applied. 4: a feature still granted by a duplicate subscription after a recorded cancellation.
  const under = await fixture('under', p95, 10), over = await fixture('over', tiered, 12), agreed = await fixture('agreed', p95, 10)
  const trueup = await fixture('trueup', flat, null, '2026-01-01'), credit = await fixture('credit', p95, 10)
  await applyPolicy(h, owner, 'lifecycle.policy', { credit_unused: false, reactivation_days: 30 })
  const prepaid = await fixture('prepaid', annual, null, '2026-01-01')
  const underContract = await prepareRamp(under, 10, 'seats ramp from $95 to $120 on 1 July 2026')
  await prepareRamp(over, 10, 'seat count reduces from 12 to 10 on 1 July 2026', tiered)
  await h.api('contract.decide', finance, { contract: await prepareRamp(agreed, 10, 'seats ramp from $95 to $120 on 1 July 2026'), decision: 'approved' })
  const commitment = (await api('contract.prepare', { subscription: trueup.subscription, revision: trueup.revision, clause: 'Signed order: $10,000 minimum from 1 January to 1 July 2026',
    commitments: [{ from: '2026-01-01', to: '2026-07-01', minimum: '10000.00', taxable: false }] })).contract
  await h.api('contract.decide', finance, { contract: commitment, decision: 'approved' })

  const issue = async (period, skip = []) => {
    const run = await api('billrun.prepare', { period })
    const invoices = {}
    for (const invoice of (await api(`runs/${run.id}`)).invoices) {
      if (skip.includes(invoice.customer_id)) { invoices[invoice.customer_id] = invoice; continue }
      await api('invoice.approve', { invoice: invoice.id, acknowledge: true })
      await api('invoice.finalise', { invoice: invoice.id, issue_date: invoice.period_end <= '2026-10-25' ? invoice.period_end : invoice.period_start })
      invoices[invoice.customer_id] = await api(`invoices/${invoice.id}`)
    }
    return invoices
  }
  const january = await issue('2026-01')
  for (const month of ['02', '03', '04', '05']) await issue(`2026-${month}`)
  const june = await issue('2026-06', [trueup.customer]), july = await issue('2026-07', [trueup.customer])
  assert.equal(july[under.customer].subtotal_cents, 95000, 'the unapplied signed ramp bills the old price')
  assert.equal(july[over.customer].subtotal_cents, 140000, 'the unapplied seat reduction bills the old quantity on the graduated price')
  assert.equal(july[agreed.customer].subtotal_cents, 120000, 'the approved ramp bills the signed step')
  // The signed step cannot be applied retroactively through the contract door.
  assert.equal((await h.api('contract.decide', finance, { contract: underContract, decision: 'approved' }, 409)).error, 'period_already_invoiced')
  await api('payment.record', { customer: credit.customer, amount: '950.00', received_on: '2026-07-15', method: 'bank_transfer', reference: 'synthetic-nectar-wire-1' })
  // Paid in advance for a year, then cancelled with no credit policy: the customer paid for access that ended.
  const annualInvoice = january[prepaid.customer]
  assert.equal(annualInvoice.total_cents, 1200000)
  const wire = await api('payment.record', { customer: prepaid.customer, amount: '12000.00', received_on: '2026-01-02', method: 'bank_transfer', reference: 'synthetic-nectar-wire-2' })
  await api('payment.allocate', { invoice: annualInvoice.id, payment: wire.payment, amount: '12000.00' })
  await api('subscription.cancel', { subscription: prepaid.subscription, revision: (await api(`subscriptions/${prepaid.subscription}`)).revision, mode: 'immediate', effective_date: '2026-07-01', reason: 'Customer cancelled' })
  // A customer cancels their subscription, yet a duplicate still grants the cancelled plan's feature.
  const access = await fixture('access', exportPrice, 5)
  const duplicate = (await api('subscription.create', { customer: access.customer, start_date: '2026-06-01', anchor_day: 1, price: [exportPrice], quantity: ['5'] })).id
  const cancelled = await api('subscription.cancel', { subscription: access.subscription, revision: access.revision, mode: 'immediate', effective_date: '2026-08-01', reason: 'Customer cancelled' })
  assert.equal(cancelled.endDate, '2026-08-01')

  const runsBefore = await api('runs'), subscriptionBefore = await api(`subscriptions/${under.subscription}`), paymentsBefore = await api('payments')
  const scan = () => h.api('assurance.scan', agent, { period: '2026-07', owner: ownerId })
  const opened = await scan()
  assert.deepEqual(opened.coverage, ['usage_source_control', 'seat_ramp', 'commitment_trueup', 'unapplied_credit', 'cancellation_access', 'paid_without_access'])
  assert.equal(opened.opened.length, 6, 'only the planted mismatches open cases; the correctly applied ramp does not')
  assert.deepEqual((await scan()).opened, [], 'repeated scans do not duplicate cases')
  assert.deepEqual(await api('runs'), runsBefore, 'a scan prepares no bill run')
  assert.deepEqual(await api(`subscriptions/${under.subscription}`), subscriptionBefore, 'a scan leaves signed terms and items unchanged')
  assert.deepEqual(await api('payments'), paymentsBefore, 'a scan applies no payment')
  const cases = await h.api('assurance-cases', agent)
  assert.deepEqual(cases.map(c => c.kind).sort(), ['cancellation_access', 'commitment_trueup', 'paid_without_access', 'seat_ramp', 'seat_ramp', 'unapplied_credit'])
  assert.ok(cases.every(c => c.owner_id === ownerId && c.status === 'open'), 'every case has an active owner')
  const byCustomer = id => cases.find(c => c.customer_id === id)
  const underCase = byCustomer(under.customer), overCase = byCustomer(over.customer), trueupCase = byCustomer(trueup.customer), creditCase = byCustomer(credit.customer), accessCase = byCustomer(access.customer), paidCase = byCustomer(prepaid.customer)
  const e = underCase.evidence
  assert.deepEqual([e.direction, e.expectedCents, e.billedCents, e.differenceCents, e.effectiveDate, e.contractStatus, e.signed], ['under_billed', 120000, 95000, 25000, '2026-07-01', 'proposed', { price: p120, unit: '120.00', quantity: 10 }])
  assert.deepEqual(e.billed.map(b => [b.number, b.price, b.quantity, b.unit, b.from, b.to]), [[july[under.customer].number, p95, '10', '95.00', '2026-07-01', '2026-08-01']])
  assert.deepEqual([overCase.evidence.direction, overCase.evidence.expectedCents, overCase.evidence.billedCents, overCase.evidence.differenceCents], ['over_billed', 120000, 140000, -20000])
  const t = trueupCase.evidence
  assert.deepEqual([t.minimumCents, t.earnedCents, t.trueUpCents, t.remainingCents, t.window, t.invoices.length], [1000000, 500000, 0, 500000, { from: '2026-01-01', to: '2026-07-01', end: '2026-07-01' }, 5])
  const c = creditCase.evidence
  assert.deepEqual([c.availableCents, c.owedCents, c.applicableCents, c.credits.map(x => [x.kind, x.unappliedCents]), c.invoices.map(x => x.number)], [95000, 190000, 95000, [['payment', 95000]], [june[credit.customer].number, july[credit.customer].number]])
  const a = accessCase.evidence
  assert.deepEqual([a.cancelledOn, a.features, a.stillGranted], ['2026-08-01', ['ramp-export'], [{ feature: 'ramp-export', grantedBy: [{ subscription: duplicate, lifecycle: 'active' }] }]])
  const paid = paidCase.evidence
  assert.deepEqual([paid.invoices.length, paid.invoices[0].paidCents, paid.invoices[0].creditedCents, paid.endedOn], [1, 1200000, 0, '2026-07-01'])
  assert.ok(paid.remainingCents > 0 && paid.remainingCents < 1200000, 'only the unused part of the paid year is owed back')
  assert.doesNotMatch(JSON.stringify(cases), /@example\.test|Synthetic ramp/, 'case evidence carries no contact details or names')

  const close = async (c, expected) => {
    const recheck = await h.api('assurance.recheck', agent, { case: c.id })
    assert.deepEqual([recheck.status, recheck.evidence.mismatch], ['open', false], 'agreement alone waits for human confirmation')
    await h.api('assurance.approve', agent, { case: c.id, basis: recheck.evidence.basis }, 403)
    await api('assurance.approve', { case: c.id, basis: c.basis_hash }, 409)
    await api('assurance.approve', { case: c.id, basis: recheck.evidence.basis })
    assert.equal((await h.api('assurance.recheck', agent, { case: c.id })).status, 'resolved')
    assert.equal((await h.api(`assurance-cases/${c.id}`, agent)).observations[0].evidence.mismatch, true, 'the original discrepancy is retained')
    return recheck.evidence
  }

  // Over-billed seat: only a credit against that case's own invoice may be linked, and approval alone never closes it.
  const overInvoice = july[over.customer]
  const creditProposal = (invoice, amount) => ({ invoice_credit: true, invoice: invoice.id, amount, reason: 'Linked invoice correction', subject: `Correction for ${invoice.number}`,
    explanation: `The linked assurance case shows $${amount} billed or paid for service the signed terms do not cover.`,
    body: `A credit of $${amount} reduces the amount owed on ${invoice.number}; the original invoice stays unchanged.`,
    citations: [{ line_id: invoice.lines[0].id, source: `/app/invoices/${invoice.id}/lines/${invoice.lines[0].id}`, quote: invoice.lines[0].description }] })
  const link = (c, payload, status) => h.api('proposal.create', agent, { assurance_case: c.id, kind: 'amendment', title: 'Seat reduction credit', payload }, status)
  const refuse = async (c, payload, error) => assert.equal((await link(c, payload, 409)).error, error)
  await refuse(underCase, creditProposal(july[under.customer], '10.00'), 'assurance_fix_source_mismatch')
  await refuse(overCase, creditProposal(july[under.customer], '10.00'), 'assurance_fix_source_mismatch')
  await refuse(overCase, creditProposal(overInvoice, '200.01'), 'assurance_fix_exceeds_difference')
  // Rejected and unauthorized linked proposals adjust nothing: the proposer's authority is rechecked on acceptance.
  await api('access.give', { email: 'synthetic-nectar-ramp-proposer@example.test', name: 'Synthetic ramp proposer', role: 'finance' })
  const proposer = await h.signIn('synthetic-nectar-ramp-proposer@example.test', { requested: true })
  const proposerId = (await h.api('members', owner)).find(m => m.email === 'synthetic-nectar-ramp-proposer@example.test').id
  const unchanged = async () => assert.equal((await api(`invoices/${overInvoice.id}`)).creditedCents, 0, 'refused or rejected proposals credit nothing')
  const demoted = await h.api('proposal.create', proposer, { assurance_case: overCase.id, kind: 'amendment', title: 'Seat reduction credit', payload: creditProposal(overInvoice, '1.00') })
  await api('access.end', { member: proposerId })
  await api('access.give', { email: 'synthetic-nectar-ramp-proposer@example.test', name: 'Synthetic ramp proposer', role: 'accountant' })
  assert.equal((await api('proposal.decide', { proposal: demoted.id, decision: 'approved' }, 409)).error, 'assurance_proposer_unavailable')
  await unchanged()
  await api('proposal.decide', { proposal: demoted.id, decision: 'rejected' })
  assert.equal((await api(`proposals/${demoted.id}`)).status, 'rejected')
  await unchanged()
  const proposal = await link(overCase, creditProposal(overInvoice, '200.00'))
  assert.equal((await api(`proposals/${proposal.id}`)).evidence.assurance.case, overCase.id)
  await api('proposal.decide', { proposal: proposal.id, decision: 'approved' })
  assert.equal((await api(`invoices/${overInvoice.id}`)).creditedCents, 20000)
  assert.equal((await h.api(`assurance-cases/${overCase.id}`, agent)).status, 'open', 'approving the credit never closes the case')
  assert.equal((await close(overCase)).creditedCents, 20000)

  // Payment without access: the paid year ended early, so a person returns only the unused part to the customer's balance.
  const owedBack = cents => (cents / 100).toFixed(2)
  const grant = (who, fields, status = 200) => h.api('balance.goodwill', who, { customer: prepaid.customer, amount: owedBack(paid.remainingCents), reason: 'Paid service after the recorded end', assurance_case: paidCase.id, ...fields }, status)
  await grant(agent, {}, 403)
  assert.equal((await grant(owner, { amount: owedBack(paid.remainingCents + 1) }, 409)).error, 'assurance_fix_source_mismatch', 'a grant above the unused service is refused')
  assert.equal((await grant(owner, { customer: credit.customer }, 409)).error, 'assurance_fix_source_mismatch', 'a grant to another customer is refused')
  assert.equal((await h.api('balance.goodwill', owner, { customer: prepaid.customer, amount: '1.00', reason: 'Unlinked', assurance_case: overCase.id }, 409)).error, 'assurance_fix_kind_unsupported')
  await grant(owner, {})
  assert.equal((await api(`customers/${prepaid.customer}/balance`)).goodwillCents, paid.remainingCents, 'the unused service becomes customer balance')
  assert.equal((await close(paidCase)).remainingCents, 0)

  // Unbilled ramp step: a member prepares the catch-up charge, a person approves the invoice that bills it.
  const charge = (who, c, fields, status = 200) => h.api('charge.add', who, { customer: under.customer, subscription: under.subscription, amount: '250', description: 'Seat ramp catch-up for July 2026',
    effective_date: '2026-07-31', assurance_case: c.id, ...fields }, status)
  await charge(agent, underCase, {}, 403)
  assert.equal((await charge(finance, underCase, { amount: '250.01' }, 409)).error, 'assurance_fix_exceeds_difference')
  assert.equal((await charge(finance, overCase, {}, 409)).error, 'assurance_fix_kind_unsupported', 'a resolved case accepts no further fix')
  assert.equal((await charge(finance, underCase, { customer: over.customer, subscription: over.subscription }, 409)).error, 'assurance_fix_source_mismatch')
  const catchUp = await charge(finance, underCase, {})
  assert.equal((await h.api('assurance.recheck', agent, { case: underCase.id })).evidence.differenceCents, 25000, 'an unbilled charge corrects nothing')
  assert.equal((await charge(finance, underCase, { amount: '0.01' }, 409)).error, 'assurance_fix_exceeds_difference', 'pending charges count against the difference')
  const manual = await api('invoice.manual', { customer: under.customer, service_date: '2026-10-25', charges: [catchUp.charge] })
  assert.equal((await h.api('assurance.recheck', agent, { case: underCase.id })).evidence.differenceCents, 25000, 'a draft invoice corrects nothing')
  await api('invoice.approve', { invoice: manual.id, acknowledge: true })
  await api('invoice.finalise', { invoice: manual.id, issue_date: '2026-10-25' })
  const fixedRamp = await close(underCase)
  assert.deepEqual([fixedRamp.chargedCents, fixedRamp.netBilledCents, fixedRamp.direction], [25000, 120000, 'agrees'])

  // Missing true-up: the ordinary final invoice is the fix; its true-up line closes the shortfall.
  const finalDraft = june[trueup.customer]
  await api('invoice.approve', { invoice: finalDraft.id, acknowledge: true })
  await api('invoice.finalise', { invoice: finalDraft.id, issue_date: '2026-07-01' })
  const settled = await close(trueupCase)
  assert.deepEqual([settled.earnedCents, settled.trueUpCents, settled.remainingCents, settled.invoices.length], [600000, 400000, 0, 6])

  // Unapplied credit: a person applies the settled payment to the invoice it belongs to, naming the case.
  await h.api('balance.apply', agent, { invoice: june[credit.customer].id, assurance_case: creditCase.id }, 403)
  assert.equal((await api('balance.apply', { invoice: july[under.customer].id, assurance_case: creditCase.id }, 409)).error, 'no_balance_available')
  assert.equal((await api('balance.apply', { invoice: june[credit.customer].id, assurance_case: creditCase.id })).appliedCents, 95000)
  const applied = await close(creditCase)
  assert.deepEqual([applied.availableCents, applied.applicableCents, applied.owedCents], [0, 0, 95000])
  assert.ok((await api('audit')).some(r => r.action === 'balance.apply' && JSON.parse(r.detail).assuranceCase === creditCase.id), 'the execution audit names its case')

  // Feature left on after cancellation: ending the duplicate through the ordinary cancel door removes the access.
  const cancel = (subscription, revision, status) => api('subscription.cancel', { subscription, revision, mode: 'immediate', effective_date: '2026-10-25', reason: 'Duplicate of a cancelled plan', assurance_case: accessCase.id }, status)
  assert.equal((await cancel(agreed.subscription, (await api(`subscriptions/${agreed.subscription}`)).revision, 409)).error, 'assurance_fix_source_mismatch')
  await cancel(duplicate, (await api(`subscriptions/${duplicate}`)).revision)
  const revoked = await close(accessCase)
  assert.deepEqual(revoked.stillGranted, [])
  assert.deepEqual((await scan()).opened, [], 'resolved cases are not reopened while records agree')
  assert.ok((await h.api('assurance-cases', agent)).every(x => x.status === 'resolved'), 'every planted case closed only after a human-confirmed recheck')
  // A later regression reopens the same case and withdraws the old confirmation.
  await api('payment.record', { customer: credit.customer, amount: '950.00', received_on: '2026-10-20', method: 'bank_transfer', reference: 'synthetic-nectar-wire-3' })
  assert.deepEqual((await scan()).rechecked, [creditCase.id])
  const reopened = await h.api(`assurance-cases/${creditCase.id}`, agent)
  assert.deepEqual([reopened.status, reopened.approved_basis, reopened.evidence.availableCents], ['open', null, 95000], 'the regression reopens the same case')
  // Approved erasure deletes the operational investigation and never the retained invoice facts; a scan cannot recreate it.
  const requested = h.mails.length
  await api('erasure.request', { customer: credit.customer })
  const verification = h.mails.slice(requested).find(mail => [mail.to].flat().includes('ap@ramp-credit.example.test'))
  const path = new URL(`${verification.text ?? ''} ${verification.html ?? ''}`.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]).pathname
  assert.equal((await h.raw(path, { form: new URLSearchParams({ confirm: 'yes' }) })).status, 200)
  const erasure = (await api('erasures')).find(row => row.customer_id === credit.customer)
  await api('erasure.approve', { request: erasure.id, confirm: true })
  assert.equal((await h.api('assurance-cases', agent)).some(x => x.customer_id === credit.customer), false, 'erasure removes the customer\'s investigations')
  await h.api(`assurance-cases/${creditCase.id}`, agent, undefined, 404)
  assert.deepEqual((await scan()).opened, [], 'retained records cannot recreate an erased investigation')
  assert.equal((await api(`invoices/${june[credit.customer].id}`)).total_cents, 95000, 'the retained issued invoice keeps its exact figures')
  console.log('AGENT-001 five planted mismatches, linked fixes and human-confirmed closure passed')
}
