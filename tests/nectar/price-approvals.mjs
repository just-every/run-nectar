import assert from 'node:assert/strict'

// GOV-002: existing price-migration proposals require a different human.
export async function priceApprovals(h, owner) {
  await h.api('access.give', owner, { email: 'price-finance@example.test', name: 'Morgan Finance', role: 'finance' })
  await h.api('access.give', owner, { email: 'price-accountant@example.test', name: 'Alex Accountant', role: 'accountant' })
  const finance = await h.signIn('price-finance@example.test', { requested: true })
  const accountant = await h.signIn('price-accountant@example.test', { requested: true })
  const agent = { bearer: (await h.api('credential.issue', owner, { name: 'Price simulation agent', scopes: ['prepare'] })).key }
  const customer = (await h.api('customer.create', owner, { external_id: 'GOV002-PRICE', name: 'Cedar Analytics', billing_email: 'ap@cedar.example' })).id
  const product = (await h.api('product.create', owner, { code: 'gov002-price-platform', name: 'Analytics platform' })).id
  const price = (await h.api('price.create', owner, { product, kind: 'flat', unit_amount: '499.00', taxable: false })).id
  const subscription = (await h.api('subscription.create', owner, { customer, start_date: '2026-01-01', anchor_day: '1', price: [price] })).id
  const payload = { product, kind: 'flat', unit_amount: '549.00', taxable: false, effective_date: '2026-06-01', subscriptions: [subscription] }
  const prepare = (who, title) => h.api('proposal.create', who, { kind: 'price_change', title, payload, evidence: { reason: 'Annual price review' } })
  const detail = id => h.api(`proposals/${id}`, owner)
  const decision = (id, who, status = 200, value = 'approved') => h.api('proposal.decide', who, { proposal: id, decision: value }, status)
  const catalog = async () => (await h.api('catalog', owner)).prices.filter(row => row.product_id === product)
  const originalSub = await h.api(`subscriptions/${subscription}`, owner)
  const originalPrices = await catalog()

  const own = await prepare(owner, 'Cedar annual price review')
  const prepared = await detail(own.id)
  assert.equal(prepared.needsOtherApprover, true)
  assert.ok(prepared.prepared_by_id)
  assert.equal((await decision(own.id, owner, 409)).error, 'second_approver_required', 'even the owner cannot approve their own price migration')
  for (const who of [agent, accountant]) await decision(own.id, who, 403)
  assert.deepEqual(await catalog(), originalPrices)
  assert.deepEqual(await h.api(`subscriptions/${subscription}`, owner), originalSub)
  assert.equal((await detail(own.id)).status, 'pending')
  const page = await h.page(`/app/proposals/${own.id}`, owner)
  assert.doesNotMatch(page, /name="decision" value="approved"/)
  assert.match(page, /name="decision" value="rejected"/)

  const competing = await prepare(finance, 'Superseded price review')
  await decision(competing.id, finance, 409)
  const preview = prepared.impact[0].periods
  assert.deepEqual(preview.map(p => [p.before.totalCents, p.after.totalCents]), [[49900, 54900], [49900, 54900]])
  await decision(own.id, finance)
  const approved = await detail(own.id)
  assert.equal(approved.status, 'approved')
  assert.equal(approved.decided_by, 'price-finance@example.test')
  assert.equal(approved.prepared_by_id, prepared.prepared_by_id)
  assert.deepEqual(approved.payload, prepared.payload)
  assert.deepEqual(approved.impact, prepared.impact)
  assert.equal((await decision(own.id, finance, 409)).error, 'already_decided')
  assert.equal((await decision(competing.id, owner, 409)).error, 'proposal_stale')
  const prices = await catalog()
  assert.equal(prices.length, 2)
  assert.deepEqual(prices.find(p => p.id === price), originalPrices[0], 'the prior price version never changes')
  const run = await h.api('billrun.prepare', owner, { period: '2026-06' })
  const invoice = (await h.api(`runs/${run.id}`, owner)).invoices.find(i => i.customer_id === customer)
  assert.equal(invoice.total_cents, preview[0].after.totalCents)
  await h.api('invoice.approve', owner, { invoice: invoice.id, acknowledge: true })
  await h.api('invoice.finalise', owner, { invoice: invoice.id, issue_date: '2026-07-01' })
  const issued = await h.api(`invoices/${invoice.id}`, owner)
  assert.equal(issued.total_cents, 54900)

  // Rejection remains possible for the preparer; agent-prepared work still
  // requires a human and a finance-prepared proposal can be approved by owner.
  payload.effective_date = '2026-08-01'
  payload.unit_amount = '599.00'
  const rejected = await prepare(owner, 'Declined September price review')
  await decision(rejected.id, owner, 200, 'rejected')
  assert.equal((await detail(rejected.id)).status, 'rejected')
  const agentProposal = await prepare(agent, 'Agent price simulation')
  await decision(agentProposal.id, agent, 403)
  await decision(agentProposal.id, owner, 200, 'rejected')
  const financeProposal = await prepare(finance, 'Cedar August price review')
  assert.equal((await detail(financeProposal.id)).needsOtherApprover, false)
  await decision(financeProposal.id, owner)
  assert.deepEqual(await h.api(`invoices/${invoice.id}`, owner), issued, 'later migration preserves the issued invoice and calculation')
  assert.equal((await catalog()).length, 3)
  console.log('GOV-002 price-migration proposals: separate approver, owner self-refusal, stale and duplicate refusal, exact billed preview passed')
  return { finance, accountant, subscription, proposal: own.id, rejected: rejected.id, payload }
}
