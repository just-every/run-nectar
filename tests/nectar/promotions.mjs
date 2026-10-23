// CAT-005 through public doors: reusable coupons, promotion codes with redemption
// limits, expiry and first-time rules redeemed at subscription creation, product
// restriction on a mixed invoice, and trials with or without a payment method on
// file that extend, convert or end unpaid.
import assert from 'node:assert/strict'
import { nativeCollectionEdge } from './native-collection.mjs'
import { totp } from './mfa.mjs'

const trialEdge = nativeCollectionEdge()
trialEdge.accounts.set(1, 'synthetic-nectar-600')
trialEdge.accounts.set(2, 'synthetic-nectar-601')

export const harnessOptions = () => ({ localTime: '2026-08-20T20:00:00Z', stripeFetch: trialEdge.fetch, stripeSecret: 'synthetic-nectar-1', stripeSecondarySecret: 'synthetic-nectar-2' })

export async function promotionsFlow(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  for (const [email, role] of [['promo-accountant@example.test', 'accountant'], ['promo-sales@example.test', 'sales']]) await api('access.give', { email, name: email, role })
  const accountant = await h.signIn('promo-accountant@example.test', { requested: true })
  const agent = { bearer: (await api('credential.issue', { name: 'Promo agent', scopes: ['prepare'] })).key }
  const customer = async name => (await api('customer.create', { external_id: `CAT005-${name}`, name: `Promo ${name}`, billing_email: `${name.toLowerCase()}@promo.example` })).id
  const pro = (await api('product.create', { code: 'cat005-pro', name: 'Pro' })).id
  const basic = (await api('product.create', { code: 'cat005-basic', name: 'Basic' })).id
  const proPrice = (await api('price.create', { product: pro, kind: 'flat', unit_amount: '100.00', taxable: false })).id
  const basicPrice = (await api('price.create', { product: basic, kind: 'flat', unit_amount: '40.00', taxable: false })).id
  const coupon = async body => (await api('coupon.create', body)).id
  const code = (body, status) => api('promotion.create', body, status)
  const subscribe = (cust, promotion_code, extra = {}, status = 200, prices = [proPrice]) => api('subscription.create', { customer: cust, start_date: '2026-09-01', anchor_day: '1', price: prices, ...(promotion_code ? { promotion_code } : {}), ...extra }, status)

  // Who may define coupons and codes.
  const spring = await coupon({ name: 'Spring 20', kind: 'percent', value: '20', duration: 'repeating', months: 3 })
  for (const who of [accountant, agent]) { await h.api('coupon.create', who, { name: 'X', kind: 'percent', value: '5', duration: 'once' }, 403); await h.api('promotion.create', who, { code: 'NOPE', coupon: spring }, 403) }
  await h.api('promotion.create', undefined, {}, 401)
  await api('coupon.create', { name: 'Spring 20', kind: 'percent', value: '5', duration: 'once' }, 409)
  await api('coupon.create', { name: 'Bad', kind: 'percent', value: '101', duration: 'once' }, 400)
  await code({ code: 'spring20', coupon: spring, max_redemptions: 2, expires_on: '2026-12-31' })
  await code({ code: 'SPRING20', coupon: spring }, 409)
  await code({ code: 'x', coupon: spring }, 400)

  // A 20%-for-three-months code redeemed at checkout, then its redemption limit.
  const a = await customer('A'), b = await customer('B'), c = await customer('C')
  await subscribe(a, 'Spring20')
  await subscribe(b, 'SPRING20')
  assert.equal((await subscribe(c, 'SPRING20', {}, 409)).error, 'promotion_exhausted')
  assert.equal((await api('customers/' + c)).subscriptions.length, 0, 'a refused redemption leaves no subscription')
  assert.equal((await subscribe(c, 'NO-SUCH-CODE', {}, 404)).error, 'promotion_code_not_found')
  const listed = (await api('promotions')).codes.find(row => row.code === 'SPRING20')
  assert.deepEqual([listed.redemptions, listed.exhausted], [2, true])
  // Concurrent redemptions of a one-use code commit exactly one.
  await code({ code: 'ONEONLY', coupon: spring, max_redemptions: 1 })
  const racers = await Promise.all([customer('R1'), customer('R2')].map(async racer => h.raw('/api/nectar/subscription.create', { cookie: owner, body: { customer: await racer, start_date: '2026-09-01', anchor_day: '1', price: [proPrice], promotion_code: 'ONEONLY' } })))
  assert.deepEqual(racers.map(r => r.status).sort(), [200, 409])
  // An expired code is refused.
  await code({ code: 'OLD10', coupon: spring, expires_on: '2026-08-19' })
  assert.equal((await subscribe(await customer('Old'), 'OLD10', {}, 409)).error, 'promotion_expired')

  // A coupon restricted to Pro discounts only Pro's lines on a mixed invoice; an amount coupon is a one-time credit.
  const proOnly = await coupon({ name: 'Pro half off', kind: 'percent', value: '50', duration: 'forever', products: [pro] })
  await code({ code: 'PROONLY', coupon: proOnly })
  const e = await customer('E')
  await subscribe(e, 'proonly', {}, 200, [proPrice, basicPrice])
  assert.equal((await subscribe(await customer('Only'), 'PROONLY', {}, 409, [basicPrice])).error, 'promotion_not_applicable')
  const fifteen = await coupon({ name: 'Fifteen off', kind: 'amount', value: '15.00', duration: 'once' })
  await code({ code: 'FIFTEEN', coupon: fifteen })
  const f = await customer('F')
  await subscribe(f, 'FIFTEEN')
  const fixedForever = await coupon({ name: 'Pro amount forever', kind: 'amount', value: '125.00', duration: 'forever', products: [pro] })
  await code({ code: 'PROAMOUNT', coupon: fixedForever })
  const g = await customer('synthetic-nectar-501')
  await subscribe(g, 'PROAMOUNT', {}, 200, [proPrice, basicPrice])
  assert.equal((await subscribe(await customer('synthetic-nectar-502'), 'PROAMOUNT', {}, 409, [basicPrice])).error, 'promotion_not_applicable')
  const fixedThree = await coupon({ name: 'Amount three months', kind: 'amount', value: '10.00', duration: 'repeating', months: 3, products: [pro] })
  await code({ code: 'AMOUNTTHREE', coupon: fixedThree })
  const j = await customer('synthetic-nectar-503')
  await subscribe(j, 'AMOUNTTHREE', {}, 200, [proPrice, basicPrice])
  const monthlyProduct = (await api('product.create', { code: 'synthetic-nectar-504', name: 'Synthetic monthly component' })).id
  const quarterlyProduct = (await api('product.create', { code: 'synthetic-nectar-505', name: 'Synthetic quarterly component' })).id
  const monthlyPrice = (await api('price.create', { product: monthlyProduct, kind: 'flat', unit_amount: '100', taxable: false, billing_timing: 'advance' })).id
  const quarterlyPrice = (await api('price.create', { product: quarterlyProduct, kind: 'flat', unit_amount: '300', taxable: false, billing_interval: 'quarterly', billing_timing: 'advance' })).id
  const mixedCoupon = await coupon({ name: 'Synthetic mixed invoice amount', kind: 'amount', value: '10', duration: 'forever' })
  await code({ code: 'MIXEDAMOUNT', coupon: mixedCoupon })
  const mixedCustomer = await customer('synthetic-nectar-506')
  await subscribe(mixedCustomer, 'MIXEDAMOUNT', {}, 200, [monthlyPrice, quarterlyPrice])

  await h.advanceClock('2027-01-05T20:00:00Z')
  const issueAll = async (period, date) => {
    const run = await api('billrun.prepare', { period })
    const out = {}
    for (const draft of (await api(`runs/${run.id}`)).invoices) {
      await api('invoice.approve', { invoice: draft.id, acknowledge: true })
      await api('invoice.finalise', { invoice: draft.id, issue_date: date })
      out[draft.customer_id] = await api(`invoices/${draft.id}`)
    }
    return out
  }
  const summary = invoice => invoice ? [invoice.total_cents, invoice.lines.filter(line => line.kind === 'discount' || line.kind === 'credit').map(line => line.amount_cents)] : null
  const months = {}
  for (const [period, date] of [['2026-09', '2026-10-01'], ['2026-10', '2026-11-01'], ['2026-11', '2026-12-01'], ['2026-12', '2027-01-01']]) months[period] = await issueAll(period, date)
  for (const period of ['2026-09', '2026-10', '2026-11']) assert.deepEqual(summary(months[period][a]), [8000, [-2000]], `${period} carries the 20% discount`)
  assert.deepEqual(summary(months['2026-12'][a]), [10000, []], 'the discount ends after three months')
  assert.deepEqual(summary(months['2026-09'][b]), [8000, [-2000]])
  assert.deepEqual(summary(months['2026-09'][e]), [9000, [-5000]], 'only the Pro line is discounted: 100 + 40 - 50')
  assert.deepEqual(summary(months['2026-12'][e]), [9000, [-5000]], 'a forever coupon keeps applying')
  assert.deepEqual(summary(months['2026-09'][f]), [8500, [-1500]])
  assert.deepEqual(summary(months['2026-10'][f]), [10000, []], 'a one-time amount applies once')
  for (const period of ['2026-09', '2026-10', '2026-11', '2026-12']) {
    assert.deepEqual(summary(months[period][g]), [4000, [-10000]], 'a forever amount is capped at Pro and never discounts Basic')
    assert.ok(months[period][g].lines.some(line => line.description.startsWith('Basic') && line.amount_cents === 4000))
  }
  for (const period of ['2026-09', '2026-10', '2026-11']) assert.deepEqual(summary(months[period][j]), [13000, [-1000]])
  assert.deepEqual(summary(months['2026-12'][j]), [14000, []], 'the repeating amount stops after its third entitlement')
  for (const period of ['2026-09', '2026-12']) {
    const invoice = months[period][mixedCustomer]
    assert.equal(invoice.total_cents, 39000, 'Monthly 100 + quarterly 300 receives exactly one 10 amount on the composed invoice')
    assert.equal(invoice.lines.filter(line => line.kind === 'discount').reduce((sum, line) => sum + line.amount_cents, 0), -1000, 'The fixed amount is not repeated for each billing component or service month')
  }
  for (const period of ['2026-10', '2026-11']) assert.equal(months[period][mixedCustomer].total_cents, 9000, 'The intervening monthly invoice receives its own single amount')
  const proLine = months['2026-09'][e].lines.find(line => line.kind === 'discount')
  assert.match(proLine.description, /Promotion PROONLY/)
  assert.ok(months['2026-09'][e].lines.some(line => line.description.startsWith('Basic') && line.amount_cents === 4000))

  // Expiry is judged on the redemption date; a first-time code refuses a customer with a paid invoice.
  assert.equal((await subscribe(await customer('Late'), 'SPRING20', { start_date: '2027-01-05' }, 409)).error, 'promotion_expired')
  await code({ code: 'NEWBIE', coupon: spring, first_time_only: true })
  await api('payment.record', { customer: a, amount: '80.00', received_on: '2026-10-05', method: 'bank_transfer', reference: 'CAT005-PAID' })
  const paid = (await api('payments')).find(row => row.reference === 'CAT005-PAID').id
  await api('payment.allocate', { payment: paid, invoice: months['2026-09'][a].id, amount: '80.00' })
  assert.equal((await subscribe(a, 'NEWBIE', { start_date: '2027-01-05' }, 409)).error, 'promotion_first_time_only')
  const fresh = await customer('Fresh')
  await subscribe(fresh, 'NEWBIE', { start_date: '2027-01-05' })
  assert.equal((await api('promotions')).codes.find(row => row.code === 'NEWBIE').redemptions, 1)
  const audit = (await api('audit')).filter(row => row.action === 'subscription.create' && row.detail.includes('"promotion":{'))
  assert.ok(audit.length >= 5, 'every redemption is audited with its code and coupon')
  console.log('CAT-005 coupons and promotion codes passed')
}

