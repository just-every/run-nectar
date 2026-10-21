import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

// Independent cents, written from the executed order rather than the rating engine.
const monthlyCents = [5000, ...Array(10).fill(10000), 40000, ...Array(11).fill(11000), 29000, ...Array(11).fill(12100), 16900]
const sum = values => values.reduce((a, b) => a + b, 0)
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex')

function executedOrder(suffix, year = 2020) {
  const customer = `Customer AGENT006-${suffix}: Cedar Research ${suffix}; billing email ap@cedar.example.`
  const subscription = `Service AGENT006-${suffix}-SERVICE runs for 36 months from ${year}-01-01 through ${year + 3}-01-01, billed monthly in arrears on day 1, Net 30.`
  const fees = [100, 110, 121].map((amount, i) => `Cedar Platform (${`agent006-${suffix}`.toLowerCase()}) costs USD ${amount}.00 per month from ${year + i}-01-01 until ${year + i + 1}-01-01; the anniversary uplift is ten percent compounded.`)
  const minimums = fees.map((_, i) => `The minimum eligible recurring fees from ${year + i}-01-01 until ${year + i + 1}-01-01 are USD 1500.00; bill any shortfall in the final month of that window. Credits do not consume the minimum.`)
  const credit = `Apply a one-time USD 50.00 launch credit in ${year}-01; there are no other credits. All stated charges are non-taxable.`
  const text = `EXECUTED ORDER\nOrder AGENT006-${suffix}\n${customer}\n${subscription}\n${fees.join('\n')}\n${minimums.join('\n')}\n${credit}\nExecuted by Cedar Research buyer: Pat Buyer, ${year - 1}-12-20.\nAccepted by Cedar Software seller: Robin Seller, ${year - 1}-12-21.\nBuyer signature record: buyer-recorded signature ref ${suffix}.\n`
  return {
    setup: true, source: { name: 'executed-order.txt', text, execution_reference: `buyer-recorded signature ref ${suffix}`, original:{filename:'executed-order.txt',type:'text/plain',base64:Buffer.from(text).toString('base64')} },
    customer: { external_id: `AGENT006-${suffix}`, name: `Cedar Research ${suffix}`, billing_email: 'ap@cedar.example', quote: customer },
    catalog: fees.map((quote, i) => ({ key: `year${i + 1}`, new_product: { code: `agent006-${suffix}`.toLowerCase(), name: 'Cedar Platform' }, kind: 'flat', unit_amount: String([100, 110, 121][i]), taxable: false, quote })),
    subscription: { external_id: `AGENT006-${suffix}-SERVICE`, start_date: `${year}-01-01`, anchor_day: 1, months: 36, quote: subscription },
    items: fees.map((quote, i) => ({ key: 'base', price: `year${i + 1}`, quantity: 1, from: `${year + i}-01-01`, to: `${year + i + 1}-01-01`, quote })),
    commitments: minimums.map((quote, i) => ({ from: `${year + i}-01-01`, to: `${year + i + 1}-01-01`, minimum: '1500', taxable: false, quote })),
    exceptions: [{ kind: 'fixed_credit', value: '50', from: `${year}-01-01`, quote: credit }], ambiguities: [],
  }
}

function checkPreview(impact, payload) {
  assert.equal(impact.periods.length, 36, 'AGENT-006 previews every month of the complete executed term')
  for (const [i, row] of impact.periods.entries()) {
    const year = Number(payload.subscription.start_date.slice(0, 4)) + Math.floor(i / 12)
    const month = String(i % 12 + 1).padStart(2, '0')
    assert.equal(row.period.start, `${year}-${month}-01`)
    assert.deepEqual([row.calculation.subtotalCents, row.calculation.taxCents, row.calculation.totalCents], [monthlyCents[i], 0, monthlyCents[i]], `AGENT-006 ${year}-${month} matches the independently calculated monthly cents`)
    assert.ok(row.inputs && typeof row.fingerprint === 'string' && row.fingerprint.length > 0, 'AGENT-006 each preview retains its actual rating inputs and fingerprint')
    const recurring = row.calculation.lines.filter(line => line.kind === 'flat')
    assert.equal(sum(recurring.map(line => line.amountCents)), [10000, 11000, 12100][Math.floor(i / 12)])
    const trueup = sum(row.calculation.lines.filter(line => line.kind === 'commitment_trueup').map(line => line.amountCents))
    assert.equal(trueup, i % 12 === 11 ? [30000, 18000, 4800][Math.floor(i / 12)] : 0, 'AGENT-006 annual shortfalls exclude the launch credit')
  }
  assert.equal(sum(impact.periods.map(row => row.calculation.totalCents)), 445000)
  assert.equal(impact.totals.totalCents, 445000)
  assert.deepEqual(impact.annualTotals.map(row => row.totalCents), [145000, 150000, 150000])
  assert.deepEqual(impact.unresolvedAmbiguities, [])
  assert.ok(impact.quotes.length > 0)
  for (const row of impact.quotes) assert.ok(payload.source.text.includes(row.quote), 'AGENT-006 every mapped quote is an exact source substring')
}

const previewLines = calculation => calculation.lines.map(line => [line.kind, line.priceId, line.quantity, line.unitAmount, line.amountCents, line.periodStart, line.periodEnd, line.taxable])

function constantOrder(suffix, evergreen = false) {
  const customer = `Customer AGENT006-${suffix}: Cedar Research ${suffix}; billing email ap@cedar.example.`
  const term = evergreen ? 'Service starts 2020-01-01 and renews monthly until canceled, with no fixed end date.' : 'Service runs from 2020-01-01 until 2024-01-01, a fixed 48-month term.'
  const fee = 'Cedar Platform costs USD 100.00 per month, billed monthly in arrears on day 1, Net 30. Charges are non-taxable; no minimum commitment or credit applies.'
  const text = `EXECUTED ORDER AGENT006-${suffix}\n${customer}\n${term}\n${fee}\nSigned by Pat Buyer and Robin Seller on 2019-12-21.\n`
  return {
    setup: true,
    source: { name: 'executed-order.txt', text, execution_reference: `buyer-recorded signature ref ${suffix}`, original: { filename: 'executed-order.txt', type: 'text/plain', base64: Buffer.from(text).toString('base64') } },
    customer: { external_id: `AGENT006-${suffix}`, name: `Cedar Research ${suffix}`, billing_email: 'ap@cedar.example', quote: customer },
    catalog: [{ key: 'base', new_product: { code: `agent006-${suffix}`.toLowerCase(), name: `Cedar Platform ${suffix}` }, kind: 'flat', unit_amount: '100', taxable: false, quote: fee }],
    subscription: { external_id: `AGENT006-${suffix}-SERVICE`, start_date: '2020-01-01', anchor_day: 1, ...(evergreen ? { evergreen: true } : { end_date: '2024-01-01' }), quote: term },
    items: [{ key: 'base', price: 'base', quantity: 1, from: '2020-01-01', ...(evergreen ? {} : { to: '2024-01-01' }), quote: fee }],
    ambiguities: [],
  }
}

