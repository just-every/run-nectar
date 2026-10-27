// Public Worker journey; only the Stripe network is substituted.
import assert from 'node:assert/strict'
import { nativeCollectionEdge } from './native-collection.mjs'
import { totp } from './mfa.mjs'

export function processorCashEdge(base = nativeCollectionEdge()) {
  const transactions = new Map(), events = new Map(), intents = new Map(), charges = new Map(), calls = []
  let loseNext = false, sequence = 0
  const created = Date.parse('2026-10-28T10:00:00Z') / 1000
  const balances = new Map()
  function transaction(customer, amount, type, detail = {}) {
    const balance = (balances.get(customer) ?? 0) + amount
    balances.set(customer, balance)
    const row = { object: 'customer_cash_balance_transaction', id: `synthetic-nectar-cash-transaction-${++sequence}`,
      customer, currency: 'usd', livemode: false, net_amount: amount, ending_balance: balance, type, created, ...detail }
    transactions.set(row.id, row)
    return row
  }
  const list = (rows, url) => {
    const cursor = url.searchParams.get('starting_after'), from = cursor ? rows.findIndex(row => row.id === cursor) + 1 : 0
    assert.ok(!cursor || from > 0)
    // Short pages deliberately exercise completion rather than trusting limit.
    return Response.json({ object: 'list', data: rows.slice(from, from + 2), has_more: from + 2 < rows.length })
  }
  const fetch = async request => {
    const url = new URL(request.url), path = url.pathname.replace('/v1', '')
    if (path.startsWith('/events/') && events.has(path.split('/').at(-1))) return Response.json(events.get(path.split('/').at(-1)))
    const cashPath = path.match(/^\/customers\/([^/]+)\/(cash_balance|cash_balance_transactions)$/)
    if (cashPath) {
      const customer = cashPath[1]
      assert.equal(request.method, 'GET')
      if (cashPath[2] === 'cash_balance') return Response.json({ object: 'cash_balance', customer, livemode: false,
        available: balances.get(customer)?{usd:balances.get(customer)}:{}, settings: { reconciliation_mode: 'manual' } })
      return list([...transactions.values()].filter(row => row.customer === customer).reverse(), url)
    }
    if (path === '/payment_intents' && request.method === 'POST') {
      const form = new URLSearchParams(await request.clone().text())
      if (form.get('payment_method_data[type]') !== 'customer_balance') return base.fetch(request)
      calls.push({ path, form })
      assert.equal(form.get('receipt_email'), null)
      assert.equal(form.get('confirm'), 'true')
      assert.equal(form.get('payment_method_types[]'), 'customer_balance')
      const customer = form.get('customer'), amount = Number(form.get('amount'))
      assert.ok(amount <= (balances.get(customer) ?? 0))
      const id = `synthetic-nectar-cash-intent-${intents.size + 1}`, chargeRef = `synthetic-nectar-cash-charge-${intents.size + 1}`
      const intent = { object: 'payment_intent', id, customer, currency: 'usd', amount, amount_received: amount, amount_capturable: 0,
        status: 'succeeded', livemode: false, created, latest_charge: chargeRef, payment_method_types: ['customer_balance'],
        metadata: Object.fromEntries([...form].filter(([key]) => key.startsWith('metadata[')).map(([key, value]) => [key.slice(9, -1), value])) }
      intents.set(id, intent)
      charges.set(chargeRef, { object: 'charge', id: chargeRef, customer, payment_intent: id, status: 'succeeded', paid: true, captured: true,
        amount, amount_captured: amount, amount_refunded: 0, refunded: false, disputed: false, currency: 'usd', livemode: false, created,
        payment_method_details: { type: 'customer_balance', customer_balance: {} } })
      transaction(customer, -amount, 'applied_to_payment', { applied_to_payment: { payment_intent: id } })
      if (loseNext) { loseNext = false; return Response.json({ error: { type: 'api_error' } }, { status: 503 }) }
      return Response.json(intent)
    }
    if (path === '/payment_intents' && request.method === 'GET' && !url.searchParams.has('created[gte]'))
      return list([...intents.values()].filter(row => row.customer === url.searchParams.get('customer')).reverse(), url)
    if (path.startsWith('/payment_intents/') && intents.has(path.split('/').at(-1))) return Response.json(intents.get(path.split('/').at(-1)))
    if (path === '/charges' && [...intents.keys()].includes(url.searchParams.get('payment_intent')))
      return list([...charges.values()].filter(row => row.payment_intent === url.searchParams.get('payment_intent')), url)
    return base.fetch(request)
  }
  const event = customer => {
    const id = `synthetic-nectar-cash-event-${events.size + 1}`
    events.set(id, { object: 'event', id, type: 'cash_balance.funds_available', created, livemode: false,
      data: { object: { object: 'cash_balance', customer, available: { usd: balances.get(customer) ?? 0 }, livemode: false } } })
    return id
  }
  return { ...base, fetch, cashCalls: calls, cashEvents: events, cashTransactions: transactions, cashIntents: intents,
    available: customer => balances.get(customer) ?? 0, consumeOutside(customer){transaction(customer,-balances.get(customer),'applied_to_payment',{applied_to_payment:{payment_intent:'synthetic-nectar-outside-intent'}})}, loseCashResponse() { loseNext = true }, event,
    fund(customer, amount, reference = '') { transaction(customer, amount, 'funded', { funded: { bank_transfer: { type: 'us_bank_transfer', reference } } }); return event(customer) } }
}