export async function trialsFlow(h, owner, onState = async () => {}) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  await api('access.give', { email: 'trial-accountant@example.test', name: 'Trial accountant', role: 'accountant' })
  const accountant = await h.signIn('trial-accountant@example.test', { requested: true })
  const agent = { bearer: (await api('credential.issue', { name: 'Trial agent', scopes: ['prepare'] })).key }
  const product = (await api('product.create', { code: 'cat005-trial', name: 'Trial platform' })).id
  const price = (await api('price.create', { product, kind: 'flat', unit_amount: '300.00', taxable: false })).id
  const make = async (name, trial_end, trial_payment) => {
    const cust = (await api('customer.create', { external_id: `TRIAL-${name}`, name: `Trial ${name}`, billing_email: `${name}@trial.example` })).id
    const sub = (await api('subscription.create', { customer: cust, start_date: '2026-09-01', anchor_day: '1', price: [price], trial_end, ...(trial_payment ? { trial_payment } : {}) })).id
    return { cust, sub }
  }
  const none = await make('none', '2026-09-15', 'none'), card = await make('card', '2026-09-15', 'card'), ext = await make('ext', '2026-09-25', 'card'), legacy = await make('legacy', '2026-09-15')
  await api('subscription.create', { customer: none.cust, start_date: '2026-09-01', anchor_day: '1', price: [price], trial_payment: 'card' }, 400)
  await api('subscription.create', { customer: none.cust, start_date: '2026-09-01', anchor_day: '1', price: [price], trial_end: '2026-09-15', trial_payment: 'cheque' }, 400)
  const sub = id => api(`subscriptions/${id}`)
  const state = async x => { const row = await sub(x.sub); return [row.trial_end, row.end_date, row.trial_payment, row.trial_outcome] }
  const tick = async time => { await h.advanceClock(time); assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse(time)}&cron=${encodeURIComponent('0 14 * * *')}`)).status, 200) }

  // A running trial extends by 14 days; only operators with record authority can.
  await h.advanceClock('2026-09-10T20:00:00Z')
  for (const who of [accountant, agent]) await h.api('trial.extend', who, { subscription: ext.sub, days: 14 }, 403)
  await h.api('trial.extend', undefined, {}, 401)
  await api('trial.extend', { subscription: ext.sub, days: 0 }, 400)
  assert.deepEqual(await api('trial.extend', { subscription: ext.sub, days: 14 }), { id: ext.sub, trialEnd: '2026-10-09' })
  assert.deepEqual(await state(ext), ['2026-10-09', null, 'card', null])
  const audit = (await api('audit')).find(row => row.action === 'trial.extend' && row.subject === ext.sub)
  assert.deepEqual(JSON.parse(audit.detail), { previousEnd: '2026-09-25', newEnd: '2026-10-09', days: 14 })
  await api('trial.resolve', { subscription: none.sub }, 409)
  await onState({ phase: 'extended', ext, none })

  // At the end date a trial with a payment method converts and one without ends unpaid; both are daily and once.
  await tick('2026-09-15T21:00:00Z')
  assert.deepEqual(await state(none), ['2026-09-15', '2026-09-15', 'none', 'ended_unpaid'])
  assert.deepEqual(await state(card), ['2026-09-15', null, 'card', 'converted'])
  assert.deepEqual(await state(ext), ['2026-10-09', null, 'card', null], 'a still-running extended trial is untouched')
  assert.deepEqual(await state(legacy), ['2026-09-15', null, null, null], 'a trial with no declared payment method is never resolved automatically')
  assert.equal((await api('trial.resolve', { subscription: legacy.sub }, 409)).error, 'trial_payment_unknown')
  assert.equal((await api('trial.extend', { subscription: card.sub, days: 7 }, 409)).error, 'trial_not_running')
  await tick('2026-09-16T21:00:00Z')
  assert.equal((await api('audit')).filter(row => row.action.startsWith('trial.') && ['trial.converted', 'trial.ended_unpaid'].includes(row.action)).length, 2, 'each outcome is recorded once')

  // Billing: the card trial charges from its end date, the no-card trial never charges, the extended trial's first charge is its new end date.
  await h.advanceClock('2026-11-02T20:00:00Z')
  const lines = {}
  for (const [period, date] of [['2026-09', '2026-10-01'], ['2026-10', '2026-11-01']]) {
    const run = await api('billrun.prepare', { period })
    for (const draft of (await api(`runs/${run.id}`)).invoices) {
      const invoice = await api(`invoices/${draft.id}`)
      lines[`${period}:${draft.customer_id}`] = [invoice.total_cents, invoice.lines.filter(line => line.kind === 'flat').map(line => [line.amount_cents, line.period_start])]
      if (invoice.total_cents > 0) { await api('invoice.approve', { invoice: draft.id, acknowledge: true }); await api('invoice.finalise', { invoice: draft.id, issue_date: date }) }
    }
  }
  assert.deepEqual(lines[`2026-09:${card.cust}`], [16000, [[16000, '2026-09-15']]], 'the card trial charges from its end date')
  assert.deepEqual(lines[`2026-09:${none.cust}`], [0, []], 'the no-card trial ends unpaid with no charge')
  assert.equal(lines[`2026-10:${none.cust}`], undefined, 'and has no later invoice')
  assert.deepEqual(lines[`2026-09:${ext.cust}`], [0, []], 'no chargeable invoice between the old and new trial end')
  assert.deepEqual(lines[`2026-10:${ext.cust}`], [22258, [[22258, '2026-10-09']]], 'the first charge moves to the new end date')
  assert.deepEqual((await api(`customers/${ext.cust}`)).ledger.invoices.map(row => row.total_cents), [22258], 'the only charging invoice is the one after the new end date')
  await onState({ phase: 'billed', ext, none, card })
  await automaticTrialFlow(h, owner, onState)
  console.log('CAT-005 trials passed')
}


async function automaticTrialFlow(h, owner, onState) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const posts = () => trialEdge.calls.filter(call => call.method === 'POST').length
  const at = '2026-11-05T20:00:00Z'
  await h.advanceClock(at)
  await api('access.give', { email: 'synthetic-nectar-610@example.test', name: 'Synthetic trial finance', role: 'finance' })
  const finance = await h.signIn('synthetic-nectar-610@example.test', { requested: true })
  const agent = { bearer: (await api('credential.issue', { name: 'Synthetic trial observer', scopes: ['prepare'] })).key }
  const product = (await api('product.create', { code: 'synthetic-nectar-611', name: 'Synthetic advance trial service' })).id
  const price = (await api('price.create', { product, kind: 'flat', unit_amount: '300', taxable: false, billing_timing: 'advance' })).id
  const factor = await api('mfa.totp.start', {})
  await api('mfa.totp.confirm', { factor: factor.factor, code: totp(factor.secret, Date.parse(at)) })
  await api('mfa.policy', { scope: 'roles', roles: ['owner'] })
  const rows = []
  for (let n = 0; n < 8; n++) {
    const external = `synthetic-nectar-${620 + n}`
    const customer = (await api('customer.create', { external_id: external, name: `Synthetic trial ${n}`, billing_email: `${external}@example.test` })).id
    const trialEnd = n === 5 ? '2026-11-16' : n === 6 ? '2026-11-17' : '2026-11-15'
    const subscription = (await api('subscription.create', { customer, start_date: '2026-11-01', anchor_day: '1', price: [price], trial_end: trialEnd, trial_payment: 'card' })).id
    const customerRef = `synthetic-nectar-${640 + n}`, methodRef = `synthetic-nectar-${660 + n}`
    trialEdge.customers.set(customerRef, { account: 1, method: methodRef })
    const row = { customer, subscription, customerRef, methodRef, trialEnd }; rows.push(row)
    if (n === 7) {
      assert.equal((await api('trial.collection.prepare', { subscription }, 409)).error, 'native_customer_binding_required', 'A recorded card choice is never a verified saved method')
      continue
    }
    await api('collection.customer.bind', { customer, account_ref: 'synthetic-nectar-600', stripe_customer_ref: customerRef, confirm: true })
    row.authorization = await api('trial.collection.prepare', { subscription })
    assert.equal(row.authorization.status, 'pending_owner')
    if (n === 0) await onState({ phase: 'trial-collection', stage: 'quote', subscription, row })
    assert.equal(posts(), 0, 'Preparation and processor card verification never charge')
    if (n === 3) continue
    const confirmation = row.authorization.instructions.confirm
    await api('trial.collection.confirm', { ...confirmation, amount_cents: confirmation.amount_cents + 1 }, 409)
    row.authorization = await api('trial.collection.confirm', confirmation)
    assert.equal(row.authorization.status, 'pending_approval')
    await api('trial.collection.approve', { request: row.authorization.id, basis_hash: row.authorization.basis, decision: 'approved' }, 409)
    row.authorization = await h.api('trial.collection.approve', finance, { request: row.authorization.id, basis_hash: row.authorization.basis, decision: 'approved' })
    assert.equal(row.authorization.status, 'active')
    if (n === 0) await onState({ phase: 'trial-collection', stage: 'active', subscription, row })
  }
  for (const who of [finance, agent, undefined]) await h.api('trial.collection.prepare', who, {}, who ? 403 : 401)
  await h.api('trial-collections', agent, undefined, 403)
  const [first, extended, changed, unconfirmed, revoked, unknown, skipped, placeholder] = rows
  const previous = extended.authorization
  await api('trial.extend', { subscription: extended.subscription, days: 14 })
  assert.equal((await api(`trial-collections?subscription=${extended.subscription}`))[0].status, 'invalidated')
  await onState({ phase: 'trial-collection', stage: 'invalidated', subscription: extended.subscription, row: extended })
  await api('trial.collection.confirm', previous.instructions.confirm ?? { request: previous.id }, 409)
  extended.trialEnd = '2026-11-29'
  const renewed = await api('trial.collection.prepare', { subscription: extended.subscription })
  const consent = await api('trial.collection.confirm', renewed.instructions.confirm)
  extended.authorization = await h.api('trial.collection.approve', finance, { request: consent.id, basis_hash: consent.basis, decision: 'approved' })
  assert.equal(extended.authorization.quote.chargeDate, '2026-11-29')
  await api('trial.collection.revoke', { request: revoked.authorization.id })
  trialEdge.customers.get(changed.customerRef).method = 'synthetic-nectar-699'
  await onState({ phase: 'trial-authorized', row: first, ext: extended })
  const tick = async instant => {
    await h.advanceClock(instant); trialEdge.capturedAt(instant)
    assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse(instant)}&cron=${encodeURIComponent('0 14 * * *')}`)).status, 200)
  }
  const view = async row => (await api(`trial-collections?subscription=${row.subscription}`)).find(saved => saved.id === row.authorization.id)
  await tick('2026-11-15T20:00:00Z')
  const captured = await view(first)
  assert.equal(captured.status, 'collected', 'The authorized saved card is captured on the trial end date despite expired interactive MFA freshness')
  assert.equal(posts(), 1)
  const invoice = await api(`invoices/${captured.invoice}`)
  assert.equal(invoice.issue_date, '2026-11-15')
  assert.equal(invoice.balanceCents, 0)
  assert.equal(invoice.paidCents, captured.quote.amountCents)
  assert.equal(invoice.lines.find(line => line.kind === 'flat').period_start, '2026-11-15')
  const receipt = (await api('payments')).find(payment => payment.customer_id === first.customer)
  assert.equal(receipt.received_on, '2026-11-15')
  assert.equal((await view(changed)).status, 'invalidated')
  assert.equal((await view(unconfirmed)).status, 'pending_owner')
  assert.equal((await view(revoked)).status, 'revoked')
  assert.equal((await api(`customers/${placeholder.customer}`)).ledger.invoices.length, 0)
  assert.equal((await api(`customers/${extended.customer}`)).ledger.invoices.length, 0, 'There is no invoice at the previous end date after extension')
  await tick('2026-11-15T21:00:00Z')
  assert.equal(posts(), 1, 'Scheduled replay does not capture again')
  await onState({ phase: 'trial-collected', row: first, captured, invoice })
  await onState({ phase: 'trial-collection', stage: 'collected', subscription: first.subscription, row: first, captured, invoice })
  trialEdge.losePayment()
  await tick('2026-11-16T20:00:00Z')
  const uncertain = await view(unknown)
  assert.equal(uncertain.status, 'uncertain')
  assert.equal((await api(`invoices/${uncertain.invoice}`)).paidCents, 0)
  const claims = posts()
  await tick('2026-11-18T20:00:00Z')
  assert.equal((await view(skipped)).status, 'expired', 'Missing the approved exact date never permits a catch-up debit')
  assert.equal(posts(), claims, 'Unknown results are never automatically retried')
  await tick('2026-11-29T20:00:00Z')
  const moved = await view(extended)
  assert.equal(moved.status, 'collected')
  assert.equal((await api(`invoices/${moved.invoice}`)).issue_date, '2026-11-29')
  assert.equal((await api(`customers/${extended.customer}`)).ledger.invoices.length, 1)
  assert.equal(posts(), claims + 1, 'Only explicit renewed approval charges at the extended date')
}
