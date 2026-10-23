import { assertCurrencyAggregateReports } from './currency-aggregate-reports.mjs'
// Public Worker/auth/catalogue/invoice/payment/report doors; fake only Stripe.
import assert from 'node:assert/strict'
import { applyPolicy, reviewer } from './policy-helper.mjs'
import { totp } from './mfa.mjs'

export function currencyEdge() {
  const calls = [], intents = new Map(), charges = new Map()
  const fetch = async request => {
    const url = new URL(request.url), path = url.pathname.slice(3), method = request.method
    assert.equal(request.headers.get('authorization'), 'Bearer synthetic-nectar-101')
    const form = method === 'POST' ? new URLSearchParams(await request.text()) : null
    calls.push({ path, method, currency: form?.get('currency') })
    if (path === '/account') return Response.json({ object: 'account', id: 'synthetic-nectar-102' })
    if (path === '/customers/synthetic-nectar-103') return Response.json({ object: 'customer', id: 'synthetic-nectar-103', livemode: false, invoice_settings: { default_payment_method: 'synthetic-nectar-104' } })
    if (path === '/payment_methods/synthetic-nectar-104') return Response.json({ object: 'payment_method', id: 'synthetic-nectar-104', customer: 'synthetic-nectar-103', type: 'card', livemode: false, card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2035 } })
    if (path === '/payment_intents' && method === 'POST') {
      assert.equal(form.get('currency'), 'cad'); assert.equal(form.get('amount'), '899')
      assert.equal(form.get('customer'), 'synthetic-nectar-103'); assert.equal(form.get('payment_method'), 'synthetic-nectar-104')
      assert.equal(intents.size, 0, 'Exactly one CAD capture is requested')
      const id = 'synthetic-nectar-105', charge = 'synthetic-nectar-106', created = Date.parse('2026-10-23T10:00:00Z') / 1000
      const intent = { object: 'payment_intent', id, created, status: 'succeeded', customer: form.get('customer'), payment_method: form.get('payment_method'), currency: form.get('currency'), amount: Number(form.get('amount')), amount_received: Number(form.get('amount')), livemode: false, latest_charge: charge,
        metadata: Object.fromEntries([...form].filter(([name]) => name.startsWith('metadata[')).map(([name, value]) => [name.slice(9, -1), value])) }
      intents.set(id, intent)
      charges.set(charge, { object: 'charge', id: charge, status: 'succeeded', paid: true, captured: true, customer: intent.customer, payment_method: intent.payment_method, payment_intent: id, currency: intent.currency, amount: intent.amount, amount_captured: intent.amount, amount_refunded: 0, refunded: false, disputed: false, created, livemode: false })
      return Response.json(intent)
    }
    if (path === '/charges') return Response.json({ object: 'list', has_more: false, data: [...charges.values()].filter(row => row.payment_intent === url.searchParams.get('payment_intent')) })
    if (path === '/payment_intents/search') return Response.json({ object: 'search_result', has_more: false, data: [...intents.values()] })
    if (path === '/payment_intents') return Response.json({ object: 'list', has_more: false, data: [...intents.values()] })
    if (path.startsWith('/payment_intents/')) return Response.json(intents.get(path.split('/').at(-1)))
    throw new Error(`Unexpected Stripe test edge request: ${method} ${path}`)
  }
  return { fetch, calls, intents, charges }
}
export const edge = currencyEdge()
export const harnessOptions = () => ({ stripeFetch: edge.fetch, stripeSecret: 'synthetic-nectar-101', localTime: '2026-10-23T10:00:00Z' })

