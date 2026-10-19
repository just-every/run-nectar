import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'

// Ordinary AGENT-002 corrections retain invoice approval as a separate action.
export async function draftCorrectionsFlow(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const previous = await api('business')
  await api('access.give', { email: 'draft-finance@example.test', name: 'Draft Correction Finance', role: 'finance' })
  await api('access.give', { email: 'draft-accountant@example.test', name: 'Draft Correction Accountant', role: 'accountant' })
  const [finance, accountant] = await Promise.all([
    h.signIn('draft-finance@example.test', { requested: true }), h.signIn('draft-accountant@example.test', { requested: true }),
  ])
  const agent = { bearer: (await api('credential.issue', { name: 'Draft correction agent', scopes: ['prepare'] })).key }
  const detail = id => api(`proposals/${id}`)
  const decide = (id, who = owner, status = 200, extra = {}) => h.api('proposal.decide', who, { proposal: id, decision: 'approved', ...extra }, status)
  const formDecision = async (id, who, extra = {}, error = null) => {
    const redirect = await h.submit('proposal.decide', who, { proposal: id, decision: 'approved', ...extra }, `/app/proposals/${id}`)
    assert.equal(redirect.searchParams.get('error'), error)
  }
  const totals = value => [value.subtotalCents, value.taxCents, value.totalCents]
  const upcoming = (fixture, period = '2026-04') => api(`subscriptions/${fixture.subscription}/upcoming?period=${period}`)
  const hostile = [{ customer: 'invented-customer', recipient: 'attacker@example.test', subject: 'Caller-selected subject', body: 'Caller-selected body', citations: [] }]

  try {
    const tax = rate => applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: rate, tax_note: 'Reviewed draft correction example' })
    await tax('10')
    await api('tax.review', { revision: (await api('business')).revision })
    const meterCode = 'agent002-draft-events'
    const meter = (await api('meter.create', { code: meterCode, name: 'Draft correction events', unit_label: 'events' })).id
    const prices = []
    for (const [code, kind, unit_amount] of [['base', 'flat', '100'], ['events', 'unit', '0.01']]) {
      const product = (await api('product.create', { code: `agent002-draft-${code}`, name: `Draft correction ${code}` })).id
      prices.push((await api('price.create', { product, kind, unit_amount, taxable: true, ...(kind === 'unit' ? { meter } : {}) })).id)
    }
    const fixtures = []
    for (const suffix of ['TERMS', 'USAGE']) {
      const external = `AGENT002-DRAFT-${suffix}`, email = `ap@draft-${suffix.toLowerCase()}.example`
      const customer = (await api('customer.create', { external_id: external, name: `Cedar Draft ${suffix}`, billing_email: email })).id
      const subscription = (await api('subscription.create', { customer, start_date: '2026-03-01', anchor_day: 1, price: prices })).id
      fixtures.push({ external, customer, subscription, email })
    }
    const [terms, usage] = fixtures
    const event = (fixture, event_id, quantity, month = '04') => ({ event_id, customer: fixture.external, meter: meterCode, quantity, occurred_at: `2026-${month}-10T12:00:00-07:00` })
    const submit = async events => assert.equal((await api('usage.submit', { events })).accepted, events.length)
    await submit(fixtures.flatMap((fixture, i) => [event(fixture, `draft-${i}-march`, '1000', '03'), event(fixture, `draft-${i}-april`, '1000')]))
    const march = await api('billrun.prepare', { period: '2026-03' })
    const marchInvoices = (await api(`runs/${march.id}`)).invoices
    for (const fixture of fixtures) {
      const invoice = marchInvoices.find(row => row.customer_id === fixture.customer)
      assert.ok(invoice)
      await api('invoice.approve', { invoice: invoice.id, acknowledge: true })
      await api('invoice.finalise', { invoice: invoice.id, issue_date: '2026-04-01' })
      fixture.original = await api(`invoices/${invoice.id}`)
      assert.deepEqual([fixture.original.subtotal_cents, fixture.original.tax_cents, fixture.original.total_cents], [11000, 1100, 12100])
      const april = await upcoming(fixture)
      assert.equal(april.state, 'preview')
      assert.equal(april.invoiceId, null)
      assert.deepEqual(totals(april.calculation), [11000, 1100, 12100])
    }
    const amendment = (extra = {}) => ({ kind: 'amendment', title: 'Executed April recurring discount', payload: {
      subscription: terms.subscription, kind: 'discount_percent', value: '10', effective_from: '2026-04-01', note: 'Reviewed recurring discount', noticeDrafts: hostile, ...extra,
    }, evidence: { clauses: [{ quote: 'From 1 April 2026 the recurring platform fee is reduced by ten percent.', reference: 'Executed renewal, section 2' }] } })
    const correction = (replacement = 'draft-usage-replacement', extra = {}) => ({ kind: 'usage_correction', title: 'Correct the duplicated April quantity', payload: {
      void: [{ event_id: 'draft-1-april', reason: 'Original quantity was twice the source count' }],
      add: [event(usage, replacement, '500')], noticeDrafts: hostile, ...extra,
    }, evidence: { sources: ['April gateway export: draft-1-april should contain 500 events, not 1000.'] } })
    const propose = (input, who = agent, status = 200) => h.api('proposal.create', who, input, status)
    const otherRecipients = []
    const mails = () => h.mails.filter(mail => [mail.to].flat().some(to => fixtures.some(fixture => fixture.email === to) || otherRecipients.includes(to) || to === 'new-draft-billing@example.test'))
    const snapshot = async () => {
      const [subscriptions, previews, batches] = await Promise.all([
        Promise.all(fixtures.map(fixture => api(`subscriptions/${fixture.subscription}`))),
        Promise.all(fixtures.map(async fixture => (await upcoming(fixture)).calculation)), api('usage/batches'),
      ])
      return { subscriptions, previews, batches }
    }
    const checkDraft = (proposal, fixture, impacts) => {
      assert.deepEqual(proposal.customerMessages, [], 'preparation creates no customer delivery record')
      assert.equal(proposal.payload.noticeDrafts.length, 1, 'one explanation covers all affected periods for this customer')
      const draft = proposal.payload.noticeDrafts[0]
      assert.equal(draft.customer, fixture.customer)
      assert.equal(draft.recipient, fixture.email)
      assert.ok(draft.subject.length && draft.body.length)
      assert.ok(!JSON.stringify(draft).includes('attacker@example.test') && !draft.body.includes('Caller-selected body'), 'caller-supplied drafts cannot replace the generated explanation')
      for (const row of impacts) {
        assert.ok(draft.body.includes(row.period.start) && draft.body.includes(row.period.end))
        assert.ok(draft.body.includes(fixture.subscription), 'the message identifies the actual subscription')
        for (const side of [row.before, row.after]) {
          assert.ok(side.fingerprint)
          assert.ok(draft.citations.some(citation => citation.fingerprint === side.fingerprint && citation.source.includes(fixture.subscription)))
          for (const amount of totals(side)) assert.ok(draft.body.includes((amount / 100).toFixed(2)), 'the explanation carries the independently verified subtotal, tax and total')
        }
      }
      return draft
    }
    const checkSent = async (id, saved, fixture, start) => {
      const approved = await detail(id), draft = saved.payload.noticeDrafts[0]
      assert.equal(approved.status, 'approved')
      assert.deepEqual(approved.payload, saved.payload, 'approval preserves the reviewed interpretation and generated message')
      assert.deepEqual(approved.evidence, saved.evidence)
      assert.deepEqual(approved.impact, saved.impact)
      assert.equal(approved.customerMessages.length, 1)
      const custody = approved.customerMessages[0]
      assert.equal(custody.customer_id, fixture.customer)
      assert.equal(custody.recipient, fixture.email)
      assert.equal(custody.subject, draft.subject)
      assert.equal(custody.body, draft.body)
      assert.deepEqual(JSON.parse(custody.citations_json), draft.citations)
      assert.equal(custody.status, 'accepted')
      assert.ok(custody.provider_ref)
      assert.equal(mails().length, start + 1, 'human approval makes exactly one provider submission per affected customer')
      assert.deepEqual([mails().at(-1).to].flat(), [fixture.email])
      assert.equal(mails().at(-1).subject, draft.subject)
      assert.equal(mails().at(-1).text, draft.body)
      await decide(id, owner, 409)
      await formDecision(id, owner, {}, 'already_decided')
      assert.equal(mails().length, start + 1)
      return approved
    }

    // Both kinds remain proposals until a real person decides them.
    for (const input of [amendment(), correction()]) {
      await propose(input, null, 401)
      await propose(input, accountant, 403)
      const before = await snapshot(), start = mails().length
      const proposal = await propose(input)
      for (const who of [agent, accountant]) await decide(proposal.id, who, 403)
      await formDecision(proposal.id, accountant, {}, 'forbidden')
      assert.deepEqual(await snapshot(), before)
      assert.equal(mails().length, start)
      await formDecision(proposal.id, owner, { decision: 'rejected' })
      assert.equal((await detail(proposal.id)).status, 'rejected')
      assert.deepEqual((await detail(proposal.id)).customerMessages, [])
      assert.deepEqual(await snapshot(), before, 'rejecting either correction leaves terms, events and invoice calculations unchanged')
      assert.equal(mails().length, start)
    }

    const termProposal = await propose(amendment()), termSaved = await detail(termProposal.id)
    assert.equal(termSaved.impact.length, 2)
    for (const [i, row] of termSaved.impact.entries()) {
      assert.equal(row.period.start, ['2026-04-01', '2026-05-01'][i])
      assert.deepEqual(totals(row.before), [11000, 1100, 12100])
      assert.deepEqual(totals(row.after), [10000, 1000, 11000], 'the discount reduces only the $100 recurring base, leaving the $10 usage charge')
      const current = await upcoming(terms, row.period.start.slice(0, 7))
      assert.equal(row.before.fingerprint, current.calculation.fingerprint)
    }
    checkDraft(termSaved, terms, termSaved.impact)
    assert.deepEqual((await h.api(`proposals/${termProposal.id}`, agent)).payload.noticeDrafts, termSaved.payload.noticeDrafts)
    let start = mails().length
    await formDecision(termProposal.id, finance, { recipient: 'attacker@example.test', subject: 'Injected', body: 'Injected', noticeDrafts: JSON.stringify(hostile) })
    const termApproved = await checkSent(termProposal.id, termSaved, terms, start)
    for (const row of termSaved.impact) {
      const current = await upcoming(terms, row.period.start.slice(0, 7))
      assert.equal(current.state, 'preview')
      assert.equal(current.invoiceId, null)
      assert.deepEqual(totals(current.calculation), totals(row.after))
    }
    const april = await api('billrun.prepare', { period: '2026-04' })
    const usageProposal = await propose(correction('draft-usage-approved', { run: april.id })), usageSaved = await detail(usageProposal.id)
    const usageImpact = usageSaved.impact.invoices.find(row => row.subscription === usage.subscription)
    assert.equal(usageSaved.impact.invoices.length, 1)
    assert.deepEqual(totals(usageImpact.before), [11000, 1100, 12100])
    assert.deepEqual(totals(usageImpact.after), [10500, 1050, 11550])
    assert.equal(usageImpact.before.fingerprint, (await upcoming(usage)).calculation.fingerprint)
    const usageDraft = checkDraft(usageSaved, usage, [usageImpact])
    for (const id of ['draft-1-april', 'draft-usage-approved']) {
      assert.ok(usageDraft.body.includes(id))
      assert.ok(usageDraft.citations.some(citation => citation.source === '/app/usage' && citation.quote.includes(id)), 'the explanation cites actual corrected source event identities')
    }
    start = mails().length
    const applied = await decide(usageProposal.id, owner, 200, { recipient: 'attacker@example.test', body: 'Injected', payload: { noticeDrafts: hostile } })
    assert.deepEqual([applied.voided, applied.added], [1, 1])
    assert.ok(applied.rerun)
    const usageApproved = await checkSent(usageProposal.id, usageSaved, usage, start)
    const refreshed = await upcoming(usage)
    assert.equal(refreshed.state, 'preview')
    assert.deepEqual(totals(refreshed.calculation), [10500, 1050, 11550])
    assert.deepEqual(refreshed.meters[0].eventIds, ['draft-usage-approved'])
    const redraft = await api(`runs/${applied.rerun}`)
    for (const [fixture, expected] of [[terms, [10000, 1000, 11000]], [usage, [10500, 1050, 11550]]]) {
      const invoice = redraft.invoices.find(row => row.customer_id === fixture.customer)
      assert.equal(invoice.status, 'draft', 'a correction never grants invoice approval or issue')
      assert.deepEqual([invoice.subtotal_cents, invoice.tax_cents, invoice.total_cents], expected)
    }

    // Derived meters consume the raw source IDs and the replacement's properties.
    const metricCustomer = (await api('customer.create', { external_id: 'AGENT002-DRAFT-METRIC', name: 'Cedar Draft Metric', billing_email: 'ap@draft-metric.example' })).id
    const metricRequest = await api('meter.prepare', { code: 'agent002-draft-sum', name: 'Billable draft event sum', unit_label: 'events', source_meter: meter,
      definition: { aggregation: 'sum', group_by: [], filters: [{ property: 'billable', operator: '=', value: true }] } })
    for (const period of ['2026-01', '2026-02', '2026-03']) await api('meter.preview', { request: metricRequest.request, customer: metricCustomer, period })
    const derived = await api('meter.activate', { request: metricRequest.request })
    const metricProduct = (await api('product.create', { code: 'agent002-draft-metric', name: 'Filtered metric usage' })).id
    const metricPrice = (await api('price.create', { product: metricProduct, kind: 'unit', meter: derived.id, unit_amount: '0.01', taxable: true })).id
    const metricSub = (await api('subscription.create', { customer: metricCustomer, start_date: '2026-04-01', price: [prices[0], metricPrice] })).id
    const metricFixture = { customer: metricCustomer, subscription: metricSub, external: 'AGENT002-DRAFT-METRIC', email: 'ap@draft-metric.example' }
    otherRecipients.push(metricFixture.email)
    const metricOriginal = { ...event(metricFixture, 'draft-metric-original', '1000'), properties: { billable: true, resource: 'customer-work' } }
    const metricReplacement = { ...event(metricFixture, 'draft-metric-replacement', '500'), properties: { billable: true, resource: 'reviewed-work' } }
    await submit([metricOriginal, { ...event(metricFixture, 'draft-metric-excluded', '100000'), properties: { billable: false } }])
    assert.deepEqual(totals((await upcoming(metricFixture)).calculation), [11000, 1100, 12100])
    const metricProposal = await propose({ kind: 'usage_correction', title: 'Correct filtered source quantity', payload: {
      void: [{ event_id: metricOriginal.event_id, reason: 'Reviewed source contains 500 billable events' }], add: [metricReplacement], noticeDrafts: hostile,
    }, evidence: { sources: ['Gateway source retains billable=true; reviewed quantity is 500.'] } })
    const metricSaved = await detail(metricProposal.id), metricImpact = metricSaved.impact.invoices.find(row => row.subscription === metricSub)
    assert.ok(metricImpact, 'raw-source corrections find the subscription using its derived meter')
    assert.deepEqual(totals(metricImpact.before), [11000, 1100, 12100])
    assert.deepEqual(totals(metricImpact.after), [10500, 1050, 11550])
    const metricDraft = checkDraft(metricSaved, metricFixture, [metricImpact])
    assert.ok(metricDraft.citations.some(citation => citation.quote.includes(metricReplacement.event_id)))
    start = mails().length
    await decide(metricProposal.id)
    const metricApproved = await checkSent(metricProposal.id, metricSaved, metricFixture, start)
    const metricCurrent = await upcoming(metricFixture)
    assert.equal(metricCurrent.state, 'preview')
    assert.equal(metricCurrent.invoiceId, null)
    assert.deepEqual(totals(metricCurrent.calculation), [10500, 1050, 11550])
    const metricLine = metricCurrent.calculation.lines.find(line => line.priceId === metricPrice)
    assert.equal(metricLine.kind, 'metric_usage')
    assert.deepEqual(metricLine.evidence.rawExactQuantity, { numerator: '500', denominator: '1' })
    assert.equal(metricLine.amountCents, 500)
    assert.deepEqual(metricLine.evidence.eventIds, [metricReplacement.event_id])
    assert.deepEqual(metricCurrent.calculation.inputs.events.find(row => row.eventId === metricReplacement.event_id).properties, metricReplacement.properties)
    const metricRun = await api('billrun.prepare', { period: '2026-04' })
    const metricInvoice = (await api(`runs/${metricRun.id}`)).invoices.find(row => row.customer_id === metricCustomer)
    assert.equal(metricInvoice.status, 'draft')
    assert.deepEqual([metricInvoice.subtotal_cents, metricInvoice.tax_cents, metricInvoice.total_cents], [10500, 1050, 11550])

    // A source not named in the correction still invalidates its complete rating basis.
    const futureAmendment = () => ({ ...amendment({ value: '5', effective_from: '2026-06-01' }), evidence: { clauses: [{ quote: 'From 1 June 2026 apply a further five percent recurring discount.' }] } })
    const futureUsage = id => correction(id, { void: [{ event_id: 'draft-usage-approved', reason: 'Review a further proposed correction' }], add: [event(usage, id, '250')] })
    const stalePair = async suffix => Promise.all([
      propose(futureAmendment()), propose(futureUsage(`draft-not-applied-${suffix}`)),
    ])
    const refusePair = async proposals => {
      const before = await snapshot(), start = mails().length
      for (const [i, proposal] of proposals.entries()) {
        if (i === 0) await decide(proposal.id, owner, 409)
        else await formDecision(proposal.id, owner, {}, 'proposal_stale')
        const saved = await detail(proposal.id)
        assert.equal(saved.status, 'pending')
        assert.equal(saved.stale, true)
        assert.deepEqual(saved.customerMessages, [])
      }
      assert.deepEqual(await snapshot(), before, 'a stale decision writes no amendment, event, draft invoice or mail custody')
      assert.equal(mails().length, start)
    }
    const staleUsage = await stalePair('source')
    await submit([event(terms, 'draft-terms-new-unreferenced', '7', '06'), event(usage, 'draft-usage-new-unreferenced', '13')])
    await refusePair(staleUsage)
    const staleTax = await stalePair('tax')
    await tax('12')
    await refusePair(staleTax)
    await tax('10')
    await api('tax.review', { revision: (await api('business')).revision })
    const staleRecipient = await stalePair('recipient')
    for (const fixture of fixtures) {
      const customer = await api(`customers/${fixture.customer}`)
      await api('customer.update', { ...customer, customer: fixture.customer, billing_email: 'new-draft-billing@example.test' })
    }
    await refusePair(staleRecipient)
    for (const fixture of fixtures) {
      const customer = await api(`customers/${fixture.customer}`)
      await api('customer.update', { ...customer, customer: fixture.customer, billing_email: fixture.email })
      assert.deepEqual(await api(`invoices/${fixture.original.id}`), fixture.original, 'corrections and later policy or recipient changes retain the complete previously issued invoice')
    }
    const mailCount = mails().length
    const scheduled = await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse('2026-07-10T14:00:00Z')}&cron=${encodeURIComponent('0 14 * * *')}`)
    assert.equal(scheduled.status, 200, await scheduled.text())
    assert.equal(mails().length, mailCount, 'scheduled recovery never repeats a claimed draft explanation')
    for (const proposal of [termApproved, usageApproved, metricApproved]) assert.deepEqual((await detail(proposal.id)).customerMessages, proposal.customerMessages)
    assert.equal(h.mails.filter(mail => [mail.to].flat().includes('attacker@example.test')).length, 0)
    const attemptAudit=await api('audit')
    for(const proposal of [termProposal,usageProposal])assert.equal(attemptAudit.filter(e=>e.subject===proposal.id&&e.action==='proposal.correction.mail.claim').length,1,'AGENT-002/GOV-004 approved draft-message sending claims are durably audited once')
    console.log('AGENT-002 ordinary amendments and usage corrections: exact taxable previews, frozen customer explanations, human decisions, stale-source refusal and issued history passed')
    return { amendment: termProposal.id, usage: usageProposal.id, run: applied.rerun }
  } finally {
    await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: previous.tax_jurisdiction, tax_mode: previous.tax_mode, tax_rate: previous.tax_rate, tax_note: previous.tax_note })
    if (previous.taxReady) await api('tax.review', { revision: (await api('business')).revision })
  }
}
