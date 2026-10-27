// Held-key Stripe test proof. Prints typed results only, never raw payloads.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { stripeSandbox, safeError, reference } from './stripe-sandbox-client.mjs'
import { processorSetup } from './processor-events.mjs'
const stripe=stripeSandbox(process.env.STRIPE_SECRET_KEY)
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
let h,remote,phase='account'
const results=[]
try {
 const account=await stripe.request('GET','/v1/account');assert.equal(account.country,'US')
 remote=await stripe.request('POST','/v1/customers',{name:`Synthetic Nectar events ${stripe.run}`,'cash_balance[settings][reconciliation_mode]':'manual'})
 const setup=await processorSetup(undefined,{localTime:undefined,stripeFetch:request=>stripe.forward(request),stripeSecret:process.env.STRIPE_SECRET_KEY})
 h=setup.h;const owner=setup.owner,api=(path,body,status)=>h.api(path,owner,body,status)
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
 phase='dispute'
 const disputeInvoice=await issue('20','Real disputed card capture')
 const disputed=await stripe.request('POST','/v1/payment_intents',{customer:remote.id,amount:2000,currency:'usd','payment_method_types[]':'card',payment_method:'pm_card_createDispute',confirm:true,'metadata[nectar_native_invoice]':disputeInvoice.id})
 const disputes=(await stripe.list('/v1/disputes',{charge:reference(disputed.latest_charge)})).data
 if(disputes.length){const event=await eventFor('charge.dispute.created',disputes[0].id);await ingest(event);results.push({kind:'dispute',eventRef:event.id,dispute:disputes[0].id,status:disputes[0].status})}
 else results.push({kind:'dispute',boundary:'genuine_dispute_not_yet_observed'})
 phase='ach-failure-boundary'
 const bankInvoice=await issue('20','ACH insufficient-funds boundary')
 let bank
 try {bank=await stripe.request('POST','/v1/payment_intents',{customer:remote.id,amount:2000,currency:'usd','payment_method_types[]':'us_bank_account',payment_method:'pm_usBankAccount_insufficientFunds',confirm:true,
  'mandate_data[customer_acceptance][type]':'online','mandate_data[customer_acceptance][online][ip_address]':'127.0.0.1','mandate_data[customer_acceptance][online][user_agent]':'Nectar sandbox verification','metadata[nectar_native_invoice]':bankInvoice.id})}
 catch(error){if(error.status!==402)throw error;bank=(await stripe.list('/v1/payment_intents',{customer:remote.id})).data.find(row=>row.metadata?.nectar_native_invoice===bankInvoice.id)}
 assert.ok(bank)
 if(bank.status==='requires_payment_method'){
  const event=await eventFor('payment_intent.payment_failed',bank.id);await ingest(event)
  assert.equal((await api(`invoices/${bankInvoice.id}`)).balanceCents,2000)
  results.push({kind:'ach_failure',paymentIntent:bank.id,eventRef:event.id,providerCode:bank.last_payment_error?.code??null,declineCode:bank.last_payment_error?.decline_code??null,lateReturnObserved:false})
 }else results.push({kind:'ach_failure',paymentIntent:bank.id,status:bank.status,lateReturnObserved:false})
 phase='failure-alert'
 assert.ok(process.env.SENDGRID_KEY&&process.env.SENDGRID_FROM,'Held SendGrid inputs are required')
 const email=process.env.SENDGRID_FROM
 await api('access.give',{email,name:'Subscribed sandbox finance',role:'finance'})
 const finance=await h.signIn(email,{requested:true})
 await h.api('notification.preferences',finance,{webhook_failure:true})
 let sends=0
 await h.configureMail({provider:'sendgrid',apiKey:process.env.SENDGRID_KEY,from:email},async request=>{
  sends++;assert.equal(request.headers.get('authorization'),`Bearer ${process.env.SENDGRID_KEY}`)
  return fetch(request.url,{method:request.method,headers:request.headers,body:await request.arrayBuffer(),redirect:'error',signal:AbortSignal.timeout(20000)})
 })
 const rejected=await stripe.request('POST','/v1/payment_intents',{customer:remote.id,amount:100,currency:'usd','payment_method_types[]':'card',payment_method:'pm_card_visa',confirm:true,'metadata[nectar_native_invoice]':'synthetic-nectar-absent'})
 const rejectedEvent=await eventFor('payment_intent.succeeded',rejected.id)
 for(let n=0;n<2;n++)await api('processor.event.consume',{account_ref:account.id,event_ref:rejectedEvent.id},409)
 const alert=(await h.api('notifications',finance)).deliveries.find(row=>row.event==='webhook_failure')
 assert.equal(sends,1);assert.equal(alert.status,'accepted');assert.ok(alert.provider_ref)
 await h.page(alert.href,finance);assert.equal((await h.raw(alert.href)).status,303)
 results.push({kind:'failure_alert',eventRef:rejectedEvent.id,status:alert.status,providerReference:alert.provider_ref,sends})
 // Manual payout constituents are not supplied by Stripe. Keep this boundary
 // explicit rather than manufacturing an automatic payout or membership list.
 results.push({kind:'payout',boundary:'automatic_payout_constituent_sandbox_pending'},{kind:'ach_return',boundary:'genuine_late_R01_return_sandbox_pending'})
 console.log(JSON.stringify({head,status:'passed_for_named_slices',results,requests:stripe.counts}))
}catch(error){console.error(JSON.stringify({head,status:'failed',phase,error:safeError(error),results}));process.exitCode=1}
finally{
 await h?.close()
 if(remote){
  try{for(const charge of (await stripe.list('/v1/charges',{customer:remote.id})).data)if(charge.paid&&!charge.disputed&&charge.amount_refunded<charge.amount)await stripe.request('POST','/v1/refunds',{charge:charge.id,amount:charge.amount-charge.amount_refunded})}catch(error){console.error(JSON.stringify({cleanup:'remaining_test_cash',error:safeError(error)}))}
  try{await stripe.request('DELETE',`/v1/customers/${remote.id}`)}catch(error){console.error(JSON.stringify({cleanup:'test_customer',error:safeError(error)}))}
 }
}
