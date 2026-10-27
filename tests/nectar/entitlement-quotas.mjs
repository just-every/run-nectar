import { nativeCollectionEdge } from './native-collection.mjs'
import { createHmac } from 'node:crypto'
import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'
import { publishPrice } from './price-helper.mjs'

// ENT-002: real subscriptions, usage, issued invoices and manual allocations,
// driven only through the built Worker's ordinary HTTP doors.
export async function entitlementQuotasFlow(h, owner, {onState=async()=>{},measure=false}={}) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  await api('business.configure', { ...(await api('business')), timezone: 'UTC', payment_terms_days: 0 })
  await h.advanceClock('2026-09-02T12:00:00Z')
  const feature = 'ent002-access'
  const meter = await api('meter.create', { code: 'ent002-requests', name: 'Entitlement requests', unit_label: 'requests' })
  const fixtures = []
  const make = async (code, product, price, policy) => {
    const external = `ENT002-${code.toUpperCase()}`
    const customer = (await api('customer.create', { external_id: external, name: `Entitlement ${code}`, billing_email: `${code}@entitlement.example` })).id
    const subscription = (await api('subscription.create', { customer, start_date: '2026-08-01', anchor_day: 1, price: [price] })).id
    const fixture = { code, external, customer, subscription, product, price, policy }
    fixtures.push(fixture)
    return fixture
  }
  const entitlement = fixture => api(`entitlements/${fixture.customer}?feature=${feature}`)
  const pathOf = (result, fixture) => {
    const path = result.paths.find(row => row.subscription === fixture.subscription)
    assert.ok(path, 'ENT-002 explanation identifies the actual subscription')
    return path
  }
  const submit = async (fixture, suffix, quantity, occurred_at = '2026-09-01T12:00:00Z') => {
    const result = await api('usage.submit', { events: [{ event_id: `ent002-${fixture.code}-${suffix}`, customer: fixture.external, meter: meter.code, quantity, occurred_at }] })
    assert.equal(result.accepted, 1, 'ENT-002 usage is accepted independently of access policy')
  }
  await api('portal.configure',{hosts:[h.origin],parents:[]})
  const policies = []
  for (const policy of ['soft', 'hard', 'overage']) {
    const product = (await api('product.create', { code: `ent002-${policy}`, name: `Requests with ${policy} quota` })).id
    const price = (await api('price.create', { product, kind: 'unit', meter: meter.id, unit_amount: '0.02', taxable: false })).id
    await api('feature.grant', { product, feature })
    await applyPolicy(h, owner, 'feature.policy', { product, feature, meter: policy === 'soft' ? meter.code : meter.id, quota: '10000', quota_policy: policy, grace_days: 3 })
    policies.push(await make(policy, product, price, policy))
  }
  const [soft, hard, overage] = policies
  const paused = await make('paused', soft.product, soft.price, 'soft')
  const cancelled = await make('cancelled', soft.product, soft.price, 'soft')
  for (const fixture of fixtures) await submit(fixture, 'august', '10', '2026-08-15T12:00:00Z')

  const assertQuota = async (fixture, used, remaining, exhausted) => {
    const result = await entitlement(fixture)
    const path = pathOf(result, fixture)
    assert.equal(result.allowed, fixture.policy !== 'hard' || !exhausted, `ENT-002 ${fixture.policy} quota has its promised access behavior`)
    assert.equal(path.granted, result.allowed)
    assert.deepEqual(Object.fromEntries(['meter','used','remaining','policy','exhausted'].map(key => [key,path.quota[key]])), { meter: meter.id, used, remaining, policy: fixture.policy, exhausted }, 'ENT-002 exact current-period quantity and remaining units explain the decision')
    assert.equal(Number(path.quota.limit), 10000)
    assert.deepEqual(path.quota.period, {start:'2026-09-01',end:'2026-10-01'})
    assert.ok(Array.isArray(path.quota.eventIds))
    assert.equal(typeof path.warning, 'boolean', 'ENT-002 warning is an explicit decision fact')
    if (!exhausted) assert.equal(path.warning, false)
    if (fixture.policy === 'soft' && exhausted) assert.equal(path.warning, true, 'ENT-002 a soft quota warns while preserving access')
    assert.equal(path.payment.restricted, false)
    assert.equal(path.payment.graceDays, 3)
    await api('portal.session.issue',{customer,contact:otherContact,origin:h.origin,audience:'hosted'},404)
  const session=await api('portal.session.issue',{customer:fixture.customer,origin:h.origin,audience:'hosted'})
    const response=await h.raw(`/portal/subscriptions/${fixture.subscription}/upcoming?period=2026-09&session=${session.token}`)
    assert.equal(response.status,200)
    const customerQuota=(await response.json()).quotas.find(row=>row.feature===feature)
    assert.deepEqual(customerQuota,{feature,meter:meter.id,used,limit:path.quota.limit,remaining,period:path.quota.period},'Customer quota quantities match the exact operator decision at every boundary')
    await onState({...fixture,session,period:'2026-09',used})
    return result
  }
  for (const fixture of policies) {
    await assertQuota(fixture, '0', '10000', false)
    await submit(fixture, 'below', '9999.75')
    await assertQuota(fixture, '9999.75', '0.25', false)
    await submit(fixture, 'exact', '0.25')
    await assertQuota(fixture, '10000', '0', true)
    await submit(fixture, 'above', '12.5')
    await assertQuota(fixture, '10012.5', '0', true)
  }

  // Genuine August service invoices retain the September 1 due dates that
  // drive the three-day grace boundary.
  const run = await api('billrun.prepare', { period: '2026-08' })
  const drafts = (await api(`runs/${run.id}`)).invoices
  for (const fixture of fixtures) {
    const draft = drafts.find(row => row.customer_id === fixture.customer)
    assert.ok(draft, 'ENT-002 historical subscription service produces an invoice')
    await api('invoice.approve', { invoice: draft.id, acknowledge: true })
    await api('invoice.finalise', { invoice: draft.id, issue_date: '2026-09-01' })
    fixture.invoice = await api(`invoices/${draft.id}`)
    assert.equal(fixture.invoice.status, 'issued')
    assert.equal(fixture.invoice.total_cents, 20, 'ENT-002 historical ten requests are rated at the real two-cent price')
    assert.equal(fixture.invoice.due_date, '2026-09-01')
  }
  const detail = fixture => api(`subscriptions/${fixture.subscription}`)
  await api('subscription.pause', { subscription: paused.subscription, revision: (await detail(paused)).revision, effective_date: '2026-09-04', resume_date: '2026-09-10', access: 'suspend', reason: 'Research paused independently of payment' })
  await api('subscription.cancel', { subscription: cancelled.subscription, revision: (await detail(cancelled)).revision, mode: 'immediate', effective_date: '2026-09-04', reason: 'Contract ended independently of payment' })
  const states = new Map(await Promise.all(fixtures.map(async fixture => [fixture.subscription, await detail(fixture)])))

  await h.advanceClock('2026-09-03T23:59:59Z')
  for (const fixture of fixtures) {
    const result = await entitlement(fixture)
    assert.equal(pathOf(result, fixture).payment.restricted, false, 'ENT-002 the last instant before three full due-date days remains in grace')
    assert.equal(result.allowed, fixture !== hard, 'ENT-002 grace preserves the independent quota and scheduled lifecycle decisions')
  }
  await h.advanceClock('2026-09-04T00:00:00Z')
  for (const fixture of policies) {
    const result = await entitlement(fixture)
    const path = pathOf(result, fixture)
    assert.equal(result.allowed, false, 'ENT-002 unpaid service is restricted at the exact grace boundary')
    assert.equal(path.payment.restricted, true)
    assert.equal(path.state.payment.status, 'past_due', 'Native payment state is derived from the issued unpaid invoice')
    assert.deepEqual(path.payment.invoices.map(({ id, number, dueDate, balanceCents }) => ({ id, number, dueDate, balanceCents })), [{ id: fixture.invoice.id, number: fixture.invoice.number, dueDate: fixture.invoice.due_date, balanceCents: 20 }], 'ENT-002 payment restriction cites the real issued invoice and its outstanding cents')
    assert.equal(path.quota.used, '10012.5', 'ENT-002 payment restriction does not erase quota evidence')
  }

  for (const fixture of fixtures) {
    const payment = await api('payment.record', { customer: fixture.customer, amount: '0.20', received_on: '2026-09-04', method: 'bank_transfer', reference: `ENT002-${fixture.code}-SETTLED` })
    assert.equal((await entitlement(fixture)).allowed, false, 'ENT-002 unallocated cash does not settle an invoice or restore access')
    await api('payment.allocate', { payment: payment.payment, invoice: fixture.invoice.id, amount: '0.20' })
    const result = await entitlement(fixture)
    assert.equal(result.allowed, fixture === soft || fixture === overage, 'ENT-002 allocation restores only access permitted by quota and lifecycle')
    if (policies.includes(fixture)) assert.equal(pathOf(result, fixture).payment.restricted, false)
    assert.equal(pathOf(result, fixture).state.payment.status, 'current', 'Allocated settlement clears the financial input without changing the lifecycle')
    assert.equal(pathOf(result, fixture).state.lifecycle, fixture === paused ? 'paused' : fixture === cancelled ? 'ended' : 'active')
    assert.equal((await api(`invoices/${fixture.invoice.id}`)).balanceCents, 0)
    assert.deepEqual(await detail(fixture), states.get(fixture.subscription), 'ENT-002 payment restriction and restoration never rewrite pause, cancel or subscription state')
  }

  await api('access.give', { email: 'ent002-accountant@example.test', name: 'Entitlement Accountant', role: 'accountant' })
  const accountant = await h.signIn('ent002-accountant@example.test', { requested: true })
  const agent = { bearer: (await api('credential.issue', { name: 'Entitlement observer', scopes: ['prepare'] })).key }
  const changed = { product: soft.product, feature, meter: meter.id, quota: '10000', quota_policy: 'hard', grace_days: 3 }
  const before = await entitlement(soft)
  for (const who of [accountant, agent]) {
    await h.api('feature.policy', who, changed, 403)
    assert.deepEqual(await h.api(`entitlements/${soft.customer}?feature=${feature}`, who), { ...before, paths: before.paths.map(path => ({ ...path, state: { ...path.state, payment: { status: path.state.payment.status } } })) }, 'ENT-002 read authority preserves the decision and explanation while new financial source facts stay owner-only')
  }
  await h.api('feature.policy', undefined, changed, 401)

  // ENT-002 inherits GOV-002: policy preparation changes no active decision,
  // and every subsequent application names a separate approver and exact basis.
  await api('access.give', {email:'ent002-finance@example.test',name:'Quota Finance',role:'finance'})
  const finance = await h.signIn('ent002-finance@example.test',{requested:true})
  const original = await entitlement(soft)
  const pending = await api('feature.policy', changed)
  const competing = await api('feature.policy', {...changed,quota:'20000'})
  assert.deepEqual(await entitlement(soft), original, 'ENT-002 preparing policy never changes access')
  await api('policy.decide',{request:pending.request,decision:'approved',confirm_single:true},409)
  await h.api('feature.policy',finance,changed,403)
  await h.api('policy.decide',finance,{request:pending.request,decision:'approved'})
  assert.equal((await entitlement(soft)).allowed,false,'ENT-002 a separately approved hard limit takes effect on the next read')
  await h.api('policy.decide',finance,{request:pending.request,decision:'approved'},409)
  await h.api('policy.decide',finance,{request:competing.request,decision:'approved'},409)
  assert.equal((await entitlement(soft)).allowed,false,'ENT-002 duplicate and stale policy approvals cannot change the effective limit')

  await h.advanceClock('2026-10-01T12:00:00Z')
  assert.equal(pathOf(await entitlement(overage), overage).quota.used, '0', 'ENT-002 a new subscription period resets the quota without deleting prior usage')
  const september = await api('billrun.prepare', { period: '2026-09' })
  const overageDraft = (await api(`runs/${september.id}`)).invoices.find(row => row.customer_id === overage.customer)
  assert.ok(overageDraft)
  await api('invoice.approve', { invoice: overageDraft.id, acknowledge: true })
  await api('invoice.finalise', { invoice: overageDraft.id, issue_date: '2026-10-01' })
  const issued = await api(`invoices/${overageDraft.id}`)
  assert.equal(issued.status, 'issued')
  assert.equal(issued.total_cents, 20025, 'ENT-002 overage keeps ordinary metered pricing: 10,012.5 requests at $0.02, with no invented free monetary allowance')
  assert.equal(issued.lines.filter(line => line.price_id === overage.price).reduce((sum, line) => sum + line.amount_cents, 0), 20025)
  await intervalQuotas(h, owner, meter)
  await numericLimits(h, owner, finance, onState, measure)
  console.log('ENT-002 exact quotas, soft warning, hard restriction, priced overage, issued-invoice grace, manual settlement, lifecycle preservation and authority passed')
  return { customer: overage.customer, subscription: overage.subscription, invoice: issued.id }
}