function renewalOrder(suffix, autoRenew = true, evergreen = true) {
  const payload = constantOrder(suffix, true)
  const term = `Service starts 2030-01-01 with an annual term of 12 months through 2031-01-01; ${autoRenew ? 'auto-renews for successive 12-month terms until canceled' : 'ends without automatic renewal'}. Send notice 30 days before renewal. Apply a 5 percent compounded price uplift at each renewal. Billing remains monthly in arrears.`
  payload.source.text = payload.source.text.replaceAll('2020-01-01', '2030-01-01').replace(payload.subscription.quote.replaceAll('2020-01-01', '2030-01-01'), term)
  payload.source.original.base64 = Buffer.from(payload.source.text).toString('base64')
  payload.subscription = { external_id: payload.subscription.external_id, start_date: '2030-01-01', anchor_day: 1, ...(evergreen ? { evergreen: true } : { months: 12 }), renewal: { months: 12, auto_renew: autoRenew, notice_days: 30, uplift_percent: '5', quote: term }, quote: term }
  payload.items[0].from = '2030-01-01'
  return payload
}

// AGENT-006: one public-HTTP journey, with no domain/database writes outside the API.
export async function contractSetup(h, owner) {
  await h.api('access.give', owner, { email: 'agent006-finance@example.test', name: 'Setup Finance', role: 'finance' })
  await h.api('access.give', owner, { email: 'agent006-accountant@example.test', name: 'Setup Accountant', role: 'accountant' })
  const [finance, accountant] = await Promise.all([
    h.signIn('agent006-finance@example.test', { requested: true }), h.signIn('agent006-accountant@example.test', { requested: true }),
  ])
  const agent = { bearer: (await h.api('credential.issue', owner, { name: 'AGENT-006 setup preparer', scopes: ['prepare'] })).key }
  const api = (path, body, status) => h.api(path, owner, body, status)
  const propose = (who, payload, status = 200) => h.api('proposal.create', who, { kind: 'amendment', title: 'Executed Cedar order setup', payload }, status)
  const decide = (who, proposal, decision = 'approved', status = 200) => h.api('proposal.decide', who, { proposal, decision }, status)
  const snapshot = async () => Promise.all([api('customers'), api('catalog'), api('runs')])
  const original = executedOrder('EXECUTED'), originalText = original.source.text
  const before = await snapshot(), proposalsBefore = await api('proposals')
  for (const who of [undefined, accountant]) await propose(who, original, who ? 403 : 401)
  const invalid = structuredClone(original)
  invalid.items[1].quote = 'This price was never agreed in the executed order.'
  await propose(agent, invalid, 400)
  const oversized=structuredClone(original)
  oversized.source.original.base64=Buffer.alloc(256001,65).toString('base64')
  const refusedFile=await propose(agent,oversized,400)
  assert.equal(refusedFile.detail.textOnlyAllowed,true, 'AGENT-006 oversized originals are clearly refused with the supported text-only path')
  assert.deepEqual(await api('proposals'), proposalsBefore, 'AGENT-006 an invented quote cannot create a proposal')
  assert.deepEqual(await snapshot(), before, 'AGENT-006 invalid and unauthorized preparation creates no customer, catalog or billing records')

  const rejected = await propose(agent, original)
  checkPreview(rejected.impact, original)
  await decide(finance, rejected.id, 'rejected')
  await decide(finance, rejected.id, 'approved', 409)
  assert.deepEqual(await snapshot(), before, 'AGENT-006 rejecting a setup leaves every domain record untouched')

  const prepared = await propose(owner, original)
  const competing = await propose(agent, original)
  checkPreview(prepared.impact, original)
  const saved = await api(`proposals/${prepared.id}`), plan = saved.payload.plan
  assert.deepEqual(saved.payload.input, original, 'AGENT-006 the exact submitted interpretation is retained')
  assert.equal(saved.payload.source.text, originalText)
  assert.equal(saved.payload.source.sha256, digest(originalText), 'AGENT-006 the retained digest covers the original source bytes')
  assert.equal(saved.payload.source.execution_reference, original.source.execution_reference)
  assert.equal(saved.payload.source.original.sha256,digest(originalText),'AGENT-006 original bytes retain independent integrity custody')
  const download=await h.raw(`/api/nectar/proposals/${prepared.id}/source`,{cookie:owner})
  assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/^attachment;/)
  assert.equal(await download.text(),originalText,'AGENT-006 authorized source download preserves the original bytes')
  assert.equal((await h.raw(`/api/nectar/proposals/${prepared.id}/source`)).status,401)
  assert.equal((await h.raw(`/app/proposals/${prepared.id}/source`,{cookie:accountant})).status,200)
  assert.deepEqual(saved.impact, prepared.impact)
  await api(`customers/${plan.customer.id}`, undefined, 404)
  await api(`subscriptions/${plan.subscription.id}`, undefined, 404)
  assert.deepEqual(await snapshot(), before, 'AGENT-006 full-term preparation writes only its proposal and evidence')
  await decide(owner, prepared.id, 'approved', 409)
  await decide(undefined, prepared.id, 'approved', 401)
  for (const who of [agent, accountant]) await decide(who, prepared.id, 'approved', 403)
  assert.deepEqual(await snapshot(), before, 'AGENT-006 refused approvals cannot partially apply setup')

  const approved = await decide(finance, prepared.id)
  assert.equal(approved.subscription, plan.subscription.id)
  await decide(finance, prepared.id, 'approved', 409)
  const afterApproval = await snapshot()
  assert.equal((await api(`proposals/${competing.id}`)).stale, true)
  await decide(finance, competing.id, 'approved', 409)
  assert.deepEqual(await snapshot(), afterApproval, 'AGENT-006 a stale competing setup cannot leave partial domain records')
  await decide(finance, competing.id, 'rejected')
  const subscription = await api(`subscriptions/${approved.subscription}`)
  assert.deepEqual(subscription.items.map(row => [row.price_id, Number(row.quantity), row.effective_from, row.effective_to]), plan.items.map(row => [row.priceId, row.quantity, row.from, row.to]))
  assert.equal(subscription.end_date, '2023-01-01')
  assert.equal(subscription.contracts.find(row => row.id === plan.contract.id)?.status, 'approved', 'AGENT-006 the single setup approval applies signed terms atomically')
  for (const amendment of plan.amendments) assert.equal(subscription.amendments.find(row => row.id === amendment.id)?.status, 'approved', 'AGENT-006 the launch credit needs no second contract-exception approval')
  const published = await api('catalog')
  for (const price of plan.prices) assert.ok(published.prices.some(row => row.id === price.id && Number(row.unit_amount) === Number(price.amount)))
  assert.deepEqual(published.priceRequests, before[1].priceRequests, 'AGENT-006 setup does not leave hidden pending catalogue approvals')
  const custody = await api(`proposals/${prepared.id}`)
  assert.equal(custody.created_by, (await api('me')).email)
  assert.equal(custody.decided_by, 'agent006-finance@example.test')
  assert.equal(custody.result.subscription, approved.subscription)
  assert.equal(custody.payload.source.text, originalText)

  // All 36 periods are historical: ordinary billing can issue them without a clock override.
  const invoices = []
  for (const [i, preview] of prepared.impact.periods.entries()) {
    const run = await api('billrun.prepare', { period: preview.period.start.slice(0, 7) })
    const draft = (await api(`runs/${run.id}`)).invoices.find(row => row.customer_id === plan.customer.id)
    assert.ok(draft, `AGENT-006 ordinary billing prepares ${preview.period.start}`)
    const unapproved = await api(`invoices/${draft.id}`)
    assert.equal(unapproved.status, 'draft', 'AGENT-006 setup approval never approves invoices')
    if (i === 0) await api('invoice.finalise', { invoice: draft.id, issue_date: preview.period.end }, 409)
    await api('invoice.approve', { invoice: draft.id, acknowledge: true })
    await api('invoice.finalise', { invoice: draft.id, issue_date: preview.period.end })
    const issued = await api(`invoices/${draft.id}`)
    assert.equal(issued.status, 'issued')
    assert.deepEqual([issued.subtotal_cents, issued.tax_cents, issued.total_cents], [monthlyCents[i], 0, monthlyCents[i]], `AGENT-006 issued ${preview.period.start} matches hand calculation`)
    assert.deepEqual(issued.lines.map(line => [line.kind, line.price_id, line.quantity, line.unit_amount, line.amount_cents, line.period_start, line.period_end, !!line.taxable]), previewLines(preview.calculation), 'AGENT-006 ordinary issued lines match the saved full-term preview')
    invoices.push(issued)
  }
  assert.equal(sum(invoices.map(row => row.total_cents)), 445000)
  assert.deepEqual([0, 1, 2].map(year => sum(invoices.slice(year * 12, year * 12 + 12).map(row => row.total_cents))), [145000, 150000, 150000])
  assert.deepEqual((await api(`invoices/${invoices[0].id}`)).calculation, invoices[0].calculation, 'AGENT-006 later anniversaries and true-ups preserve the first issued calculation')

  // An executed amendment reuses identities and changes only its named item.
  const spareProduct = (await api('product.create', { code: 'agent006-support', name: 'Cedar Support' })).id
  const sparePrice = (await api('price.create', { product: spareProduct, kind: 'flat', unit_amount: '25', taxable: false })).id
  const existing = (await api('subscription.create', { customer: plan.customer.id, start_date: '2023-01-01', price: [plan.prices[0].id, sparePrice] })).id
  const existingBefore = await api(`subscriptions/${existing}`)
  const target = existingBefore.items.find(row => row.price_id === plan.prices[0].id)
  const untouched = existingBefore.items.find(row => row.price_id === sparePrice)
  const amendmentQuote = 'From 2023-02-01 change only Cedar Platform to USD 110.00 monthly; Cedar Support remains USD 25.00 monthly and all previously issued invoices remain unchanged. The amended service renews monthly until canceled, with no fixed end date.'
  const amendment = {
    setup: true,
    source: { name: 'executed-amendment.txt', text: `${originalText}\nEXECUTED AMENDMENT\n${amendmentQuote}\nSigned by Pat Buyer and Robin Seller on 2023-01-20.\n`, execution_reference: 'buyer-recorded amendment signature ref' },
    customer: { id: plan.customer.id, quote: original.customer.quote },
    catalog: [{ key: 'amended', existing: plan.prices[1].id, quote: amendmentQuote }],
    subscription: { id: existing, effective_date: '2023-02-01', months: 36, quote: amendmentQuote },
    ramps: [{ item: target.id, effective_date: '2023-02-01', price: 'amended', quantity: 1, quote: amendmentQuote }],
    ambiguities: [],
  }
  const amended = await propose(owner, amendment), staleAmendment = await propose(agent, amendment)
  assert.deepEqual(amended.impact.periods.map(row => row.calculation.totalCents), Array(36).fill(13500))
  assert.equal(amended.impact.totals.totalCents, 486000)
  assert.ok(amended.impact.assumptions.some(row => row.label.includes('auto-renewal periods beyond 36 months not previewed')), 'AGENT-006 an existing evergreen amendment explains the preview horizon')
  assert.deepEqual(await api(`subscriptions/${existing}`), existingBefore, 'AGENT-006 amendment preparation leaves the complete current timeline untouched')
  const catalogBeforeAmendment = await api('catalog')
  await decide(finance, amended.id)
  await decide(finance, staleAmendment.id, 'approved', 409)
  await decide(finance, staleAmendment.id, 'rejected')
  const existingAfter = await api(`subscriptions/${existing}`)
  assert.deepEqual(existingAfter.items.find(row => row.id === untouched.id), untouched, 'AGENT-006 an amendment cannot silently alter an unrelated item')
  assert.deepEqual(existingAfter.items.filter(row => row.id !== untouched.id).map(row => [row.price_id, row.effective_from, row.effective_to]), [[plan.prices[0].id, '2023-01-01', '2023-02-01'], [plan.prices[1].id, '2023-02-01', null]])
  assert.deepEqual(await api('catalog'), catalogBeforeAmendment, 'AGENT-006 existing immutable prices are reused without creating catalogue revisions')
  assert.deepEqual((await api(`invoices/${invoices[0].id}`)).calculation, invoices[0].calculation, 'AGENT-006 an amendment cannot rewrite the issued order history')

  const beforeTermPreviews = await snapshot()
  const finite = await propose(agent, constantOrder('FINITE48'))
  assert.equal(finite.impact.periods.length, 48, 'AGENT-006 a finite executed term is previewed in full beyond 36 months')
  assert.equal(finite.impact.periods.at(-1).period.start, '2023-12-01')
  assert.equal(finite.impact.periods.at(-1).period.end, '2024-01-01')
  assert.deepEqual(finite.impact.periods.map(row => row.calculation.totalCents), Array(48).fill(10000))
  assert.equal(finite.impact.totals.totalCents, 480000)
  assert.deepEqual(finite.impact.annualTotals.map(row => row.totalCents), Array(4).fill(120000))
  assert.deepEqual(finite.impact.unresolvedAmbiguities, [])
  assert.equal((await api(`proposals/${finite.id}`)).payload.plan.subscription.endDate, '2024-01-01')
  await decide(finance, finite.id, 'rejected')
  const evergreen = await propose(agent, constantOrder('EVERGREEN', true))
  assert.deepEqual(evergreen.impact.periods.map(row => row.calculation.totalCents), Array(36).fill(10000))
  assert.equal(evergreen.impact.totals.totalCents, 360000)
  assert.ok(evergreen.impact.assumptions.some(row => row.label.includes('auto-renewal periods beyond 36 months not previewed')), 'AGENT-006 a new evergreen order explains that later renewals are outside the preview')
  assert.deepEqual(evergreen.impact.unresolvedAmbiguities, [])
  const evergreenPlan = (await api(`proposals/${evergreen.id}`)).payload.plan
  assert.equal(evergreenPlan.subscription.endDate, null)
  assert.equal(evergreenPlan.items[0].to, null, 'AGENT-006 an evergreen preview cannot silently impose an end date on the service')
  await decide(finance, evergreen.id, 'rejected')
  assert.deepEqual(await snapshot(), beforeTermPreviews, 'AGENT-006 finite and evergreen previews and rejection leave all billing records unchanged')

  const renewalInput = renewalOrder('RENEWAL5')
  const renewalBefore = await snapshot()
  const unquotedRenewal = structuredClone(renewalInput)
  unquotedRenewal.subscription.renewal.quote = 'Invented renewal settings.'
  await propose(agent, unquotedRenewal, 400)
  const badNotice = structuredClone(renewalInput)
  badNotice.subscription.renewal.notice_days = 14
  await propose(agent, badNotice, 400)
  const missingRenewal = structuredClone(renewalInput)
  delete missingRenewal.subscription.renewal
  const unsupportedRenewal = await propose(agent, missingRenewal)
  assert.ok(unsupportedRenewal.impact.unresolvedAmbiguities.length, 'SUB-004/AGENT-006 quoted annual auto-renewal still needs explicit executable settings')
  await decide(finance, unsupportedRenewal.id, 'rejected')
  const renewal = await propose(agent, renewalInput)
  assert.deepEqual(renewal.impact.unresolvedAmbiguities, [], 'SUB-004/AGENT-006 valid quoted annual renewal terms are supported')
  assert.deepEqual(renewal.impact.periods.map(row => row.calculation.totalCents), [...Array(12).fill(10000), ...Array(12).fill(10500), ...Array(12).fill(11025)], 'SUB-004/AGENT-006 monthly arrears preview compounds the quoted 5 percent only at annual term boundaries')
  assert.equal(renewal.impact.totals.totalCents, 378300)
  assert.deepEqual(renewal.impact.annualTotals.map(row => row.totalCents), [120000, 126000, 132300])
  assert.equal(renewal.impact.previewHorizon.finite, false)
  const renewalSaved = await api(`proposals/${renewal.id}`), renewalPlan = renewalSaved.payload.plan
  assert.equal(renewalPlan.subscription.endDate, '2031-01-01', 'SUB-004/AGENT-006 evergreen auto-renewal stores the finite initial term end')
  assert.equal(renewalPlan.items[0].to, null, 'SUB-004/AGENT-006 service items continue across automatic renewals')
  assert.deepEqual(renewal.impact.periods[12].inputs.renewals.map(row => [row.effectiveDate, row.upliftPercent]), [['2031-01-01', '5.00'], ['2032-01-01', '5.00']])
  assert.ok(renewal.impact.assumptions.some(row => row.kind === 'renewal' && row.recorded === false), 'SUB-004/AGENT-006 future renewals remain labelled hypothetical')
  assert.deepEqual(await snapshot(), renewalBefore, 'SUB-004/AGENT-006 preparing renewal setup writes no billing records')
  const renewalApproval = await decide(finance, renewal.id)
  const installedRenewal = await api(`subscriptions/${renewalApproval.subscription}`)
  const installedTerm = installedRenewal.renewal.terms.find(row => row.id === renewalPlan.renewal.id)
  assert.ok(installedTerm, 'SUB-004/AGENT-006 the same setup approval atomically installs the renewal term')
  assert.deepEqual([installedTerm.start_date, installedTerm.end_date, installedTerm.months, installedTerm.auto_renew, installedTerm.notice_days, installedTerm.uplift_percent, installedTerm.status], ['2030-01-01', '2031-01-01', 12, 1, 30, '5.00', 'active'])
  assert.deepEqual([installedTerm.prepared_by_id, installedTerm.prepared_by, installedTerm.decided_by, installedTerm.approval_mode, installedTerm.quote], [renewalSaved.prepared_by_id, renewalSaved.created_by, 'agent006-finance@example.test', 'two-person', renewalInput.subscription.renewal.quote], 'SUB-004/AGENT-006 renewal retains original preparer, separate approver and source quote')
  assert.equal(installedRenewal.end_date, renewalPlan.subscription.endDate)
  assert.deepEqual(installedRenewal.renewal.events, [], 'SUB-004/AGENT-006 setup approval never records hypothetical future renewal events')
  const installedUpcoming = await api(`subscriptions/${renewalApproval.subscription}/upcoming?period=2030-01`)
  assert.deepEqual(installedUpcoming.calculation.lines.map(line => [line.kind, line.priceId, line.unitAmount, line.amountCents]), renewal.impact.periods[0].calculation.lines.map(line => [line.kind, line.priceId, line.unitAmount, line.amountCents]), 'SUB-004/AGENT-006 installed ordinary monthly billing matches the reviewed initial-term preview')
  for (const [suffix, autoRenew] of [['FINITEAUTO', true], ['FINITENONRENEW', false]]) {
    const finiteRenewal = await propose(agent, renewalOrder(suffix, autoRenew, false))
    assert.deepEqual(finiteRenewal.impact.unresolvedAmbiguities, [])
    assert.equal(finiteRenewal.impact.periods.length, autoRenew ? 36 : 12, 'SUB-004/AGENT-006 a finite initial term previews successive automatic terms, or stops at its own end when renewal is off')
    await decide(finance, finiteRenewal.id, 'rejected')
  }
  const advanceRenewal = renewalOrder('ADVANCERENEW')
  advanceRenewal.source.text += 'Billing must be annual billing in advance.\n'
  const advance = await propose(agent, advanceRenewal)
  assert.ok(advance.impact.unresolvedAmbiguities.length, 'SUB-004/AGENT-006 renewal support preserves genuine nonmonthly and advance billing blockers')
  await decide(finance, advance.id, 'approved', 409)
  await decide(finance, advance.id, 'rejected')

  const ambiguous = executedOrder('AMBIGUOUS')
  ambiguous.ambiguities = [{ issue: 'The buyer needs to confirm the intended service account.' }]
  const unresolved = await propose(agent, ambiguous), unresolvedBefore = await api(`proposals/${unresolved.id}`)
  assert.ok(unresolved.impact.unresolvedAmbiguities.length)
  const ambiguitySnapshot = await snapshot()
  await decide(finance, unresolved.id, 'approved', 409)
  const agentResolution = { ...ambiguous, ambiguities: [{ ...ambiguous.ambiguities[0], resolution: 'Buyer confirmed this exact service account.' }], revises: unresolved.id }
  await propose(agent, agentResolution, 403)
  await propose(owner, { ...agentResolution, source: { ...agentResolution.source, text: agentResolution.source.text + 'Altered source.\n' } }, 409)
  assert.deepEqual(await snapshot(), ambiguitySnapshot)
  const resolutionPage=await h.submit('setup.resolve',owner,{proposal:unresolved.id,resolution:agentResolution.ambiguities[0].resolution},'/app/proposals/{id}')
  assert.notEqual(resolutionPage.pathname, `/app/proposals/${unresolved.id}`, 'AGENT-006 the public resolution form prepares a new reviewable proposal')
  const resolved=await api(`proposals/${resolutionPage.pathname.split('/').at(-1)}`)
  assert.deepEqual(resolved.impact.unresolvedAmbiguities, [])
  await decide(owner, resolved.id, 'approved', 409)
  await decide(finance, resolved.id)
  const unresolvedAfter = await api(`proposals/${unresolved.id}`)
  for (const field of ['payload', 'evidence', 'impact', 'created_by', 'created_at', 'status']) assert.deepEqual(unresolvedAfter[field], unresolvedBefore[field], 'AGENT-006 human resolution appends a new proposal without rewriting the original evidence')
  assert.equal((await api(`proposals/${resolved.id}`)).payload.source.sha256, unresolvedBefore.payload.source.sha256)
  await decide(finance, unresolved.id, 'rejected')

  for (const extra of ['Purchase order PO number BUYER-42 must appear on each invoice.', 'Payment is Net 60.']) {
    const unsupported = executedOrder('UNSUPPORTED')
    unsupported.source.text += extra + '\n'
    const proposal = await propose(agent, unsupported)
    assert.ok(proposal.impact.unresolvedAmbiguities.length, 'AGENT-006 unsupported buyer requirements cannot disappear from the review')
    const unchanged = await snapshot()
    await decide(finance, proposal.id, 'approved', 409)
    assert.deepEqual(await snapshot(), unchanged)
    const attemptedResolution = await propose(owner, { ...unsupported, revises: proposal.id, ambiguities: proposal.impact.unresolvedAmbiguities.map(row => ({ issue: row.issue, resolution: 'Buyer reviewed this requirement.' })) })
    assert.ok(attemptedResolution.impact.unresolvedAmbiguities.length, 'AGENT-006 human free text cannot make an unsupported billing requirement executable')
    await decide(finance, attemptedResolution.id, 'approved', 409)
    assert.deepEqual(await snapshot(), unchanged)
    await decide(finance, attemptedResolution.id, 'rejected')
    await decide(finance, proposal.id, 'rejected')
  }
  // Other existing setup capabilities use the same approval and ordinary bill door.
  const meter=(await api('meter.create',{code:'agent006-exception-calls',name:'Cedar calls',unit_label:'calls'})).id
  const quote='Cedar Exceptions customer AGENT006-EXCEPTIONS, billing ap@cedar.example. Service 2017-01-01 through 2017-02-01, monthly in arrears on day 1, Net 30. Platform USD 100 monthly overridden to USD 80; calls USD 2 each with 5 included calls; discount the recurring platform charge 10 percent, then a USD 5 launch credit. Non-taxable. Executed by Pat Buyer and Robin Seller.'
  const exceptionSetup={setup:true,source:{name:'executed-exceptions.txt',text:quote,execution_reference:'buyer-recorded exceptions signature'},customer:{external_id:'AGENT006-EXCEPTIONS',name:'Cedar Exceptions',billing_email:'ap@cedar.example',quote},catalog:[{key:'platform',new_product:{code:'agent006-ex-platform',name:'Cedar Platform'},kind:'flat',unit_amount:'100',taxable:false,quote},{key:'calls',new_product:{code:'agent006-ex-calls',name:'Cedar Calls'},kind:'unit',meter,unit_amount:'2',taxable:false,quote}],subscription:{start_date:'2017-01-01',end_date:'2017-02-01',anchor_day:1,quote},items:[{key:'platform',price:'platform',quote},{key:'calls',price:'calls',quote}],included:[{price:'calls',quantity:'5',from:'2017-01-01',to:'2017-02-01',quote}],exceptions:[{kind:'price_override',price:'platform',value:'80',from:'2017-01-01',to:'2017-02-01',quote},{kind:'discount_percent',value:'10',from:'2017-01-01',to:'2017-02-01',quote},{kind:'fixed_credit',value:'5',from:'2017-01-01',quote}],usage_scenario_label:'Buyer supplied fifteen calls, additional hypothetical usage',usage_assumptions:[{period:'2017-01',meter,quantity:'15',quote}],ambiguities:[]}
  const exceptionProposal=await propose(agent,exceptionSetup)
  assert.deepEqual(exceptionProposal.impact.unresolvedAmbiguities,[])
  assert.equal(exceptionProposal.impact.periods[0].calculation.totalCents,8700,'AGENT-006 override80 less10percent, plus (15-5)*2, less credit5 = USD87')
  assert.ok(exceptionProposal.impact.assumptions.some(a=>a.kind==='scenario'&&a.ingested===false),'AGENT-006 hypothetical usage is labelled and never ingested')
  const exceptionApproval=await decide(finance,exceptionProposal.id)
  const beforeUsage=await api(`subscriptions/${exceptionApproval.subscription}/upcoming?period=2017-01`)
  assert.equal(beforeUsage.calculation.totalCents,6700,'AGENT-006 approving a scenario does not create actual usage')
  await api('usage.submit',{events:[{event_id:'agent006-exception-15',customer:'AGENT006-EXCEPTIONS',meter:'agent006-exception-calls',quantity:'15',occurred_at:'2017-01-15T12:00:00Z'}]})
  const exceptionRun=await api('billrun.prepare',{period:'2017-01'}),exceptionInvoice=(await api(`runs/${exceptionRun.id}`)).invoices.find(i=>i.customer_id===exceptionApproval.customer)
  await api('invoice.approve',{invoice:exceptionInvoice.id,acknowledge:true});await api('invoice.finalise',{invoice:exceptionInvoice.id,issue_date:'2017-02-01'})
  const exceptionIssued=await api(`invoices/${exceptionInvoice.id}`)
  assert.equal(exceptionIssued.total_cents,8700,'AGENT-006 actual usage, included allowance, discount, override and credit bill exactly as previewed with no manual setup')
  console.log('AGENT-006 executed-order setup: exact source custody, independent 36-month preview and ordinary issued bills, atomic separate approval, rejection/staleness and append-only human resolution passed')
  return { proposal: prepared.id, subscription: approved.subscription, customer: plan.customer.id, invoices: invoices.map(row => row.id) }
}

