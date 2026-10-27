// Extend the existing event journey; only processor HTTP is faked.
import assert from 'node:assert/strict'
import { nativeCollectionEdge } from './native-collection.mjs'
import { assertRecoveryBuckets } from './recovery-assertions.mjs'
import { totp } from './mfa.mjs'
import { publishPrice } from './price-helper.mjs'

export function processorRecoveryEdge(base) {
 const native=nativeCollectionEdge(),customerRef='synthetic-nectar-4001',methodRef='synthetic-nectar-4002'
 native.accounts.set(1,base.account)
 native.customers.clear();native.customers.set(customerRef,{account:1,method:methodRef})
 return {...base,recovery:{native,customerRef},fetch:async request=>{
  const url=new URL(request.url),path=url.pathname.slice(3)
  const body=request.method==='POST'?new URLSearchParams(await request.clone().text()):null
  const nativeRequest=path===`/customers/${customerRef}`||path===`/payment_methods/${methodRef}`
   ||path.startsWith('/payment_intents/synthetic-nectar-native-')
   ||path==='/payment_intents'&&(url.searchParams.get('customer')===customerRef||body?.get('customer')===customerRef)
   ||path==='/payment_intents/search'||path==='/charges'&&url.searchParams.get('payment_intent')?.startsWith('synthetic-nectar-native-')
  return nativeRequest?native.fetch(request):base.fetch(request)
 }}
}