// A quota inherits the billed meter's calendar, including its full anniversary.
// When access usage is not sold as a meter, only an unambiguous product cadence
// can supply that calendar.
async function intervalQuotas(h, owner, meter) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const feature = 'synthetic-nectar-interval-access'
  const make = async (number, intervals, start, metered = true) => {
    const code = `synthetic-nectar-${number}`
    const product = (await api('product.create', { code, name: `Synthetic interval quota ${number}` })).id
    const prices = []
    for (const [index, interval] of intervals.entries()) prices.push((await publishPrice(h, owner, {
      product, kind: metered && index === 0 ? 'unit' : 'flat',
      ...(metered && index === 0 ? { meter: meter.id } : {}),
      unit_amount: interval === 'weekly' ? '3' : metered && index === 0 ? '2' : '1',
      taxable: false, billing_interval: interval, billing_timing: 'arrears',
    })).id)
    await api('feature.grant', { product, feature })
    await applyPolicy(h, owner, 'feature.policy', { product, feature, meter: meter.id, quota: '10', quota_policy: 'hard' })
    const customer = (await api('customer.create', { external_id: code, name: code, billing_email: `${code}@example.test` })).id
    const subscription = (await api('subscription.create', { customer, start_date: start, anchor_day: 1, price: prices })).id
    return { code, customer, subscription, price: prices[0] }
  }
  const read = (row, date, status) => api(`entitlements/${row.customer}?feature=${feature}${date ? `&date=${date}` : ''}`, undefined, status)
  const decision = (result, row) => result.paths.find(path => path.subscription === row.subscription)
  const usage = async (row, suffix, quantity, occurred_at) => {
    assert.equal((await api('usage.submit', { events: [{ event_id: `${row.code}-${suffix}`, customer: row.code, meter: meter.code, quantity, occurred_at }] })).accepted, 1)
  }
  const quota = async (row, date, period, used, allowed) => {
    const result = await read(row, date), path = decision(result, row)
    assert.deepEqual(path.quota.period, period)
    assert.equal(path.quota.used, used)
    assert.equal(result.allowed, allowed)
    return path.quota
  }
  const issue = async (row, from, to, cents, issueDate) => {
    const run = await api('billrun.prepare', { period: '2026-11' })
    const candidates = (await api(`runs/${run.id}`)).invoices.filter(invoice => invoice.customer_id === row.customer)
    const invoices = await Promise.all(candidates.map(invoice => api(`invoices/${invoice.id}`)))
    const draft = invoices.find(invoice => invoice.lines.some(line => line.price_id === row.price && line.period_start === from && line.period_end === to))
    assert.ok(draft, 'Actual interval billing includes the same service period as its quota')
    await api('invoice.approve', { invoice: draft.id, acknowledge: true })
    await api('invoice.finalise', { invoice: draft.id, issue_date: issueDate })
    const issued = await api(`invoices/${draft.id}`)
    assert.equal(issued.status, 'issued')
    const lines = issued.lines.filter(line => line.price_id === row.price)
    assert.equal(lines.reduce((sum, line) => sum + line.amount_cents, 0), cents, 'The ordinary invoice rates the actual quota-period usage without a monetary allowance')
    return issued
  }

  await h.advanceClock('2026-11-14T23:59:59Z')
  const annual = await make(188, ['annual', 'monthly'], '2025-11-15')
  await usage(annual, 'earlier-month', '6', '2026-10-01T12:00:00Z')
  await usage(annual, 'last-day', '4', '2026-11-14T12:00:00Z')
  const annualPeriod = { start: '2025-11-15', end: '2026-11-15' }
  await quota(annual, '2026-11-14', annualPeriod, '10', false)
  const annualAccess = await make(189, ['annual'], '2025-11-15', false)
  await usage(annualAccess, 'access', '6', '2026-10-01T12:00:00Z')
  await quota(annualAccess, '2026-11-14', annualPeriod, '6', true)
  const ambiguous = await make(190, ['annual', 'monthly'], '2025-11-15', false)
  assert.equal((await read(ambiguous, '2026-11-14', 409)).error, 'feature_quota_billing_period_ambiguous', 'Conflicting nonmetered product cadences cannot silently supply a monthly quota')

  await h.advanceClock('2026-11-15T00:00:00Z')
  await quota(annual, undefined, { start: '2026-11-15', end: '2027-11-15' }, '0', true)
  await usage(annual, 'anniversary', '3', '2026-11-15T00:00:00Z')
  const next = await quota(annual, undefined, { start: '2026-11-15', end: '2027-11-15' }, '3', true)
  assert.deepEqual(next.eventIds, [`${annual.code}-anniversary`], 'The anniversary event belongs only to the new annual quota')
  await issue(annual, annualPeriod.start, annualPeriod.end, 2000, '2026-11-15')

  const weekly = await make(191, ['weekly'], '2026-11-16')
  await h.advanceClock('2026-11-22T23:59:59Z')
  await usage(weekly, 'week-start', '4', '2026-11-17T12:00:00Z')
  await usage(weekly, 'week-end', '6', '2026-11-22T12:00:00Z')
  await quota(weekly, undefined, { start: '2026-11-16', end: '2026-11-23' }, '10', false)
  await h.advanceClock('2026-11-23T00:00:00Z')
  await quota(weekly, undefined, { start: '2026-11-23', end: '2026-11-30' }, '0', true)
  await usage(weekly, 'next-week', '1', '2026-11-23T00:00:00Z')
  await quota(weekly, undefined, { start: '2026-11-23', end: '2026-11-30' }, '1', true)
  await issue(weekly, '2026-11-16', '2026-11-23', 3000, '2026-11-23')
}

