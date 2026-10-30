import { portalAnswersFlow } from './portal-answers.mjs'
import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'

// Realistic saved evidence shared by the public-door journey and local browser
// use. Every record enters through the ordinary operator commands.
export async function seedAnswerRecords(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  await api('access.give', { email: 'answers-finance@example.test', name: 'Casey Finance', role: 'finance' })
  await api('access.give', { email: 'answers-accountant@example.test', name: 'Avery Accountant', role: 'accountant' })
  const finance = await h.signIn('answers-finance@example.test', { requested: true })
  const accountant = await h.signIn('answers-accountant@example.test', { requested: true })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: '10', tax_note: 'Reviewed evidence-answer billing example' })
  await api('tax.review', { revision: (await api('business')).revision })
  const customer = (await api('customer.create', { external_id: 'CEDAR-ANS', name: 'Cedar Analytics', billing_email: 'ap@cedar.example' })).id
  const otherCustomer = (await api('customer.create', { external_id: 'MAPLE-ANS', name: 'Maple Research', billing_email: 'ap@maple.example' })).id
  const meter = (await api('meter.create', { code: 'answer-calls', name: 'Analysis calls', unit_label: 'calls' })).id
  const prices = []
  for (const [code, kind, amount] of [['platform', 'flat', '100'], ['seats', 'seat', '10'], ['calls', 'unit', '0.25']]) {
    const product = (await api('product.create', { code: `answer-${code}`, name: `Cedar ${code}` })).id
    prices.push((await api('price.create', { product, kind, unit_amount: amount, taxable: true, ...(kind === 'unit' ? { meter } : {}) })).id)
  }
  const subscription = (await api('subscription.create', { customer, start_date: '2026-07-01', anchor_day: 1, price: prices, quantity: ['', '2', ''] })).id
  const otherSub = (await api('subscription.create', { customer: otherCustomer, start_date: '2026-07-01', anchor_day: 1, price: [prices[0]] })).id
  const sub = await api(`subscriptions/${subscription}`)
  const terms = await api('contract.prepare', { subscription, revision: sub.revision,
    clause: 'Two-month order: $500 minimum before tax, with a monthly platform, two seats and analysis calls billed as consumed.',
    commitments: [{ from: '2026-07-01', to: '2026-09-01', minimum: '500', taxable: true }], included: [], ramps: [] })
  await h.api('contract.decide', finance, { contract: terms.contract, decision: 'approved' })
  for (const [kind, value] of [['discount_percent', '10'], ['fixed_credit', '5']]) {
    const amendment = await api('amendment.propose', { subscription, kind, value, effective_from: '2026-07-01', effective_to: '2026-09-01', clause: 'Signed launch order: 10 percent recurring discount and a one-time $5 credit.' })
    await api('amendment.decide', { amendment: amendment.amendment, decision: 'approved' })
  }
  await api('usage.submit', { events: [
    { event_id: 'cedar-july-a', customer: 'CEDAR-ANS', meter: 'answer-calls', quantity: '40.25', occurred_at: '2026-07-10T12:00:00-07:00', properties: { region: 'west' } },
    { event_id: 'cedar-july-b', customer: 'CEDAR-ANS', meter: 'answer-calls', quantity: '59.75', occurred_at: '2026-07-20T12:00:00-07:00', properties: { region: 'east' } },
    { event_id: 'cedar-august-a', customer: 'CEDAR-ANS', meter: 'answer-calls', quantity: '200', occurred_at: '2026-08-15T12:00:00-07:00', properties: { region: 'west' } },
  ] })
  const issue = async period => {
    const run = await api('billrun.prepare', { period })
    const rows = (await api(`runs/${run.id}`)).invoices
    for (const row of rows) {
      await api('invoice.approve', { invoice: row.id, acknowledge: true })
      await api('invoice.finalise', { invoice: row.id, issue_date: row.period_end })
    }
    return rows
  }
  const july = await issue('2026-07'), august = await issue('2026-08')
  const previous = july.find(row => row.subscription_id === subscription || row.customer_id === customer).id
  const invoice = august.find(row => row.customer_id === customer).id
  const otherInvoice = august.find(row => row.customer_id === otherCustomer).id
  await api('credit.issue', { invoice, amount: '10', reason: 'Reviewed goodwill credit' })
  const payment = await api('payment.record', { customer, amount: '20', received_on: '2026-09-01', method: 'check', reference: 'CEDAR-CHK-20', evidence: 'Bank receipt 2026-09-01' })
  await api('payment.allocate', { payment: payment.payment, invoice, amount: '20' })
  return { customer, otherCustomer, subscription, otherSub, previous, invoice, otherInvoice, finance, accountant, prices }
}

const pointer = (value, path) => path.split('/').slice(1).reduce((record, key) => record?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], value)