export async function processorRecoveryFlow(h,owner,edge,{deliver,finance}) {
 const api=(path,body,status)=>h.api(path,owner,body,status)
 let sequence=4100,instant=Date.parse('2026-10-22T12:00:00Z')
 const id=()=>`synthetic-nectar-${sequence++}`,money=cents=>(cents/100).toFixed(2)
 const move=async seconds=>{instant=Date.parse('2026-10-22T12:00:00Z')+seconds*1000;await h.advanceClock(new Date(instant).toISOString())}
 assert.deepEqual((await api('recovery')).invoices,[],'The prior erased customer contributes no active recovery cohort')
 const customer=(await api('customer.create',{external_id:id(),name:'Synthetic recovery cohort',billing_email:'synthetic-nectar-4000@example.test'})).id
 const customerRef=edge.recovery.customerRef,native=edge.recovery.native
 await api('collection.customer.bind',{customer,account_ref:edge.account,stripe_customer_ref:customerRef,confirm:true})
 const factor=await api('mfa.totp.start',{})
 await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,instant)})
 const financeFactor=await h.api('mfa.totp.start',finance,{})
 await h.api('mfa.totp.confirm',finance,{factor:financeFactor.factor,code:totp(financeFactor.secret,instant)})
 const issue=async invoice=>{await api('invoice.approve',{invoice,acknowledge:true});await api('invoice.finalise',{invoice,issue_date:'2026-10-22'});return invoice}
 const manual=async amount=>{
  const charge=(await api('charge.add',{customer,amount:money(amount),description:'Synthetic recovery source',taxable:false,effective_date:'2026-10-22'})).charge
  return issue((await api('invoice.manual',{customer,charges:[charge],service_date:'2026-10-22'})).id)
 }
 const product=(await api('product.create',{code:id(),name:'Synthetic recovery service'})).id
 const recurring=async(amount,trial=false)=>{
  const price=(await publishPrice(h,owner,{product,kind:'flat',unit_amount:money(amount),taxable:false,...(trial?{billing_timing:'advance'}:{})})).id
  return (await api('subscription.create',{customer,start_date:trial?'2026-10-01':'2026-09-01',price:[price],...(trial?{trial_end:'2026-10-22',trial_payment:'card'}:{})})).id
 }
 const unpaidSub=await recurring(8000),paidSub=await recurring(6000),trialSub=await recurring(1000,true)
 const run=await api('billrun.prepare',{period:'2026-09'}),invoices=(await api(`runs/${run.id}`)).invoices
 const unpaid=await issue(invoices.find(row=>row.subscription_id===unpaidSub).id),paid=await issue(invoices.find(row=>row.subscription_id===paidSub).id)

 // A real approved native trial refusal remains a single native cohort. Its
 // webhook cannot create a second failure with a different time or amount.
 const trialReview=await api('trial.collection.prepare',{subscription:trialSub})
 const trialConsent=await api('trial.collection.confirm',trialReview.instructions.confirm)
 await h.api('trial.collection.approve',finance,{request:trialConsent.id,basis_hash:trialConsent.basis,decision:'approved'})
 native.capturedAt(new Date(instant).toISOString());native.refuseNext('card_declined')
 const tick=await h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent('0 14 * * *')}`)
 assert.equal(tick.status,200,await tick.text())
 const trial=(await api(`trial-collections?subscription=${trialSub}`)).find(row=>row.id===trialConsent.id)
 assert.equal(trial.status,'declined')
 const nativeIntent=[...native.intents.values()].find(row=>row.value.metadata.nectar_native_invoice===trial.invoice).value
 const trialEvent=edge.event(id(),'payment_intent.payment_failed',nativeIntent,instant/1000)
 assert.equal((await deliver(trialEvent,{status:409})).error,'processor_recovery_source_excluded')
 const expected=[{invoice:trial.invoice,currency:'USD',declineCode:'card_declined',firstFailedAt:instant,failedAmountCents:1000,recoveredAmountCents:0,attempts:[{attempt:1,step:null}],steps:[],recoveries:[]}]

 const prepaid=await api('prepaid.prepare',{subscription:unpaidSub,mode:'grant',kind:'money',source:'purchase',amount:'50',effective_date:'2026-10-22',expires_date:'2027-10-22',priority:0,expiry_consent:true})
 await h.api('prepaid.decide',finance,{request:prepaid.request,decision:'approved'})
 const purchase=await api('prepaid.purchase.prepare',{intent:prepaid.request,issue_date:'2026-10-22'})
 await issue(purchase.invoice)
 const intent=(invoice,amount,status='requires_payment_method',code='processing_error')=>{
  const value={object:'payment_intent',id:id(),customer:customerRef,amount,amount_received:0,currency:'usd',livemode:false,status,latest_charge:null,
   metadata:{nectar_native_invoice:invoice},last_payment_error:{code}}
  edge.objects.set(value.id,value);return value
 }
 const failure=async(value,at=instant)=>{
  const event=edge.event(id(),'payment_intent.payment_failed',value,at/1000)
  await deliver(event);assert.equal((await deliver(event)).replayed,true);return event
 }
 const purchaseIntent=intent(purchase.invoice,5000)
 const prepaidEvent=edge.event(id(),'payment_intent.payment_failed',purchaseIntent,instant/1000)
 assert.equal((await deliver(prepaidEvent,{status:409})).error,'processor_recovery_source_excluded')
 assert.equal((await api(`invoices/${purchase.invoice}`)).balanceCents,5000)
 assertRecoveryBuckets(await api('recovery'),expected)

 const partial=await manual(10000),pending=await manual(3000)
 const allocate=async(invoice,amount)=>{
  const payment=await api('payment.record',{customer,amount:money(amount),received_on:'2026-10-22',method:'bank_transfer',reference:id()})
  await api('payment.allocate',{payment:payment.payment,invoice,amount:money(amount)});return payment.payment
 }
 await move(10);await allocate(partial,2000)
 await move(20)
 const partialIntent=intent(partial,4000),unpaidIntent=intent(unpaid,8000,'requires_payment_method','do_not_honor'),paidIntent=intent(paid,6000,'requires_payment_method','insufficient_funds')
 const first=await failure(partialIntent)
 await failure(unpaidIntent);await failure(paidIntent)
 expected.push(...[[partial,4000,'processing_error'],[unpaid,8000,'do_not_honor'],[paid,6000,'insufficient_funds']].map(([invoice,amount,declineCode])=>({invoice,currency:'USD',declineCode,firstFailedAt:instant,failedAmountCents:amount,recoveredAmountCents:0,attempts:[{attempt:1,step:null}],steps:[],recoveries:[]})))
 const partialExpected=expected.find(row=>row.invoice===partial),paidExpected=expected.find(row=>row.invoice===paid)
 const read=async()=>{
  const report=await api('recovery')
  assertRecoveryBuckets(report,expected)
  assert.deepEqual(report.invoices.map(row=>row.invoice).sort(),expected.map(row=>row.invoice).sort())
  for(const row of expected){
   const actual=report.invoices.find(candidate=>candidate.invoice===row.invoice)
   for(const key of ['firstFailedAt','failedAmountCents','declineCode','recoveredAmountCents'])assert.equal(actual[key],row[key],`${row.invoice} ${key}`)
   assert.deepEqual(actual.recoveries.map(cash=>[cash.amountCents,cash.attempt,cash.step]),row.recoveries.map(cash=>[cash.amountCents,cash.attempt,cash.step]))
  }
  return report
 }
 await read()
 await move(25);await failure({...partialIntent,amount:8000,last_payment_error:{code:'do_not_honor'}})
 // An already accepted envelope is immutable even if its provider event later
 // returns a different snapshot. Duplicate intake never rewrites that fact.
 edge.events.set(first.id,{...first,data:{object:{...first.data.object,amount:9000,last_payment_error:{code:'insufficient_funds'}}}})
 assert.equal((await deliver(first)).replayed,true)
 await read()
 await move(30)
 const unallocated=await api('payment.record',{customer,amount:'10',received_on:'2026-10-22',method:'bank_transfer',reference:id()})
 await read()
 await api('payment.allocate',{payment:unallocated.payment,invoice:partial,amount:'10'})
 partialExpected.recoveredAmountCents=1000;partialExpected.recoveries=[{amountCents:1000,attempt:null,step:null}]
 await read()
 await api('credit.issue',{invoice:partial,amount:'10',reason:'Synthetic credit reduces debt without recovered cash'})
 await read()

 // A current processing intent and an unconfirmed failure cannot manufacture
 // either a cohort or allocated recovery money.
 const processing=intent(pending,3000,'processing')
 await deliver(edge.event(id(),'payment_intent.processing',processing,instant/1000))
 assert.equal((await deliver(edge.event(id(),'payment_intent.payment_failed',processing,instant/1000),{status:409})).error,'processor_failure_unconfirmed')
 await read()
 assert.equal((await api(`invoices/${pending}`)).paidCents,0)

 const policy=await api('dunning.policy.create',{name:'Synthetic invoice reminders',scope:'default',scope_ref:'',offsets:'0',end_day:1,end_action:'keep_active',invoice_only:true,confirm:true})
 const series=await api('dunning.enroll',{invoice:partial,policy:policy.id,confirm:true})
 const message=await api('dunning.mail.prepare',{series:series.id,step:1,confirm:true})
 const sent=await api('dunning.mail.send',{delivery:message.id,basis_hash:message.basisHash,confirm:true})
 assert.equal(sent.status,'accepted')
 partialExpected.steps=[`dunning:${policy.id}:1`]
 await read()
 const publicSeries=(await api('dunning')).series.find(row=>row.id===series.id)
 assert.deepEqual([publicSeries.first_failed_at,publicSeries.deliveries[0].step,publicSeries.deliveries[0].amount_cents],[partialExpected.firstFailedAt,1,6000])

 await move(40)
 Object.assign(paidIntent,{status:'succeeded',amount_received:6000,latest_charge:id()});delete paidIntent.last_payment_error
 const transaction={object:'balance_transaction',id:id(),type:'charge',source:paidIntent.latest_charge,amount:6000,fee:200,net:5800,currency:'usd',status:'available',created:instant/1000,available_on:instant/1000}
 const charge={object:'charge',id:paidIntent.latest_charge,customer:customerRef,payment_intent:paidIntent.id,status:'succeeded',paid:true,captured:true,amount:6000,amount_captured:6000,currency:'usd',livemode:false,created:instant/1000,balance_transaction:transaction.id,payment_method_details:{type:'card'}}
 edge.objects.set(charge.id,charge);edge.transactions.set(transaction.id,transaction)
 const succeeded=edge.event(id(),'payment_intent.succeeded',paidIntent,instant/1000)
 await deliver(succeeded);await deliver(succeeded)
 paidExpected.recoveredAmountCents=6000;paidExpected.recoveries=[{amountCents:6000,attempt:1,step:null}]
 await read()
 const publicPaid=await api(`invoices/${paid}`)
 assert.deepEqual([publicPaid.balanceCents,publicPaid.paidCents,publicPaid.allocations.length],[0,6000,1])
 assert.equal((await read()).invoices.find(row=>row.invoice===paid).recoveries[0].payment,publicPaid.allocations[0].payment_id)
 await allocate(partial,6000)
 partialExpected.recoveredAmountCents=4000;partialExpected.recoveries.push({amountCents:3000,attempt:null,step:null})
 const report=await read()
 assert.deepEqual([report.totals.failedInvoices,report.totals.recoveredInvoices,report.totals.failedAmountCents,report.totals.recoveredAmountCents,report.totals.recoveryRate,report.totals.amountRecoveryRate],[4,2,19000,10000,1/2,10/19])
 assert.equal((await api(`invoices/${partial}`)).paidCents,9000,'Actual allocated cash can exceed the immutable failed cohort amount')
 assert.equal(report.byDunningStep.find(row=>row.key===partialExpected.steps[0]).recoveredAmountCents,0,'Later external cash never borrows a recorded reminder step')

 // Webhook-only failures qualify for explicit churn attribution, while member
 // authority, an actual ended subscription and unpaid debt remain mandatory.
 const beforeChurn=(await api('recovery')).involuntaryChurn
 assert.equal(beforeChurn.count,0)
 await api('retry.churn.record',{invoice:unpaid,subscription_revision:(await api(`subscriptions/${unpaidSub}`)).revision,end_date:'2026-10-22',confirm:true},409)
 for(const subscription of [unpaidSub,paidSub])await api('subscription.end',{subscription,end_date:'2026-10-22',reason:'Synthetic reviewed subscription end'})
 const ended=await api(`subscriptions/${unpaidSub}`),paidEnded=await api(`subscriptions/${paidSub}`)
 const churn={invoice:unpaid,subscription_revision:ended.revision,end_date:ended.end_date,confirm:true}
 const beforeInvoice=await api(`invoices/${unpaid}`),beforePayments=await api('payments')
 const candidates=(await api('recovery')).involuntaryChurn.candidates
 assert.ok(candidates.some(row=>row.invoice===unpaid));assert.ok(!candidates.some(row=>row.invoice===paid))
 await h.api('retry.churn.record',finance,churn,403)
 await api('retry.churn.record',{invoice:paid,subscription_revision:paidEnded.revision,end_date:paidEnded.end_date,confirm:true},409)
 assert.equal((await api('recovery')).involuntaryChurn.count,0)
 await api('retry.churn.record',churn)
 const after=await read()
 assert.deepEqual(after.involuntaryChurn.records.map(row=>[row.invoice_id,row.subscription_id,row.ended_on]),[[unpaid,unpaidSub,'2026-10-22']])
 await api('retry.churn.record',churn,409)
 assert.deepEqual(await api(`invoices/${unpaid}`),beforeInvoice)
 assert.deepEqual(await api('payments'),beforePayments)
 assert.equal(native.calls.filter(call=>call.method==='POST').length,1,'Only the separately authorized first trial charge reaches the paid edge')
 await h.advanceClock('2026-10-22T12:00:00Z')
 return {customer,invoice:partial,unpaid,paid,trial:trial.invoice,purchase:purchase.invoice,expected}
}
