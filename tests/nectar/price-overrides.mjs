import assert from 'node:assert/strict'

export async function priceOverrides(h, owner) {
  const finance = await h.signIn('price-finance@example.test')
  const accountant = await h.signIn('price-accountant@example.test')
  const agent = { bearer: (await h.api('credential.issue', owner, { name: 'Contract price agent', scopes: ['prepare'] })).key }
  const customer = (await h.api('customer.create', owner, { external_id: 'GOV002-OVERRIDE', name: 'Juniper Systems', billing_email: 'ap@juniper.example' })).id
  const product = (await h.api('product.create', owner, { code: 'gov002-contract-platform', name: 'Contract platform' })).id
  const price = (await h.api('price.create', owner, { product, kind: 'flat', unit_amount: '1000.00', taxable: false })).id
  const clause = 'The platform is $850 per month from 1 May through 31 May 2026.'
  const terms = { kind: 'price_override', value: '850.00', price, effective_from: '2026-05-01', effective_to: '2026-06-01', clause }
  const create = extra => h.api('subscription.create', owner, { customer, start_date: '2026-01-01', anchor_day: '1', price: [price], ...extra })
  const subscription = (await create()).id
  const read = () => h.api(`subscriptions/${subscription}`, owner)
  const original = await read()
  const proposed = await h.api('amendment.propose', owner, { subscription, ...terms })
  const decide = (amendment, who, decision = 'approved', status = 200) => h.api('amendment.decide', who, { amendment, decision }, status)
  assert.equal((await decide(proposed.amendment, owner, 'approved', 409)).error, 'second_approver_required')
  for (const who of [accountant, agent]) await decide(proposed.amendment, who, 'approved', 403)
  let state = await read()
  assert.deepEqual(state.items, original.items)
  assert.equal(state.revision, original.revision)
  assert.equal(state.amendments[0].status, 'proposed')
  const page = await h.page(`/app/subscriptions/${subscription}`, owner)
  assert.doesNotMatch(page, new RegExp(`name="amendment" value="${proposed.amendment}"[^]*?name="decision" value="approved"`))
  await decide(proposed.amendment, finance)
  await decide(proposed.amendment, finance, 'approved', 409)
  state = await read()
  assert.equal(state.amendments[0].status, 'approved')
  assert.equal(state.amendments[0].decided_by, 'price-finance@example.test')

  // A contract price entered while creating a subscription is not a bypass.
  const initial = (await create({ exception_kind: terms.kind, exception_value: terms.value, exception_price: price, exception_effective_from: terms.effective_from, exception_effective_to: terms.effective_to, exception_clause: clause })).id
  const initialAmendment = (await h.api(`subscriptions/${initial}`, owner)).amendments[0]
  assert.ok(initialAmendment.prepared_by_id)
  await decide(initialAmendment.id, owner, 'approved', 409)
  await decide(initialAmendment.id, finance)
  const run = await h.api('billrun.prepare', owner, { period: '2026-05' })
  const invoices = (await h.api(`runs/${run.id}`, owner)).invoices.filter(i => i.customer_id === customer)
  assert.equal(invoices.length, 2)
  for (const invoice of invoices) {
    assert.equal(invoice.total_cents, 85000)
    await h.api('invoice.approve', owner, { invoice: invoice.id, acknowledge: true })
    await h.api('invoice.finalise', owner, { invoice: invoice.id, issue_date: '2026-06-01' })
  }
  const issued = await h.api(`invoices/${invoices[0].id}`, owner)

  // The proposal door uses the same rule for contract prices, while an agent
  // still cannot approve and a preparer can reject their own work.
  const payload = { ...terms, subscription, value: '800.00', effective_from: '2026-07-01', effective_to: '2026-08-01' }
  const proposal = await h.api('proposal.create', owner, { kind: 'amendment', title: 'Juniper July contract price', payload, evidence: { clauses: [{ quote: 'July platform fee is $800.' }] } })
  await h.api('proposal.decide', owner, { proposal: proposal.id, decision: 'approved' }, 409)
  await h.api('proposal.decide', finance, { proposal: proposal.id, decision: 'approved' })
  const applied = (await read()).amendments.find(a => a.proposal_id === proposal.id)
  assert.equal(applied.prepared_by_id, (await h.api(`proposals/${proposal.id}`, owner)).prepared_by_id)
  assert.equal(applied.status, 'approved')
  const rejected = await h.api('amendment.propose', owner, { ...payload, value: '750.00' })
  await decide(rejected.amendment, owner, 'rejected')
  assert.equal((await read()).amendments.find(a => a.id === rejected.amendment).status, 'rejected')
  assert.deepEqual(await h.api(`invoices/${invoices[0].id}`, owner), issued)
  console.log('GOV-002 contract price overrides: native, subscription-create and proposal doors require separate human approval; exact billing and issued history passed')
  return { subscription, finance, price }
}