const anchoredMonth = (anchor, offset) => {
  const [year, month, day] = anchor.split('-').map(Number)
  const first = new Date(Date.UTC(year, month - 1 + offset, 1))
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  return `${first.toISOString().slice(0, 8)}${String(Math.min(day, last)).padStart(2, '0')}`
}

function intervalOrder(number, { unit = 'month', count = 12, timing = 'advance', months = 24, mixed = false, meter } = {}) {
  const id = `synthetic-nectar-${number}`, start = '2018-01-31', end = anchoredMonth(start, months)
  const customer = `Customer ${id}, Synthetic Cedar, billing ap@cedar.example.`
  const term = `Service starts ${start}, with a fixed ${months}-month term ending ${end}, anchored to ${start}; all additions co-term at that end.`
  const fee = `Platform costs USD ${mixed ? '12000' : '100'} every ${count} ${unit}${count === 1 ? '' : 's'}, billed in ${timing}, non-taxable, Net 30.`
  const usage = 'Calls cost USD 2 each, billed monthly in arrears, non-taxable. Ten calls per monthly period are a buyer-supplied hypothetical scenario, never actual usage.'
  const addon = `Add-on costs USD 1200 every 12 months, billed in advance from 2019-07-31 and co-termed to ${end}, non-taxable.`
  const text = [customer, term, fee, ...(mixed ? [usage, addon] : []), 'Executed by Synthetic Buyer and Synthetic Seller.'].join('\n')
  return {
    setup: true, source: { name: 'synthetic-executed-order.txt', text, execution_reference: `${id} execution record` },
    customer: { external_id: id, name: 'Synthetic Cedar', billing_email: 'ap@cedar.example', quote: customer },
    catalog: [
      { key: 'platform', new_product: { code: id, name: 'Synthetic Platform' }, kind: 'flat', unit_amount: mixed ? '12000' : '100', interval_unit: unit, interval_count: count, billing_timing: timing, taxable: false, quote: fee },
      ...(mixed ? [
        { key: 'calls', new_product: { code: `${id}-calls`, name: 'Synthetic Calls' }, kind: 'unit', unit_amount: '2', meter, interval_unit: 'month', interval_count: 1, billing_timing: 'arrears', taxable: false, quote: usage },
        { key: 'addon', new_product: { code: `${id}-addon`, name: 'Synthetic Add-on' }, kind: 'flat', unit_amount: '1200', interval_unit: 'month', interval_count: 12, billing_timing: 'advance', taxable: false, quote: addon },
      ] : []),
    ],
    subscription: { external_id: `${id}-service`, start_date: start, billing_anchor_date: start, anchor_day: 31, term_months: months, quote: term },
    items: [{ key: 'platform', price: 'platform', quote: fee }, ...(mixed ? [{ key: 'calls', price: 'calls', quote: usage }, { key: 'addon', price: 'addon', from: '2019-07-31', quote: addon }] : [])],
    ...(mixed ? { usage_scenario_label: 'Buyer supplied ten hypothetical calls per month', usage_assumptions: Array.from({ length: months }, (_, i) => ({ period: anchoredMonth(start, i), meter, quantity: '10', quote: usage })) } : {}),
    ambiguities: [],
  }
}

