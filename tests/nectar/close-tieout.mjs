// One close-preparation sanity journey through ordinary Worker and D1 doors.
// The only provider substitution is the existing QuickBooks network edge.
import assert from 'node:assert/strict'
import { quickbooksEdge } from './quickbooks-edge.mjs'

let edge
export const harnessOptions = () => { edge = quickbooksEdge(); return { quickbooksFetch: edge.fetch, localTime: '2026-09-30T20:00:00Z' } }

export async function seedCloseSources(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const mailbox = (await api('me')).email
  const customer = (await api('customer.create', { external_id: 'synthetic-nectar-1', name: 'Native close review', billing_email: mailbox })).id
  const clean = (await api('customer.create', { external_id: 'synthetic-nectar-2', name: 'Clean close control', billing_email: mailbox })).id
  edge?.addCustomer('Native close review')
  const product = (await api('product.create', { code: 'synthetic-nectar-1', name: 'Annual service' })).id
  const price = (await api('price.create', { product, kind: 'flat', unit_amount: '1200', billing_interval: 'annual', billing_timing: 'advance', taxable: false })).id
  await api('subscription.create', { customer, start_date: '2026-08-01', billing_anchor_date: '2026-08-01', price: [price] })
  const run = await api('billrun.prepare', { period: '2026-08' })
  const annual = (await api(`runs/${run.id}`)).invoices.find(row => row.customer_id === customer).id
  const issue = async (invoice, date) => {
    await api('invoice.approve', { invoice, acknowledge: true })
    await api('invoice.finalise', { invoice, issue_date: date })
    return invoice
  }
  await issue(annual, '2026-08-01')
  const manual = async (customer, amount) => {
    const charge = (await api('charge.add', { customer, amount, description: 'Reviewed September service', taxable: false, effective_date: '2026-09-10' })).charge
    return issue((await api('invoice.manual', { customer, charges: [charge], service_date: '2026-09-10' })).id, '2026-09-10')
  }
  const badDebtInvoice = await manual(customer, '300'), cleanInvoice = await manual(clean, '200')
  await api('balance.goodwill', { customer, amount: '30', reason: 'Reviewed service goodwill' })
  await api('balance.apply', { invoice: annual })
  await api('balance.goodwill', { customer: clean, amount: '10', reason: 'Unused clean-control goodwill' })
  await api('credit.issue', { invoice: annual, amount: '50', reason: 'Reviewed annual service concession' })
  const payment = (await api('payment.record', { customer, amount: '120', received_on: '2026-09-15', method: 'bank_transfer', reference: 'synthetic-nectar-1' })).payment
  await api('payment.allocate', { payment, invoice: annual, amount: '100' })
  const cleanPayment = (await api('payment.record', { customer: clean, amount: '200', received_on: '2026-09-15', method: 'bank_transfer', reference: 'synthetic-nectar-2' })).payment
  await api('payment.allocate', { payment: cleanPayment, invoice: cleanInvoice, amount: '200' })
  edge?.setOutage('down')
  const written = await api('writeoff.issue', { invoice: badDebtInvoice, amount: '100', reason: 'Reviewed uncollectable balance' })
  return { customer, clean, annual, badDebtInvoice, cleanInvoice, payment, cleanPayment, posting: written.posting.id }
}

