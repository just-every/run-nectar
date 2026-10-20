import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'

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
    console.log('AGENT-002 issued credit corrections: exact evidence, frozen preview and mail, human approval, stale and duplicate refusal, governed threshold, durable provider outcomes passed')
    return { invoice: seats.id, proposal: prepared.id, governed: high.id, rejected: rejected.id }
  } finally {
    await applyPolicy(h, owner, 'credit.policy', { two_person_above: previousPolicy.creditLimitCents === null ? '' : (previousPolicy.creditLimitCents / 100).toFixed(2) })
    await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: previous.tax_jurisdiction, tax_mode: previous.tax_mode, tax_rate: previous.tax_rate, tax_note: previous.tax_note })
    if (previous.taxReady) await api('tax.review', { revision: (await api('business')).revision })
  }
}