let edge
export const harnessOptions = () => {
  edge = processorCashEdge()
  return { localTime: '2026-10-28T10:00:00Z', stripeFetch: edge.fetch, stripeSecret: 'synthetic-nectar-1', stripeSecondarySecret: 'synthetic-nectar-2' }
}
export async function processorCashFlow(h, owner, { cashEdge = edge, onState=async()=>{} } = {}) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const instant = Date.parse('2026-10-28T10:00:00Z')
  await h.advanceClock(new Date(instant).toISOString())
  const factor = await api('mfa.totp.start', {})
  await api('mfa.totp.confirm', { factor: factor.factor, code: totp(factor.secret, instant) })
  await api('business.configure', { ...await api('business'), timezone: 'UTC' })
  const customer = (await api('customer.create', { external_id: 'synthetic-nectar-cash-1', name: 'Processor cash customer', billing_email: 'cash@example.test' })).id
  const remote = 'synthetic-nectar-native-customer-1', account = 'synthetic-nectar-native-account-1'
  await api('collection.customer.bind', { customer, account_ref: account, stripe_customer_ref: remote, confirm: true })
  const invoice = async amount => {
    const charge = await api('charge.add', { customer, amount, description: 'Cash application service', effective_date: '2026-10-28', taxable: false })
    const draft = await api('invoice.manual', { customer, charges: [charge.charge], service_date: '2026-10-28' })
    await api('invoice.approve', { invoice: draft.id, acknowledge: true })
    await api('invoice.finalise', { invoice: draft.id, issue_date: '2026-10-28' })
    return api(`invoices/${draft.id}`)
  }
  const byReference = await invoice('100'), byAmount = await invoice('125'), unknown = await invoice('150')
  const apply = event_ref => api('processor.event.consume', { account_ref: account, event_ref })
  // The reference wins over a different exact-amount candidate.
  const competing = await invoice('110')
  const first = cashEdge.fund(remote, 11000, `Payment ${byReference.number}`)
  await apply(first)
  assert.equal((await api(`invoices/${byReference.id}`)).paidCents, 10000)
  assert.equal((await api(`invoices/${competing.id}`)).paidCents, 0)
  assert.equal(cashEdge.available(remote), 1000)
  await apply(first)
  assert.equal(cashEdge.cashCalls.length, 1, 'Event replay never applies the same transfer again')
  const exact = cashEdge.fund(remote, 12500)
  await apply(exact)
  assert.equal((await api(`invoices/${byAmount.id}`)).paidCents, 12500)
  assert.equal((await api(`invoices/${byAmount.id}`)).allocations.length, 1)
  const unmatched = cashEdge.fund(remote, 700)
  await apply(unmatched)
  assert.equal(cashEdge.available(remote), 1700)
  assert.equal(cashEdge.cashCalls.length, 2, 'Unmatched processor money remains unapplied')
  cashEdge.loseCashResponse()
  await apply(cashEdge.fund(remote, 15000, unknown.number))
  assert.equal((await api(`invoices/${unknown.id}`)).paidCents, 0, 'An unknown create response cannot manufacture cash evidence')
  await apply(cashEdge.event(remote))
  assert.equal((await api(`invoices/${unknown.id}`)).paidCents, 15000)
  assert.equal((await api(`invoices/${unknown.id}`)).allocations.length, 1)
  assert.equal(cashEdge.cashCalls.length, 3, 'Unknown recovery only reads the original intent')
  assert.equal(cashEdge.available(remote), 1700)
  const beforeZero=await api(`processor-events?customer=${customer}`)
  assert.equal(beforeZero.cashBalances.find(row=>row.currency==='usd').amount_cents,1700)
  cashEdge.consumeOutside(remote)
  await apply(cashEdge.event(remote))
  const observed=await api(`processor-events?customer=${customer}`)
  assert.equal(cashEdge.available(remote),0)
  assert.deepEqual(observed.cashBalances.map(row=>[row.currency,row.amount_cents]),[['usd',0]],'An empty provider available map clears the previously observed balance')
  assert.equal(cashEdge.cashCalls.length,3,'Observing externally consumed funds creates no payment intent')
  await onState({customer})
  return { customer, invoices: [byReference.id, byAmount.id, unknown.id], unappliedCents: 1700 }
}

if(process.argv[1]===new URL(import.meta.url).pathname){
 const {processorSetup}=await import('./processor-events.mjs')
 const options=harnessOptions(),{h,owner}=await processorSetup(undefined,options)
 try {await processorCashFlow(h,owner);console.log('Processor cash: exact matching, duplicate events, complete history, unapplied balance and unknown-response reconciliation passed')} finally {await h.close()}
}
