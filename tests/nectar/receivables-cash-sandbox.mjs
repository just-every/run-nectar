// Actual processor cash: an unidentified transfer is allocated through the
// ordinary receivables door, rather than inserted into the local ledger.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { stripeSandbox, safeError } from './stripe-sandbox-client.mjs'
import { processorSetup } from './processor-events.mjs'
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
const stripe=stripeSandbox(process.env.STRIPE_SECRET_KEY)
let h,remote,phase='account'
try{
 const account=await stripe.request('GET','/v1/account')
 const setup=await processorSetup(undefined,{localTime:undefined,stripeFetch:request=>stripe.forward(request),stripeSecret:process.env.STRIPE_SECRET_KEY})
 h=setup.h;const owner=setup.owner,api=(path,body,status)=>h.api(path,owner,body,status)
 remote=await stripe.request('POST','/v1/customers',{name:'Synthetic Nectar cash '+stripe.run,'cash_balance[settings][reconciliation_mode]':'manual'})
 const customer=(await api('customer.create',{external_id:'synthetic-nectar-'+stripe.run,name:'Synthetic cash allocation',billing_email:['synthetic-nectar-cash','example.test'].join('@')})).id
 await api('collection.customer.bind',{customer,account_ref:account.id,stripe_customer_ref:remote.id,confirm:true})
 const day=new Date().toISOString().slice(0,10)
 const charge=(await api('charge.add',{customer,amount:'13.25',description:'Synthetic received cash',effective_date:day,taxable:false})).charge
 const invoice=(await api('invoice.manual',{customer,charges:[charge],service_date:day})).id
 await api('invoice.approve',{invoice,acknowledge:true});await api('invoice.finalise',{invoice,issue_date:day})
 phase='fund-cash'
 await stripe.request('POST','/v1/test_helpers/customers/'+remote.id+'/fund_cash_balance',{amount:500,currency:'usd',reference:'synthetic-nectar-unmatched'})
 let event
 for(let attempt=0;attempt<30;attempt++){
  const events=(await stripe.list('/v1/events',{type:'cash_balance.funds_available'})).data
  event=events.find(row=>row.data.object.customer===remote.id)
  if(event)break
  await delay(2000)
 }
 assert.ok(event,'The actual processor records the simulated funding event')
 phase='queue'
 await api('processor.event.consume',{account_ref:account.id,event_ref:event.id})
 await api('processor.event.consume',{account_ref:account.id,event_ref:event.id})
 const state=await api('processor-events?customer='+customer),queued=state.unmatched
 assert.equal(queued.length,1)
 assert.equal(queued[0].amount_cents,500);assert.equal(queued[0].daysLeft,75)
 assert.equal(queued[0].returnDeadline,queued[0].occurred_at+75*86400000)
 assert.equal((await api('payments')).length,0)
 const desk=await h.page('/app/receivables',owner)
 assert.ok(desk.includes(queued[0].id));assert.ok(desk.includes('75 days left'))
 phase='allocation'
 const allocation={customer,account_ref:account.id,transfer_ref:queued[0].transfer_ref,invoice,amount:'5.00',confirm:true}
 await api('processor.cash.allocate',{...allocation,confirm:false},400)
 const collected=await api('processor.cash.allocate',allocation)
 assert.equal(collected.status,'collected')
 assert.equal((await api('processor.cash.allocate',allocation)).replayed,true)
 const final=await api('invoices/'+invoice)
 assert.deepEqual([final.paidCents,final.balanceCents],[500,825])
 assert.equal((await api('payments')).length,1)
 assert.equal((await api('processor-events?customer='+customer)).unmatched.length,0)
 const cash=await stripe.request('GET','/v1/customers/'+remote.id+'/cash_balance')
 assert.equal(cash.available?.usd??0,0)
 console.log(JSON.stringify({head,status:'passed',kind:'actual-unmatched-cash-allocation',fundingEvent:event.id,paymentIntent:(await api('processor-events?customer='+customer)).cashApplications[0].payment_intent_ref,receivedCents:500,remainingInvoiceCents:825,daysLeftAtReceipt:75,requests:stripe.counts}))
}catch(error){console.log(JSON.stringify({head,status:'failed',phase,error:safeError(error),...(error.code==='ERR_ASSERTION'?{assertion:String(error.message).slice(0,500)}:{})}));process.exitCode=1}
finally{await h?.close();if(remote)try{await stripe.request('DELETE','/v1/customers/'+remote.id)}catch(error){console.log(JSON.stringify({cleanup:'customer',error:safeError(error)}));process.exitCode=1}}