// AGENT-007: ten independently useful questions, parameterized records, real
// source lookup, handler authority and an ordinary pending AGENT-002 proposal.
export async function billingAnswersFlow(h, owner) {
  const fixture = await seedAnswerRecords(h, owner)
  const { customer, otherCustomer, invoice, otherInvoice, previous, finance, accountant } = fixture
  const api = (path, body, status) => h.api(path, owner, body, status)
  const agent = { bearer: (await api('credential.issue', { name: 'Cited billing assistant', scopes: ['prepare'] })).key }
  const usageAgent = { bearer: (await api('credential.issue', { name: 'Usage pipeline only', scopes: ['usage'] })).key }
  const current = await api(`invoices/${invoice}`), prior = await api(`invoices/${previous}`)
  assert.deepEqual([prior.total_cents, current.total_cents, current.balanceCents], [14080, 40370, 37370], 'AGENT-007 independent hand calculation includes actual commitment, tax, credit and allocation')
  const beforeAudit = await api('audit'), beforeProposals = await api('proposals'), beforeMail = h.mails.length
  const questions = [
    ['What is the total on this invoice?', 'total'],
    ['Why is this invoice higher than the previous invoice?', 'comparison'],
    ['How many seats were billed and what did they cost?', 'seats'],
    ['What usage was billed on this invoice?', 'usage'],
    ['Which events are behind the usage charge?', 'events'],
    ['How was the sales tax calculated?', 'tax'],
    ['Which discounts and contract credits affected this bill?', 'adjustments'],
    ['Why did the minimum commitment need a true-up?', 'commitment'],
    ['What do we still owe after payments and credit notes?', 'balance'],
    ['What saved billing terms and service dates were used?', 'terms'],
  ]
  const answers = []
  for (const who of [owner, finance, accountant, agent]) {
    for (const [question, topic] of questions) {
      const answer = await h.api('answer.read', who, { customer, invoice, question })
      assert.equal(answer.topic, topic, `AGENT-007 interprets ${question}`)
      assert.equal(answer.customerId, customer)
      assert.equal(answer.invoiceId, invoice)
      assert.ok(answer.citations.length, 'AGENT-007 every answer links its source calculation')
      for (const figure of answer.figures) {
        const record = await api(figure.source.replace('/api/nectar/', ''))
        assert.deepEqual(figure.value, pointer(record, figure.recordPath), `AGENT-007 ${topic}: ${figure.label} equals its exact cited source path`)
      }
      if (topic === 'comparison') {
        assert.equal(answer.comparison.totalDeltaCents, current.total_cents - prior.total_cents)
        assert.equal(answer.comparison.lineDeltas.reduce((n, row) => n + row.deltaCents, 0), current.subtotal_cents - prior.subtotal_cents)
        for (const row of answer.comparison.lineDeltas) assert.equal(row.deltaCents, row.afterCents - row.beforeCents)
      }
      if (topic === 'events') assert.ok(JSON.stringify(answer).includes('cedar-august-a'), 'AGENT-007 answer cites the actual saved event, not only a grand total')
      if (topic === 'commitment') assert.ok(answer.figures.some(figure => figure.value === 20900), 'AGENT-007 exact $209 true-up is sourced from the saved engine evidence')
      answers.push(answer)
    }
  }
  assert.deepEqual(await api(`invoices/${invoice}`), current, 'AGENT-007 all answers leave issued calculations, lines, credits and allocations unchanged')
  assert.deepEqual(await api('audit'), beforeAudit, 'AGENT-007 reading does not write a domain or audit record')
  assert.deepEqual(await api('proposals'), beforeProposals, 'AGENT-007 reading does not prepare a correction')
  assert.equal(h.mails.length, beforeMail, 'AGENT-007 reading sends no customer message')
  await api('answer.read', { customer, invoice: previous, question: 'Compare this bill', comparison_invoice: invoice }, 404)
  await api('usage.submit', { events: [{ event_id: 'cedar-after-issue', customer: 'CEDAR-ANS', meter: 'answer-calls', quantity: '999', occurred_at: '2026-08-20T12:00:00-07:00' }] })
  await api('price.retire', { price: fixture.prices[1] })
  const savedEvents = await api('answer.read', { customer, invoice, question: 'Which source events were used?' })
  assert.ok(!JSON.stringify(savedEvents).includes('cedar-after-issue'), 'AGENT-007 later raw ingestion never enters the issued answer evidence')
  assert.deepEqual((await api('answer.read', { customer, invoice, question: 'What billing terms applied?' })).figures,
    answers.find(answer => answer.topic === 'terms').figures, 'AGENT-007 a later catalogue retirement preserves saved issued prices and terms')
  // The same question uses another customer's actual records; no fixture answer.
  const alternate = await api('answer.read', { customer: otherCustomer, invoice: otherInvoice, question: 'Show the billed total please' })
  assert.ok(alternate.figures.some(figure => figure.value === 11000), 'AGENT-007 arbitrary second customer has its independently billed $110 total')
  for (const who of [owner, finance, accountant, agent]) {
    for (const wrong of [{ customer, invoice: otherInvoice }, { customer: otherCustomer, invoice }, { customer, invoice, comparison_invoice: otherInvoice }]) {
      await h.api('answer.read', who, { ...wrong, question: 'Compare this invoice with the previous bill', topic: 'comparison' }, 404)
    }
    await h.api('answer.read', who, { customer, invoice, question: 'What does Maple Research owe?', topic: 'balance' }, 404)
  }
  for (const [who, status] of [[undefined, 401], [usageAgent, 403]]) {
    await h.api('answer.read', who, { customer, invoice, question: 'What is the invoice total?' }, status)
    await h.api('answer.propose', who, {}, status)
  }
  await api('answer.read', { customer, invoice, question: 'Predict our share price next year' }, 400)
  const interpreted = await api('answer.read', { customer, invoice, question: 'Can you explain this?', topic: 'tax' })
  assert.equal(interpreted.topic, 'tax', 'AGENT-007 explicit visible interpretation resolves an otherwise unsupported question')
  await api('answer.read', { customer, invoice, question: 'Explain', topic: 'invented' }, 400)
  const form = new URLSearchParams({ customer, invoice, question: questions[1][0], topic: '' })
  const rendered = await h.raw('/app/answers', { cookie: accountant, form })
  assert.equal(rendered.status, 200, 'AGENT-007 accountant asks through the actual HTML form')
  const html = await rendered.text()
  assert.ok(html.includes(prior.number) || html.includes(previous), 'AGENT-007 the form answer links the compared invoice')
  assert.ok(!html.includes('/app/do/answer.propose'), 'AGENT-007 read-only accountant has no prepare control')
  assert.equal((await h.raw('/app/answers', { cookie: owner, form, headers: { origin: 'https://other.example' } })).status, 403)
  assert.ok((await h.page(`/app/invoices/${invoice}`, owner)).includes('/app/answers?customer='), 'AGENT-007 invoice links to its evidence-question door')
  assert.ok((await h.page('/app/more', owner)).includes('/app/answers'), 'AGENT-007 ordinary navigation reaches answers')
  const request = { customer, invoice, question: 'What is still owed?', topic: 'balance', credit_amount: '12.34', reason: 'Review a disputed service charge' }
  const draft = await api('answer.read', request)
  assert.equal(draft.proposalDraft.payload.amount, '12.34')
  assert.equal((await api('proposals')).length, beforeProposals.length, 'AGENT-007 suggesting a credit remains read-only until explicit preparation')
  for (const who of [accountant, usageAgent]) await h.api('answer.propose', who, request, 403)
  await api('answer.propose', { ...request, invoice: otherInvoice }, 404)
  const prepared = await h.api('answer.propose', agent, request)
  const proposal = await api(`proposals/${prepared.id}`)
  assert.equal(proposal.status, 'pending')
  assert.equal(proposal.payload.invoice_credit, true)
  assert.equal(proposal.payload.invoice, invoice)
  assert.equal(proposal.impact.credit.amountCents, 1234)
  assert.equal(proposal.impact.credit.balanceAfterCents, 36136)
  assert.equal(proposal.correctionMail, null, 'AGENT-007 suggested credit queues no mail before human approval')
  assert.deepEqual(await api(`invoices/${invoice}`), current, 'AGENT-007 an explicit suggested-credit proposal still changes no money')
  assert.equal(h.mails.length, beforeMail, 'AGENT-007 proposal preparation sends no customer message under the default opt-outs')
  await h.api('proposal.decide', agent, { proposal: prepared.id, decision: 'approved' }, 403)
  const formPrepared = await h.submit('answer.propose', owner, request, '/app/proposals/{id}')
  assert.equal(formPrepared.searchParams.get('error'), null, 'AGENT-007 human form prepares the same ordinary pending correction')
  assert.equal((await api(`proposals/${formPrepared.pathname.split('/').pop()}`)).status, 'pending')
  await api('proposal.decide', { proposal: prepared.id, decision: 'rejected' })
  assert.deepEqual(await api(`invoices/${invoice}`), current, 'AGENT-007 rejecting the suggestion leaves issued and financial evidence unchanged')
  console.log('AGENT-007 ten cited evidence questions across every current reader, foreign-customer refusal and proposal-only credits passed')
  await portalAnswersFlow(h,owner,async()=>{},fixture)
  return { ...fixture, questions, answers }
}