export async function currencyFlow(h, owner,{onState=async()=>{},confirmCollection,recordRate}={}) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  await h.advanceClock('2026-10-23T10:00:00Z')
  await api('business.configure', { ...await api('business'), timezone: 'UTC',payment_terms_days:1 })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'no_tax', tax_note: 'Synthetic multi-currency acceptance fixture' })
  await api('tax.review', { revision: (await api('business')).revision })
  const product = (await api('product.create', { code: 'synthetic-nectar-107', name: 'Synthetic CAD service' })).id
  const cad = (await api('price.create', { product, kind: 'flat', unit_amount: '10.00', currency: 'CAD', taxable: false })).id
  const usdRequest = await api('price.create', { product, kind: 'flat', unit_amount: '7.35', currency: 'USD', taxable: false })
  const saved = (await api('catalog')).priceRequests.find(row => row.id === usdRequest.request)
  const priceApprover = await reviewer(h, owner, saved.singleAllowed)
  const usd = (await h.api('price.decide', priceApprover, { request: usdRequest.request, decision: 'approved', confirm_single: saved.singleAllowed })).id
  const customer = (await api('customer.create', { external_id: 'synthetic-nectar-108', name: 'Synthetic Canadian customer', billing_email: 'synthetic-nectar-108@example.test', address: '1 Synthetic Way, Toronto, CA', currency: 'CAD' })).id
  const defaultCustomer = (await api('customer.create', { external_id: 'synthetic-nectar-109', name: 'Synthetic USD customer', billing_email: 'synthetic-nectar-109@example.test' })).id
  assert.equal((await api(`customers/${defaultCustomer}`)).currency, 'USD')
  await api('subscription.create', { customer, start_date: '2026-09-01', price: [usd] }, 409)
  await api('subscription.create', { customer: defaultCustomer, start_date: '2026-09-01', price: [cad] }, 409)
  await api('charge.add', { customer, price: usd, effective_date: '2026-09-01' }, 409)
  const sub = await api('subscription.create', { customer, start_date: '2026-09-01', price: [cad] })
  const record = await api(`customers/${customer}`)
  await api('customer.update', { customer, revision: record.revision, name: record.name, billing_email: record.billing_email, currency: 'USD' }, 409)
  const run = await api('billrun.prepare', { period: '2026-09' })
  const invoice = (await api(`runs/${run.id}`)).invoices.find(row => row.customer_id === customer)
  assert.equal(invoice.currency, 'CAD'); assert.equal(invoice.total_cents, 1000)
  await api('invoice.approve', { invoice: invoice.id, acknowledge: true })
  await api('invoice.finalise', { invoice: invoice.id, issue_date: '2026-10-01' })
  const original = await api(`invoices/${invoice.id}`)
  await api('reports/currency?from=2026-10-01&to=2026-10-23', undefined, 409)
  await api('ageing',undefined,409)
  await api('reminder.prepare',{customer},409)
  await api('cadence.enroll',{invoice:invoice.id,segment:'synthetic-nectar-113',transfer_terms:'Synthetic unsupported foreign reminder'},409)
  await onState({stage:'missing-rate',customer,invoice:invoice.id,run:run.id})
  await api('access.give',{email:'synthetic-nectar-112@example.test',name:'Synthetic currency finance',role:'finance'})
  const finance=await h.signIn('synthetic-nectar-112@example.test',{requested:true})
  await h.api('currency.rate.record',finance,{},403)
  assert.ok((await h.page('/app',owner)).includes('CAD 10.00'),'Outstanding work never labels CAD as USD')
  for (const rate_date of ['2026-10-01', '2026-10-23']){const payload={currency:'CAD',rate_date,usd_per_unit:'0.735055',source:'Synthetic finance worksheet synthetic-nectar-110; test-only rate'};if(recordRate)await recordRate(payload);else await api('currency.rate.record',payload)}
  await api('currency.rate.record', { currency: 'CAD', rate_date: '2026-10-01', usd_per_unit: '0.80', source: 'Synthetic duplicate rate' }, 409)
  await api('credit.issue', { invoice: invoice.id, amount: '1.01', currency: 'USD', reason: 'Synthetic mismatch refusal' }, 409)
  await api('credit.issue', { invoice: invoice.id, amount: '1.01', reason: 'Synthetic CAD adjustment' })
  await api('payment.record', { customer, currency: 'USD', amount: '8.99', received_on: '2026-10-23', method: 'bank_transfer', reference: 'synthetic-nectar-111' }, 409)
  const started = await api('mfa.totp.start', {})
  await api('mfa.totp.confirm', { factor: started.factor, code: totp(started.secret, Date.parse('2026-10-23T10:00:00Z')) })
  await api('mfa.policy', { scope: 'all' })
  await api('collection.customer.bind', { customer, account_ref: 'synthetic-nectar-102', stripe_customer_ref: 'synthetic-nectar-103', confirm: true })
  const prepared = await api('collection.prepare', { invoice: invoice.id })
  assert.equal(prepared.review.currency, 'cad')
  await onState({stage:'review',customer,invoice:invoice.id,run:run.id})
  const collection = confirmCollection?await confirmCollection({invoice:invoice.id,prepared}):await api('collection.confirm', prepared.instructions.confirm)
  assert.equal(collection.status, 'collected'); assert.equal(collection.proof.currency, 'cad')
  await api('collection.confirm', prepared.instructions.confirm, 409)
  const final = await api(`invoices/${invoice.id}`), ledger = (await api(`customers/${customer}`)).ledger
  assert.equal(final.currency, 'CAD'); assert.equal(final.total_cents, 1000); assert.equal(final.balanceCents, 0)
  assert.deepEqual(final.lines, original.lines); assert.deepEqual(final.calculation, original.calculation)
  assert.equal(final.source_fingerprint, original.source_fingerprint)
  assert.equal(ledger.currency, 'CAD'); assert.equal(ledger.payments[0].currency, 'CAD'); assert.equal(ledger.credits[0].currency, 'CAD')
  assert.equal(ledger.payments[0].amount_cents, 899); assert.equal(ledger.credits[0].amount_cents, 101)
  const report = await api('reports/currency?from=2026-10-01&to=2026-10-23')
  assert.deepEqual(report.totals, { invoice: 735, payment: 661, credit: 74 })
  for (const row of report.transactions) { assert.equal(row.currency, 'CAD'); assert.equal(row.reporting.currency, 'USD'); assert.equal(row.reporting.rate, '0.735055'); assert.equal(row.reporting.rateDate, row.transaction_date); assert.match(row.reporting.source, /Synthetic finance worksheet/) }
  for(const metric of ['ar','mrr','unbilled','credit-balances'])await api(`reports/${metric}`,undefined,409)
  await h.page('/app/reports/currency',owner)
  await onState({stage:'collected',customer,invoice:invoice.id,run:run.id})
  const financeFactor=await h.api('mfa.totp.start',finance,{})
  await h.api('mfa.totp.confirm',finance,{factor:financeFactor.factor,code:totp(financeFactor.secret,Date.parse('2026-10-23T10:00:00Z'))})
  const aggregates=await assertCurrencyAggregateReports(h,owner,{customer,invoice:invoice.id,usdCustomer:defaultCustomer,recordRate,finance})
  await onState({stage:'aggregate',customer,invoice:invoice.id,run:run.id,aggregates})
  assert.equal((await api(`subscriptions/${sub.id}`)).currency, 'CAD')
  return { customer, invoice: invoice.id, collection: collection.id }
}
