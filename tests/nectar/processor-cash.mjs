// Public Worker journey; only the Stripe network is substituted.
import assert from 'node:assert/strict'
import { nativeCollectionEdge } from './native-collection.mjs'
import { totp } from './mfa.mjs'
import { processorCashReturnEdge, processorCashReturnFlow } from './processor-cash-return.mjs'

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
    fund(customer, amount, reference = '') { transaction(customer, amount, 'funded', { funded: { bank_transfer: { type: 'us_bank_transfer', reference, us_bank_transfer:{network:'ach',sender_name:'Synthetic transfer sender'} } } }); return event(customer) } }
}

let edge
export const cashTestEdge=()=>edge
export const harnessOptions = () => {
  edge = processorCashReturnEdge(processorCashEdge())
  return { localTime: '2026-10-28T10:00:00Z', stripeFetch: edge.fetch, stripeSecret: 'synthetic-nectar-1', stripeSecondarySecret: 'synthetic-nectar-2' }
}
export async function processorCashFlow(h, owner, { cashEdge = edge, onState=async()=>{},allocate } = {}) {
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
  const cadence=await api('cadence.policy.prepare',{enabled:true,require_human:false,rules:[{segment:'cash-transfer',minimum_cents:0,subject:'Invoice {invoice}: {balance}',body:'Please arrange the recorded transfer for {invoice}: {balance}.'}]})
  const me=(await api('me')).id,otherApprover=(await api('members')).find(row=>row.id!==me&&row.status==='active'&&['owner','finance'].includes(row.role))
  const cadenceApprover=otherApprover?await h.signIn(otherApprover.email):owner
  await h.api('cadence.policy.decide',cadenceApprover,{request:cadence.request,decision:'approved',confirm_single:!otherApprover})
  for(const issued of [byReference,byAmount,unknown])await api('cadence.enroll',{invoice:issued.id,segment:'cash-transfer',transfer_terms:'Synthetic signed transfer terms, Net30'})
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
  const short = await invoice('90')
  await apply(cashEdge.fund(remote, 3500, short.number))
  assert.deepEqual([(await api(`invoices/${short.id}`)).paidCents,(await api(`invoices/${short.id}`)).balanceCents],[3500,5500], 'A referenced short transfer leaves precisely the unpaid remainder')
  await h.advanceClock('2026-10-28T10:01:00Z')
  const oldest = await invoice('45')
  await h.advanceClock('2026-10-28T10:02:00Z')
  const newer = await invoice('45')
  await apply(cashEdge.fund(remote,4500))
  assert.equal((await api(`invoices/${oldest.id}`)).balanceCents,0,'An unreferenced exact transfer chooses the oldest open matching invoice')
  assert.equal((await api(`invoices/${newer.id}`)).balanceCents,4500)
  const callsBeforeAmbiguous=cashEdge.cashCalls.length
  const ambiguous=cashEdge.fund(remote,1000,`${short.number} and ${newer.number}`)
  await apply(ambiguous);await apply(ambiguous)
  assert.equal(cashEdge.cashCalls.length,callsBeforeAmbiguous,'Ambiguous invoice references cannot fall through to an automatic amount match')
  assert.equal((await api(`invoices/${short.id}`)).balanceCents,5500)
  assert.equal((await api(`invoices/${newer.id}`)).balanceCents,4500)
  const other=(await api('customer.create',{external_id:'synthetic-nectar-cash-peer',name:'Other transfer customer',billing_email:'other-cash@example.test'})).id
  const otherCharge=(await api('charge.add',{customer:other,amount:'80',description:'Separate customer service',effective_date:'2026-10-28',taxable:false})).charge
  const otherInvoice=(await api('invoice.manual',{customer:other,charges:[otherCharge],service_date:'2026-10-28'})).id
  await api('invoice.approve',{invoice:otherInvoice,acknowledge:true});await api('invoice.finalise',{invoice:otherInvoice,issue_date:'2026-10-28'})
  await apply(cashEdge.fund(remote,8000,(await api(`invoices/${otherInvoice}`)).number))
  assert.equal((await api(`invoices/${otherInvoice}`)).balanceCents,8000,'A customer cash account never pays another customer invoice')
  assert.equal(cashEdge.cashCalls.length,callsBeforeAmbiguous)
  const unmatchedState=await api(`processor-events?customer=${customer}`)
  assert.equal(unmatchedState.cashBalances.find(row=>row.currency==='usd').amount_cents,9000)
  assert.deepEqual(unmatchedState.cashApplications.filter(row=>row.invoice_id===short.id).map(row=>row.amount_cents),[3500])
  assert.deepEqual(unmatchedState.unmatched.map(row=>row.amount_cents).sort((a,b)=>a-b),[1000,8000],'Unmatched funds enter the receivables queue with their exact remaining amounts')
  const transfer=unmatchedState.unmatched.find(row=>row.amount_cents===8000)
  assert.equal(transfer.reference,(await api(`invoices/${otherInvoice}`)).number)
  assert.equal(transfer.sender,'Synthetic transfer sender');assert.equal(transfer.occurred_at,instant)
  const desk=await h.page('/app/receivables',owner)
  assert.ok(desk.includes(transfer.id),'The ordinary receivables desk links to the exact unmatched transfer')
  const allocation={customer,account_ref:account,transfer_ref:transfer.transfer_ref,invoice:newer.id,amount:'45',confirm:true}
  const writesBeforeManual=cashEdge.cashCalls.length
  await api('processor.cash.allocate',{...allocation,invoice:otherInvoice},409)
  assert.equal(cashEdge.cashCalls.length,writesBeforeManual,'A manual choice still cannot cross customer custody')
  const email='synthetic-nectar-cash-readonly@example.test'
  await api('access.give',{email,name:'Read only cash observer',role:'accountant'})
  const readonly=await h.signIn(email,{requested:true})
  await h.api('processor.cash.allocate',readonly,allocation,403)
  const allocated=allocate?await allocate(allocation):await api('processor.cash.allocate',allocation)
  assert.equal(allocated.status,'collected')
  const replay=await api('processor.cash.allocate',allocation)
  assert.equal(replay.replayed,true)
  assert.equal(cashEdge.cashCalls.length,writesBeforeManual+1,'Human allocation and its duplicate create exactly one processor cash payment')
  assert.equal((await api(`invoices/${newer.id}`)).balanceCents,0)
  assert.equal((await api(`invoices/${otherInvoice}`)).balanceCents,8000)
  assert.equal(cashEdge.available(remote),4500)
  const taskStart=(await api('tasks')).length
  for(const [day,expected] of [['2026-11-03',0],['2026-11-04',1],['2026-11-27',2],['2026-12-27',3]]){
    const clock=`${day}T10:00:00Z`;await h.advanceClock(clock)
    for(let repeat=0;repeat<2;repeat++)assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse(clock)}&cron=${encodeURIComponent('0 14 * * *')}`)).status,200)
    const tasks=(await api('tasks')).slice(0).filter(row=>row.customer_id===customer&&row.title.startsWith('Unapplied bank transfer:'))
    assert.equal(tasks.length,expected,'Each due escalation produces exactly one owner task despite repeated ticks')
  }
  assert.ok((await api('tasks')).length>=taskStart+3)
  const escalations=(await api('audit')).filter(row=>row.action==='processor.cash.escalate').map(row=>JSON.parse(row.detail))
  assert.deepEqual(escalations.map(row=>row.ageDays).sort((a,b)=>a-b),[7,30,60])
  assert.deepEqual([...new Set(escalations.map(row=>row.assignedOwner))],[me],'Each escalation is assigned to the actual active owner')
  await api('mfa.verify',{code:totp(factor.secret,Date.parse('2026-12-27T10:00:00Z'))})
  const remaining=(await api(`processor-events?customer=${customer}`)).unmatched
  assert.equal(remaining.length,1);assert.equal(remaining[0].amount_cents,4500)
  const finalAllocation={...allocation,transfer_ref:remaining[0].transfer_ref,invoice:short.id}
  await api('processor.cash.allocate',finalAllocation);await api('processor.cash.allocate',finalAllocation)
  assert.deepEqual([(await api(`invoices/${short.id}`)).paidCents,(await api(`invoices/${short.id}`)).balanceCents],[8000,1000])
  await h.advanceClock('2027-01-12T10:00:00Z')
  assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse('2027-01-12T10:00:00Z')}&cron=${encodeURIComponent('0 14 * * *')}`)).status,200)
  await apply(cashEdge.event(remote))
  assert.equal(cashEdge.available(remote),0,'Before and after day 76 the processor holds no unapplied transfer funds')
  assert.equal((await api(`processor-events?customer=${customer}`)).unmatched.length,0)
  assert.equal([...cashEdge.cashTransactions.values()].filter(row=>row.type!=='funded'&&row.type!=='applied_to_payment').length,0,'No transfer was returned by the processor')
  const cadenceState=await api('cadences'),paidIds=[byReference.id,byAmount.id,unknown.id]
  assert.equal(cadenceState.invoices.filter(row=>paidIds.includes(row.id)&&row.segment==='cash-transfer').length,3,'Paid transfer invoices retain their real prior collection enrollment')
  assert.equal(cadenceState.deliveries.filter(row=>paidIds.includes(row.invoice_id)).length,0,'Actual payment stops every enrolled transfer invoice before a reminder is reserved')
  assert.equal((await api('dunning')).series.filter(row=>paidIds.includes(row.invoice)).length,0)
  await h.advanceClock('2026-10-28T10:02:00Z')
  await onState({customer})
  return { customer, invoices: [byReference.id, byAmount.id, unknown.id,short.id,oldest.id,newer.id], unappliedCents: 0 }
}

if(process.argv[1]===new URL(import.meta.url).pathname){
 const {processorSetup}=await import('./processor-events.mjs')
 const options=harnessOptions(),{h,owner}=await processorSetup(undefined,options)
 try {await processorCashFlow(h,owner);await processorCashReturnFlow(h,owner,{cashReturnEdge:edge});console.log('Processor cash: matching, manual allocation, escalation, returns, complete history and uncertainty reconciliation passed')} finally {await h.close()}
}
