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
