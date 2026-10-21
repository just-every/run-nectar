import assert from 'node:assert/strict'
import { publishPrice } from './price-helper.mjs'

// AGENT-004: one public-HTTP journey, with independently calculated examples.
export async function pricingSimulation(h, owner) {
  await h.api('access.give', owner, { email: 'simulation-finance@example.test', name: 'Simulation Finance', role: 'finance' })
  await h.api('access.give', owner, { email: 'simulation-accountant@example.test', name: 'Simulation Accountant', role: 'accountant' })
  const finance = await h.signIn('simulation-finance@example.test', { requested: true })
  const accountant = await h.signIn('simulation-accountant@example.test', { requested: true })
  const agent = { bearer: (await h.api('credential.issue', owner, { name: 'Historical pricing planner', scopes: ['prepare'] })).key }
  const seatProduct = (await h.api('product.create', owner, { code: 'simulation-seats', name: 'Historical seats' })).id
  const unitProduct = (await h.api('product.create', owner, { code: 'simulation-units', name: 'Proposed usage' })).id
  const meter = (await h.api('meter.create', owner, { code: 'simulation-calls', name: 'Retained calls', unit_label: 'calls' })).id
  const seat = (await publishPrice(h, owner, { product: seatProduct, kind: 'seat', unit_amount: '10', taxable: false })).id
  const unit = (await publishPrice(h, owner, { product: unitProduct, kind: 'unit', meter, unit_amount: '2', taxable: false })).id
  const retiredTarget = (await publishPrice(h, owner, { product: unitProduct, kind: 'unit', meter, unit_amount: '3', taxable: false })).id
  const cohorts = []
  for (const [suffix, quantity, counts] of [['A', 2, [2, 5, 8, 13, 21, 34]], ['B', 3, [4, 7, 10, 16, 25, 40]], ['HELD', 4, [1, 2, 3, 4, 5, 6]]]) {
    const external = `SIMULATION-${suffix}`
    const email = `billing-${suffix.toLowerCase()}@simulation.example`
    const customer = (await h.api('customer.create', owner, { external_id: external, name: `Simulation ${suffix}`, billing_email: email })).id
    const subscription = (await h.api('subscription.create', owner, { customer, external_id: external, start_date: '2026-01-01', anchor_day: 1, price: [seat], quantity: [String(quantity)] })).id
    cohorts.push({ external, email, customer, subscription, quantity, counts, history: [] })
  }
  const [a, b, held] = cohorts
  const contract=await h.api('contract.prepare',owner,{subscription:b.subscription,revision:(await h.api(`subscriptions/${b.subscription}`,owner)).revision,clause:'Executed terms: a $210 minimum for January through June, before tax.',commitments:[{from:'2026-01-01',to:'2026-07-01',minimum:'210',taxable:false}]})
  await h.api('contract.decide',finance,{contract:contract.contract,decision:'approved'})
  const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']
  const getSub = id => h.api(`subscriptions/${id}`, owner)
  const getProposal = id => h.api(`proposals/${id}`, owner)
  const decide = (id, who, status = 200, decision = 'approved') => h.api('proposal.decide', who, { proposal: id, decision }, status)
  const payload = { simulation: true, start_month: '2026-01', effective_date: '2026-07-01', source_price: seat, target_price: unit, subscriptions: [a.subscription, b.subscription], cost_cents: 500 }
  const propose = (who, title, overrides = {}, status = 200) => h.api('proposal.create', who, { kind: 'price_change', title, payload: { ...payload, ...overrides } }, status)
  const event = (cohort, month, quantity, suffix = '') => ({ event_id: `${cohort.external}-${month}${suffix}`, customer: cohort.external, meter: 'simulation-calls', quantity: String(quantity), occurred_at: `${month}-10T12:00:00-08:00` })
  const issue = async (invoice, date) => {
    await h.api('invoice.approve', owner, { invoice: invoice.id, acknowledge: true })
    const result = await h.api('invoice.finalise', owner, { invoice: invoice.id, issue_date: date })
    assert.equal(result.issued.length, 1)
    return h.api(`invoices/${invoice.id}`, owner)
  }

  for (const [index, month] of months.entries()) {
    const usage = await h.api('usage.submit', owner, { events: cohorts.map(c => event(c, month, c.counts[index])) })
    assert.deepEqual([usage.accepted, usage.duplicates, usage.rejected], [3, 0, 0])
    const run = await h.api('billrun.prepare', owner, { period: month })
    const invoices = (await h.api(`runs/${run.id}`, owner)).invoices
    for (const cohort of cohorts) {
      const draft = invoices.find(invoice => invoice.customer_id === cohort.customer)
      assert.ok(draft)
      const invoice = await issue(draft, `${index === 5 ? '2026-07' : months[index + 1]}-01`)
      assert.equal(invoice.status, 'issued')
      assert.equal(invoice.total_cents, cohort.quantity * 1000 + (cohort===b&&index===5?3000:0), 'AGENT-004 historical seats plus the final signed minimum true-up are independently computed')
      assert.equal(invoice.lines.find(line => line.kind === 'seat').quantity, String(cohort.quantity))
      assert.deepEqual(invoice.calculation.inputs.events, [], 'the seat invoice never had a metered item')
      cohort.history.push(invoice)
    }
    const inspect = await h.api(`usage/inspect?period=${month}`, owner)
    for (const cohort of cohorts) assert.ok(inspect.unattributed.some(row => row.event_id === `${cohort.external}-${month}`), 'raw events remain available before subscribing to metered pricing')
  }

  // Missing history, malformed dates and duplicate cohort selections fail before writes.
  const missing = (await h.api('subscription.create', owner, { customer: held.customer, start_date: '2026-07-01', price: [seat], quantity: ['1'] })).id
  assert.equal((await propose(agent, 'No six issued months', { subscriptions: [missing] }, 409)).error, 'six_issued_monthly_invoices_required')
  for (const changes of [{ start_month: '2026-13' }, { effective_date: '2026-02-30' }, { subscriptions: [a.subscription, a.subscription] }]) {
    await propose(agent, 'Invalid simulation selection', changes, 400)
  }
  await propose(agent, 'Cannot schedule inside issued history', { effective_date: '2026-06-01' }, 409)
  await propose(accountant, 'Read-only cannot prepare', {}, 403)
  await propose(undefined, 'Signed out cannot prepare', {}, 401)

  const rejected = await propose(owner, 'Declined historical pricing change')
  const beforeRejection = await Promise.all(cohorts.map(c => getSub(c.subscription)))
  await decide(rejected.id, owner, 200, 'rejected')
  assert.equal((await getProposal(rejected.id)).status, 'rejected')
  assert.deepEqual(await Promise.all(cohorts.map(c => getSub(c.subscription))), beforeRejection)

  const staleUsage = await propose(agent, 'Usage basis before late retained event')
  const savedStale = await getProposal(staleUsage.id)
  assert.equal((await h.api('usage.submit', owner, { events: [event(a, '2026-01', 1, '-late')] })).accepted, 1)
  a.counts[0] = 3
  assert.equal((await getProposal(staleUsage.id)).stale, true)
  assert.equal((await decide(staleUsage.id, finance, 409)).error, 'proposal_stale')
  assert.deepEqual((await getProposal(staleUsage.id)).impact, savedStale.impact, 'staleness never rewrites a saved explanation or notice')

  // Exercise other stale bases on the excluded subscription, before its snapshot.
  const staleSub = await propose(agent, 'Subscription basis before scheduled seat quantity', { subscriptions: [held.subscription] })
  const heldBefore = await getSub(held.subscription)
  const change = await h.api('change.prepare', owner, { subscription: held.subscription, item: heldBefore.items[0].id, quantity: 5, effective_date: '2026-09-01' })
  await h.api('change.decide', owner, { change: change.change, decision: 'approved' })
  const heldAfterQuantity = await getSub(held.subscription)
  assert.equal((await decide(staleSub.id, finance, 409)).error, 'proposal_stale')
  assert.deepEqual(await getSub(held.subscription), heldAfterQuantity)
  const staleTarget = await propose(agent, 'Target basis before retirement', { subscriptions: [held.subscription], target_price: retiredTarget })
  await h.api('price.retire', owner, { price: retiredTarget })
  assert.equal((await decide(staleTarget.id, finance, 409)).error, 'proposal_stale')
  assert.deepEqual(await getSub(held.subscription), heldAfterQuantity)

  // Retained historical usage can replay, but another future owner of its source
  // prevents scheduling a second charge for the same customer's July events.
  await h.api('subscription.create', owner, { customer: held.customer, start_date: '2026-07-01', price: [unit] })
  assert.equal((await propose(agent, 'Future meter already owned', { subscriptions: [held.subscription] }, 409)).error, 'meter_already_billed')
  const packageTarget=(await publishPrice(h,owner,{product:unitProduct,kind:'unit',meter,taxable:false,pricing_model:'package',package_size:'5',tiers:[{up_to:null,unit_amount:'3'}]})).id
  const packageProposal=await propose(agent,'Historical package comparison',{target_price:packageTarget,subscriptions:[a.subscription],cost_cents:undefined})
  const packageView=await getProposal(packageProposal.id)
  assert.deepEqual(packageView.impact[0].historical.periods.map(p=>p.after.subtotalCents),[300,300,600,900,1500,2100],'AGENT-004 exact catalog packaging replays independently counted ceil(quantity/5) blocks at $3')
  assert.equal(packageView.impact[0].historical.estimatedMargins,undefined,'AGENT-004 no cost input means no invented margin')
  assert.equal(packageView.impact[0].simulationSummary.costAssumption,undefined)
  await decide(packageProposal.id,owner,200,'rejected')
  const before = await Promise.all(cohorts.map(c => getSub(c.subscription)))
  const catalogBefore = (await h.api('catalog', owner)).prices
  assert.equal((await h.api('usage.submit', owner, { events: [event(a, '2026-07', 11), event(b, '2026-07', 17)] })).accepted, 2)

  const mailCount = h.mails.length
  const main = await propose(owner, 'Six-month seat-to-usage cohort')
  const saved = await getProposal(main.id)
  assert.equal(saved.stale, false)
  assert.equal(saved.needsOtherApprover, true)
  assert.deepEqual(saved.payload.subscriptions, [a.subscription, b.subscription])
  assert.deepEqual(saved.payload.resolved_dates, { [a.subscription]: '2026-07-01', [b.subscription]: '2026-07-01' })
  assert.equal(saved.payload.product, unitProduct, 'cross-product replacement uses the target catalogue product')
  assert.deepEqual(saved.impact.map(entry => entry.subscription), [a.subscription, b.subscription])
  const expectedAfter = [[600, 1000, 1600, 2600, 4200, 6800], [800, 1400, 2000, 3200, 5000, 8600]]
  const expectedTotals = [
    { beforeSubtotalCents: 12000, afterSubtotalCents: 16800, beforeTotalCents: 12000, afterTotalCents: 16800, deltaSubtotalCents: 4800, deltaTotalCents: 4800 },
    { beforeSubtotalCents: 21000, afterSubtotalCents: 21000, beforeTotalCents: 21000, afterTotalCents: 21000, deltaSubtotalCents: 0, deltaTotalCents: 0 },
  ]
  for (const [index, cohort] of [a, b].entries()) {
    const entry = saved.impact[index]
    assert.equal(entry.historical.periods.length, 6)
    assert.deepEqual(entry.historical.totals, expectedTotals[index])
    assert.deepEqual(entry.historical.estimatedMargins, { label: entry.historical.estimatedMargins.label, costPerPeriodCents: 500, totalCostCents: 3000, beforeMarginCents: expectedTotals[index].beforeSubtotalCents - 3000, afterMarginCents: expectedTotals[index].afterSubtotalCents - 3000 })
    for (const [monthIndex, period] of entry.historical.periods.entries()) {
      const original = cohort.history[monthIndex]
      const expected = expectedAfter[index][monthIndex]
      const expectedBefore=cohort.quantity*1000+(cohort===b&&monthIndex===5?3000:0)
      assert.equal(period.invoice, original.id)
      assert.equal(period.invoiceNumber, original.number)
      assert.equal(period.period.start, `${months[monthIndex]}-01`)
      assert.deepEqual([period.before.subtotalCents, period.before.totalCents], [expectedBefore, expectedBefore])
      assert.deepEqual([period.after.subtotalCents, period.after.totalCents], [expected, expected])
      assert.deepEqual([period.deltaSubtotalCents, period.deltaTotalCents], [expected - expectedBefore, expected - expectedBefore], 'each monthly delta is checked against hand arithmetic')
      assert.equal(period.before.lines.find(line => line.kind === 'seat').quantity, String(cohort.quantity))
      const usage = period.after.lines.filter(line => line.priceId === unit)
      assert.equal(usage.length, 1)
      assert.equal(Number(usage[0].quantity), cohort.counts[monthIndex])
      assert.equal(usage[0].unitAmount, '2.00')
      assert.equal(usage[0].amountCents,cohort.counts[monthIndex]*200)
      if(cohort===b&&monthIndex===5)assert.deepEqual([period.before.lines.find(l=>l.kind==='commitment_trueup').amountCents,period.after.lines.find(l=>l.kind==='commitment_trueup').amountCents],[3000,600],'AGENT-004 replayed earlier invoice earnings feed the final minimum true-up')
      const ids = [`${cohort.external}-${months[monthIndex]}`, ...(cohort === a && monthIndex === 0 ? [`${a.external}-2026-01-late`] : [])]
      assert.deepEqual(period.sourceEvents.map(e => e.eventId).sort(), ids.sort())
      assert.equal(period.sourceEvents.reduce((sum, e) => sum + Number(e.quantity), 0), cohort.counts[monthIndex])
      assert.equal(typeof period.fingerprint, 'string')
      assert.ok(period.fingerprint.length)
      for (const key of ['original', 'raw', 'target']) assert.ok(period.fingerprints[key], 'replay identifies each historical, usage and target basis')
      assert.ok(entry.historical.explanation.includes(original.number))
    }
    assert.equal(entry.periods.length, 2)
    assert.deepEqual(entry.periods.map(p => p.period.start), ['2026-07-01', '2026-08-01'])
    assert.deepEqual([entry.periods[0].before.totalCents, entry.periods[0].after.totalCents], [cohort.quantity * 1000, index === 0 ? 2200 : 3400])
    assert.equal(entry.periods[1].after.totalCents,0,'AGENT-004 July projected consumption leaves no invented August usage charge')
    assert.deepEqual(entry.periods[1].after.consumedEvents,[],'AGENT-004 no event is consumed on two projected invoices')
    assert.deepEqual(entry.notice.invoiceIds, cohort.history.map(i => i.id))
    assert.equal(entry.notice.status, 'prepared')
    assert.equal(entry.notice.recipient, cohort.email)
    assert.equal(entry.notice.effectiveDate, '2026-07-01')
    assert.ok(entry.notice.subject && entry.notice.body.includes('2026-07-01'))
    assert.ok(entry.notice.body.includes(cohort.history[0].number) && entry.notice.body.includes(cohort.history[5].number))
    assert.doesNotMatch(entry.notice.body, /(?:has been|was|successfully) (?:sent|delivered)/i)
  }
  const summary = saved.impact[0].simulationSummary
  assert.deepEqual(summary.totals, { beforeSubtotalCents: 33000, afterSubtotalCents: 37800, beforeTotalCents: 33000, afterTotalCents: 37800, deltaSubtotalCents: 4800, deltaTotalCents: 4800 })
  assert.deepEqual(summary.highestAffectedCustomers.map(c => [c.subscription, c.deltaTotalCents]), [[a.subscription, 4800], [b.subscription, 0]])
  assert.deepEqual([summary.costAssumption.totalCostCents, summary.costAssumption.beforeMarginCents, summary.costAssumption.afterMarginCents], [6000, 27000, 31800])
  assert.deepEqual(await Promise.all(cohorts.map(c => getSub(c.subscription))), before, 'simulation preparation changes no selected or excluded subscription')
  assert.equal((await decide(main.id, owner, 409)).error, 'second_approver_required')
  for (const who of [agent, accountant]) await decide(main.id, who, 403)
  await decide(main.id, undefined, 401)
  const agentPrepared = await propose(agent, 'Agent may prepare but never approve')
  await decide(agentPrepared.id, agent, 403)
  await decide(agentPrepared.id, owner, 200, 'rejected')
  await decide(main.id, finance)
  assert.equal((await decide(main.id, finance, 409)).error, 'already_decided')
  const approved = await getProposal(main.id)
  assert.equal(approved.status, 'approved')
  assert.equal(approved.decided_by, 'simulation-finance@example.test')
  assert.deepEqual(approved.payload, saved.payload)
  assert.deepEqual(approved.impact, saved.impact, 'approval preserves the exact prepared notices, comparisons and cohort')
  assert.equal(h.mails.length, mailCount, 'prepared customer explanations are not delivery claims or sent mail')
  assert.deepEqual((await h.api('catalog', owner)).prices, catalogBefore)
  for (const cohort of [a, b]) {
    const scheduled = await getSub(cohort.subscription)
    assert.deepEqual(scheduled.items.map(item => [item.price_id, item.quantity, item.effective_from, item.effective_to]), [[seat, cohort.quantity, '2026-01-01', '2026-07-01'], [unit, 1, '2026-07-01', null]])
  }
  assert.deepEqual(await getSub(held.subscription), before[2], 'the excluded cohort retains all its saved prices, dates and revision')

  const july = await h.api('billrun.prepare', owner, { period: '2026-07' })
  const julyInvoices = (await h.api(`runs/${july.id}`, owner)).invoices
  for (const [index, cohort] of [a, b].entries()) {
    const preview = saved.impact[index].periods[0].after
    const draft = julyInvoices.find(invoice => invoice.customer_id === cohort.customer)
    assert.ok(!draft.exceptions.some(e=>e.code==='historical_usage_correction'),'AGENT-004 retained events never priced by historical seat-only invoices need no financial correction before the first metered period')
    const issued = await issue(draft, '2026-08-01')
    assert.deepEqual([issued.subtotal_cents, issued.tax_cents, issued.total_cents], [preview.subtotalCents, preview.taxCents, preview.totalCents])
    assert.deepEqual(issued.lines.map(l => [l.price_id, l.kind, l.quantity, l.amount_cents, l.period_start, l.period_end]), preview.lines.map(l => [l.priceId, l.kind, l.quantity, l.amountCents, l.periodStart, l.periodEnd]), 'issued July charges equal the saved future preview')
  }
  for (const cohort of cohorts) for (const original of cohort.history) {
    assert.deepEqual(await h.api(`invoices/${original.id}`, owner), original, 'replay, stale/refused actions and scheduling preserve every issued calculation and source quantity')
  }
  assert.deepEqual((await getProposal(main.id)).impact, saved.impact, 'subsequent billing cannot rewrite the approved customer explanation')
  await mixedIntervalReplay(h, owner, finance)
  await evergreenIntervalReplay(h, owner)
  console.log('AGENT-004 six issued months, retained usage replay, independently checked deltas, governed cohort scheduling, immutable prepared notices and exact July billing passed')
}