/** CAT-001 inherits executed-source custody, one governed approval, and ordinary billing. */
export async function contractIntervalSetup(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  await api('access.give', { email: 'synthetic-nectar-80@example.test', name: 'Synthetic Finance', role: 'finance' })
  const finance = await h.signIn('synthetic-nectar-80@example.test', { requested: true })
  const propose = payload => api('proposal.create', { kind: 'amendment', title: 'Synthetic executed interval order', payload })
  const decide = (id, decision = 'approved', who = finance, status = 200) => h.api('proposal.decide', who, { proposal: id, decision }, status)
  const snapshot = () => Promise.all([api('customers'), api('catalog'), api('runs')])
  const initial = await snapshot()
  for (const [number, options, expected] of [
    [83, { unit: 'week', count: 1, timing: 'arrears', months: 12 }, 53],
    [84, { count: 3, months: 36 }, 12],
    [85, { count: 6, months: 24 }, 4],
    [86, { count: 5, months: 12 }, 3],
    [87, { count: 1, timing: 'arrears', months: 1 }, 1],
  ]) {
    const payload = intervalOrder(number, options), proposal = await propose(payload)
    assert.deepEqual(proposal.impact.unresolvedAmbiguities, [])
    assert.equal(proposal.impact.periods.length, expected, 'CAT-001 finite terms include every actual invoice period, including weekly terms beyond 36 periods')
    assert.equal(proposal.impact.previewHorizon.through, anchoredMonth('2018-01-31', options.months))
    const spans = proposal.impact.periods.map(row => [row.period.start, row.period.end])
    assert.equal(spans[0][0], '2018-01-31')
    assert.equal(spans.at(-1)[1], anchoredMonth('2018-01-31', options.months))
    if (number === 87) assert.deepEqual(spans, [['2018-01-31', '2018-02-28']], 'CAT-001 full anchors clamp February without losing day 31')
    await decide(proposal.id, 'rejected')
  }
  assert.deepEqual(await snapshot(), initial, 'CAT-001 rejected full-term previews write no billing records')

  const meter = (await api('meter.create', { code: 'synthetic-nectar-82', name: 'Synthetic Calls', unit_label: 'calls' })).id
  const payload = intervalOrder(81, { mixed: true, meter }), before = await snapshot()
  const prepared = await propose(payload), saved = await api(`proposals/${prepared.id}`), plan = saved.payload.plan
  assert.deepEqual(prepared.impact.unresolvedAmbiguities, [])
  assert.equal(prepared.impact.periods.length, 25, 'CAT-001 services due together compose one invoice per due date')
  assert.deepEqual(await snapshot(), before, 'CAT-001 preparation retains only the proposal, never live setup records')
  assert.equal(plan.subscription.contractTermMonths, 24)
  assert.equal(plan.subscription.contractEndDate, '2020-01-31')
  assert.deepEqual(plan.prices.map(price => price.billing), [{ unit: 'month', count: 12, timing: 'advance' }, { unit: 'month', count: 1, timing: 'arrears' }, { unit: 'month', count: 12, timing: 'advance' }])
  const platform = prepared.impact.periods.filter(row => row.calculation.lines.some(line => line.priceId === plan.prices[0].id))
  const platformLines = platform.flatMap(row => row.calculation.lines.filter(line => line.priceId === plan.prices[0].id).map(line => [row.assumedIssueDate, line.periodStart, line.periodEnd, line.amountCents]))
  assert.deepEqual(platformLines, [['2018-01-31', '2018-01-31', '2019-01-31', 1200000], ['2019-01-31', '2019-01-31', '2020-01-31', 1200000]])
  const usage = prepared.impact.periods.filter(row => row.calculation.lines.some(line => line.priceId === plan.prices[1].id))
  assert.equal(usage.length, 24)
  assert.deepEqual(usage.flatMap(row => row.calculation.lines.filter(line => line.priceId === plan.prices[1].id).map(line => line.amountCents)), Array(24).fill(2000))
  const addon = prepared.impact.periods.find(row => row.calculation.lines.some(line => line.priceId === plan.prices[2].id))
  const addonLines = addon.calculation.lines.filter(line => line.priceId === plan.prices[2].id)
  assert.equal(addonLines.length, 1)
  assert.deepEqual([addon.assumedIssueDate, addonLines[0].periodStart, addonLines[0].periodEnd, addonLines[0].amountCents], ['2019-07-31', '2019-07-31', '2020-01-31', 60493], 'CAT-001 co-termed annual add-on earns 184 of 365 days, rounded once')
  assert.equal(prepared.impact.totals.totalCents, 2508493)
  assert.deepEqual(prepared.impact.annualTotals.map(row => row.totalCents), [1222000, 1284493, 2000], 'CAT-001 whole-invoice annual totals follow actual due dates, including the final arrears invoice')
  await decide(prepared.id, 'approved', owner, 409)
  assert.deepEqual(await snapshot(), before, 'CAT-001 self-approval cannot partially apply interval setup')
  const approved = await decide(prepared.id)
  await decide(prepared.id, 'approved', finance, 409)
  const installed = await api(`subscriptions/${approved.subscription}`)
  assert.equal(installed.billing_anchor_date, '2018-01-31')
  assert.equal(installed.contract_end_date, '2020-01-31')
  assert.equal(installed.items.find(item => item.price_id === plan.prices[2].id).effective_to, '2020-01-31')
  await api('usage.submit', { events: Array.from({ length: 24 }, (_, i) => ({ event_id: `synthetic-nectar-81-calls-${i}`, customer: 'synthetic-nectar-81', meter: 'synthetic-nectar-82', quantity: '10', occurred_at: `${anchoredMonth('2018-01-31', i)}T12:00:00Z` })) })
  const byMonth = Map.groupBy(prepared.impact.periods, row => row.assumedIssueDate.slice(0, 7))
  const invoices = []
  for (const [month, previews] of byMonth) {
    const firstRun = await api('billrun.prepare', { period: month })
    const first = (await api(`runs/${firstRun.id}`)).invoices.filter(row => row.customer_id === approved.customer)
    const rerun = await api('billrun.prepare', { period: month })
    const drafts = (await api(`runs/${rerun.id}`)).invoices.filter(row => row.customer_id === approved.customer)
    assert.deepEqual(drafts.map(row => row.total_cents).sort((a, b) => a - b), first.map(row => row.total_cents).sort((a, b) => a - b), 'CAT-001 re-preparation never duplicates or changes interval amounts')
    assert.equal(drafts.length, previews.length)
    for (const draft of drafts) {
      const detail = await api(`invoices/${draft.id}`)
      const preview = previews.find(row => row.billing.key === detail.calculation.inputs.billing.key)
      assert.ok(preview, 'CAT-001 ordinary due-date billing selects the exact saved preview window')
      assert.equal(detail.status, 'draft', 'CAT-001 setup approval leaves ordinary invoice approval separate')
      assert.deepEqual(detail.lines.map(line => [line.kind, line.price_id, line.quantity, line.unit_amount, line.amount_cents, line.period_start, line.period_end, !!line.taxable]), previewLines(preview.calculation))
      await api('invoice.approve', { invoice: draft.id, acknowledge: true })
      await api('invoice.finalise', { invoice: draft.id, issue_date: preview.assumedIssueDate })
      const issued = await api(`invoices/${draft.id}`)
      assert.equal(issued.total_cents, preview.calculation.totalCents)
      invoices.push(issued)
    }
  }
  assert.equal(invoices.length, 25)
  assert.equal(invoices.flatMap(invoice => invoice.lines).filter(line => line.price_id === plan.prices[0].id).length, 2)
  assert.equal(invoices.flatMap(invoice => invoice.lines).filter(line => line.price_id === plan.prices[1].id).length, 24)
  assert.equal(invoices.flatMap(invoice => invoice.lines).filter(line => line.price_id === plan.prices[2].id).length, 1)
  assert.equal(sum(invoices.map(row => row.total_cents)), prepared.impact.totals.totalCents)
  for (const invoice of invoices) assert.deepEqual((await api(`invoices/${invoice.id}`)).calculation, invoice.calculation, 'CAT-001 later intervals preserve all previously issued evidence')
  console.log('CAT-001/AGENT-006 quoted intervals, complete finite terms, day-31 anchors, mixed advance/arrears, co-termination and ordinary issued invoice parity passed')
}

