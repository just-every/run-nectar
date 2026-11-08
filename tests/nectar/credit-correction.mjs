import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'
import { csvRows } from './financial-reports.mjs'

// AGENT-002: real issued invoices, human decisions, and the existing mail edge.
export async function creditCorrectionFlow(h, owner, onState=async()=>{}) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const previous = await api('business'), previousPolicy = await api('policies/current')
  await api('access.give', { email: 'correction-finance@example.test', name: 'Casey Correction Finance', role: 'finance' })
  await api('access.give', { email: 'correction-accountant@example.test', name: 'Alex Correction Accountant', role: 'accountant' })
  const [finance, accountant] = await Promise.all([
    h.signIn('correction-finance@example.test', { requested: true }), h.signIn('correction-accountant@example.test', { requested: true }),
  ])
  const agent = { bearer: (await api('credential.issue', { name: 'Invoice correction preparer', scopes: ['prepare'] })).key }
  const read = id => api(`invoices/${id}`)
  const detail = id => api(`proposals/${id}`)
  const decide = (id, who = owner, status = 200, extra = {}) => h.api('proposal.decide', who, { proposal: id, decision: 'approved', ...extra }, status)
  const frozen = invoice => ({ number: invoice.number, status: invoice.status, subtotal: invoice.subtotal_cents, tax: invoice.tax_cents,
    total: invoice.total_cents, calculation: invoice.calculation, lines: invoice.lines, source: invoice.source_fingerprint })
  const mailTo = (mail, recipient) => [mail.to].flat().includes(recipient)
  const formDecision = async (id, who, extra = {}, error = null) => {
    const result = await h.submit('proposal.decide', who, { proposal: id, decision: 'approved', ...extra }, `/app/proposals/${id}`)
    assert.equal(result.searchParams.get('error'), error, 'the human form enforces the same decision controls')
    return result
  }

  try {
    await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: '10', tax_note: 'Reviewed correction journey tax' })
    await api('tax.review', { revision: (await api('business')).revision })
    await applyPolicy(h, owner, 'credit.policy', { two_person_above: '1000.00' })
    const fixtures = []
    for (const [suffix, unit_amount] of [['SEATS', '10.00'], ['GOV', '1000.00']]) {
      const email = `ap@correction-${suffix.toLowerCase()}.example`
      const customer = (await api('customer.create', { external_id: `AGENT002-${suffix}`, name: `Cedar Correction ${suffix}`, billing_email: email })).id
      const product = (await api('product.create', { code: `agent002-${suffix.toLowerCase()}`, name: `Correction ${suffix} seats` })).id
      const price = (await api('price.create', { product, kind: 'seat', unit_amount, taxable: true })).id
      const subscription = (await api('subscription.create', { customer, start_date: '2026-04-01', anchor_day: '1', price: [price], quantity: ['10'] })).id
      fixtures.push({ customer, subscription, price, email })
    }
    const run = await api('billrun.prepare', { period: '2026-04' })
    const invoices = (await api(`runs/${run.id}`)).invoices
    for (const fixture of fixtures) {
      const draft = invoices.find(row => row.customer_id === fixture.customer)
      assert.ok(draft, 'the actual bill run rates the correction customer')
      await api('invoice.approve', { invoice: draft.id, acknowledge: true })
      await api('invoice.finalise', { invoice: draft.id, issue_date: '2026-05-01' })
      fixture.issued = await read(draft.id)
      fixture.revenue = await api(`revenue/${draft.id}`)
      fixture.id = draft.id
      fixture.line = fixture.issued.lines.find(line => line.price_id === fixture.price)
      assert.equal(fixture.line.quantity, '10')
      assert.equal(fixture.line.evidence.quantity, 10)
      fixture.subscriptionBefore = await api(`subscriptions/${fixture.subscription}`)
    }
    const [seats, governed] = fixtures
    assert.deepEqual([seats.issued.subtotal_cents, seats.issued.tax_cents, seats.issued.total_cents], [10000, 1000, 11000])
    assert.deepEqual([governed.issued.subtotal_cents, governed.issued.tax_cents, governed.issued.total_cents], [1000000, 100000, 1100000])
    const payload = async (fixture, amount = '50.00', label = 'Seat correction') => {
      const invoice = await read(fixture.id), credit = Math.round(Number(amount) * 100)
      const explanation = label === 'Seat correction'
        ? 'The issued line billed 10 seats at $10.00; the reviewed signed requirement was 5 seats. The excess is 5 × $10.00 = $50.00.'
        : `${label}: a separately reviewed credit of $${amount} against the cited issued seat line.`
      return { invoice_credit: true, invoice: fixture.id, amount, reason: label, explanation,
        subject: `${label} for ${invoice.number}`,
        body: `${explanation}\nA $${amount} credit reduces the amount owed from $${(invoice.balanceCents / 100).toFixed(2)} to $${((invoice.balanceCents - credit) / 100).toFixed(2)}. The original invoice and its $${(invoice.tax_cents / 100).toFixed(2)} tax remain unchanged. No tax reversal was calculated.`,
        citations: [{ line_id: fixture.line.id, source: `/app/invoices/${fixture.id}/lines/${fixture.line.id}`, quote: fixture.line.description },
          { line_id: fixture.line.id, source: `/app/invoices/${fixture.id}/lines/${fixture.line.id}#evidence`, quote: '"quantity":10' }] }
    }
    const propose = (input, who = agent, status = 200) => h.api('proposal.create', who, { kind: 'amendment', title: input.reason, payload: input }, status)
    const billingMails = () => h.mails.filter(mail => fixtures.some(fixture => mailTo(mail, fixture.email)) || mailTo(mail, 'new-billing@correction.example'))
    const unchanged = async (fixture, credits, balance) => {
      const current = await read(fixture.id)
      assert.deepEqual((await api(`revenue/${fixture.id}`)).schedules, fixture.revenue.schedules, 'REV-001 issued credit decisions preserve every original recognition schedule and source basis')
      assert.deepEqual(frozen(current), frozen(fixture.issued), 'credit decisions retain issued source line identities, calculation, subtotal, tax and total')
      assert.deepEqual(current.credits.map(row => [row.amount_cents, row.reason]), credits)
      assert.equal(current.balanceCents, balance)
      assert.equal(current.creditedCents, credits.reduce((sum, row) => sum + row[0], 0))
      assert.deepEqual(await api(`subscriptions/${fixture.subscription}`), fixture.subscriptionBefore, 'invoice correction does not rewrite future subscription terms')
      return current
    }

    const checkRevenue = async (saved, fixture) => {
      const revenue = saved.impact.revenue, source = await api(`revenue/${fixture.id}`)
      const html=await h.page(`/app/proposals/${saved.id}`,owner)
      for(const r of revenue.periods)assert.ok(html.includes(`data-revenue-period="${r.period}" data-before-cents="${r.beforeCents}" data-after-cents="${r.afterCents}" data-delta-cents="${r.deltaCents}"`),'REV-001 the operator sees exact reviewed monthly recognition deltas')
      assert.ok(!html.includes('[object Object]'),'REV-001 recognition is readable in the operator preview')
      const amount = saved.impact.credit.amountCents
      assert.deepEqual(revenue.before.schedules.slice(0, source.schedules.length).sort((a, b) => a.lineId.localeCompare(b.lineId)), [...source.schedules].sort((a, b) => a.lineId.localeCompare(b.lineId)), 'REV-001 credit preview uses the immutable issued line schedules')
      assert.deepEqual(revenue.before.schedules.slice(source.schedules.length).map(row => [row.lineId, row.amountCents, row.entries.map(entry => [entry.period, entry.amountCents])]),
        source.credits.map(row => [`credit:${row.id}`, row.amountCents, [[row.period, row.amountCents]]]), 'REV-001 credit preview includes every actual earlier signed credit in its issue month')
      assert.deepEqual(revenue.after.schedules.slice(0, -1), revenue.before.schedules, 'REV-001 a credit adds a contra schedule without reallocating original revenue')
      const adjustment = revenue.after.schedules.at(-1)
      assert.deepEqual([adjustment.kind, adjustment.amountCents, adjustment.serviceStart, adjustment.entries.map(row => [row.period, row.amountCents])],
        ['credit_note', -amount, `${revenue.issueMonth}-01`, [[revenue.issueMonth, -amount]]], 'REV-001 exact proposed credit recognition is negative in its issue month')
      const periods = new Map()
      for (const row of [...source.schedules.flatMap(schedule => schedule.entries), ...source.credits]) periods.set(row.period, (periods.get(row.period) ?? 0) + row.amountCents)
      const expected = [...new Set([...periods.keys(), revenue.issueMonth])].sort().map(period => {
        const beforeCents = periods.get(period) ?? 0, deltaCents = period === revenue.issueMonth ? -amount : 0
        return { period, beforeCents, afterCents: beforeCents + deltaCents, deltaCents }
      })
      assert.deepEqual(revenue.periods, expected, 'REV-001 exact before/after revenue and signed period deltas exclude tax')
      for (const side of ['before', 'after']) assert.deepEqual(revenue[side].periods,
        expected.filter(row => side === 'after' || periods.has(row.period)).map(row => ({ period: row.period, amountCents: row[`${side}Cents`] })), 'REV-001 schedule totals match the reviewed period table')
      for (const [index, schedule] of revenue.before.schedules.slice(0, source.schedules.length).entries()) for (const [entryIndex] of schedule.entries.entries()) {
        assert.ok(revenue.citations.some(citation => citation.line_id === schedule.lineId && citation.source === `/app/invoices/${fixture.id}/lines/${schedule.lineId}#calculation`
          && citation.recordPath === `/revenue/before/schedules/${index}/entries/${entryIndex}` && citation.fingerprint === revenue.before.fingerprint && citation.policyVersion === revenue.policyVersion), 'REV-001 each issued schedule entry cites its actual line and frozen preview')
      }
      assert.deepEqual(saved.impact.mail.citations, [...saved.payload.citations, ...revenue.citations], 'REV-001 the reviewed customer explanation includes the revenue source citations')
      assert.equal(saved.impact.mail.body, `${saved.payload.body}\n\n${saved.payload.revenueNotice.explanation}`)
      return revenue
    }
    const checkBooked = async (saved, fixture, credit) => {
      const revenue = saved.impact.revenue, source = await api(`revenue/${fixture.id}`)
      const html=await h.page(`/app/proposals/${saved.id}`,owner)
      for(const r of revenue.periods)assert.ok(html.includes(`data-revenue-period="${r.period}" data-before-cents="${r.beforeCents}" data-after-cents="${r.afterCents}" data-delta-cents="${r.deltaCents}"`),'REV-001 the operator sees exact reviewed monthly recognition deltas')
      assert.ok(!html.includes('[object Object]'),'REV-001 recognition is readable in the operator preview')
      const booked = source.credits.find(row => row.id === credit.id)
      assert.deepEqual([booked.period, booked.amountCents], [revenue.issueMonth, revenue.adjustment.amountCents], 'REV-001 approved credit and actual recognition month match the frozen preview')
      assert.equal(booked.basis.invoiceId, fixture.id)
      const report = await api(`revenue?period=${revenue.issueMonth}&customer=${fixture.customer}`)
      assert.deepEqual(report.contributions.filter(row => row.creditId === credit.id).map(row => [row.kind, row.period, row.amountCents]).sort(),
        [['credit-billing', revenue.issueMonth, -credit.amount_cents], ['credit-recognition', revenue.issueMonth, -credit.amount_cents]], 'REV-001 the issued credit is booked once as signed billings and recognition')
    }

    const input = await payload(seats), beforeProposals = await api('proposals'), beforeMail = billingMails().length
    for (const who of [null, accountant]) await propose(input, who, who ? 403 : 401)
    const foreign = { line_id: governed.line.id, source: `/app/invoices/${governed.id}/lines/${governed.line.id}`, quote: governed.line.description }
    for (const invalid of [
      { ...input, citations: [] }, { ...input, citations: [foreign] },
      { ...input, citations: [{ ...input.citations[0], source: foreign.source }] },
      { ...input, citations: [{ ...input.citations[0], quote: 'This invented executed clause is absent from the issued evidence.' }] },
      { ...input, recipient: 'attacker@example.test' },
    ]) await propose(invalid, agent, 400)
    assert.deepEqual(await api('proposals'), beforeProposals, 'invalid or cross-invoice evidence cannot create a proposal')
    assert.equal(billingMails().length, beforeMail)
    await unchanged(seats, [], 11000)

    const rejected = await propose(input)
    assert.equal((await detail(rejected.id)).correctionMail, null)
    const rejectForm = await h.submit('proposal.decide', owner, { proposal: rejected.id, decision: 'rejected' }, `/app/proposals/${rejected.id}`)
    assert.equal(rejectForm.searchParams.get('error'), null)
    assert.equal((await detail(rejected.id)).status, 'rejected')
    await decide(rejected.id, owner, 409)
    assert.equal((await detail(rejected.id)).correctionMail, null)
    assert.equal(billingMails().length, beforeMail)
    await unchanged(seats, [], 11000)

    const prepared = await propose(input), saved = await detail(prepared.id)
    assert.deepEqual((await h.api(`proposals/${prepared.id}`, agent)).impact, saved.impact, 'a prepare-scoped agent can read its exact preview')
    assert.deepEqual([saved.impact.credit.amountCents, saved.impact.credit.balanceBeforeCents, saved.impact.credit.balanceAfterCents], [5000, 11000, 6000])
    assert.deepEqual([saved.impact.invoice.subtotalCents, saved.impact.invoice.taxCents, saved.impact.invoice.totalCents], [10000, 1000, 11000])
    await checkRevenue(saved, seats)
    await onState({label:'credit-prepared',id:prepared.id})
    assert.deepEqual([saved.impact.mail.recipient, saved.impact.mail.subject], [seats.email, input.subject])
    assert.equal(saved.impact.mail.language, 'en', 'PORT-006 the invoice-credit author sees the customer’s language; the text is sent as written')
    assert.equal(saved.payload.recipient, seats.email)
    assert.deepEqual(saved.payload.citations, input.citations)
    for (const who of [agent, accountant]) {
      await decide(prepared.id, who, 403)
      await h.api('proposal.credit.prepare', who, { proposal: prepared.id }, 403)
      await h.api('credit.issue', who, { invoice: seats.id, amount: '50', reason: input.reason }, 403)
      await h.api('credit.prepare', who, { invoice: seats.id, amount: '50', reason: input.reason }, 403)
    }
    await formDecision(prepared.id, accountant, {}, 'forbidden')
    assert.equal(billingMails().length, beforeMail)
    await unchanged(seats, [], 11000)
    // Approval fields cannot rewrite the proposal's frozen credit or message.
    await formDecision(prepared.id, owner, { recipient: 'attacker@example.test', amount: '109.00', subject: 'Replaced subject', body: 'Replaced body', payload: JSON.stringify({ amount: '109.00' }) })
    const approved = await detail(prepared.id), corrected = await unchanged(seats, [[5000, input.reason]], 6000)
    assert.equal(approved.status, 'approved')
    assert.deepEqual(approved.payload, saved.payload)
    assert.deepEqual(approved.impact, saved.impact)
    assert.equal(corrected.credits[0].proposal_id, prepared.id)
    assert.equal(approved.correctionMail.status, 'accepted')
    assert.ok(approved.correctionMail.provider_ref)
    assert.equal(approved.correctionMail.credit_id, corrected.credits[0].id)
    assert.equal(approved.correctionMail.recipient, seats.email)
    assert.equal(approved.correctionMail.body, saved.impact.mail.body)
    assert.deepEqual(JSON.parse(approved.correctionMail.citations_json), saved.impact.mail.citations)
    await checkBooked(saved, seats, corrected.credits[0])
    await onState({label:'credit-approved',id:prepared.id})
    assert.equal(billingMails().length, beforeMail + 1, 'one approval submits one correction email to the billing address')
    assert.equal(billingMails().at(-1).subject, input.subject)
    assert.equal(billingMails().at(-1).text, saved.impact.mail.body)
    await decide(prepared.id, owner, 409)
    await formDecision(prepared.id, owner, {}, 'already_decided')
    assert.equal(billingMails().length, beforeMail + 1)
    await unchanged(seats, [[5000, input.reason]], 6000)

    // Independently changed balance, policy revision and recipient each invalidate review.
    const staleBalance = await propose(await payload(seats, '10.00', 'Prepared before another credit'))
    await api('credit.issue', { invoice: seats.id, amount: '1.00', reason: 'Intervening credit' })
    const seatCredits = [[5000, input.reason], [100, 'Intervening credit']]
    await decide(staleBalance.id, owner, 409)
    assert.equal((await detail(staleBalance.id)).stale, true)
    const stalePolicy = await propose(await payload(seats, '10.00', 'Prepared under earlier policy'))
    await applyPolicy(h, owner, 'credit.policy', { two_person_above: '1200.00' })
    await decide(stalePolicy.id, owner, 409)
    assert.equal((await detail(stalePolicy.id)).stale, true)
    await applyPolicy(h, owner, 'credit.policy', { two_person_above: '1000.00' })
    const staleEmail = await propose(await payload(seats, '10.00', 'Prepared for earlier billing recipient'))
    const customerBefore = await api(`customers/${seats.customer}`)
    await api('customer.update', { ...customerBefore, customer: seats.customer, billing_email: 'new-billing@correction.example' })
    await formDecision(staleEmail.id, owner, {}, 'proposal_stale')
    assert.equal((await detail(staleEmail.id)).stale, true)
    const customerNow = await api(`customers/${seats.customer}`)
    await api('customer.update', { ...customerNow, customer: seats.customer, billing_email: seats.email })
    for (const proposal of [staleBalance, stalePolicy, staleEmail]) assert.equal((await detail(proposal.id)).correctionMail, null)
    assert.equal(billingMails().length, beforeMail + 1)
    await unchanged(seats, seatCredits, 5900)

    const highInput = await payload(governed, '1500.00', 'Reviewed large invoice correction')
    const high = await propose(highInput)
    const highSaved = await detail(high.id)
    await checkRevenue(highSaved, governed)
    assert.equal(highSaved.impact.credit.needsSecondApprover, true)
    await decide(high.id, owner, 409)
    await formDecision(high.id, owner, {}, 'second_approver_required')
    const binding = await h.api('proposal.credit.prepare', finance, { proposal: high.id })
    assert.ok(binding.request)
    assert.equal((await detail(high.id)).creditRequest, binding.request)
    const request = (await read(governed.id)).creditRequests.find(row => row.id === binding.request)
    const financePerson = await h.api('me', finance), ownerPerson = await api('me')
    assert.equal(request.prepared_by, financePerson.id)
    assert.equal(request.prepared_name, financePerson.email)
    await h.api('proposal.credit.prepare', finance, { proposal: high.id }, 409)
    for (const who of [agent, accountant]) {
      await h.api('credit.approve', who, { request: binding.request }, 403)
      await decide(high.id, who, 403)
    }
    for (const who of [finance, owner]) {
      assert.equal((await h.api('credit.approve', who, { request: binding.request }, 409)).error, 'credit_request_proposal_bound')
      await h.api('credit.issue', who, { invoice: governed.id, amount: '1500.00', reason: highInput.reason, request: binding.request }, 409)
    }
    const bypass = await h.submit('credit.approve', owner, { request: binding.request }, `/app/invoices/${governed.id}`)
    assert.equal(bypass.searchParams.get('error'), 'credit_request_proposal_bound')
    await decide(high.id, finance, 409)
    await formDecision(high.id, finance, {}, 'second_approver_required')
    await unchanged(governed, [], 1100000)
    assert.equal((await detail(high.id)).correctionMail, null)
    await formDecision(high.id, owner)
    let highDetail = await unchanged(governed, [[150000, highInput.reason]], 950000)
    await checkBooked(highSaved, governed, highDetail.credits[0])
    const issuedRequest = highDetail.creditRequests.find(row => row.id === binding.request)
    assert.equal(issuedRequest.status, 'issued')
    assert.equal(issuedRequest.approved_by, ownerPerson.email)
    const audit = (await api('audit')).find(row => row.action === 'credit.issue' && row.subject === highDetail.credits[0].id)
    assert.equal(audit.actor, ownerPerson.email)
    assert.equal(JSON.parse(audit.detail).preparedBy, financePerson.email)
    assert.equal(JSON.parse(audit.detail).request, binding.request)
    await decide(high.id, owner, 409)
    const lowInput = await payload(governed, '900.00', 'Below threshold human correction')
    const low = await propose(lowInput, finance)
    const lowSaved = await detail(low.id)
    await checkRevenue(lowSaved, governed)
    assert.equal(lowSaved.impact.credit.needsSecondApprover, false)
    await decide(low.id, finance, 200, { recipient: 'attacker@example.test', amount: '1500.00', body: 'Altered' })
    highDetail = await unchanged(governed, [[150000, highInput.reason], [90000, lowInput.reason]], 860000)
    assert.equal(highDetail.credits[1].issued_by, financePerson.email)
    assert.equal((await detail(low.id)).correctionMail.body, lowSaved.impact.mail.body)
    await checkBooked(lowSaved, governed, highDetail.credits[1])

    const failed = []
    for (const [status, outcome] of [[400, 'failed'], [500, 'uncertain']]) {
      const mailInput = await payload(seats, '5.00', `Provider ${outcome} correction`)
      const proposal = await propose(mailInput), start = billingMails().length
      const mailSaved = await detail(proposal.id)
      await checkRevenue(mailSaved, seats)
      h.mailResponses.push({ status, body: { name: 'provider_error' } })
      await decide(proposal.id)
      seatCredits.push([500, mailInput.reason])
      await unchanged(seats, seatCredits, 11000 - seatCredits.reduce((sum, row) => sum + row[0], 0))
      await checkBooked(mailSaved, seats, (await read(seats.id)).credits.find(row => row.proposal_id === proposal.id))
      const custody = (await detail(proposal.id)).correctionMail
      assert.equal(custody.status, outcome)
      assert.equal(custody.provider_ref, null, 'provider refusal or uncertainty cannot become an acceptance receipt')
      assert.equal(billingMails().length, start + 1)
      failed.push({ id: proposal.id, custody })
      await decide(proposal.id, owner, 409)
    }
    const attemptAudit=await api('audit')
    assert.equal(attemptAudit.filter(e=>e.subject===prepared.id&&e.action==='proposal.credit.mail.claim').length,1,'AGENT-002/GOV-004 the sending claim is durably audited once')
    const mailCount = billingMails().length, acceptedCustody = (await detail(prepared.id)).correctionMail
    for (let tick = 0; tick < 2; tick++) {
      const response = await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse('2026-07-10T14:00:00Z')}&cron=${encodeURIComponent('0 14 * * *')}`)
      assert.equal(response.status, 200, await response.text())
    }
    assert.equal(billingMails().length, mailCount, 'scheduled recovery never retries accepted, rejected or uncertain submissions')
    assert.deepEqual((await detail(prepared.id)).correctionMail, acceptedCustody)
    for (const proposal of failed) assert.deepEqual((await detail(proposal.id)).correctionMail, proposal.custody)
    assert.equal(h.mails.filter(mail => mailTo(mail, 'attacker@example.test')).length, 0)
    await annualAdvanceCorrection(h, owner, { finance, accountant, agent, checkRevenue, checkBooked, unchanged })
    console.log('AGENT-002 issued credit corrections: exact evidence, frozen preview and mail, human approval, stale and duplicate refusal, governed threshold, durable provider outcomes passed')
    return { invoice: seats.id, proposal: prepared.id, governed: high.id, rejected: rejected.id }
  } finally {
    await applyPolicy(h, owner, 'credit.policy', { two_person_above: previousPolicy.creditLimitCents === null ? '' : (previousPolicy.creditLimitCents / 100).toFixed(2) })
    await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: previous.tax_jurisdiction, tax_mode: previous.tax_mode, tax_rate: previous.tax_rate, tax_note: previous.tax_note })
    if (previous.taxReady) await api('tax.review', { revision: (await api('business')).revision })
  }
}

// CAT-001 inherits the ordinary AGENT-002 proposal, approval, credit and
// message doors. The annual source remains $1,000 in every service month;
// its reviewed invoice-level credit is a separate issue-month contra entry.
async function annualAdvanceCorrection(h, owner, { finance, accountant, agent, checkRevenue, checkBooked, unchanged }) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  await h.advanceClock('2026-07-15T16:00:00Z')
  const email = 'synthetic-nectar-annual-correction@example.test'
  const customer = (await api('customer.create', { external_id: 'synthetic-nectar-201', name: 'Synthetic annual correction', billing_email: email })).id
  const product = (await api('product.create', { code: 'synthetic-nectar-202', name: 'Synthetic annual platform' })).id
  const price = (await api('price.create', { product, kind: 'flat', unit_amount: '12000', taxable: true, billing_interval: 'annual', billing_timing: 'advance' })).id
  const subscription = (await api('subscription.create', { customer, start_date: '2026-01-01', term_months: 24, price: [price] })).id
  const run = await api('billrun.prepare', { period: '2026-01' })
  const draft = (await api(`runs/${run.id}`)).invoices.find(row => row.customer_id === customer)
  assert.ok(draft)
  await api('invoice.approve', { invoice: draft.id, acknowledge: true })
  await api('invoice.finalise', { invoice: draft.id, issue_date: '2026-01-01' })
  const id = draft.id, issued = await api(`invoices/${id}`), revenue = await api(`revenue/${id}`)
  const fixture = { id, customer, subscription, issued, revenue, subscriptionBefore: await api(`subscriptions/${subscription}`) }
  assert.deepEqual([issued.subtotal_cents, issued.tax_cents, issued.total_cents], [1200000, 120000, 1320000])
  const line = issued.lines.find(row => row.price_id === price)
  assert.deepEqual([line.period_start, line.period_end, line.evidence.calendar.terms.timing], ['2026-01-01', '2027-01-01', 'advance'])
  const months = Array.from({ length: 12 }, (_, index) => `2026-${String(index + 1).padStart(2, '0')}`)
  assert.deepEqual(revenue.schedules.flatMap(schedule => schedule.entries.map(entry => [entry.period, entry.amountCents])), months.map(month => [month, 100000]), 'CAT-001 the issued $12,000 advance fee recognizes exactly $1,000 in each actual service month')
  const payload = { invoice_credit: true, invoice: id, amount: '1500.00', reason: 'Synthetic annual platform overbilling',
    explanation: 'The original annual platform line billed $12,000 for January through December. The reviewed annual requirement was $10,500; the $1,500 excess is an invoice-level credit.',
    subject: `Reviewed annual correction for ${issued.number}`,
    body: 'We reviewed a $1,500 invoice-level credit against the annual platform fee. The original $1,200 tax and the issued invoice remain unchanged; this credit computes no tax reversal. The amount owed falls from $13,200 to $11,700.',
    citations: [{ line_id: line.id, source: `/app/invoices/${id}/lines/${line.id}`, quote: line.description },
      { line_id: line.id, source: `/app/invoices/${id}/lines/${line.id}#evidence`, quote: '"timing":"advance"' }] }
  const propose = () => h.api('proposal.create', agent, { kind: 'amendment', title: payload.reason, payload })
  const readProposal = proposal => api(`proposals/${proposal}`)
  const decide = (proposal, who = owner, status = 200, decision = 'approved') => h.api('proposal.decide', who, { proposal, decision }, status)
  const mailCount = () => h.mails.filter(mail => [mail.to].flat().includes(email)).length
  const initialMail = mailCount()

  const rejected = await propose()
  await decide(rejected.id, owner, 200, 'rejected')
  await unchanged(fixture, [], 1320000)
  assert.equal(mailCount(), initialMail)
  const stale = await propose()
  await h.advanceClock('2026-08-01T16:00:00Z')
  await decide(stale.id, owner, 409)
  assert.equal((await readProposal(stale.id)).stale, true, 'CAT-001 an annual correction cannot issue in a different recognition month from the reviewed preview')
  await unchanged(fixture, [], 1320000)
  assert.equal(mailCount(), initialMail)
  await decide(stale.id, owner, 200, 'rejected')
  await h.advanceClock('2026-07-15T16:00:00Z')

  const prepared = await propose(), saved = await readProposal(prepared.id)
  const preview = await checkRevenue(saved, fixture)
  assert.deepEqual(preview.periods, months.map(period => ({ period, beforeCents: 100000, afterCents: period === '2026-07' ? -50000 : 100000, deltaCents: period === '2026-07' ? -150000 : 0 })), 'CAT-001 every annual service-month delta is reviewed, including eleven unchanged months')
  assert.equal(saved.impact.credit.needsSecondApprover, true)
  for (const who of [agent, accountant]) await decide(prepared.id, who, 403)
  await decide(prepared.id, owner, 409)
  const binding = await h.api('proposal.credit.prepare', finance, { proposal: prepared.id })
  await decide(prepared.id, finance, 409)
  assert.equal((await h.api('credit.approve', owner, { request: binding.request }, 409)).error, 'credit_request_proposal_bound')
  await unchanged(fixture, [], 1320000)
  assert.equal(mailCount(), initialMail)
  await decide(prepared.id)
  const corrected = await unchanged(fixture, [[150000, payload.reason]], 1170000), credit = corrected.credits[0]
  assert.equal(credit.proposal_id, prepared.id)
  await checkBooked(saved, fixture, credit)
  const approved = await readProposal(prepared.id)
  assert.deepEqual(approved.impact, saved.impact)
  assert.equal(approved.correctionMail.body, saved.impact.mail.body)
  assert.deepEqual(JSON.parse(approved.correctionMail.citations_json), saved.impact.mail.citations)
  assert.equal(approved.correctionMail.status, 'accepted')
  assert.equal(mailCount(), initialMail + 1)
  await decide(prepared.id, owner, 409)
  assert.equal(mailCount(), initialMail + 1)

  const query = `from=2026-01&to=2026-12&customer=${customer}`
  const actual = await api(`revenue?${query}`)
  assert.deepEqual(actual.months.map(month => [month.period, month.recognizedCents]), preview.after.periods.map(month => [month.period, month.amountCents]), 'CAT-001 actual recognition equals the exact approved annual correction preview in every month')
  assert.deepEqual(actual.months.map((month, index) => [month.netBillingsCents, month.closingCents]), months.map((period, index) => [index === 0 ? 1200000 : period === '2026-07' ? -150000 : 0, (11 - index) * 100000]), 'CAT-001 original annual deferral and the separate correction reconcile across the whole service year')
  assert.deepEqual([actual.netBillingsCents, actual.recognizedCents, actual.closingCents], [1050000, 1050000, 0])
  const source = await api(`revenue/${id}?${query}`)
  assert.deepEqual(source.schedules, revenue.schedules)
  assert.deepEqual(source.credits.map(row => [row.id, row.period, row.amountCents]), [[credit.id, '2026-07', -150000]])
  const drill = await api(`invoices/${id}/lines/${line.id}`)
  assert.equal(drill.line.id, line.id)
  assert.deepEqual(drill.line.evidence, line.evidence)
  const csv = await h.raw(`/app/exports/revenue.csv?${query}`, { cookie: owner })
  assert.equal(csv.status, 200)
  const rows = csvRows(await csv.text()), cents = value => Math.round(Number(value.replace(/^'/, '')) * 100)
  assert.deepEqual(rows.filter(row => row.row_kind === 'recognition').map(row => [row.period, cents(row.signed_contribution)]), months.map(period => [period, 100000]))
  assert.deepEqual(rows.filter(row => row.row_kind.startsWith('credit-')).map(row => [row.row_kind, row.period, row.credit_id, cents(row.signed_contribution)]).sort(), [['credit-billing', '2026-07', credit.id, -150000], ['credit-recognition', '2026-07', credit.id, -150000]])
  const journal = await api(`revenue-journal?${query}`)
  assert.deepEqual(journal.periods.map(month => [month.period, month.netBillingsCents, month.recognizedCents, month.closingCents]), actual.months.map(month => [month.period, month.netBillingsCents, month.recognizedCents, month.closingCents]))
  for (const period of journal.periods) assert.equal(period.debitCents, period.creditCents)
  assert.deepEqual(journal.entries.filter(entry => entry.period === '2026-07').map(entry => [entry.account, entry.debitCents, entry.creditCents]).sort(), [['deferred-revenue', 100000, 0], ['pretax-billings-clearing', 0, 150000], ['recognized-revenue', 50000, 0]])
  const journalCsv = await h.raw(`/app/exports/revenue-journal.csv?${query}`, { cookie: owner })
  assert.equal(journalCsv.status, 200)
  assert.deepEqual(csvRows(await journalCsv.text()).map(row => [row.period, row.account, cents(row.debit), cents(row.credit)]), journal.entries.map(entry => [entry.period, entry.account, entry.debitCents, entry.creditCents]))
}

// Public-door prepaid-agent-corrections checks share this retained journey module.
const prepaidAgentCorrectionsJourneys = await (async () => {
const { default: assert } = await import('node:assert/strict')
const { applyPolicy } = await import('./policy-helper.mjs')
const { publishPrice } = await import('./price-helper.mjs')
const { prepaidReportParity } = await import('./prepaid-report-parity.mjs')
const { csvRows } = await import('./financial-reports.mjs')

const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0)
const numeric = value => Number(String(value).replace(/^'/, ''))
const original = invoice => ({calculation:invoice.calculation,lines:invoice.lines,number:invoice.number,total:invoice.total_cents,source:invoice.source_fingerprint})

async function fixture(h,owner,n,{annual=false,paid=false,finite=true}={}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  await h.advanceClock('2026-01-01T18:00:00Z')
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Synthetic agent prepaid correction consideration'})
  await api('tax.review',{revision:(await api('business')).revision})
  const external=`synthetic-nectar-${n}`,email=`${external}@example.test`
  await api('access.give',{email:`synthetic-nectar-${n+1}@example.test`,name:'Synthetic correction finance',role:'finance'})
  const finance=await h.signIn(`synthetic-nectar-${n+1}@example.test`,{requested:true})
  const agent={bearer:(await api('credential.issue',{name:'Synthetic prepaid correction preparer',scopes:['prepare']})).key}
  const customer=(await api('customer.create',{external_id:external,name:'Synthetic prepaid agent correction',billing_email:email})).id
  const meterCode=`synthetic-nectar-${n+2}`,meter=(await api('meter.create',{code:meterCode,name:'Synthetic corrected calls',unit_label:'calls'})).id
  const product=(await api('product.create',{code:`synthetic-nectar-${n+3}`,name:'Synthetic corrected usage'})).id
  const price=(await api('price.create',{product,kind:'unit',meter,unit_amount:'1',taxable:false})).id
  const prices=[price]
  if(annual){
    const platform=(await api('product.create',{code:`synthetic-nectar-${n+4}`,name:'Synthetic annual platform'})).id
    prices.push((await api('price.create',{product:platform,kind:'flat',unit_amount:'12000',billing_interval:'annual',billing_timing:'advance',taxable:false})).id)
  }
  const subscription=(await api('subscription.create',{customer,start_date:'2026-01-01',price:prices,...(finite?{term_months:24}:{})})).id
  const grant=async(source,amount,priority)=>{
    const request=await api('prepaid.prepare',{subscription,mode:'grant',kind:'money',source,amount,effective_date:'2026-01-01',expires_date:'2027-01-01',priority,expiry_consent:true})
    await h.api('prepaid.decide',finance,{request:request.request,decision:'approved'})
    return request.request
  }
  const intent=await grant('purchase','10000',10)
  const purchase=(await api('prepaid.purchase.prepare',{intent,issue_date:'2026-01-01'})).invoice
  await api('invoice.approve',{invoice:purchase,acknowledge:true});await api('invoice.finalise',{invoice:purchase,issue_date:'2026-01-01'})
  if(paid){
    const payment=await api('payment.record',{customer,amount:'10000',received_on:'2026-01-01',method:'bank_transfer',reference:`synthetic-nectar-${n+5}`})
    await api('payment.allocate',{payment:payment.payment,invoice:purchase,amount:'10000'})
    await api('prepaid.funding.confirm',{intent,confirm:true})
    await grant('promotion','1000',0)
  }
  const state=()=>api(`prepaid/${subscription}`)
  const event=(id,quantity,month)=>({event_id:`synthetic-nectar-${id}`,customer:external,meter:meterCode,quantity,occurred_at:`2026-${month}-15T12:00:00Z`})
  const propose=body=>h.api('proposal.create',agent,body)
  const detail=id=>api(`proposals/${id}`)
  const approve=async saved=>{
    await h.api('proposal.decide',agent,{proposal:saved.id,decision:'approved'},403)
    if(saved.impact.credit?.needsSecondApprover)await api('proposal.credit.prepare',{proposal:saved.id})
    await h.api('proposal.decide',finance,{proposal:saved.id,decision:'approved'})
    const decided=await detail(saved.id)
    assert.equal(decided.status,'approved');assert.deepEqual(decided.impact,saved.impact);assert.deepEqual(decided.payload,saved.payload)
    const notices=decided.correctionMail?[decided.correctionMail]:decided.customerMessages
    assert.equal(notices.length,1);assert.equal(notices[0].status,'accepted')
    const reviewed=saved.impact.mail??saved.payload.noticeDrafts[0]
    assert.equal(notices[0].recipient,email);assert.equal(notices[0].body,reviewed.body)
    const delivered=h.mails.filter(mail=>[mail.to].flat().includes(email))
    assert.equal(delivered.at(-1).text,reviewed.body)
    await h.api('proposal.decide',finance,{proposal:saved.id,decision:'approved'},409)
    assert.equal(h.mails.filter(mail=>[mail.to].flat().includes(email)).length,delivered.length,'An approved correction never repeats its reviewed customer message')
    return decided
  }
  const issue=async(period,date)=>{
    await h.advanceClock(`${date}T18:00:00Z`)
    const run=await api('billrun.prepare',{period})
    const invoices=(await api(`runs/${run.id}`)).invoices.filter(invoice=>invoice.customer_id===customer)
    assert.equal(invoices.length,1,'The actual same-due service components form one invoice')
    const id=invoices[0].id
    await api('invoice.approve',{invoice:id,acknowledge:true});await api('invoice.finalise',{invoice:id,issue_date:date})
    return api(`invoices/${id}`)
  }
  return {api,customer,subscription,product,meter,price,purchase,intent,email,agent,finance,state,event,propose,detail,approve,issue}
}

// The proposal and its customer explanation must agree with the actual credit:
// unpaid purchase consideration is liability, with no earned revenue to reverse.
async function prepaidAgentCreditFlow(h,owner) {
  const f=await fixture(h,owner,740),{api,purchase}=f
  const issued=await api(`invoices/${purchase}`),source=await api(`revenue/${purchase}`),ledger=await f.state()
  assert.deepEqual([issued.subtotal_cents,issued.balanceCents],[1000000,1000000])
  assert.equal(sum(source.schedules.flatMap(row=>row.entries),'amountCents'),0)
  let liability=1000000
  for(const amount of ['2500','1000']){
    const cents=Number(amount)*100,line=issued.lines.find(row=>row.kind==='prepaid_purchase')
    const created=await f.propose({kind:'amendment',title:'Synthetic unpaid purchase correction',payload:{invoice_credit:true,invoice:purchase,amount,
      reason:'Reduce the unused unpaid prepaid purchase',explanation:'The cited purchase remains unpaid and has earned no revenue. The credit reduces only the outstanding contract liability.',
      subject:'Reviewed prepaid purchase credit',body:'The original purchase remains unchanged. The separately approved credit reduces the unpaid balance and deferred liability; recognized revenue is unchanged.',
      citations:[{line_id:line.id,source:`/app/invoices/${purchase}/lines/${line.id}`,quote:line.description}]}})
    const saved=await f.detail(created.id),r=saved.impact.revenue
    assert.deepEqual(r.before.schedules.slice(0,source.schedules.length),source.schedules)
    assert.deepEqual(r.after.schedules.slice(0,-1),r.before.schedules)
    assert.equal(sum(r.before.periods,'amountCents'),0);assert.equal(sum(r.after.periods,'amountCents'),0)
    assert.ok(r.periods.every(row=>row.beforeCents===0&&row.afterCents===0&&row.deltaCents===0))
    assert.deepEqual([r.adjustment.kind,r.adjustment.amountCents,r.adjustment.billingsDeltaCents,r.adjustment.liabilityDeltaCents],['prepaid-liability-reversal',0,-cents,-cents])
    assert.equal(r.after.schedules.at(-1).amountCents,0)
    for(const measure of [r.billings,r.liability])assert.deepEqual(measure,{beforeCents:liability,afterCents:liability-cents,deltaCents:-cents})
    assert.deepEqual(await f.state(),ledger,'Preparing a purchase credit never funds or mutates the prepaid ledger')
    assert.deepEqual(original(await api(`invoices/${purchase}`)),original(issued))
    await f.approve(saved);liability-=cents
    const current=await api(`invoices/${purchase}`),booked=await api(`revenue/${purchase}`)
    assert.deepEqual(original(current),original(issued));assert.equal(current.balanceCents,liability)
    assert.deepEqual(booked.schedules,source.schedules)
    assert.deepEqual(booked.credits.map(row=>[row.amountCents,row.recognitionCents]),liability===750000?[[-250000,0]]:[[-250000,0],[-100000,0]])
    const report=await api(`revenue?period=2026-01&customer=${f.customer}`)
    assert.deepEqual([report.netBillingsCents,report.recognizedCents,report.closingCents],[liability,0,liability])
    assert.equal(report.deferredLiabilityCents,liability)
    const csv=csvRows(await(await h.raw(`/app/exports/revenue.csv?period=2026-01&customer=${f.customer}`,{cookie:owner})).text())
    const rollforward=csv.find(row=>row.row_kind==='rollforward')
    assert.deepEqual(['net_billings','recognized','closing'].map(key=>numeric(rollforward[key])*100),[liability,0,liability])
    assert.ok(csv.filter(row=>row.row_kind==='credit-recognition').every(row=>numeric(row.signed_contribution)===0))
    assert.deepEqual(await f.state(),ledger)
    await api('prepaid.funding.confirm',{intent:f.intent,confirm:true},409)
  }
  return {customer:f.customer,subscription:f.subscription,invoice:purchase}
}

// Paid and promotional funds are re-evaluated by the same engine as the next
// invoice. Previews reserve nothing, and the issued annual source stays intact.
async function prepaidAgentDraftCorrectionsFlow(h,owner) {
  for(const kind of ['terms','usage']){
    const f=await fixture(h,owner,kind==='terms'?760:780,{annual:true,paid:true}),{api}=f
    const month=kind==='terms'?'02':'01',event=f.event(kind==='terms'?766:786,'6000',month)
    await h.advanceClock('2026-03-01T18:00:00Z')
    await api('usage.submit',{events:[event]})
    const state=await f.state(),purchase=await api(`invoices/${f.purchase}`)
    assert.equal(sum(state.balances,'remainingN'),1100000)
    // A term proposal precedes the original annual issue; it cannot rewrite an
    // already issued advance service term. Usage correction needs no term edit.
    let annual=kind==='usage'?await f.issue('2026-01','2026-01-01'):null
    if(annual)await h.advanceClock('2026-03-01T18:00:00Z')
    const proposal=kind==='terms'
      ? {kind:'amendment',title:'Synthetic signed unit-price correction',payload:{subscription:f.subscription,kind:'price_override',price:f.price,value:'0.50',effective_from:'2026-02-01',note:'Correct future usage to the signed unit rate'},evidence:{clauses:[{quote:'From 1 February 2026, recorded calls cost USD 0.50 each.',reference:'Synthetic executed rate clause'}]}}
      : {kind:'usage_correction',title:'Synthetic unbilled source correction',payload:{void:[{event_id:event.event_id,reason:'Source count was duplicated'}],add:[f.event(787,'3000',month)]},evidence:{sources:['Synthetic gateway source: 3000 calls, not 6000.']}}
    const created=await f.propose(proposal),saved=await f.detail(created.id)
    const impacts=kind==='terms'?saved.impact:saved.impact.invoices
    const relevant=impacts.find(row=>row.before.lines.some(line=>line.amountCents===600000))
    assert.ok(relevant,'The correction includes the actual metered service window')
    for(const [side,expectedUsage,expectedDraw] of [['before',600000,-600000],['after',300000,-300000]]){
      assert.equal(sum(relevant[side].lines.filter(row=>row.amountCents>0),'amountCents'),expectedUsage)
      assert.equal(sum(relevant[side].lines.filter(row=>row.amountCents<0),'amountCents'),expectedDraw)
      assert.deepEqual([relevant[side].subtotalCents,relevant[side].taxCents,relevant[side].totalCents],[0,0,0])
      assert.equal(sum(relevant[side].revenue.periods,'amountCents'),0,'Service redemption offsets source consideration; purchased value is earned on the original paid purchase')
    }
    assert.ok(relevant.revenueDeltas.every(row=>row.deltaCents===0))
    assert.deepEqual(await f.state(),state,'Preparing either correction does not reserve, consume or restore funds')
    assert.deepEqual(original(await api(`invoices/${f.purchase}`)),original(purchase))
    await f.approve(saved)
    if(!annual)annual=await f.issue('2026-01','2026-01-01')
    const annualSource=await api(`revenue/${annual.id}?from=2026-01&to=2026-12`)
    assert.deepEqual(annualSource.schedules.find(row=>row.kind==='flat').entries.map(row=>row.amountCents),Array(12).fill(100000))
    const next=await f.issue(kind==='terms'?'2026-03':'2026-02',kind==='terms'?'2026-03-01':'2026-02-01')
    assert.deepEqual([next.subtotal_cents,next.tax_cents,next.total_cents],[0,0,0])
    assert.equal(sum(next.lines.filter(row=>row.kind==='usage'),'amount_cents'),300000)
    assert.equal(sum(next.lines.filter(row=>row.kind==='prepaid_drawdown'),'amount_cents'),-300000)
    const after=await f.state()
    assert.equal(sum(after.balances,'remainingN'),800000)
    assert.equal(sum(after.balances,'liabilityCents'),800000)
    const draws=after.entries.filter(row=>row.kind==='drawdown')
    assert.equal(sum(draws,'amountN'),-300000);assert.equal(sum(draws,'recognitionCents'),200000)
    assert.equal(draws.filter(row=>row.purchaseInvoice).length,1)
    assert.deepEqual(original(await api(`invoices/${annual.id}`)),original(annual))
    assert.deepEqual((await api(`revenue/${annual.id}?from=2026-01&to=2026-12`)).schedules,annualSource.schedules)
    const purchaseSource=await api(`revenue/${f.purchase}?from=2026-01&to=2026-12`)
    assert.equal(sum(purchaseSource.schedules.flatMap(row=>row.entries),'amountCents'),200000)
    const source=await api(`revenue/${next.id}`)
    assert.equal(sum(source.schedules.flatMap(row=>row.entries),'amountCents'),0)
    const report=await api(`revenue?period=2026-${month}&customer=${f.customer}`)
    assert.equal(report.recognizedCents,300000,'Actual service month earns USD 1000 annual allocation plus USD 2000 purchased consumption; promotion earns no liability revenue')
    const csv=csvRows(await(await h.raw(`/app/exports/prepaid/${f.subscription}.csv`,{cookie:owner})).text())
    assert.equal(csv.length,after.entries.length)
    assert.deepEqual(original(await api(`invoices/${f.purchase}`)),original(purchase))
  }
}

// Two proposed periods share one finite wallet on each side of the migration.
// Approval and ordinary issue must preserve the preview's depletion and excess.
async function prepaidCommercialMigrationFlow(h,owner,{onState=async()=>{}}={}) {
  const f=await fixture(h,owner,810,{paid:true,finite:false}),{api}=f
  const target=(await publishPrice(h,owner,{product:f.product,meter:f.meter,kind:'unit',unit_amount:'2',taxable:false})).id
  await api('usage.submit',{events:[f.event(816,'6000','02'),f.event(817,'6000','03')]})
  await h.advanceClock('2026-04-01T18:00:00Z')
  const state=await f.state(),purchase=await api(`invoices/${f.purchase}`)
  const created=await api('proposal.create',{kind:'price_change',title:'Synthetic prepaid commercial migration',payload:{target_price:target,effective_date:'2026-02-01',subscriptions:[f.subscription]}})
  const saved=await f.detail(created.id),periods=saved.impact[0].periods
  const figures=rating=>[sum(rating.lines.filter(line=>line.kind==='usage'),'amountCents'),sum(rating.lines.filter(line=>line.kind==='prepaid_drawdown'),'amountCents'),rating.totalCents]
  assert.deepEqual(periods.map(p=>figures(p.before)),[[600000,-600000,0],[600000,-500000,100000]],'The unchanged-price comparison depletes its own wallet across periods')
  assert.deepEqual(periods.map(p=>figures(p.after)),[[1200000,-1100000,100000],[1200000,0,1200000]],'The migrated-price comparison depletes a separate wallet and bills only excess')
  assert.deepEqual(await f.state(),state,'Preparing a commercial migration never consumes credits')
  await onState({label:'migration-prepared',f,proposal:saved})
  await h.api('proposal.decide',f.agent,{proposal:saved.id,decision:'approved'},403)
  await api('proposal.decide',{proposal:saved.id,decision:'approved'},409)
  await h.api('proposal.decide',f.finance,{proposal:saved.id,decision:'approved'})
  await h.api('proposal.decide',f.finance,{proposal:saved.id,decision:'approved'},409)
  for(const [index,date]of ['2026-03-01','2026-04-01'].entries()){
    const invoice=await f.issue(index===0?'2026-02':'2026-03',date),calculation=invoice.calculation
    assert.deepEqual([invoice.subtotal_cents,invoice.tax_cents,invoice.total_cents],[periods[index].after.subtotalCents,periods[index].after.taxCents,periods[index].after.totalCents])
    assert.deepEqual(figures({lines:invoice.lines.map(line=>({kind:line.kind,amountCents:line.amount_cents})),totalCents:invoice.total_cents}),figures(periods[index].after),'Issued usage, drawdown and cash owed equal the independently approved commercial preview')
    await prepaidReportParity(h,owner,{customer:f.customer,subscription:f.subscription})
    await onState({label:`migration-issued-${index}`,f,proposal:saved,invoice})
  }
  const after=await f.state()
  assert.equal(sum(after.balances,'remainingN'),0);assert.equal(sum(after.balances,'liabilityCents'),0)
  assert.equal(sum(after.entries,'recognitionCents'),1000000,'Promotions never earn purchased consideration')
  const source=await api(`revenue/${f.purchase}?from=2026-01&to=2026-12`)
  assert.equal(sum(source.schedules.flatMap(schedule=>schedule.entries),'amountCents'),1000000)
  assert.deepEqual(original(await api(`invoices/${f.purchase}`)),original(purchase))
  // The historical comparison carries changed usage consideration through six
  // saved periods; actual issued draws and purchase recognition stay immutable.
  const g=await fixture(h,owner,830,{paid:true,finite:false})
  const next=(await publishPrice(h,owner,{product:g.product,meter:g.meter,kind:'unit',unit_amount:'2',taxable:false})).id
  const originals=[]
  for(let index=0;index<6;index++){
    const month=String(index+1).padStart(2,'0'),due=String(index+2).padStart(2,'0')
    await g.api('usage.submit',{events:[g.event(840+index,'1000',month)]})
    originals.push(await g.issue(`2026-${month}`,`2026-${due}-01`))
  }
  const ledger=await g.state()
  const simulation=await g.api('proposal.create',{kind:'price_change',title:'Synthetic saved prepaid commercial comparison',payload:{simulation:true,source_price:g.price,target_price:next,subscriptions:[g.subscription],start_month:'2026-01',effective_date:'2026-07-01'}})
  const comparison=await g.detail(simulation.id),history=comparison.impact[0].historical.periods
  assert.deepEqual(history.map(period=>period.before.totalCents),Array(6).fill(0))
  assert.deepEqual(history.map(period=>period.after.totalCents),[0,0,0,0,0,100000],'A six-period historical comparison cannot repeatedly spend the original purchased wallet')
  assert.deepEqual(await g.state(),ledger)
  for(const invoice of originals)assert.deepEqual(original(await g.api(`invoices/${invoice.id}`)),original(invoice))
  await onState({label:'migration-historical',f:g,proposal:comparison})
  return {subscription:f.subscription,customer:f.customer,proposal:saved.id}
}

return { prepaidAgentCreditFlow, prepaidAgentDraftCorrectionsFlow, prepaidCommercialMigrationFlow }
})()
export const { prepaidAgentCreditFlow, prepaidAgentDraftCorrectionsFlow, prepaidCommercialMigrationFlow } = prepaidAgentCorrectionsJourneys