async function mixedIntervalReplay(h, owner, finance) {
  const api = (action, body, status) => h.api(action, owner, body, status)
  const customer = (await api('customer.create', { external_id: 'synthetic-nectar-replay-mixed', name: 'Mixed annual replay', billing_email: 'mixed@replay.example' })).id
  const product = (await api('product.create', { code: 'mixed-replay-platform', name: 'Annual platform replay' })).id
  const monthlyProduct = (await api('product.create', { code: 'mixed-replay-monthly', name: 'Monthly companion' })).id
  const annual = { product, kind: 'flat', taxable: false, billing_interval: 'annual', billing_timing: 'advance' }
  const source = (await publishPrice(h, owner, { ...annual, unit_amount: '1000' })).id
  const target = (await publishPrice(h, owner, { ...annual, unit_amount: '1200' })).id
  const companion = (await publishPrice(h, owner, { product: monthlyProduct, kind: 'flat', unit_amount: '10', taxable: false })).id
  const subscription = (await api('subscription.create', { customer, start_date: '2020-01-01', billing_anchor_date: '2020-01-01', price: [source, companion] })).id
  const term = await api('term.prepare', { subscription, revision: (await api(`subscriptions/${subscription}`)).revision, term_start: '2020-01-01', months: 12, auto_renew: true, notice_days: 30, uplift_percent: '0' })
  await h.api('term.decide', finance, { term: term.term, decision: 'approved' })
  const originals = []
  for (let index = 0; index <= 12; index++) {
    const month = `${2020 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`
    await api('billrun.prepare', { period: month })
    const drafts = (await api(`subscriptions/${subscription}`)).invoices.filter(invoice => invoice.status === 'draft')
    for (const invoice of drafts) {
      await api('invoice.approve', { invoice: invoice.id, acknowledge: true })
      await api('invoice.finalise', { invoice: invoice.id, issue_date: `${month}-01` })
      originals.push(await api(`invoices/${invoice.id}`))
    }
  }
  // Jan2021 also contains the next annual advance; replay the complete first
  // signed term only, including all twelve independent monthly invoices.
  const firstTerm = originals.filter(invoice => invoice.period_start < '2021-01-01')
  assert.equal(firstTerm.length, 13)
  const created = await api('proposal.create', { kind: 'price_change', title: 'Complete mixed service term', payload: { simulation: true, start_month: '2020-01', effective_date: '2022-01-01', source_price: source, target_price: target, subscriptions: [subscription], cost_cents: 500 } })
  const view = await api(`proposals/${created.id}`), history = view.impact[0].historical
  assert.equal(history.periods.length, 13)
  assert.deepEqual([history.totals.beforeSubtotalCents, history.totals.afterSubtotalCents, history.totals.deltaSubtotalCents], [112000, 132000, 20000])
  assert.equal(history.periods.filter(period => period.deltaSubtotalCents === 20000).length, 1)
  assert.equal(history.periods.filter(period => period.deltaSubtotalCents === 0).length, 12)
  assert.equal(history.estimatedMargins.totalCostCents, 6500)
  assert.equal(view.impact[0].notice.status, 'prepared')
  assert.deepEqual(new Set(view.impact[0].notice.invoiceIds), new Set(firstTerm.map(invoice => invoice.id)))
  for (const invoice of originals) assert.deepEqual(await api(`invoices/${invoice.id}`), invoice, 'Interval replay preserves original saved windows, amounts and evidence')
}

