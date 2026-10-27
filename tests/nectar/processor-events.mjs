import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { harness } from './harness.mjs'
import { processorEdge } from './processor-edge.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { csvRows } from './financial-reports.mjs'
export const webhookSecret='synthetic-nectar-webhook'
export async function processorSetup(edge=processorEdge(),options={}) {
 const h=await harness({assets:true,localTime:'2026-10-22T12:00:00Z',stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1',stripeWebhookSecret:webhookSecret,...options})
 await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
 const owner=await h.signIn(h.vars.OWNER_EMAIL)
 await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
 await h.api('business.configure',owner,{legal_name:'Cedar Finance',timezone:'UTC',invoice_prefix:'PAY',payment_terms_days:30})
 await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Synthetic processor reconciliation'})
 await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
 return {h,owner,edge}
}
export async function processorEventFlow(h,owner,edge,{onState=async()=>{}}={}) {
 const api=(path,body,status)=>h.api(path,owner,body,status)
 const customer=(await api('customer.create',{external_id:'synthetic-nectar-pay004',name:'Cedar Finance',billing_email:'finance@cedar.example'})).id
 const manual=async(amount,tag)=>{
  const charge=(await api('charge.add',{customer,amount,description:tag,taxable:false,effective_date:'2026-10-22'})).charge
  const invoice=(await api('invoice.manual',{customer,charges:[charge],service_date:'2026-10-22'})).id
  await api('invoice.approve',{invoice,acknowledge:true});await api('invoice.finalise',{invoice,issue_date:'2026-10-22'});return invoice
 }
 const invoice=await manual('100','October platform service')
 await api('collection.customer.bind',{customer,account_ref:edge.account,stripe_customer_ref:edge.customerRef,confirm:true})
 const source=edge.seed(invoice)
 const paid=edge.event('synthetic-nectar-event-paid','payment_intent.succeeded',source.intent)
 const failed=edge.event('synthetic-nectar-event-failed','payment_intent.payment_failed',{...source.intent,status:'requires_payment_method',amount_received:0,last_payment_error:{code:'card_declined',decline_code:'insufficient_funds'}},edge.at-60)
 const refund={object:'refund',id:'synthetic-nectar-refund',charge:source.charge.id,payment_intent:source.intent.id,status:'succeeded',amount:2500,currency:'usd',created:edge.at+2,livemode:false,balance_transaction:'synthetic-nectar-txn-refund'}
 edge.objects.set(refund.id,refund);edge.transactions.set(refund.balance_transaction,{object:'balance_transaction',id:refund.balance_transaction,type:'refund',source:refund.id,amount:-2500,fee:0,net:-2500,currency:'usd',status:'available',created:edge.at+2,available_on:edge.at+2})
 const refunded=edge.event('synthetic-nectar-event-refund','refund.created',refund,edge.at+2)
 const deliver=async(event,{signature=true,delta=0,status=200}={})=>{
  const timestamp=Date.parse('2026-10-22T12:00:00Z')/1000+delta,body=JSON.stringify(event)
  const sig=createHmac('sha256',webhookSecret).update(`${timestamp}.${body}`).digest('hex')
  const response=await h.raw('/api/nectar/stripe/payment-events',{body:event,headers:{'stripe-signature':`t=${timestamp},v1=${signature?sig:'0'.repeat(64)}`}})
  const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result
 }
 await deliver(paid,{signature:false,status:401});await deliver(paid,{delta:-301,status:401})
 assert.equal((await api(`invoices/${invoice}`)).balanceCents,10000)
 // First arrival is the refund; current charge and immutable invoice metadata
 // independently establish the gross cash without trusting the stale envelope.
 await deliver(refunded)
 const payment=(await api('payments')).find(row=>row.customer_id===customer)
 assert.equal(payment.amount_cents,10000)
 assert.equal((await api(`invoices/${invoice}`)).balanceCents,0)
 const duplicate=await deliver(refunded);assert.equal(duplicate.replayed,true)
 const parallel=await Promise.all([deliver(paid),deliver(paid)]);assert.equal(parallel.filter(row=>!row.replayed).length,1)
 await deliver(failed);await deliver(failed)
 const state=await api(`processor-events?customer=${customer}`)
 assert.deepEqual(state.events.map(row=>row.event_type).sort(),['payment_intent.payment_failed','payment_intent.succeeded','refund.created'])
 assert.deepEqual(state.transactions.map(row=>[row.type,row.amount_cents,row.fee_cents,row.net_cents]).sort(),[['charge',10000,320,9680],['refund',-2500,0,-2500]])
 assert.equal((await api('payments')).filter(row=>row.customer_id===customer).length,1)
 const recovery=await api('recovery'),cohort=recovery.invoices.find(row=>row.invoice===invoice)
 assert.equal(cohort.firstFailedAt,(edge.at-60)*1000);assert.equal(cohort.failedAmountCents,10000);assert.equal(cohort.recoveredAmountCents,10000)
 assert.equal(cohort.recoveries.length,1);assert.equal(cohort.recoveries[0].payment,payment.id)
 assert.equal(cohort.recoveries[0].attempt,1,'Actual payment identity attributes the recovered cash to the recorded processor attempt')
 const oldest=edge.event('synthetic-nectar-event-oldest','payment_intent.payment_failed',{...source.intent,amount:4000,status:'requires_payment_method',amount_received:0,last_payment_error:{code:'processing_error'}},edge.at-120)
 await deliver(oldest);await deliver(oldest)
 const capped=await api('recovery'),earliest=capped.invoices.find(row=>row.invoice===invoice)
 assert.deepEqual([earliest.firstFailedAt,earliest.failedAmountCents,earliest.recoveredAmountCents,earliest.declineCode],[(edge.at-120)*1000,4000,4000,'processing_error'])
 assert.deepEqual([capped.totals.failedInvoices,capped.totals.recoveredInvoices,capped.totals.failedAmountCents,capped.totals.recoveredAmountCents,capped.totals.recoveryRate,capped.totals.amountRecoveryRate],[1,1,4000,4000,1,1])
 assert.deepEqual(capped.byDecline.map(row=>[row.key,row.recoveredInvoices,row.recoveredAmountCents,row.recoveryRate]),[['processing_error',1,4000,1]])
 assert.deepEqual(capped.byAttempt.map(row=>[row.key,row.recoveredInvoices,row.recoveredAmountCents,row.recoveryRate]),[['1',1,4000,1]])
 assert.deepEqual(capped.byDunningStep.map(row=>[row.key,row.recoveredInvoices,row.recoveredAmountCents,row.recoveryRate]),[['unrecorded',1,4000,1]])
 for(const [metric,total] of [['collections',10000],['settlements',9680],['refunds',-2500]]) {
  const report=await api(`reports/${metric}?period=2026-10&customer=${customer}`)
  assert.equal(report.totalCents,total);assert.equal(report.entries.length,1)
  const source=await api(report.entries[0].href.replace('/app/',''))
  assert.equal(source.totalCents,total);assert.equal(source.components.reduce((sum,row)=>sum+row.amountCents,0),total)
  assert.ok(source.processor||report.entries[0].processor)
  const csv=csvRows(await (await h.raw(`/app/exports/reports/${metric}.csv?period=2026-10&customer=${customer}`,{cookie:owner})).text())
  assert.equal(csv.find(row=>row.source==='TOTAL').amount,`${total<0?"'":''}${(total/100).toFixed(2)}`);assert.equal(csv.filter(row=>row.source!=='TOTAL').length,1)
 }
 const dispute={object:'dispute',id:'synthetic-nectar-dispute',charge:source.charge.id,status:'needs_response',amount:2000,currency:'usd',reason:'fraudulent',livemode:false,balance_transactions:[{id:'synthetic-nectar-txn-dispute'}]}
 edge.objects.set(dispute.id,dispute)
 edge.transactions.set('synthetic-nectar-txn-dispute',{object:'balance_transaction',id:'synthetic-nectar-txn-dispute',type:'adjustment',source:dispute.id,amount:-2000,fee:1500,net:-3500,currency:'usd',status:'available',created:edge.at+3,available_on:edge.at+3})
 const disputed=edge.event('synthetic-nectar-event-dispute','charge.dispute.created',dispute,edge.at+3)
 await deliver(disputed);await deliver(disputed)
 assert.equal((await api(`processor-events?customer=${customer}`)).objects.find(row=>row.object_ref===dispute.id).status,'needs_response')
 const bankInvoice=await manual('40','Bank debit service'),bank=edge.seed(bankInvoice,4000,'bank')
 Object.assign(bank.charge.payment_method_details,{type:'us_bank_account'})
 Object.assign(bank.transaction,{fee:10,net:3990})
 const bankPaid=edge.event('synthetic-nectar-event-bank-paid','charge.succeeded',bank.charge,edge.at+4)
 await deliver(bankPaid)
 assert.equal((await api(`invoices/${bankInvoice}`)).balanceCents,0)
 Object.assign(bank.charge,{status:'failed',paid:false,failure_code:'R01',failure_balance_transaction:'synthetic-nectar-txn-return'})
 edge.transactions.set(bank.charge.failure_balance_transaction,{object:'balance_transaction',id:bank.charge.failure_balance_transaction,type:'payment_failure_refund',source:bank.charge.id,amount:-4000,fee:0,net:-4000,currency:'usd',status:'available',created:edge.at+5,available_on:edge.at+5})
 const bankReturn=edge.event('synthetic-nectar-event-bank-return','charge.failed',bank.charge,edge.at+5)
 await deliver(bankReturn);await deliver(bankReturn);await deliver(bankPaid)
 const returned=await api(`invoices/${bankInvoice}`)
 assert.deepEqual([returned.balanceCents,returned.paidCents,returned.processorReversals.length],[4000,0,1])
 const payoutAmount=Array.from(edge.transactions.values()).reduce((sum,row)=>sum+row.net,0)
 assert.equal(payoutAmount,3670)
 const payout={object:'payout',id:'synthetic-nectar-payout',status:'paid',amount:payoutAmount,currency:'usd',automatic:true,livemode:false,balance_transaction:'synthetic-nectar-txn-payout'}
 edge.objects.set(payout.id,payout);edge.transactions.set(payout.balance_transaction,{object:'balance_transaction',id:payout.balance_transaction,type:'payout',source:payout.id,amount:-payoutAmount,fee:0,net:-payoutAmount,currency:'usd',status:'available',created:edge.at+6,available_on:edge.at+6})
 const payoutEvent=edge.event('synthetic-nectar-event-payout','payout.paid',payout,edge.at+6)
 await deliver(payoutEvent);await deliver(payoutEvent)
 const reconciliation=await api('processor-events'),members=reconciliation.transactions.filter(row=>row.payout_ref===payout.id&&row.type!=='payout')
 assert.deepEqual(members.map(row=>row.transaction_ref).sort(),[source.transaction.id,refund.balance_transaction,'synthetic-nectar-txn-dispute',bank.transaction.id,bank.charge.failure_balance_transaction].sort())
 assert.equal(members.reduce((sum,row)=>sum+row.net_cents,0),payout.amount)
 assert.equal(reconciliation.transactions.find(row=>row.type==='payout').amount_cents,-3670)
 await api('report.schedule',{enabled:true,day:1})
 await h.advanceClock('2026-11-01T12:00:00Z')
 const tick=await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse('2026-11-01T12:00:00Z')}&cron=${encodeURIComponent('0 14 * * *')}`)
 assert.equal(tick.status,200,await tick.text())
 const frozen=(await api('report-schedule')).deliveries
 assert.equal(frozen.length,1)
 const snapshot=await api(`report-deliveries/${frozen[0].id}`)
 assert.deepEqual(snapshot.reports.filter(row=>['collections','settlements','refunds'].includes(row.metric)).map(row=>[row.metric,row.totalCents]),[['collections',14000],['settlements',13670],['refunds',-2500]])
 const frozenSettlements=snapshot.sourceEvidence.filter(row=>row.metric==='settlements')
 assert.equal(frozenSettlements.length,2);assert.equal(frozenSettlements.reduce((sum,row)=>sum+row.detail.totalCents,0),13670)
 await h.advanceClock('2026-10-22T12:00:00Z')
 await onState({label:'reconciled',customer,invoice,bankInvoice,delivery:frozen[0].id})
 // Failure notifications honour existing per-member choices and action authority.
 const people={}
 for(const [name,role,subscribed] of [['finance','finance',true],['quiet','finance',false],['accountant','accountant',true],['developer','developer',true]]) {
  const email=`synthetic-nectar-${name}@example.test`
  await api('access.give',{email,name,role});const who=await h.signIn(email,{requested:true});people[name]={email,who}
  await h.api('notification.preferences',who,Object.fromEntries(['mentions','payment_mismatch','billrun_exceptions','proposals','webhook_failure'].map(key=>[key,key==='webhook_failure'&&subscribed])))
 }
 const another=await manual('80','Second service'),second=edge.seed(another,8000,'2'),bad=edge.event('synthetic-nectar-event-unavailable','charge.succeeded',second.charge)
 edge.setFailure(true);const mailAt=h.mails.length
 await deliver(bad,{status:502});await deliver(bad,{status:502})
 const messages=h.mails.slice(mailAt)
 assert.equal(messages.length,1);assert.deepEqual(messages.flatMap(mail=>[mail.to].flat()),[people.finance.email])
 const notice=(await h.api('notifications',people.finance.who)).deliveries.find(row=>row.event==='webhook_failure')
 assert.equal(notice.status,'accepted');assert.ok(notice.provider_ref);assert.equal(new URL(notice.href,h.origin).hash,`#${notice.subject}`)
 const linked=await h.page(notice.href,people.finance.who);assert.ok(linked.includes(`id="${notice.subject}"`));assert.equal((await h.raw(notice.href)).status,303)
 const out=await h.api('processor.event.consume',people.accountant.who,{account_ref:edge.account,event_ref:bad.id},403);assert.equal(out.error,'forbidden')
 const agent={bearer:(await api('credential.issue',{name:'Synthetic observer',scopes:['prepare']})).key}
 await h.api('processor.event.consume',agent,{account_ref:edge.account,event_ref:bad.id},403)
 edge.setFailure(false);await h.api('processor.event.consume',people.finance.who,{account_ref:edge.account,event_ref:bad.id})
 assert.equal((await api(`invoices/${another}`)).balanceCents,0)
 assert.equal((await h.api('notifications',people.finance.who)).deliveries.length,1)
 await onState({label:'failure-resolved',customer,invoice:another})
 const personal=(await api(`customers/${customer}`)).billing_email
 const beforeErasure=h.mails.length,request=await api('erasure.request',{customer})
 const verification=h.mails.slice(beforeErasure).find(mail=>[mail.to].flat().includes(personal))
 assert.ok(verification)
 const path=new URL(`${verification.text??''} ${verification.html??''}`.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]).pathname
 assert.equal((await h.raw(path,{form:new URLSearchParams({confirm:'yes'})})).status,200)
 const erased=await api('erasure.approve',{request:request.id,confirm:true})
 assert.ok(erased.receipt.retained.until)
 const hidden=await api(`processor-events?customer=${customer}`)
 assert.deepEqual([hidden.events.length,hidden.transactions.length,hidden.objects.length,hidden.reversals.length],[0,0,0,0])
 assert.equal((await api('customers?search='+encodeURIComponent(refund.id))).length,0)
 const retained=await api(`reports/settlements?period=2026-10&customer=${customer}`)
 assert.equal(retained.totalCents,21350)
 assert.deepEqual([...new Set(retained.entries.map(row=>row.customerName))],['Erased customer'])
 const refused=await api('processor.event.consume',{account_ref:edge.account,event_ref:bad.id})
 assert.equal(refused.replayed,true)
 assert.equal((await api(`processor-events?customer=${customer}`)).events.length,0)
 await onState({label:'erased',customer,invoice})
 return {customer,invoice,source,deliver,manual,people}
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const {h,owner,edge}=await processorSetup()
 try{await processorEventFlow(h,owner,edge);console.log('Processor events: signed intake, out-of-order refund and recovery, exactly-once cash, fees, reports, CSV and authorized failure alerts passed')}finally{await h.close()}
}
