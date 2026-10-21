import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'

// CAT-001 inherited SUB-003: real issued advance service, governed credits,
// source tax, paid liability and restart billing through ordinary public doors.
export async function intervalCancellationFlow(h, owner) {
  await h.advanceClock('2026-07-20T18:00:00Z')
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: '10', tax_note: 'Synthetic annual-service cancellation' })
  await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
  await applyPolicy(h, owner, 'credit.policy', { two_person_above: '1000' })
  await applyPolicy(h, owner, 'lifecycle.policy', { credit_unused: true, reactivation_days: 30 })
  await h.api('access.give', owner, { email: 'synthetic-nectar-62@example.test', name: 'Synthetic approver', role: 'finance' })
  const finance = await h.signIn('synthetic-nectar-62@example.test', { requested: true })
  const product = (await h.api('product.create', owner, { code: 'synthetic-nectar-62', name: 'Synthetic annual service' })).id
  const price = (await h.api('price.create', owner, { product, kind: 'flat', unit_amount: '12000', taxable: true, billing_interval: 'annual', billing_timing: 'advance' })).id
  const detail = subscription => h.api(`subscriptions/${subscription}`, owner)
  const cancel = async (subscription, changes = {}, status = 200) => h.api('subscription.cancel', owner, { subscription, revision: (await detail(subscription)).revision, mode: 'immediate', effective_date: '2026-07-01', reason: 'Synthetic service ended', ...changes }, status)
  const decide = (cancellation, actor = finance, decision = 'approved', status = 200) => h.api('subscription.cancel.decide', actor, { cancellation, decision }, status)
  const issue = async (customer, month = '2026-01', issueDate = '2026-01-01') => {
    const run = (await h.api('billrun.prepare', owner, { period: month })).id
    const invoice = (await h.api(`runs/${run}`, owner)).invoices.find(invoice => invoice.customer_id === customer)
    assert.ok(invoice)
    await h.api('invoice.approve', owner, { invoice: invoice.id, acknowledge: true })
    await h.api('invoice.finalise', owner, { invoice: invoice.id, issue_date: issueDate })
    return h.api(`invoices/${invoice.id}`, owner)
  }
  const make = async n => {
    const customer = (await h.api('customer.create', owner, { external_id: `synthetic-nectar-${n}`, name: `Synthetic customer ${n}`, billing_email: `synthetic-nectar-${n}@example.test` })).id
    const subscription = (await h.api('subscription.create', owner, { customer, start_date: '2026-01-01', term_months: 24, price: [price] })).id
    const amendment = await h.api('amendment.propose', owner, { subscription, kind: 'discount_percent', value: '10', effective_from: '2026-01-01', note: 'Signed synthetic discount' })
    await h.api('amendment.decide', owner, { amendment: amendment.amendment, decision: 'approved' })
    return { customer, subscription }
  }
  const term = await make(63)
  const ended = await cancel(term.subscription, { mode: 'term_end', effective_date: '2026-06-16' })
  assert.equal(ended.endDate, '2028-01-01', 'Cancellation uses the separate 24-month contract end, rather than its annual billing interval')

  const originals = []
  for (const [index, paid] of [0, 1178000, 1188000].entries()) {
    const row = await make(64 + index), original = await issue(row.customer)
    originals.push(original)
    assert.equal(original.total_cents, 1188000)
    if (paid) {
      const payment = await h.api('payment.record', owner, { customer: row.customer, amount: (paid / 100).toFixed(2), received_on: '2026-01-02', method: 'bank_transfer', reference: `synthetic-nectar-${67 + index}` })
      await h.api('payment.allocate', owner, { invoice: original.id, payment: payment.payment, amount: (paid / 100).toFixed(2) })
    }
    const before = await detail(row.subscription), prepared = await cancel(row.subscription)
    assert.equal(prepared.status, 'pending')
    assert.equal((await detail(row.subscription)).revision, before.revision)
    assert.equal((await detail(row.subscription)).end_date, '2028-01-01', 'Preparing the credit changes neither service nor signed terms')
    assert.equal(prepared.amountCents, 598883, '181/365 earned days, original 10% discount and signed 10% tax round independently before subtraction')
    assert.equal(prepared.credits[0].subtotalCents, 544439)
    assert.equal(prepared.credits[0].taxCents, 54444)
    assert.equal(prepared.credits[0].revenue.reduce((n, period) => n + period.deltaCents, 0), -544439)
    assert.ok(prepared.credits[0].original.every(line => line.evidence.calendar))
    assert.ok(prepared.credits[0].earned.every(line => line.evidence.calendar))
    await decide(prepared.cancellation, owner, 'approved', 409)
    const pendingInvoice = await h.api(`invoices/${original.id}`, owner)
    const request = pendingInvoice.creditRequests.find(request => request.status === 'pending')
    assert.ok(request)
    await h.api('credit.approve', finance, { request: request.id }, 409)
    const approved = await decide(prepared.cancellation)
    assert.equal(approved.status, 'approved')
    await decide(prepared.cancellation, finance, 'approved', 409)
    const corrected = await h.api(`invoices/${original.id}`, owner), note = corrected.credits[0]
    assert.equal(note.amount_cents, 598883)
    assert.equal(note.subtotal_cents, 544439)
    assert.equal(note.tax_cents, 54444)
    assert.equal(note.applied_cents, Math.min(598883, 1188000 - paid))
    assert.equal(corrected.balanceCents, Math.max(0, 1188000 - paid - 598883))
    assert.deepEqual(corrected.calculation, original.calculation, 'Cancellation never rewrites the issued calculation')
    assert.deepEqual(corrected.lines, original.lines, 'Original line identity, service period and evidence remain immutable')
    assert.deepEqual((await detail(row.subscription)).lifecycle.map(event => event.kind), ['cancel'])
    const ledger = (await h.api(`customers/${row.customer}`, owner)).ledger
    assert.equal(ledger.carriedUsageCredits.reduce((n, credit) => n + credit.availableCents, 0), Math.max(0, 598883 - (1188000 - paid)))
    if (index === 2) {
      await h.api('subscription.reactivate', owner, { subscription: row.subscription, revision: (await detail(row.subscription)).revision, effective_date: '2026-07-11', reason: 'Synthetic service restarted' })
      const restarted = await detail(row.subscription)
      assert.deepEqual(restarted.lifecycle.map(event => event.kind), ['cancel', 'reactivate'])
      assert.equal(restarted.lifecycle[1].related_id, restarted.lifecycle[0].id)
      assert.equal(restarted.contract_end_date, '2028-01-01', 'Restart inside the signed term preserves its actual end')
      const preview = await h.api(`subscriptions/${row.subscription}/upcoming?period=2026-07`, owner)
      assert.equal(preview.calculation.totalCents, 566334, 'Reinstated service receives an ordinary 174/365-day advance invoice')
      const stub = await issue(row.customer, '2026-07', '2026-07-11')
      assert.equal(stub.total_cents, preview.calculation.totalCents)
      assert.equal(stub.balanceCents, 0, 'The paid-service credit applies once to the new ordinary invoice')
      assert.equal(stub.carriedApplications.reduce((n, application) => n + application.amount_cents, 0), 566334)
      const remaining = (await h.api(`customers/${row.customer}`, owner)).ledger.carriedUsageCredits
      assert.equal(remaining.reduce((n, credit) => n + credit.availableCents, 0), 32549)
      const run = (await h.api('billrun.prepare', owner, { period: '2026-07' })).id
      assert.ok(!(await h.api(`runs/${run}`, owner)).invoices.some(invoice => invoice.customer_id === row.customer), 'Re-preparation cannot bill a reinstated component or apply its credit twice')
      assert.deepEqual((await h.api(`invoices/${original.id}`, owner)).calculation, original.calculation)
    }
  }

  const rejected = await make(70), rejectedOriginal = await issue(rejected.customer)
  const rejectedPlan = await cancel(rejected.subscription)
  await decide(rejectedPlan.cancellation, owner, 'rejected')
  assert.equal((await detail(rejected.subscription)).lifecycle.length, 0)
  assert.equal((await h.api(`invoices/${rejectedOriginal.id}`, owner)).credits.length, 0)
  const stale = await cancel(rejected.subscription)
  const payment = await h.api('payment.record', owner, { customer: rejected.customer, amount: '1', received_on: '2026-07-01', method: 'bank_transfer', reference: 'synthetic-nectar-71' })
  await h.api('payment.allocate', owner, { invoice: rejectedOriginal.id, payment: payment.payment, amount: '1' })
  await decide(stale.cancellation, finance, 'approved', 409)
  assert.equal((await detail(rejected.subscription)).lifecycle.length, 0)
  await decide(stale.cancellation, owner, 'rejected')
  await applyPolicy(h, owner, 'credit.policy', { two_person_above: '10000' })
  const onePerson = await cancel(rejected.subscription)
  await decide(onePerson.cancellation, owner)
  assert.equal((await h.api(`invoices/${rejectedOriginal.id}`, owner)).credits.length, 1, 'A below-limit correcting credit can be approved by its preparer')

  await applyPolicy(h, owner, 'lifecycle.policy', { credit_unused: false, reactivation_days: 30 })
  const retained = await make(72), retainedOriginal = await issue(retained.customer)
  const retainedCancel = await cancel(retained.subscription)
  assert.equal(retainedCancel.cancellation, undefined)
  assert.equal((await h.api(`invoices/${retainedOriginal.id}`, owner)).credits.length, 0)
  assert.deepEqual((await h.api(`invoices/${retainedOriginal.id}`, owner)).calculation, retainedOriginal.calculation)

  await h.api('subscription.cancel.decide', undefined, {}, 401)
  const credential = { bearer: (await h.api('credential.issue', owner, { name: 'Synthetic cancellation observer', scopes: ['prepare'] })).key }
  for (const action of ['subscription.cancel', 'subscription.reactivate', 'subscription.cancel.decide']) await h.api(action, credential, {}, 403)
  console.log('CAT-001 cancellation: actual contract end, exact taxed discounted unused-service credits, threshold/standalone/stale/reject controls, unpaid/part-paid/paid custody and ordinary restart billing passed')
}
