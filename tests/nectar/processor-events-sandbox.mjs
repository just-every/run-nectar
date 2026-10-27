// Held-key Stripe test proof. Prints typed results only, never raw payloads.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { stripeSandbox, safeError, reference } from './stripe-sandbox-client.mjs'
import { processorSetup } from './processor-events.mjs'
import { proveImportedCash } from './processor-cash-imported-sandbox.mjs'
const stripe=stripeSandbox(process.env.STRIPE_SECRET_KEY)
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
let h,remote,phase='account'
const results=[]
async function provePayout(account,api) {
 const payouts=(await stripe.list('/v1/payouts')).data.filter(row=>row.automatic===true&&row.method==='standard'&&row.reconciliation_status==='completed')
 assert.ok(payouts.length,'A genuine reconciled automatic payout is required')
 const events=(await stripe.list('/v1/events',{type:'payout.paid'})).data
 const event=events.find(row=>payouts.some(payout=>payout.id===row.data?.object?.id))
 assert.ok(event,'A genuine paid-payout event is required')
 const payout=payouts.find(row=>row.id===event.data.object.id)
 const debit=await stripe.request('GET',`/v1/balance_transactions/${reference(payout.balance_transaction)}`)
 const members=(await stripe.list('/v1/balance_transactions',{payout:payout.id})).data.filter(row=>row.id!==debit.id)
 assert.ok(members.length,'The automatic payout has actual constituents')
 assert.equal(members.reduce((sum,row)=>sum+row.net,0),payout.amount)
 await api('processor.event.consume',{account_ref:account.id,event_ref:event.id})
 assert.equal((await api('processor.event.consume',{account_ref:account.id,event_ref:event.id})).replayed,true)
 const ledger=await api('processor-events')
 const observed=ledger.transactions.filter(row=>row.payout_ref===payout.id)
 const actual=observed.map(row=>[row.transaction_ref,row.amount_cents,row.fee_cents,row.net_cents,row.currency]).sort()
 const expected=[...members,debit].map(row=>[row.id,row.amount,row.fee,row.net,row.currency]).sort()
 assert.deepEqual(actual,expected,'Every actual payout constituent and its debit reconcile exactly')
 assert.equal(debit.amount,-payout.amount)
 return {kind:'automatic_payout',payout:payout.id,eventRef:event.id,members:members.length,payoutCents:payout.amount,constituentNetCents:members.reduce((sum,row)=>sum+row.net,0),currency:payout.currency}
}
try {
 const account=await stripe.request('GET','/v1/account');assert.equal(account.country,'US')
 const setup=await processorSetup(undefined,{localTime:undefined,stripeFetch:request=>stripe.forward(request),stripeSecret:process.env.STRIPE_SECRET_KEY})
 h=setup.h;const owner=setup.owner,api=(path,body,status)=>h.api(path,owner,body,status)
 if(process.argv[2]==='payout'){phase='automatic-payout';results.push(await provePayout(account,api));assert.equal(stripe.counts.POST,0,'Payout proof makes no provider writes')}else{
 remote=await stripe.request('POST','/v1/customers',{name:`Synthetic Nectar events ${stripe.run}`,'cash_balance[settings][reconciliation_mode]':'manual'})
 const customer=(await api('customer.create',{external_id:`synthetic-nectar-${stripe.run}`,name:'Nectar processor sandbox',billing_email:'processor@example.test'})).id
 await api('collection.customer.bind',{customer,account_ref:account.id,stripe_customer_ref:remote.id,confirm:true})
 const issue=async(amount,label)=>{
  const day=new Date().toISOString().slice(0,10)
  const charge=(await api('charge.add',{customer,amount,description:label,taxable:false,effective_date:day})).charge
  const id=(await api('invoice.manual',{customer,charges:[charge],service_date:day})).id
  await api('invoice.approve',{invoice:id,acknowledge:true});await api('invoice.finalise',{invoice:id,issue_date:day});return api(`invoices/${id}`)
 }
 const ingest=async event=>{
  const first=await api('processor.event.consume',{account_ref:account.id,event_ref:event.id})
  const second=await api('processor.event.consume',{account_ref:account.id,event_ref:event.id})
  assert.equal(second.replayed,true);return first
 }
 async function eventFor(type,id) {
  for(let n=0;n<10;n++){
   const list=await stripe.list('/v1/events',{type,'created[gte]':Math.floor(Date.now()/1000)-600})
   const found=list.data.find(row=>row.data?.object?.id===id||row.data?.object?.customer===id)
   if(found)return found
   await delay(1500)
  }
  throw Object.assign(new Error('sandbox_event_not_observed'),{code:'sandbox_event_not_observed'})
 }
 phase='card-refund'
 const invoice=await issue('100','Real card reconciliation')
 const intent=await stripe.request('POST','/v1/payment_intents',{customer:remote.id,amount:10000,currency:'usd','payment_method_types[]':'card',payment_method:'pm_card_visa',confirm:true,'metadata[nectar_native_invoice]':invoice.id})
 assert.equal(intent.status,'succeeded')
 const refund=await stripe.request('POST','/v1/refunds',{payment_intent:intent.id,amount:2500})
 assert.equal(refund.status,'succeeded')
 const refundEvent=await eventFor('refund.created',refund.id),paidEvent=await eventFor('payment_intent.succeeded',intent.id)
 await ingest(refundEvent);await ingest(paidEvent)
 const record=await api(`invoices/${invoice.id}`);assert.equal(record.balanceCents,0);assert.equal(record.allocations.length,1)
 const ledger=await api(`processor-events?customer=${customer}`)
 for(const source of [await stripe.request('GET',`/v1/charges/${reference(intent.latest_charge)}`),refund]){
  const txn=await stripe.request('GET',`/v1/balance_transactions/${reference(source.balance_transaction)}`)
  const observed=ledger.transactions.find(row=>row.transaction_ref===txn.id)
  assert.ok(observed);assert.deepEqual([observed.amount_cents,observed.fee_cents,observed.net_cents],[txn.amount,txn.fee,txn.net])
 }
 results.push({kind:'card_and_refund',invoice:invoice.id,paymentIntent:intent.id,refund:refund.id,eventRefs:[refundEvent.id,paidEvent.id],grossCents:10000,refundCents:2500,allocations:1})
 phase='cash-funding'
 const cashInvoice=await issue('25','Real transferred cash application')
 const funding=await stripe.request('POST',`/v1/test_helpers/customers/${remote.id}/fund_cash_balance`,{amount:2500,currency:'usd',reference:cashInvoice.number})
 const fundingEvent=await eventFor('cash_balance.funds_available',remote.id)
 await ingest(fundingEvent)
 const cashRecord=await api(`invoices/${cashInvoice.id}`)
 assert.equal(cashRecord.balanceCents,0);assert.equal(cashRecord.allocations.length,1)
 const cash=await stripe.request('GET',`/v1/customers/${remote.id}/cash_balance`),transactions=(await stripe.list(`/v1/customers/${remote.id}/cash_balance_transactions`)).data
 assert.equal(cash.available?.usd??0,0)
 assert.equal(transactions.filter(row=>row.type==='funded'&&row.id===funding.id).length,1)
 assert.equal(transactions.filter(row=>row.type==='applied_to_payment').length,1)
 const observation=await api(`processor-events?customer=${customer}`)
 assert.deepEqual(observation.cashTransactions.map(row=>[row.transaction_ref,row.amount_cents,row.ending_balance_cents]).sort(),transactions.map(row=>[row.id,row.net_amount,row.ending_balance]).sort())
 results.push({kind:'cash_application',invoice:cashInvoice.id,eventRef:fundingEvent.id,transactions:transactions.map(row=>({id:row.id,type:row.type,netCents:row.net_amount,endingBalanceCents:row.ending_balance})),remainingCents:0})
 phase='imported-cash'
 results.push(...await proveImportedCash(stripe,h,owner,account))
 phase='dispute'
 const disputeInvoice=await issue('20','Real disputed card capture')
 const disputed=await stripe.request('POST','/v1/payment_intents',{customer:remote.id,amount:2000,currency:'usd','payment_method_types[]':'card',payment_method:'pm_card_createDispute',confirm:true,'metadata[nectar_native_invoice]':disputeInvoice.id})
 let disputes=[]
 for(let observed=0;observed<20&&!disputes.length;observed++){disputes=(await stripe.list('/v1/disputes',{charge:reference(disputed.latest_charge)})).data;if(!disputes.length)await delay(1000)}
 assert.ok(disputes.length,'The genuine disputed-card fixture must produce its dispute')
 const disputeEvent=await eventFor('charge.dispute.created',disputes[0].id);await ingest(disputeEvent);results.push({kind:'dispute',eventRef:disputeEvent.id,dispute:disputes[0].id,status:disputes[0].status})
 phase='ach-returns'
 // Official ACH fixtures; only actual raw provider fields establish Rxx identity.
 const bankFixtures=[
  ['pm_usBankAccount_insufficientFunds',['R01']],
  ['pm_usBankAccount_accountClosed',['R02']],
  ['pm_usBankAccount_noAccount',['R03','R04']],
  ['pm_usBankAccount_debitNotAuthorized',['R05','R07','R08','R10','R11','R29','R31']],
 ]
 for(const [index,[fixture,expectedCodes]] of bankFixtures.entries()) {
  const bankInvoice=await issue('20',`Genuine ACH return ${index+1}`)
  let bank
  try {bank=await stripe.request('POST','/v1/payment_intents',{customer:remote.id,amount:2000,currency:'usd','payment_method_types[]':'us_bank_account',payment_method:fixture,confirm:true,
   'mandate_data[customer_acceptance][type]':'online','mandate_data[customer_acceptance][online][ip_address]':'127.0.0.1','mandate_data[customer_acceptance][online][user_agent]':'Nectar sandbox verification','metadata[nectar_native_invoice]':bankInvoice.id})}
  catch(error){if(error.status!==402)throw error;bank=(await stripe.list('/v1/payment_intents',{customer:remote.id})).data.find(row=>row.metadata?.nectar_native_invoice===bankInvoice.id)}
  assert.ok(bank,'The real failed intent exists')
  bank=await stripe.request('GET',`/v1/payment_intents/${bank.id}`)
  assert.equal(bank.status,'requires_payment_method')
  const charge=await stripe.request('GET',`/v1/charges/${reference(bank.latest_charge)}`)
  assert.equal(charge.status,'failed');assert.equal(charge.payment_method_details?.type,'us_bank_account')
  const raw=charge.outcome?.network_decline_code,normalized=bank.last_payment_error?.decline_code??bank.last_payment_error?.code
  assert.ok(/^R\d{2}$/.test(raw),'A genuine raw network return code is required')
  assert.ok(expectedCodes.includes(raw),'The documented bank fixture produces its expected return category')
  assert.equal(bank.last_payment_error?.network_decline_code,raw,'Current intent and charge independently agree on the raw return identity')
  assert.ok(typeof normalized==='string'&&/^[a-z][a-z0-9_]{0,99}$/.test(normalized),'The normalized provider code remains separately identified')
  const chargeEvent=await eventFor('charge.failed',charge.id),intentEvent=await eventFor('payment_intent.payment_failed',bank.id)
  assert.equal(chargeEvent.data.object.outcome?.network_decline_code,raw)
  assert.equal(intentEvent.data.object.last_payment_error?.network_decline_code,raw)
  const order=index%2?[intentEvent,chargeEvent]:[chargeEvent,intentEvent]
  for(const event of order)await ingest(event)
  for(const event of order.toReversed())assert.equal((await api('processor.event.consume',{account_ref:account.id,event_ref:event.id})).replayed,true)
  const record=await api(`invoices/${bankInvoice.id}`),ledger=await api(`processor-events?customer=${customer}`)
  assert.deepEqual([record.balanceCents,record.allocations.length,record.processorReversals.length],[2000,0,0])
  const returned=ledger.objects.find(row=>row.object_ref===charge.id),failure=ledger.objects.find(row=>row.object_ref===bank.id)
  assert.deepEqual([returned?.kind,returned?.code,failure?.code],['ach_return',raw,normalized],'Raw return identity and normalized failure are retained independently')
  assert.ok(charge.failure_balance_transaction,'A real return balance transaction is required')
  const movements=[]
  for(const transactionRef of [charge.balance_transaction,charge.failure_balance_transaction].filter(Boolean)){
   const transaction=await stripe.request('GET',`/v1/balance_transactions/${reference(transactionRef)}`)
   const observed=ledger.transactions.find(row=>row.transaction_ref===transaction.id)
   assert.ok(observed);assert.equal(reference(transaction.source),charge.id)
   assert.deepEqual([observed.amount_cents,observed.fee_cents,observed.net_cents,observed.currency],[transaction.amount,transaction.fee,transaction.net,transaction.currency])
   movements.push({id:transaction.id,grossCents:transaction.amount,feeCents:transaction.fee,netCents:transaction.net})
  }
  results.push({kind:'ach_return',fixture,paymentIntent:bank.id,charge:charge.id,eventRefs:order.map(event=>event.id),networkReturnCode:raw,providerCode:normalized,movements,allocatedCents:0,apiVersion:stripe.apiVersion})
 }
 phase='failure-alert'
 assert.ok(process.env.SENDGRID_KEY&&process.env.SENDGRID_FROM,'Held SendGrid inputs are required')
 const email=process.env.SENDGRID_FROM
 await api('access.give',{email,name:'Subscribed sandbox finance',role:'finance'})
 const finance=await h.signIn(email,{requested:true})
 await h.api('notification.preferences',finance,{webhook_failure:true})
 let sends=0
 await h.configureMail({provider:'sendgrid',apiKey:process.env.SENDGRID_KEY,from:email},async request=>{
  sends++;assert.ok(request.headers.get('authorization')===`Bearer ${process.env.SENDGRID_KEY}`,'Held mail binding matches')
  return fetch(request.url,{method:request.method,headers:request.headers,body:await request.arrayBuffer(),redirect:'error',signal:AbortSignal.timeout(20000)})
 })
 const rejected=await stripe.request('POST','/v1/payment_intents',{customer:remote.id,amount:100,currency:'usd','payment_method_types[]':'card',payment_method:'pm_card_visa',confirm:true,'metadata[nectar_native_invoice]':'synthetic-nectar-absent'})
 const rejectedEvent=await eventFor('payment_intent.succeeded',rejected.id)
 for(let n=0;n<2;n++)await api('processor.event.consume',{account_ref:account.id,event_ref:rejectedEvent.id},409)
 const alert=(await h.api('notifications',finance)).deliveries.find(row=>row.event==='webhook_failure')
 assert.equal(sends,1);assert.equal(alert.status,'accepted');assert.ok(alert.provider_ref)
 await h.page(alert.href,finance);assert.equal((await h.raw(alert.href)).status,303)
 results.push({kind:'failure_alert',eventRef:rejectedEvent.id,status:alert.status,providerReference:alert.provider_ref,sends})
 phase='automatic-payout'
 results.push(await provePayout(account,api))
 }
 console.log(JSON.stringify({head,status:'passed_for_named_slices',results,requests:stripe.counts}))
}catch(error){console.error(JSON.stringify({head,status:'failed',phase,error:safeError(error),results}));process.exitCode=1}
finally{
 await h?.close()
 if(remote){
  try{for(const charge of (await stripe.list('/v1/charges',{customer:remote.id})).data)if(charge.paid&&!charge.disputed&&charge.amount_refunded<charge.amount)await stripe.request('POST','/v1/refunds',{charge:charge.id,amount:charge.amount-charge.amount_refunded})}catch(error){console.error(JSON.stringify({cleanup:'remaining_test_cash',error:safeError(error)}))}
  try{await stripe.request('DELETE',`/v1/customers/${remote.id}`)}catch(error){console.error(JSON.stringify({cleanup:'test_customer',error:safeError(error)}))}
 }
}