// SET-001 inheritance: this proves quoted routing intent and ordinary invoice
// custody. It makes no claim of processor execution or accounting delivery.
export async function contractEntitySetup(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  await api('access.give', { email: 'synthetic-nectar-entity-finance@example.test', name: 'Synthetic Entity Finance', role: 'finance' })
  const finance = await h.signIn('synthetic-nectar-entity-finance@example.test', { requested: true })
  const agent = { bearer: (await api('credential.issue', { name: 'Synthetic entity setup preparer', scopes: ['prepare'] })).key }
  const mutate = async (path, body, status) => api(path, { revision: (await api('business')).revision, ...body }, status)
  const identity = (number, days) => ({ legal_name: `Synthetic entity ${number}`, address: `${number} Synthetic Way, US`, ein: `${number}-7654321`, invoice_prefix: `SE${number}`, invoice_number_width: 4,
    payment_terms_days: days, processor_account_ref: `synthetic-nectar-${number}-processor`, ledger_company_ref: `synthetic-nectar-${number}-ledger`, tax_registration: `synthetic-nectar-${number}-tax` })
  const a = identity(21, 45), b = identity(22, 60)
  const entityA = (await mutate('entity.create', a)).id, entityB = (await mutate('entity.create', b)).id
  const entityRows = await api('billing-entities')
  const order = (number, entity, id, existingCustomer) => {
    const buyer = `Customer synthetic-nectar-${number}, Synthetic order customer ${number}, billing synthetic-nectar-${number}@example.test.`
    const service = `Service runs from 2016-01-01 until 2016-03-01, billed monthly in arrears on day 1, Net ${entity.payment_terms_days}.`
    const fee = 'The platform fee is USD 100 per month, non-taxable.'
    const routing = `Bill-to entity ${entity.legal_name}; processor account ${entity.processor_account_ref}; ledger company ${entity.ledger_company_ref}.`
    return { setup: true, source: { name: 'synthetic-entity-order.txt', text: [buyer, service, fee, routing, 'Executed by Synthetic Buyer and Synthetic Seller.'].join('\n'), execution_reference: `synthetic-nectar-${number} execution` },
      customer: existingCustomer ? { id: existingCustomer, quote: buyer } : { external_id: `synthetic-nectar-${number}`, name: `Synthetic order customer ${number}`, billing_email: `synthetic-nectar-${number}@example.test`, quote: buyer },
      entity: { id, processor_account_ref: entity.processor_account_ref, ledger_company_ref: entity.ledger_company_ref, quote: routing },
      catalog: [{ key: 'platform', new_product: { code: `synthetic-nectar-${number}`, name: 'Synthetic Entity Platform' }, kind: 'flat', unit_amount: '100', taxable: false, quote: fee }],
      subscription: { start_date: '2016-01-01', end_date: '2016-03-01', quote: service }, items: [{ key: 'platform', price: 'platform', quote: fee }], ambiguities: [] }
  }
  const propose = (payload, status = 200) => h.api('proposal.create', agent, { kind: 'amendment', title: 'Executed entity order', payload }, status)
  const decide = (proposal, who = owner, decision = 'approved', status = 200) => h.api('proposal.decide', who, { proposal, decision }, status)
  const snapshot = () => Promise.all([api('customers'), api('catalog'), api('runs'), api('billing-entities')])
  const initial = await snapshot()
  const invalid = order(211, a, entityA)
  invalid.entity.quote = 'An entity route that is absent from the executed source.'
  await propose(invalid, 400)
  const invented = order(212, a, entityA)
  invented.entity.processor_account_ref = 'synthetic-nectar-unknown-processor'
  await propose(invented, 409)
  assert.deepEqual(await snapshot(), initial, 'SET-001 unquoted or mismatched routes create no billing records')
  const incomplete = order(213, a, entityA)
  delete incomplete.entity
  const unresolved = await propose(incomplete)
  assert.ok(unresolved.impact.unresolvedAmbiguities.length)
  await decide(unresolved.id, owner, 'approved', 409)
  await decide(unresolved.id, owner, 'rejected')
  assert.deepEqual(await snapshot(), initial)
  const rejected = await propose(order(214, a, entityA))
  await decide(rejected.id, owner, 'rejected')
  assert.deepEqual(await snapshot(), initial, 'SET-001 rejected entity setup leaves customer assignments and sequence counters unchanged')

  const installed = []
  for (const [number, entity, id] of [[215, a, entityA], [216, b, entityB]]) {
    const input = order(number, entity, id), prepared = await propose(input), saved = await api(`proposals/${prepared.id}`)
    assert.deepEqual(prepared.impact.unresolvedAmbiguities, [])
    assert.equal(prepared.impact.periods.length, 2)
    assert.deepEqual(prepared.impact.periods.map(period => period.calculation.totalCents), [10000, 10000])
    assert.equal(saved.basis.sourceSha256, saved.payload.source.sha256)
    const quoted = saved.payload.plan.billingEntity
    assert.equal(quoted.revision, entityRows.entities.find(row => row.id === id).revision)
    assert.deepEqual(prepared.impact.billingEntity, quoted)
    for (const period of prepared.impact.periods) {
      assert.deepEqual(period.inputs.invoiceContent.billingEntity, quoted)
      assert.equal(period.inputs.invoiceContent.paymentTermsDays, entity.payment_terms_days)
    }
    const page = await h.raw(`/app/proposals/${prepared.id}`, { cookie: owner })
    assert.equal(page.status, 200)
    const markup = await page.text()
    assert.ok(markup.includes(entity.processor_account_ref) && markup.includes(entity.ledger_company_ref))
    assert.match(markup, /Owner-recorded routing intent/)
    const before = await snapshot()
    await decide(prepared.id, finance, 'approved', 403)
    assert.deepEqual(await snapshot(), before, 'SET-001 finance approval cannot bypass owner entity-assignment authority')
    const approved = await decide(prepared.id)
    assert.equal(approved.billingEntity.id, id)
    assert.equal((await api(`customers/${approved.customer}`)).billing_entity_id, id)
    await decide(prepared.id, owner, 'approved', 409)
    installed.push({ approved, prepared, saved, input, entity })
  }
  for (const month of ['2016-01', '2016-02']) {
    const run = await api('billrun.prepare', { period: month })
    const drafts = (await api(`runs/${run.id}`)).invoices
    for (const value of installed) {
      const draft = drafts.find(invoice => invoice.customer_id === value.approved.customer), preview = value.prepared.impact.periods.find(period => period.period.start.startsWith(month))
      assert.ok(draft)
      await api('invoice.approve', { invoice: draft.id, acknowledge: true })
      await api('invoice.finalise', { invoice: draft.id, issue_date: preview.assumedIssueDate })
      const issued = await api(`invoices/${draft.id}`)
      assert.equal(issued.total_cents, preview.calculation.totalCents)
      assert.equal(issued.billing_entity_id, value.approved.billingEntity.id)
      assert.deepEqual(JSON.parse(issued.billing_route_json), value.approved.billingEntity.route, 'SET-001 ordinary issue retains the exact quoted processor/ledger intent')
      assert.deepEqual(issued.calculation.inputs.invoiceContent, preview.inputs.invoiceContent, 'SET-001 normal invoice terms and entity snapshot equal the full-term preview')
      assert.equal(issued.number, `${value.entity.invoice_prefix}-${month === '2016-01' ? '0001' : '0002'}`)
      const due = new Date(`${preview.assumedIssueDate}T00:00:00Z`); due.setUTCDate(due.getUTCDate() + value.entity.payment_terms_days)
      assert.equal(issued.due_date, due.toISOString().slice(0, 10))
      ;(value.issued ??= []).push(issued)
    }
  }

  const existing = (await api('customer.create', { external_id: 'synthetic-nectar-217', name: 'Synthetic reassigned customer', billing_email: 'synthetic-nectar-217@example.test' })).id
  await mutate('customer.entity', { customer: existing, entity: entityA, confirm: true })
  const reassignment = await propose(order(217, b, entityB, existing))
  assert.equal((await api(`customers/${existing}`)).billing_entity_id, entityA, 'SET-001 preparing a new assignment changes no existing customer')
  await decide(reassignment.id)
  assert.equal((await api(`customers/${existing}`)).billing_entity_id, entityB, 'SET-001 the same setup approval applies an eligible existing-customer assignment')
  await propose(order(218, b, entityB, installed[0].approved.customer), 409)

  const staleInput = order(219, a, entityA), stale = await propose(staleInput)
  await mutate('entity.update', { ...a, entity: entityA, ledger_company_ref: 'synthetic-nectar-21-new-ledger' })
  const afterEdit = await snapshot()
  assert.equal((await api(`proposals/${stale.id}`)).stale, true)
  await decide(stale.id, owner, 'approved', 409)
  assert.deepEqual(await snapshot(), afterEdit, 'SET-001 an edited route refuses stale approval without installing customer, catalog or subscription changes')
  assert.equal((await api(`proposals/${stale.id}`)).payload.source.text, staleInput.source.text)
  await decide(stale.id, owner, 'rejected')
  for (const value of installed) for (const invoice of value.issued) assert.deepEqual(await api(`invoices/${invoice.id}`), invoice, 'SET-001 later entity edits preserve issued legal and route evidence')
  console.log('SET-001/AGENT-006 quoted existing entity and route intent, complete-term invoice parity, owner approval, stale routing refusal and immutable issue custody passed')
}