// Governed numeric capacity follows the actual effective price and lifecycle.
async function numericLimits(h, owner, finance, onState, measure) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  await h.advanceClock('2026-12-04T12:00:00Z')
  const feature = 'synthetic-nectar-capacity', external = 'synthetic-nectar-capacity', products = [], prices = []
  for (const [index, limit] of ['10.125001', '100', '0'].entries()) {
    const product = (await api('product.create', { code: `synthetic-nectar-capacity-${index}`, name: `Capacity ${limit}` })).id
    products.push(product)
    prices.push((await api('price.create', { product, kind: 'flat', unit_amount: '10', taxable: false })).id)
    await api('feature.grant', { product, feature })
    await applyPolicy(h, owner, 'feature.policy', { product, feature, quota_policy: 'soft', numeric_limit: limit })
  }
  const customer = (await api('customer.create', { external_id: external, name: 'Capacity research', billing_email: 'capacity@example.test' })).id
  const subscription = (await api('subscription.create', { customer, price: [prices[0]], start_date: '2026-12-01', anchor_day: 1 })).id
  const read = () => api(`entitlements/${customer}?feature=${feature}`)
  const observe = async (label, limit, price, allowed = true, changedAt) => {
    const result = await read(), path = result.paths.find(row => row.subscription === subscription)
    assert.equal(result.allowed, allowed)
    if (allowed) {
      assert.equal(path.numericLimit, limit)
      assert.ok(path.steps.some(step => step.includes(price)), 'Explanation names the exact immutable price')
    }
    assert.equal(path.subscription, subscription)
    if(changedAt!==undefined)assert.ok(performance.now()-changedAt<5000,'Native entitlement changes become visible within five seconds')
    await onState({ label: `numeric-${label}`, customer, subscription, product: products[prices.indexOf(price)], limit, allowed })
    return result
  }
  await observe('initial', '10.125001', prices[0])
  if(measure) {
    const product={bearer:(await api('credential.issue',{name:'Synthetic product entitlement reader',scopes:['prepare']})).key}
    const latencies=[]
    for(let index=0;index<100;index++) {
      const start=performance.now(),answer=await h.api(`entitlements/${customer}?feature=${feature}`,product)
      latencies.push(performance.now()-start)
      assert.equal(answer.paths[0].numericLimit,'10.125001')
      assert.ok(answer.paths[0].steps.some(step=>step.includes(prices[0])))
    }
    latencies.sort((a,b)=>a-b)
    console.log('NATIVE_ENTITLEMENT_TIMING',JSON.stringify({samples:latencies.length,p95Ms:latencies[Math.ceil(latencies.length*.95)-1],location:'local Workerd; deployed edge measurement still pending'}))
  }
  const change = async (price, date, expected) => {
    const sub = await api(`subscriptions/${subscription}`)
    const item = sub.items.find(item => item.effective_to === null)
    const pending = await api('change.prepare', { subscription, item: item.id, price, effective_date: date })
    const start = performance.now()
    await h.api('change.decide', finance, { change: pending.change, decision: 'approved' })
    const result = await observe(date, expected, price, true, start)
    assert.deepEqual(await api(`entitlements/${external}`), [result], 'External customer IDs have list and single-feature parity')
  }
  await change(prices[1], '2026-12-02', '100.00')
  await change(prices[0], '2026-12-03', '10.125001')
  await change(prices[2], '2026-12-04', '0.00')
  const payload = { product: products[2], feature, quota_policy: 'soft' }
  const before = await read()
  const pending = await api('feature.policy', { ...payload, numeric_limit: '7.125001' })
  assert.deepEqual(await read(), before, 'A pending numeric capacity policy has no access effect')
  await api('policy.decide', { request: pending.request, decision: 'approved' }, 409)
  await h.api('policy.decide', finance, { request: pending.request, decision: 'approved' })
  await observe('approved', '7.125001', prices[2])
  const audit = (await api('audit')).find(row => row.action === 'policy.apply' && row.subject === pending.request)
  assert.equal(JSON.parse(audit.detail).payload.numericLimit, '7.125001', 'The exact approved numeric limit is audited')
  await api('feature.policy', { ...payload, numeric_limit: '-1' }, 400)
  const agent = { bearer: (await api('credential.issue', { name: 'Capacity reader', scopes: ['prepare'] })).key }
  await h.api('feature.policy', agent, { ...payload, numeric_limit: '999' }, 403)
  const sub = await api(`subscriptions/${subscription}`), start = performance.now()
  await api('subscription.pause', { subscription, revision: sub.revision, effective_date: '2026-12-04', resume_date: '2026-12-10', access: 'suspend', reason: 'Capacity pause' })
  const paused = await observe('paused', null, prices[2], false, start)
  assert.equal(paused.paths[0].state.lifecycle, 'paused')
  await api('access.give', { email: 'synthetic-nectar-sales@example.test', name: 'Capacity Sales', role: 'sales' })
  const sales = await h.signIn('synthetic-nectar-sales@example.test', { requested: true })
  const limited = await h.api(`entitlements/${customer}?feature=${feature}`, sales)
  assert.equal(limited.paths[0].state.payment, undefined, 'A sales reader receives no new financial state facts')
}