async function evergreenIntervalReplay(h, owner) {
  for (const [name, periods] of [
    ['annual', ['2011-01', '2012-01', '2013-01', '2014-01', '2015-01', '2016-01']],
    ['quarterly', ['2010-04', '2010-07', '2010-10', '2011-01', '2011-04', '2011-07']],
    ['weekly', ['2010-01', '2010-02']],
  ]) {
    const api = (action, body) => h.api(action, owner, body)
    const customer = (await api('customer.create', { external_id: `synthetic-nectar-replay-${name}`, name: `Saved ${name} service`, billing_email: `${name}@replay.example` })).id
    const product = (await api('product.create', { code: `saved-replay-${name}`, name: `Replay ${name}` })).id
    const fields = { product, kind: 'flat', taxable: false, billing_interval: name, billing_timing: 'arrears' }
    const source = (await publishPrice(h, owner, { ...fields, unit_amount: '100' })).id
    const target = (await publishPrice(h, owner, { ...fields, unit_amount: '120' })).id
    const subscription = (await api('subscription.create', { customer, start_date: '2010-01-01', billing_anchor_date: '2010-01-01', price: [source] })).id
    for (const month of periods) {
      await api('billrun.prepare', { period: month })
      for (const invoice of (await api(`subscriptions/${subscription}`)).invoices.filter(invoice => invoice.status === 'draft')) {
        await api('invoice.approve', { invoice: invoice.id, acknowledge: true })
        await api('invoice.finalise', { invoice: invoice.id, issue_date: `${month}-28` })
      }
    }
    const created = await api('proposal.create', { kind: 'price_change', title: `Replay six saved ${name} intervals`, payload: { simulation: true, start_month: '2010-01', effective_date: '2025-01-01', source_price: source, target_price: target, subscriptions: [subscription] } })
    const replay = (await api(`proposals/${created.id}`)).impact[0].historical
    assert.equal(replay.periods.length, 6, 'Evergreen replay selects six actual saved service intervals')
    assert.deepEqual([replay.totals.beforeSubtotalCents, replay.totals.afterSubtotalCents, replay.totals.deltaSubtotalCents], [60000, 72000, 12000])
    assert.ok(replay.periods.every(period => period.before.totalCents === 10000 && period.after.totalCents === 12000))
    const originals = await Promise.all(replay.periods.map(period => api(`invoices/${period.invoice}`)))
    assert.deepEqual(replay.periods.map(period => period.period), originals.map(invoice => ({ start: invoice.period_start, end: invoice.period_end })))
  }
}
