// One close-preparation sanity journey through ordinary Worker and D1 doors.
// The only provider substitution is the existing QuickBooks network edge.
import assert from 'node:assert/strict'
import { processorEdge } from './processor-edge.mjs'
import { quickbooksEdge } from './quickbooks-edge.mjs'

let edge, processor
export const harnessOptions = () => { edge = quickbooksEdge(); processor = processorEdge({ at: Date.parse('2026-09-25T10:00:00Z')/1000 }); return { quickbooksFetch: edge.fetch, stripeFetch: processor.fetch, stripeSecret: 'synthetic-nectar-1', localTime: '2026-09-30T20:00:00Z' } }

export async function seedCloseSources(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const mailbox = (await api('me')).email
  const customer = (await api('customer.create', { external_id: 'synthetic-nectar-8001', name: 'Native close review', billing_email: mailbox })).id
  const clean = (await api('customer.create', { external_id: 'synthetic-nectar-8002', name: 'Clean close control', billing_email: mailbox })).id
  edge?.addCustomer('Native close review')
  const product = (await api('product.create', { code: 'synthetic-nectar-8001', name: 'Annual service' })).id
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
  const credit = await api('credit.issue', { invoice: annual, amount: '50', reason: 'Reviewed annual service concession' })
  const payment = (await api('payment.record', { customer, amount: '150', received_on: '2026-09-15', method: 'bank_transfer', reference: 'synthetic-nectar-8001' })).payment
  await api('payment.allocate', { payment, invoice: annual, amount: '100' })
  await api('balance.return', { customer, payment, amount: '30', reason: 'Reviewed cash overpayment returned externally', reference: 'synthetic-nectar-return' })
  let cleanPayment = (await api('payment.record', { customer: clean, amount: '200', received_on: '2026-09-15', method: 'bank_transfer', reference: 'synthetic-nectar-8002' })).payment
  await api('payment.allocate', { payment: cleanPayment, invoice: cleanInvoice, amount: '200' })
  edge?.setOutage('down')
  const written = await api('writeoff.issue', { invoice: badDebtInvoice, amount: '100', reason: 'Reviewed uncollectable balance' })
  let payout, cleanPayout, payoutEvent, processorInvoice, cleanProcessorInvoice
  if (processor) {
    processorInvoice = await manual(customer, '40')
    cleanProcessorInvoice = await manual(clean, '200')
    const consume = (event, status = 200) => api('processor.event.consume', { account_ref: processor.account, event_ref: event.id }, status)
    await api('collection.customer.bind', { customer, account_ref: processor.account, stripe_customer_ref: processor.customerRef, confirm: true })
    const cleanRef = 'synthetic-nectar-close-control-customer'
    processor.objects.set(cleanRef, { object: 'customer', id: cleanRef, livemode: false, invoice_settings: { default_payment_method: null } })
    await api('collection.customer.bind', { customer: clean, account_ref: processor.account, stripe_customer_ref: cleanRef, confirm: true })
    const brokenSource = processor.seed(processorInvoice, 4000, 'close-broken')
    const cleanSource = processor.seed(cleanProcessorInvoice, 20000, 'close-control')
    cleanSource.intent.customer = cleanRef; cleanSource.charge.customer = cleanRef
    for (const [suffix, source] of [['broken', brokenSource], ['control', cleanSource]]) {
      await consume(processor.event(`synthetic-nectar-close-payment-${suffix}`, 'charge.succeeded', source.charge))
    }
    const seedPayout = (suffix, source) => {
      const value = { object: 'payout', id: `synthetic-nectar-close-payout-${suffix}`, status: 'paid', amount: source.transaction.net, currency: 'usd', automatic: true, livemode: false, balance_transaction: `synthetic-nectar-close-debit-${suffix}` }
      processor.objects.set(value.id, value)
      processor.transactions.set(value.balance_transaction, { object: 'balance_transaction', id: value.balance_transaction, type: 'payout', source: value.id, amount: -value.amount, fee: 0, net: -value.amount, currency: 'usd', status: 'available', created: processor.at + 2, available_on: processor.at + 2 })
      processor.payoutMembers.set(value.id, [source.transaction.id])
      return value
    }
    payout = seedPayout('broken', brokenSource); cleanPayout = seedPayout('control', cleanSource)
    await consume(processor.event('synthetic-nectar-close-control-event', 'payout.paid', cleanPayout))
    // The processor's payout constituent omits its known 320-cent fee. The
    // previously authenticated charge observation remains unchanged.
    Object.assign(brokenSource.transaction, { fee: 0, net: 4000 })
    payoutEvent = processor.event('synthetic-nectar-close-broken-event', 'payout.paid', payout)
    assert.equal((await consume(payoutEvent, 409)).error, 'processor_payout_does_not_reconcile')
  }
  if (edge) {
    edge.setOutage(null)
    await api('close.credits.observe', { period: '2026-09', basis: (await api('close-tieout?period=2026-09')).basis })
    edge.setOutage('down')
  }
  return { credit, customer, clean, annual, badDebtInvoice, cleanInvoice, payment, cleanPayment, posting: written.posting.id, payout, cleanPayout, payoutEvent, processorInvoice, cleanProcessorInvoice }
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
  const snapshot = async () => ({ invoices: await Promise.all([annual, badDebtInvoice, sources.cleanInvoice].map(id => api(`invoices/${id}`))), payments: await api('payments'), postings: await api('ledger-postings'), closes: await api('period-closes'), processorCalls: processor.calls.length, journals: edge.summary(), calls: edge.calls.length })
  const scan = async (who = agent, basis, assigned = ownerId, status = 200) => h.api('close.scan', who, { period: '2026-09', basis: basis ?? (await packet()).basis, owner: assigned }, status)
  const baseline = await snapshot(), before = await packet()
  // Expected figures come from the public writes above, not the packet's input arrays.
  assert.deepEqual(before.totals.debt, { issuedCents: 194000, creditNotesCents: 5000, allocatedCents: 54000, carriedAppliedCents: 0, goodwillAppliedCents: 3000, writeOffCents: 10000, recoveryCents: 0, reversedCents: 0, reportedCents: 122000, computedCents: 122000, differenceCents: 0 })
  assert.deepEqual(before.totals.cash, { receivedCents: 59000, allocatedCents: 54000, returnedCents: 3000, reportedUnappliedCents: 2000, computedUnappliedCents: 2000, differenceCents: 0 })
  assert.deepEqual(before.totals.credit, { grantedCents: 4000, appliedCents: 3000, reportedGoodwillCents: 1000, carriedCents: 0, computedGoodwillCents: 1000, differenceCents: 0 })
  assert.deepEqual(before.totals.revenue, { openingCents: 110000, netBillingsCents: 69000, recognizedCents: 79000, closingCents: 100000, differenceCents: 0, rollforwardDifferenceCents: 0 })
  assert.equal(before.sources.invoices.length, 5)
  const creditProof = before.proofs.find(row => row.credit === sources.credit.credit)
  assert.equal(creditProof.status, 'missing')
  assert.equal(creditProof.category, 'synchronization_failure')
  assert.equal(before.sources.creditSync[0].amountCents, 5000)
  assert.equal(before.sources.allocations.length, 4)
  assert.equal(before.proofs.filter(row => row.customer === clean && row.mismatch).length, 0, 'The clean customer creates no financial break')
  const cash = before.proofs.find(row => row.payment === payment), ledger = before.proofs.find(row => row.posting === posting)
  assert.equal(cash.category, 'review'); assert.equal(ledger.category, 'synchronization_failure')
  assert.equal(ledger.error, 'ledger_unavailable')
  assert.equal(before.coverage.find(row => row.area === 'Payouts and processor fees').state, 'observed_test_sources')
  assert.deepEqual(before.totals.payouts, { count: 2, amountCents: 23360, grossCents: 24000, feeCents: 320, netCents: 23680, differenceCents: 320, unresolved: 1 })
  const payoutProof = before.proofs.find(row => row.payoutRef === sources.payout.id)
  assert.equal(payoutProof.category, 'reconciliation_break')
  assert.equal(payoutProof.members[0].recordedFeeCents, 320)
  assert.equal(payoutProof.members[0].feeCents, 0)
  assert.equal(payoutProof.members[0].changed, true)
  assert.ok(before.proofs.filter(row => row.payoutRef === sources.cleanPayout.id).every(row => !row.mismatch))
  const recorded = (await api('processor-events')).transactions.find(row => row.transaction_ref === payoutProof.members[0].transaction)
  assert.deepEqual([recorded.fee_cents, recorded.net_cents], [320, 3680], 'A refused payout never replaces the recorded financial facts')
  assert.equal(before.coverage.find(row => row.area === 'Provider tax commitments').state, 'not_covered')
  for (const source of [...before.sources.invoices, ...before.sources.payments, ...before.sources.allocations, ...before.sources.credits, ...before.sources.movements, ...before.sources.payouts]) {
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
  assert.equal(opened.opened.length, 4)
  const cases = await api('assurance-cases'), cashCase = cases.find(row => row.kind === cash.kind), ledgerCase = cases.find(row => row.kind === ledger.kind), payoutCase = cases.find(row => row.kind === payoutProof.kind), creditCase = cases.find(row => row.kind === creditProof.kind)
  assert.ok(cashCase && ledgerCase && payoutCase && creditCase)
  assert.deepEqual((await scan()).opened, [], 'Repeating a scan creates no duplicate item')
  const concurrent = await Promise.all([1, 2].map(() => h.raw('/api/nectar/close.scan', { ...agent, body: { period: '2026-09', basis: before.basis, owner: ownerId } })))
  for (const response of concurrent) {
    const result = await response.json()
    if (response.status === 200) assert.deepEqual(result.opened, [])
    else { assert.equal(response.status, 409); assert.equal(result.error, 'assurance_source_changed') }
  }
  assert.equal((await api('assurance-cases')).length, 4)
  assert.deepEqual(await snapshot(), baseline, 'Scanning allocates nothing, posts nothing and closes nothing')
  const assigneeEmail = (await api('me')).email.replace(/^[^@]+/, 'synthetic-nectar-assignee')
  const assignee = await api('access.give', { email: assigneeEmail, name: 'Close case assignee', role: 'finance' })
  await api('assurance.assign', { case: cashCase.id, owner: assignee.id })
  await api('access.end', { member: assignee.id })
  await h.api('assurance.recheck', agent, { case: cashCase.id }, 409)
  assert.equal((await api(`assurance-cases/${cashCase.id}`)).status, 'open', 'An unavailable assignee cannot resolve the case')
  await api('assurance.assign', { case: cashCase.id, owner: ownerId })
  for (const who of [agent, identities.accountant, identities.collections, identities.developer]) {
    await h.api('assurance.assign', who, { case: cashCase.id, owner: ownerId }, 403)
    await h.api('assurance.approve', who, { case: cashCase.id, basis: cash.basis }, 403)
  }
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
  // Only a finance-authorized fresh provider observation can replace the
  // rejected payout comparison. Neither scans nor confirmations call Stripe.
  const priorPayout = (await packet()).sources.payouts.find(row => row.payout_ref === sources.payout.id)
  const processorBefore = processor.calls.length
  await api('assurance.approve', { case: payoutCase.id, basis: payoutProof.basis }, 409)
  assert.equal((await h.api('assurance.recheck', agent, { case: payoutCase.id })).status, 'open')
  assert.equal(processor.calls.length, processorBefore)
  for (const who of [agent, identities.accountant, identities.collections, identities.developer]) {
    await h.api('processor.event.consume', who, { account_ref: processor.account, event_ref: sources.payoutEvent.id }, 403)
  }
  const transaction = processor.transactions.get(payoutProof.members[0].transaction)
  Object.assign(transaction, { fee: 320, net: 3680 })
  await h.rejectAudit('processor.event.apply')
  await h.api('processor.event.consume', identities.finance, { account_ref: processor.account, event_ref: sources.payoutEvent.id }, 500)
  assert.deepEqual((await packet()).sources.payouts.find(row => row.payout_ref === sources.payout.id), priorPayout, 'Audit failure cannot publish a corrected comparison')
  await h.rejectAudit(null)
  await h.api('processor.event.consume', identities.finance, { account_ref: processor.account, event_ref: sources.payoutEvent.id })
  const observed = await h.api('assurance.recheck', agent, { case: payoutCase.id })
  assert.equal(observed.status, 'open'); assert.equal(observed.evidence.mismatch, false)
  await api('assurance.approve', { case: payoutCase.id, basis: payoutProof.basis }, 409)
  await h.api('assurance.approve', identities.finance, { case: payoutCase.id, basis: observed.evidence.basis })
  assert.equal((await h.api('assurance.recheck', agent, { case: payoutCase.id })).status, 'resolved')
  // The credit exists natively, but its absence in the ledger is distinct
  // from the existing bad-debt posting and the payout comparison.
  for (const who of [agent, identities.accountant, identities.collections, identities.developer]) {
    await h.api('close.credits.observe', who, { period: '2026-09', basis: (await packet()).basis }, 403)
  }
  const memo = { Id: 'synthetic-nectar-credit-memo', DocNumber: sources.credit.number, TotalAmt: 49, CurrencyRef: { value: 'USD' }, CustomerRef: { value: 'synthetic-customer-1' }, PrivateNote: `Nectar credit ${sources.credit.credit} for invoice ${annual}` }
  const observeCurrent = async (status = 200) => h.api('close.credits.observe', identities.finance, { period: '2026-09', basis: (await packet()).basis }, status)
  edge.setCreditMemo(memo)
  await observeCurrent()
  const wrong = await h.api('assurance.recheck', agent, { case: creditCase.id })
  assert.equal(wrong.evidence.status, 'mismatch')
  await h.api('assurance.approve', identities.finance, { case: creditCase.id, basis: wrong.evidence.basis }, 409)
  // Equal totals and a reused document number cannot adopt another source.
  memo.TotalAmt = 50; memo.PrivateNote = 'synthetic-nectar-other-source'
  edge.setCreditMemo(memo); await observeCurrent()
  assert.equal((await h.api('assurance.recheck', agent, { case: creditCase.id })).evidence.status, 'mismatch')
  memo.PrivateNote = `Nectar credit ${sources.credit.credit} for invoice ${annual}`
  memo.CustomerRef.value = 'synthetic-nectar-foreign-customer'
  edge.setCreditMemo(memo); await observeCurrent()
  assert.equal((await h.api('assurance.recheck', agent, { case: creditCase.id })).evidence.status, 'mismatch')
  memo.CustomerRef.value = 'synthetic-customer-1'
  edge.setCreditMemo(memo)
  const creditBeforeAudit = (await packet()).sources.creditSync
  await h.rejectAudit('close.credits.observe'); await observeCurrent(500); await h.rejectAudit(null)
  assert.deepEqual((await packet()).sources.creditSync, creditBeforeAudit, 'Audit failure cannot adopt a ledger observation')
  await observeCurrent()
  const creditAgreed = await h.api('assurance.recheck', agent, { case: creditCase.id })
  assert.equal(creditAgreed.status, 'open'); assert.equal(creditAgreed.evidence.status, 'synced')
  await h.api('assurance.approve', identities.finance, { case: creditCase.id, basis: creditProof.basis }, 409)
  await h.api('assurance.approve', identities.finance, { case: creditCase.id, basis: creditAgreed.evidence.basis })
  assert.equal((await h.api('assurance.recheck', agent, { case: creditCase.id })).status, 'resolved')
  assert.equal(edge.calls.filter(row => row.method === 'POST').length, 1, 'Credit observation and case closure write no journal or credit memo')
  const fixed = await packet()
  assert.deepEqual(fixed.totals.payouts, { count: 2, amountCents: 23360, grossCents: 24000, feeCents: 640, netCents: 23360, differenceCents: 0, unresolved: 0 })
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
  assert.equal(withdrawn.sources.invoices.length, 2, 'The clean control remains')
  assert.deepEqual(withdrawn.sources.payouts.map(row => row.payout_ref), [sources.cleanPayout.id], 'Erasure withdraws the affected payout and preserves the clean control')
  assert.equal((await scan(owner, fixed.basis, ownerId, 409)).error, 'close_source_changed', 'Replaying the old packet cannot restore erased cases')
  await onState('withdrawn', sources)
  console.log('AGENT-008 native close preparation, independent totals, case custody and safe human fixes passed')
  return sources
}

// Focused real archive custody without starting an installer or a development server.
export async function closeTieoutArchive() {
  const { access, mkdir, mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { readArchive } = await import('@runeditrun/rer/modules/portability')
  const { harness, file } = await import('./harness.mjs')
  const { command } = await import('./cli.mjs')
  const { applyPolicy } = await import('./policy-helper.mjs')
  assert.equal(process.env.NECTAR_TEST_CHECKOUT, '1', 'Use a disposable checkout')
  const root = process.cwd()
  for (const name of ['.dev.vars', '.wrangler/state']) await access(join(root, name)).then(() => { throw new Error('A fresh unconfigured checkout is required') }, error => { if (error.code !== 'ENOENT') throw error })
  await mkdir('exports', { recursive: true })
  const scratch = await mkdtemp(join(root, 'exports', 'close-archive-'))
  const archive = name => join(scratch, `${name}.rer`)
  const items = async name => {
    const bytes = await readFile(archive(name)), rows = []
    for await (const record of readArchive(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }))) {
      if (record.kind === 'part') rows.push(...record.items.map(({ index, ...item }) => item))
    }
    return rows
  }
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'))
  const persistence = join(root, '.wrangler/state/v3'), databaseId = config.d1_databases.find(row => row.binding === 'DB').database_id
  const options = harnessOptions()
  let h, owner, settings
  const start = async () => {
    h = await harness({ ...options, persistence, databaseId, applyMigrations: false, ...(settings ? { settings } : {}) })
    assert.equal((await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Close Owner' } })).status, 303, 'The restored owner explicitly bootstraps new local sign-in authority')
    owner = await h.signIn(h.vars.OWNER_EMAIL)
    settings = { ...h.vars }
  }
  const stop = async () => { await h?.close(); h = null }
  const selected = rows => rows.filter(row => row.kind === 'row' && ['nc_assurance_cases', 'nc_assurance_observations', 'nc_ledger_postings', 'nc_payout_checks', 'nc_close_credit_observations'].includes(row.table))
  try {
    await command(root, ['export', '--output', archive('empty')])
    await start()
    await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })
    await h.api('business.configure', owner, { legal_name: 'Close Archive Software', timezone: 'America/Los_Angeles', invoice_prefix: 'CLOSE', payment_terms_days: 30 })
    await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'no_tax', tax_note: 'Reviewed close archive journey' })
    await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
    const source = await seedCloseSources(h, owner)
    const basis = (await h.api('close-tieout?period=2026-09', owner)).basis
    const ownerId = (await h.api('me', owner)).id
    await h.api('close.scan', owner, { period: '2026-09', basis, owner: ownerId })
    const cases = await h.api('assurance-cases', owner)
    assert.equal(cases.length, 4)
    await stop()
    await command(root, ['export', '--output', archive('populated')])
    const populated = selected(await items('populated'))
    assert.equal(populated.filter(row => row.table === 'nc_assurance_cases').length, 4)
    assert.equal(populated.filter(row => row.table === 'nc_assurance_observations').length, 4)
    assert.equal(populated.filter(row => row.table === 'nc_ledger_postings').length, 1)
    assert.equal(populated.filter(row => row.table === 'nc_payout_checks').length, 2)
    const calls = edge.calls.length
    await command(root, ['reset', '--yes'])
    await command(root, ['import', '--input', archive('populated'), '--yes'])
    await command(root, ['export', '--output', archive('restored')])
    assert.deepEqual(selected(await items('restored')), populated, 'Actual restore preserves exact case, observation and financial posting evidence')
    await start()
    assert.equal((await h.api('close-tieout?period=2026-09', owner)).basis, basis)
    assert.equal(edge.calls.length, calls, 'Restoration and packet reads create no ledger request')
    assert.deepEqual((await h.api('period-closes', owner)).closes, [])
    const request = await h.api('erasure.request', owner, { customer: source.customer })
    await h.api('erasure.verify', owner, { request: request.id, reason: 'Independent close-source erasure verification', evidence: file('verification.txt', 'Synthetic independent verification', 'text/plain') })
    await h.api('erasure.approve', owner, { request: request.id, confirm: true })
    assert.deepEqual(await h.api('assurance-cases', owner), [])
    await stop()
    await command(root, ['export', '--output', archive('anonymous')])
    const anonymous = await items('anonymous')
    assert.ok(!selected(anonymous).some(row => ['nc_assurance_cases', 'nc_assurance_observations'].includes(row.table)), 'Erased operational investigations are absent')
    assert.equal(selected(anonymous).find(row => row.table === 'nc_ledger_postings' && row.row.id === source.posting).row.amount_cents, 10000, 'Minimal financial custody retains the bad-debt amount')
    await command(root, ['reset', '--yes'])
    await command(root, ['import', '--input', archive('populated'), '--journal', archive('anonymous'), '--yes'], { refuse: true })
    await command(root, ['import', '--input', archive('anonymous'), '--yes'])
    await start()
    const restored = await h.api('close-tieout?period=2026-09', owner)
    assert.equal(restored.sources.invoices.length, 2, 'The clean peer survives anonymous restoration')
    assert.ok(restored.proofs.every(row => row.customer !== source.customer))
    await h.api('close.scan', owner, { period: '2026-09', basis, owner: ownerId }, 409)
    assert.deepEqual(await h.api('assurance-cases', owner), [], 'An old packet cannot resurrect erased investigations')
    assert.equal(edge.calls.length, calls, 'Archive operations confer no posting authority')
    console.log('AGENT-008 actual export, exact restore, erasure, old-archive refusal and anonymous close custody passed')
  } finally { await stop(); await rm(scratch, { recursive: true, force: true }) }
}

if (process.argv[1] === new URL(import.meta.url).pathname && process.argv[2] === 'archive') await closeTieoutArchive()