// Dedicated native timing receipt; deliberately outside the push Verify list.
export async function entitlementTimingFlow(h,owner) {
  await entitlementQuotasFlow(h,owner,{measure:true})
}

let alertEdge, alertRequests=[], alertSecret=''
export function harnessOptions() {
  alertEdge=nativeCollectionEdge();alertEdge.capturedAt('2026-09-15T12:00:00Z');alertRequests=[];alertSecret=''
  return {stripeFetch:alertEdge.fetch,stripeSecret:'synthetic-nectar-1',webhookFetch:async request=>{
    const body=await request.text(),parts=Object.fromEntries(request.headers.get('nectar-signature').split(',').map(p=>p.split('=')))
    assert.equal(parts.v1,createHmac('sha256',alertSecret).update(`${parts.t}.${body}`).digest('hex'),'Threshold webhook signature verifies')
    alertRequests.push(JSON.parse(body));return new Response(null,{status:204})
  }}
}
export async function usageThresholdFlow(h,owner,{onState=async()=>{}}={}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  await h.advanceClock('2026-09-15T12:00:00Z')
  await api('business.configure',{...await api('business'),timezone:'UTC'})
  await api('access.give',{email:'threshold-finance@example.test',name:'Finance',role:'finance'})
  const finance=await h.signIn('threshold-finance@example.test',{requested:true})
  await api('access.give',{email:'threshold-reader@example.test',name:'Accountant',role:'accountant'})
  const reader=await h.signIn('threshold-reader@example.test',{requested:true}),agent={bearer:(await api('credential.issue',{name:'Alert reader',scopes:['prepare']})).key}
  for(const who of [finance,reader,agent,undefined])await h.api('usage.threshold.configure',who,{},who?403:401)
  await api('portal.configure',{hosts:[h.origin],parents:[]})
  const customer=(await api('customer.create',{external_id:'synthetic-nectar-alert-1',name:'Acacia Analytics',billing_email:'billing@acacia.example'})).id
  const contact=(await api('contact.add',{customer,name:'Priya Finance',email:'priya@acacia.example',role:'billing'})).contact
  const other=(await api('customer.create',{external_id:'synthetic-nectar-alert-2',name:'Banksia Data',billing_email:'billing@banksia.example'})).id
  const otherContact=(await api('contact.add',{customer:other,name:'Other Finance',email:'finance@banksia.example',role:'billing'})).contact
  const entity=(await api('entity.create',{revision:(await api('business')).revision,legal_name:'Acacia seller',address:'1 Synthetic Way',ein:'12-3456789',invoice_prefix:'ALERT',invoice_number_width:4,payment_terms_days:30,processor_account_ref:'synthetic-nectar-native-account-1',ledger_company_ref:'synthetic-nectar-native-ledger-1',tax_registration:'Test registration'})).id
  await api('customer.entity',{revision:(await api('business')).revision,customer,entity,confirm:true})
  const product=(await api('product.create',{code:'synthetic-nectar-alert-1',name:'Analytics calls'})).id
  const meter=await api('meter.create',{code:'threshold-calls',name:'API calls',unit_label:'calls'})
  const price=(await publishPrice(h,owner,{product,kind:'unit',meter:meter.id,unit_amount:'0.005',taxable:false})).id
  const subscription=(await api('subscription.create',{customer,external_id:'acacia-analytics',start_date:'2026-09-01',anchor_day:1,price:[price]})).id
  const terms=await api('contract.prepare',{subscription,revision:(await api(`subscriptions/${subscription}`)).revision,clause:'Signed monthly minimum',commitments:[{from:'2026-09-01',to:'2026-10-01',minimum:'6000',taxable:false}]})
  await h.api('contract.decide',finance,{contract:terms.contract,decision:'approved'})
  const session=await api('portal.session.issue',{customer,contact,origin:h.origin,audience:'hosted'}),foreign=await api('portal.session.issue',{customer:other,contact:otherContact,origin:h.origin,audience:'hosted'}),unbound=await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
  const portal=async(token,path='/portal/alerts/data',body,status=200)=>{
    const response=await h.raw(`${path}?session=${encodeURIComponent(token)}`,{body}),text=await response.text()
    assert.equal(response.status,status,`${path}: ${text.slice(0,250)}`)
    return response.headers.get('content-type')?.includes('application/json')?JSON.parse(text):text
  }
  await portal(unbound.token,'/portal/alerts',{},403)
  const fields={subscription,kind:'usage',meter:meter.id,threshold:'1000000',name:'One million calls',confirm_mail:true}
  await portal(session.token,'/portal/alerts',{...fields,recipient:'attacker@example.test'},400)
  await portal(session.token,'/portal/alerts',{...fields,confirm_mail:false},400)
  const own=await portal(session.token,'/portal/alerts',fields)
  const spend=await api('usage.threshold.configure',{subscription,kind:'spend',threshold:'5000',name:'Accrued spend',recipient:'priya@acacia.example',confirm_mail:true}),commitment=await api('usage.threshold.configure',{subscription,kind:'commitment',contract:terms.contract,threshold:'80',name:'Commitment 80 percent',recipient:'priya@acacia.example',confirm_mail:true})
  alertSecret=(await api('webhook.register',{url:'https://receiver.nectar-app.com/alerts',consent:true})).secret
  const baseMails=h.mails.length,ingest=(id,quantity)=>api('usage.submit',{events:[{event_id:id,customer:'synthetic-nectar-alert-1',meter:meter.code,quantity,occurred_at:'2026-09-15T10:00:00Z'}]})
  await ingest('synthetic-nectar-alert-before','950000')
  assert.equal((await api('usage' + '/thresholds')).crossings.length,0,'No crossing below the configured thresholds')
  await ingest('synthetic-nectar-alert-crossing','60000')
  const crossed=await api('usage' + '/thresholds'),values=new Map(crossed.crossings.map(x=>[x.threshold_id,x.value]))
  assert.deepEqual(crossed.crossings.map(x=>x.threshold_id).sort(),[own.id,spend.id,commitment.id].sort(),'Exactly the three expected thresholds cross')
  assert.equal(values.get(own.id),'1010000.00');assert.equal(values.get(spend.id),'5050.00');assert.equal(values.get(commitment.id),'84.166667')
  assert.ok(crossed.crossings.every(x=>x.email_status==='accepted'))
  const sent=()=>h.mails.slice(baseMails).filter(m=>m.subject.startsWith('Usage alert:'))
  assert.equal(sent().length,3);assert.ok(sent().every(m=>[m.to].flat().includes('priya@acacia.example')))
  await api('webhook.dispatch',{})
  const webhooks=()=>alertRequests.filter(e=>e.type==='usage.threshold_crossed')
  assert.deepEqual(webhooks().map(e=>e.data.threshold_id).sort(),[own.id,spend.id,commitment.id].sort());assert.equal(new Set(webhooks().map(e=>e.id)).size,3)
  await Promise.all([1,2].map(()=>ingest('synthetic-nectar-alert-crossing','60000')))
  await api('usage.threshold.configure',{id:own.id,...fields,recipient:'priya@acacia.example'})
  await api('webhook.dispatch',{})
  assert.equal((await api('usage' + '/thresholds')).crossings.length,3);assert.equal(sent().length,3);assert.equal(webhooks().length,3)
  h.mailResponses.push({to:'priya@acacia.example',status:503,body:{message:'Synthetic refusal'}})
  const refused=await api('usage.threshold.configure',{subscription,kind:'usage',meter:meter.id,threshold:'1000000',name:'Refused delivery',recipient:'priya@acacia.example',confirm_mail:true})
  assert.equal((await api('usage' + '/thresholds')).crossings.find(x=>x.threshold_id===refused.id).email_status,'failed')
  const attempts=sent().length
  await api('usage.threshold.configure',{id:refused.id,subscription,kind:'usage',meter:meter.id,threshold:'1000000',name:'Refused delivery',recipient:'priya@acacia.example',confirm_mail:true})
  assert.equal(sent().length,attempts,'A refused email is never sent again for the crossing')
  const theirs=await portal(foreign.token);assert.deepEqual(theirs.definitions,[]);assert.deepEqual(theirs.crossings,[])
  await portal(foreign.token,'/portal/alerts',{id:own.id,...fields},404);await portal(foreign.token,'/portal/alerts',fields,404)
  const ownView=await portal(session.token)
  assert.equal(ownView.definitions.find(d=>d.id===own.id).recipient,'priya@acacia.example');assert.equal(ownView.crossings.find(x=>x.threshold_id===own.id).value,'1010000.00')
  assert.equal((await h.raw(`/portal/alerts?session=${session.token}`,{body:fields,headers:{origin:'https://untrusted.example'}})).status,403)
  await onState({label:'crossed',session,foreign,subscription,customer})
  const spending=crossed.crossings.find(x=>x.threshold_id===spend.id)
  for(const who of [reader,agent,undefined])await h.api('usage.threshold.invoice',who,{crossing:spending.id},who?403:401)
  const draft=await api('usage.threshold.invoice',{crossing:spending.id})
  assert.equal((await api('usage.threshold.invoice',{crossing:spending.id})).id,draft.id)
  assert.equal((await api(`invoices/${draft.id}`)).subtotal_cents,505000)
  await api('invoice.finalise',{invoice:draft.id},409)
  await api('invoice.approve',{invoice:draft.id,acknowledge:true});await api('invoice.finalise',{invoice:draft.id,issue_date:'2026-09-15'})
  await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:'synthetic-nectar-native-customer-1',confirm:true})
  const prepared=await api('collection.prepare',{invoice:draft.id})
  const collect=await api('collection.confirm',prepared.instructions.confirm)
  assert.equal(collect.status,'collected');await api('collection.confirm',prepared.instructions.confirm,409)
  const invoice=await api(`invoices/${draft.id}`)
  assert.equal(invoice.status,'issued');assert.equal(invoice.paidCents,505000);assert.equal(invoice.balanceCents,0)
  assert.equal(alertEdge.calls.filter(c=>c.method==='POST'&&c.path==='/payment_intents').length,1,'Threshold charged once')
  await onState({label:'threshold-invoice',session,invoice:draft.id,subscription,customer})
  await ingest('synthetic-nectar-alert-rest','190000')
  await h.advanceClock('2026-10-02T12:00:00Z')
  const run=await api('billrun.prepare',{period:'2026-09'}),final=(await api(`runs/${run.id}`)).invoices.find(i=>i.subscription_id===subscription)
  assert.equal(final.subtotal_cents,95000,'Full $6000 liability less issued $5050 bills only $950')
  assert.equal((await api(`invoices/${final.id}`)).lines.find(l=>l.kind==='threshold_settlement').amount_cents,-505000)
  await api('invoice.approve',{invoice:final.id,acknowledge:true});await api('invoice.finalise',{invoice:final.id,issue_date:'2026-10-02'})
  assert.equal((await api(`invoices/${final.id}`)).subtotal_cents+invoice.subtotal_cents,600000)
  assert.equal((await api('usage.threshold.invoice',{crossing:spending.id})).id,draft.id)
  await onState({label:'remainder-invoice',invoice:final.id,subscription,customer})
  await thresholdPricingRemainders(h,owner)
}