export async function closeTieoutFlow(h, owner, { onState = async () => {} } = {}) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const sources = await seedCloseSources(h, owner)
  const { customer, clean, annual, badDebtInvoice, payment, posting } = sources
  const ownerId = (await api('me')).id
  const identities = {}
  for (const role of ['finance', 'accountant', 'collections', 'developer']) {
    const email = (await api('me')).email.replace(/^[^@]+/, `synthetic-nectar-${role}`)
    await api('access.give', { email, name: `Close ${role}`, role })
    identities[role] = await h.signIn(email, { requested: true })
  }
  const credential = await api('credential.issue', { name: 'Close investigator', scopes: ['prepare'] })
  const agent = { bearer: credential.key }
  const meter = { bearer: (await api('credential.issue', { name: 'Usage only', scopes: ['usage'] })).key }
  const packet = () => api('close-tieout?period=2026-09')
  const snapshot = async () => ({ invoices: await Promise.all([annual, badDebtInvoice, sources.cleanInvoice].map(id => api(`invoices/${id}`))), payments: await api('payments'), postings: await api('ledger-postings'), closes: await api('period-closes'), journals: edge.summary(), calls: edge.calls.length })
  const scan = async (who = agent, basis, assigned = ownerId, status = 200) => h.api('close.scan', who, { period: '2026-09', basis: basis ?? (await packet()).basis, owner: assigned }, status)
  const baseline = await snapshot(), before = await packet()
  // Expected figures come from the public writes above, not the packet's input arrays.
  assert.deepEqual(before.totals.debt, { issuedCents: 170000, creditNotesCents: 5000, allocatedCents: 30000, carriedAppliedCents: 0, goodwillAppliedCents: 3000, writeOffCents: 10000, recoveryCents: 0, reversedCents: 0, reportedCents: 122000, computedCents: 122000, differenceCents: 0 })
  assert.deepEqual(before.totals.cash, { receivedCents: 32000, allocatedCents: 30000, returnedCents: 0, reportedUnappliedCents: 2000, computedUnappliedCents: 2000, differenceCents: 0 })
  assert.deepEqual(before.totals.credit, { grantedCents: 4000, appliedCents: 3000, reportedGoodwillCents: 1000, carriedCents: 0, computedGoodwillCents: 1000, differenceCents: 0 })
  assert.deepEqual(before.totals.revenue, { openingCents: 110000, netBillingsCents: 45000, recognizedCents: 55000, closingCents: 100000, differenceCents: 0, rollforwardDifferenceCents: 0 })
  assert.equal(before.sources.invoices.length, 3)
  assert.equal(before.sources.allocations.length, 2)
  assert.equal(before.proofs.filter(row => row.customer === clean && row.mismatch).length, 0, 'The clean customer creates no financial break')
  const cash = before.proofs.find(row => row.payment === payment), ledger = before.proofs.find(row => row.posting === posting)
  assert.equal(cash.category, 'review'); assert.equal(ledger.category, 'synchronization_failure')
  assert.equal(ledger.error, 'ledger_unavailable')
  assert.equal(before.coverage.find(row => row.area === 'Payouts and processor fees').state, 'not_covered')
  assert.equal(before.coverage.find(row => row.area === 'Provider tax commitments').state, 'not_covered')
  for (const source of [...before.sources.invoices, ...before.sources.payments, ...before.sources.allocations, ...before.sources.credits, ...before.sources.movements]) {
    const response = await h.raw(source.href, { cookie: owner })
    assert.equal(response.status, 200, 'An exact source citation opens under ordinary authority')
    assert.ok((await response.text()).includes(source.id), `The source door ${source.href} contains the cited record ${source.id}`)
  }
  assert.equal((await packet()).basis, before.basis, 'Reads preserve a stable source fingerprint')
  assert.deepEqual(await snapshot(), baseline, 'Packet reads issue no financial instruction or ledger request')
  await onState('prepared', sources)

  for (const who of [undefined, meter]) await h.api('close-tieout?period=2026-09', who, undefined, who ? 403 : 401)
  for (const who of [identities.collections]) await h.api('close-tieout?period=2026-09', who, undefined, 403)
  for (const who of [identities.accountant, identities.developer, identities.collections, meter]) await scan(who, before.basis, ownerId, 403)
  await h.api('close.scan', undefined, {}, 401)
  const accountant = await h.api('close-tieout?period=2026-09', identities.accountant)
  assert.equal(accountant.basis, before.basis)
  await h.api('close-tieout?period=wrong', owner, undefined, 400)
  await h.rejectAudit('close.scan')
  await scan(agent, before.basis, ownerId, 500)
  assert.deepEqual(await api('assurance-cases'), [], 'Audit failure rolls back every case and observation')
  await h.rejectAudit(null)
  const opened = await scan()
  assert.equal(opened.opened.length, 2)
  const cases = await api('assurance-cases'), cashCase = cases.find(row => row.kind === cash.kind), ledgerCase = cases.find(row => row.kind === ledger.kind)
  assert.ok(cashCase && ledgerCase)
  assert.deepEqual((await scan()).opened, [], 'Repeating a scan creates no duplicate item')
  const concurrent = await Promise.all([1, 2].map(() => h.raw('/api/nectar/close.scan', { ...agent, body: { period: '2026-09', basis: before.basis, owner: ownerId } })))
  for (const response of concurrent) {
    const result = await response.json()
    if (response.status === 200) assert.deepEqual(result.opened, [])
    else { assert.equal(response.status, 409); assert.equal(result.error, 'assurance_source_changed') }
  }
  assert.equal((await api('assurance-cases')).length, 2)
  assert.deepEqual(await snapshot(), baseline, 'Scanning allocates nothing, posts nothing and closes nothing')
  await onState('open', sources)
  await api('assurance.approve', { case: cashCase.id, basis: cash.basis }, 409)
  await h.api('assurance.approve', agent, { case: cashCase.id, basis: cash.basis }, 403)
  assert.equal((await api('assurance.recheck', { case: cashCase.id })).status, 'open')
  for (const [action, body] of [['payment.allocate', { payment, invoice: annual, amount: '20' }], ['ledger.post', { posting }], ['revenue.close', { period: '2026-08' }]]) await h.api(action, agent, body, 403)
  assert.deepEqual(await snapshot(), baseline, 'An investigator cannot execute any proposed financial fix')

  // An ordinary human allocation changes the reviewed basis, but does not close the case.
  await h.api('payment.allocate', identities.finance, { payment, invoice: annual, amount: '10' })
  assert.equal((await scan(agent, before.basis, ownerId, 409)).error, 'close_source_changed')
  assert.equal((await api('assurance.recheck', { case: cashCase.id })).status, 'open')
  await h.api('payment.allocate', identities.finance, { payment, invoice: annual, amount: '10' })
  const fresh = await h.api('assurance.recheck', agent, { case: cashCase.id })
  assert.equal(fresh.evidence.mismatch, false)
  assert.equal(fresh.status, 'open', 'A fix alone does not close a case')
  await api('assurance.approve', { case: cashCase.id, basis: cash.basis }, 409)
  await h.rejectAudit('assurance.approve')
  await api('assurance.approve', { case: cashCase.id, basis: fresh.evidence.basis }, 500)
  assert.equal((await api(`assurance-cases/${cashCase.id}`)).approved_basis, null)
  await h.rejectAudit(null)
  await h.api('assurance.approve', identities.finance, { case: cashCase.id, basis: fresh.evidence.basis })
  assert.equal((await api(`assurance-cases/${cashCase.id}`)).status, 'open', 'Confirmation still requires a fresh recheck')
  assert.equal((await h.api('assurance.recheck', agent, { case: cashCase.id })).status, 'resolved')

  edge.setOutage(null)
  const retried = await h.api('ledger.post', identities.finance, { posting })
  assert.equal(retried.postings[0].status, 'posted')
  const agreed = await h.api('assurance.recheck', agent, { case: ledgerCase.id })
  assert.equal(agreed.status, 'open'); assert.equal(agreed.evidence.mismatch, false)
  await h.api('assurance.approve', identities.accountant, { case: ledgerCase.id, basis: agreed.evidence.basis }, 403)
  await h.api('assurance.approve', identities.finance, { case: ledgerCase.id, basis: agreed.evidence.basis })
  assert.equal((await h.api('assurance.recheck', agent, { case: ledgerCase.id })).status, 'resolved')
  const fixed = await packet()
  assert.deepEqual([fixed.totals.debt.computedCents, fixed.totals.cash.computedUnappliedCents, edge.entries.length], [120000, 0, 1])
  assert.equal(fixed.proofs.some(row => row.mismatch), false)
  assert.deepEqual(fixed.totals.revenue, before.totals.revenue, 'Allocation and posting fixes never rewrite revenue')
  assert.deepEqual((await api('period-closes')).closes, [], 'Preparing and resolving cases closes no period')
  assert.equal((await api(`assurance-cases/${cashCase.id}`)).observations[0].evidence.unappliedCents, 2000, 'The original review evidence remains immutable')
  await onState('resolved', sources)

  await api('credential.revoke', { key: credential.id })
  const retained = await snapshot()
  await h.api('close-tieout?period=2026-09', agent, undefined, 401)
  await scan(agent, fixed.basis, ownerId, 401)
  await h.api('assurance.recheck', agent, { case: cashCase.id }, 401)
  assert.deepEqual(await snapshot(), retained, 'Revocation changes no financial fact')

  const request = await api('erasure.request', { customer })
  await api('erasure.verify', { request: request.id, reason: 'Independently verified customer request', evidence: { filename: 'verification.txt', base64: Buffer.from('Synthetic independent verification').toString('base64'), type: 'text/plain' } })
  await api('erasure.approve', { request: request.id, confirm: true })
  assert.deepEqual(await api('assurance-cases'), [], 'Erasure withdraws both operational cases')
  await api(`assurance-cases/${cashCase.id}`, undefined, 404)
  const withdrawn = await packet()
  assert.ok(withdrawn.sources.invoices.every(row => row.customer_id !== customer))
  assert.ok(withdrawn.proofs.every(row => row.customer !== customer))
  assert.ok(withdrawn.sources.revenue.every(row => row.customerId !== customer))
  assert.equal(withdrawn.sources.invoices.length, 1, 'The clean control remains')
  assert.equal((await scan(owner, fixed.basis, ownerId, 409)).error, 'close_source_changed', 'Replaying the old packet cannot restore erased cases')
  await onState('withdrawn', sources)
  console.log('AGENT-008 native close preparation, independent totals, case custody and safe human fixes passed')
  return sources
}