async function thresholdPricingRemainders(h,owner) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  await h.advanceClock('2026-11-15T12:00:00Z')
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'flat_rate',tax_rate:'8.25',tax_note:'Synthetic exact threshold rounding'})
  await api('tax.review',{revision:(await api('business')).revision})
  const customer=(await api('customer.create',{external_id:'synthetic-nectar-volume-1',name:'Nonlinear usage account',billing_email:'ap@volume.example'})).id
  await api('contact.add',{customer,name:'Volume Finance',email:'finance@volume.example',role:'billing'})
  const product=(await api('product.create',{code:'synthetic-nectar-volume-1',name:'Volume calls'})).id,meter=await api('meter.create',{code:'threshold-volume',name:'Volume calls',unit_label:'calls'})
  const price=(await publishPrice(h,owner,{product,kind:'unit',meter:meter.id,pricing_model:'volume',tiers:[{up_to:'1000',unit_amount:'0.006',flat_amount:'0.009'},{up_to:null,unit_amount:'0.004',flat_amount:'0.019'}],taxable:true})).id
  const subscription=(await api('subscription.create',{customer,start_date:'2026-11-01',anchor_day:1,price:[price]})).id
  const definitions=[]
  for(const threshold of ['5','7'])definitions.push(await api('usage.threshold.configure',{subscription,kind:'spend',threshold,name:`Volume spend ${threshold}`,recipient:'finance@volume.example',confirm_mail:true}))
  const issued=[]
  for(const [index,amount,tax] of [[0,601,50],[1,201,16]]){
    await api('usage.submit',{events:[{event_id:`synthetic-nectar-volume-${index}`,customer:'synthetic-nectar-volume-1',meter:meter.code,quantity:'1000',occurred_at:'2026-11-15T10:00:00Z'}]})
    const crossing=(await api('usage' + '/thresholds')).crossings.find(x=>x.threshold_id===definitions[index].id)
    assert.ok(crossing,'The expected volume threshold crosses')
    const draft=await api('usage.threshold.invoice',{crossing:crossing.id})
    let invoice=await api(`invoices/${draft.id}`)
    assert.deepEqual([invoice.subtotal_cents,invoice.tax_cents],[amount,tax],'Cumulative volume pricing and original tax are deducted exactly')
    await api('invoice.approve',{invoice:invoice.id,acknowledge:true});await api('invoice.finalise',{invoice:invoice.id,issue_date:'2026-11-15'})
    await api('invoice.finalise',{invoice:invoice.id},409)
    invoice=await api(`invoices/${invoice.id}`);issued.push(invoice)
  }
  await api('usage.submit',{events:[{event_id:'synthetic-nectar-volume-final',customer:'synthetic-nectar-volume-1',meter:meter.code,quantity:'1000',occurred_at:'2026-11-15T10:00:00Z'}]})
  await h.advanceClock('2026-12-02T12:00:00Z')
  const run=await api('billrun.prepare',{period:'2026-11'}),final=(await api(`runs/${run.id}`)).invoices.find(i=>i.subscription_id===subscription)
  assert.deepEqual([final.subtotal_cents,final.tax_cents],[400,33],'Final invoice bills only the independent full-volume remainder and saved tax difference')
  await api('invoice.approve',{invoice:final.id,acknowledge:true});await api('invoice.finalise',{invoice:final.id,issue_date:'2026-12-02'})
  assert.equal(issued.reduce((n,i)=>n+i.subtotal_cents,0)+final.subtotal_cents,1202)
  assert.equal(issued.reduce((n,i)=>n+i.tax_cents,0)+final.tax_cents,99)
  const revenue=await api(`revenue?from=2026-11&to=2026-12&customer=${customer}`)
  assert.deepEqual([revenue.recognizedCents,revenue.netBillingsCents,revenue.closingCents],[1202,1202,0],'Threshold recognition and final cumulative consideration reconcile without double recognition')
}
