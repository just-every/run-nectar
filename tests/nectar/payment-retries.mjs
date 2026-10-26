import assert from 'node:assert/strict'
import { retryEdge } from './retry-edge.mjs'
import { totp } from './mfa.mjs'
let edge
export const harnessOptions=()=>{edge=retryEdge();return {assets:true,localTime:'2026-10-22T10:00:00Z',stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1',webhookFetch:async request=>{edge.delivered.push(await request.json());return Response.json({accepted:true})}}}
export async function paymentRetriesFlow(h,owner,{onState=async()=>{},prepareCollection,acceptCollection}={}){
 const api=(path,body,status)=>h.api(path,owner,body,status),first=Date.parse('2026-10-22T10:00:00Z'),day=86400000
 let instant=first
 await api('business.configure',{...await api('business'),timezone:'UTC'})
 const factor=await api('mfa.totp.start',{});await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,instant)});await api('mfa.policy',{scope:'all'})
 await api('portal.configure',{hosts:[h.origin],parents:[]})
 await api('webhook.register',{url:'https://receiver.nectar-app.com/retries',consent:true})
 const customers=[]
 for(const n of [1,3,4]){
  const c=(await api('customer.create',{external_id:`synthetic-nectar-retry-${n}`,name:`Cedar retry customer ${n}`,billing_email:`retry-${n}@example.test`,language:n===3?'es-US':'en'})).id
  customers.push(c);await api('collection.customer.bind',{customer:c,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:`synthetic-nectar-native-customer-${n}`,confirm:true})
 }
 const move=async at=>{instant=at;edge.setTime(at);await h.advanceClock(new Date(at).toISOString())}
 const fresh=()=>api('mfa.verify',{code:totp(factor.secret,instant)})
 const tick=async at=>{await move(at);assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${at}&cron=${encodeURIComponent('* * * * *')}`)).status,200)}
 const create=async(code,{customer=customers[0],enabled=true,recoverAt=Infinity,advice}={})=>{
  await fresh()
  const n=customers.indexOf(customer),method=n===1?edge.bank:`synthetic-nectar-native-card-${n===2?4:1}`
  edge.rules.set(method,{code,recoverAt,advice})
  const charge=await api('charge.add',{customer,amount:'100',description:'Monthly retry service',effective_date:new Date(instant).toISOString().slice(0,10),taxable:false})
  const id=(await api('invoice.manual',{customer,charges:[charge.charge],service_date:new Date(instant).toISOString().slice(0,10)})).id
  const request=await (prepareCollection??(input=>api('automatic.collection.prepare',input)))({invoice:id,issue_date:new Date(instant).toISOString().slice(0,10),enable_retries:enabled,...(n===1?{mandate_ref:edge.mandate}:{})})
  const session=await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'}),path=`/portal/automatic-collections/${request.id}?session=${encodeURIComponent(session.token)}`
  await onState({state:'consent',id,customer,request,path})
  if(acceptCollection)await acceptCollection({path,request})
  else assert.equal((await h.raw(path,{body:{request:request.id,basis_hash:request.basis,accept:true}})).status,200)
  await api('automatic.collection.decide',{request:request.id,basis_hash:request.basis,decision:'approved',confirm:true,confirm_single:true})
  await api('invoice.approve',{invoice:id,acknowledge:true});await api('invoice.finalise',{invoice:id,issue_date:new Date(instant).toISOString().slice(0,10)})
  return {id,request,method,path}
 }
 const parity=async invoice=>{
  const view=await api(`invoices/${invoice.id}`)
  await fresh();await api('webhook.dispatch',{})
  const event=edge.delivered.filter(e=>e.type==='invoice.payment_failed'&&e.data.invoice===invoice.id).at(-1)
  assert.ok(event);assert.equal(event.data.next_payment_attempt,view.next_payment_attempt);assert.equal(event.data.attempt_count,view.attempt_count)
  const response=await h.page(`/app/invoices/${invoice.id}`,owner)
  assert.ok(response.includes(`data-next-payment-attempt="${view.next_payment_attempt??''}"`))
  return view
 }
 // Default is off, even when a method is saved and first collection is accepted.
 const disabled=await create('processing_error',{enabled:false})
 assert.equal((await parity(disabled)).next_payment_attempt,null)
 const processing=await create('processing_error',{recoverAt:2})
 assert.equal((await parity(processing)).next_payment_attempt,first+4*3600000)
 await onState({state:'scheduled',...processing})
 const count=edge.writes.length;await tick(first+4*3600000-1);assert.equal(edge.writes.length,count)
 await tick(first+4*3600000);await tick(first+4*3600000)
 assert.equal(edge.writes.length,count+1);assert.equal((await api(`invoices/${processing.id}`)).balanceCents,0)
 assert.equal((await api(`invoices/${processing.id}`)).allocations.length,1)
 await onState({state:'recovered',...processing})
 // Hard declines and unknown reasons are never confirmed again on the same method.
 for(const code of ['stolen_card','lost_card','authentication_required','pickup_card','incorrect_number','revocation_of_authorization','revocation_of_all_authorizations','highest_risk_level','transaction_not_allowed']){
  // Each fixture uses a genuinely new saved method after the prior hard refusal.
  edge.customers.get('synthetic-nectar-native-customer-4').method=`synthetic-nectar-replacement-${code}`
  const method=edge.customers.get('synthetic-nectar-native-customer-4').method
  edge.rules.set(method,{code,recoverAt:Infinity})
  // create sets a standard method rule too; the selected replacement remains hard.
  const hard=await create(code,{customer:customers[2]})
  assert.equal((await parity(hard)).next_payment_attempt,null)
  await onState({state:code,...hard})
 }
 // Both ACH eligible returns allow at most two reinitiations; all authorization returns stop.
 for(const code of ['R01','R09','R02','R03','R05','R07','R10','R29']){
  const bank=await create(code,{customer:customers[1]})
  const initial=await parity(bank)
  assert.equal(initial.next_payment_attempt,['R01','R09'].includes(code)?instant+3*day:null)
  if(initial.next_payment_attempt){
   const before=edge.writes.length
   await tick(initial.next_payment_attempt);const second=await parity(bank);await tick(second.next_payment_attempt)
   assert.equal((await parity(bank)).attempt_count,3);assert.equal((await api(`invoices/${bank.id}`)).next_payment_attempt,null)
   await tick(instant+day);assert.equal(edge.writes.length,before+2)
  }
 }
 // Default attempt and time caps are independently observable at the public invoice door.
 const capped=await create('do_not_honor'),capStart=instant
 for(let n=1;n<=7;n++)await tick(capStart+n*day)
 assert.equal((await parity(capped)).attempt_count,8);assert.equal((await api(`invoices/${capped.id}`)).next_payment_attempt,null)
 const windowed=await create('insufficient_funds'),windowStart=instant
 for(let n=1;n<=4;n++)await tick(windowStart+n*3*day)
 assert.equal((await parity(windowed)).attempt_count,5);assert.equal((await api(`invoices/${windowed.id}`)).next_payment_attempt,null)
 const prohibited=await create('do_not_honor',{advice:'do_not_try_again'})
 assert.equal((await parity(prohibited)).next_payment_attempt,null,'Processor advice prohibits retry even for a soft code')
 // Configure the four-attempt week. Existing customer consent stays frozen.
 await fresh();await api('retry.policy.configure',{max_attempts:4,window_days:7,confirm:true})
 const limited=await create('do_not_honor'),start=instant
 for(let n=1;n<=3;n++){await tick(start+n*day);await parity(limited)}
 assert.equal((await api(`invoices/${limited.id}`)).attempt_count,4)
 assert.equal((await api(`invoices/${limited.id}`)).next_payment_attempt,null)
 await onState({state:'exhausted',...limited})
 // A dispute after scheduling stops all retry collection, including an undisputed remainder.
 const held=await create('do_not_honor',{recoverAt:2}),view=await api(`invoices/${held.id}`)
 const dispute=await api('cadence.dispute',{invoice:held.id,line:view.lines[0].id,amount:'10',reason:'Disputed source quantity'})
 const before=edge.writes.length;await tick(instant+day);assert.equal(edge.writes.length,before)
 assert.equal((await api(`invoices/${held.id}`)).next_payment_attempt,null)
 await onState({state:'disputed',...held})
 await fresh();await api('cadence.resolve',{dispute:dispute.dispute,outcome:'Quantity agreed'})
 await tick(instant);assert.equal(edge.writes.length,before+1);assert.equal((await api(`invoices/${held.id}`)).balanceCents,0)
 const unknown=await create('processing_error',{recoverAt:2});edge.lose();await tick(instant+4*3600000)
 const after=edge.writes.length;await tick(instant);assert.equal(edge.writes.length,after)
 assert.equal((await api(`invoices/${unknown.id}`)).balanceCents,0,'Lost confirmation response reconciles the same intent once')
 await fresh()
 const report=await api('recovery')
 assert.ok(report.totals.failedInvoices>0);assert.equal(report.totals.recoveredInvoices,3)
 assert.equal(report.totals.recoveredAmountCents,30000)
 assert.equal(report.involuntaryChurn.available,true);assert.equal(report.involuntaryChurn.count,0,'Exhaustion alone is never involuntary churn')
 await onState({state:'report',id:unknown.id,report})
 const stopped=await create('do_not_honor',{recoverAt:2}),session=await api('portal.session.issue',{customer:stopped.request.customer,origin:h.origin,audience:'hosted'})
 assert.equal((await h.raw(`/portal/automatic-collections/${stopped.request.id}?session=${encodeURIComponent(session.token)}`,{body:{request:stopped.request.id,withdraw:true}})).status,200)
 assert.equal((await api(`invoices/${stopped.id}`)).next_payment_attempt,null)
 const stoppedCount=edge.writes.length;await tick(instant+day);assert.equal(edge.writes.length,stoppedCount,'Customer withdrawal revokes future retry authority')
 const missing=await create('do_not_honor',{recoverAt:2});edge.customers.get('synthetic-nectar-native-customer-1').method=null
 const missingCount=edge.writes.length;await tick(instant+day);assert.equal(edge.writes.length,missingCount)
 assert.equal((await api(`invoices/${missing.id}`)).next_payment_attempt,null,'Missing methods stop without a provider write')
 const mails=h.mails.length;await tick(instant+20*day);assert.equal(h.mails.length,mails,'Retries send no customer notices')
 console.log('paymentRetriesFlow: consented policy, exact timing, hard and ACH prohibitions, caps, dispute hold, once-only cash and page API webhook parity')
}

export async function retryComparisonFlow(h,owner){
 const api=(p,b,status)=>h.api(p,owner,b,status)
 const record=await api('retry-comparison'),{measured,baseline}=record.publishedDefault
 assert.equal(measured.failedPayments,record.payments.length)
 const independentlySummed=result=>record.payments.reduce((sum,p)=>sum+(result.outcomes.find(o=>o.id===p.id).recoveredAtHours!==null?p.amountCents:0),0)
 for(const result of [measured,baseline]){
  assert.equal(result.recoveredAmountCents,independentlySummed(result))
  assert.equal(result.recoveredPayments,result.outcomes.filter(o=>o.recoveredAtHours!==null).length)
  for(const o of result.outcomes){const p=record.payments.find(p=>p.id===o.id);if(o.recoveredAtHours!==null)assert.ok(p.successWindowsHours.some(([a,b])=>o.recoveredAtHours>=a&&o.recoveredAtHours<b))}
 }
 assert.deepEqual({count:measured.recoveredPayments,amount:measured.recoveredAmountCents},{count:record.publishedRecord.find(r=>r.policy==='decline-table-v1').recoveredPayments,amount:record.publishedRecord.find(r=>r.policy==='decline-table-v1').recoveredAmountCents})
 assert.equal(baseline.recoveredAmountCents,record.publishedRecord.find(r=>r.policy==='fixed-three-v1').recoveredAmountCents)
 const page=await h.page('/app/reports/recovery',owner)
 assert.ok(page.includes('$1,900')&&page.includes('$1,200'))
 console.log('retryComparisonFlow: published known outcomes independently sum to both schedules and the product description')
}

export async function retryPlanChurnFlow(h,owner,{onState=async()=>{}}={}){
 const api=(p,b,status)=>h.api(p,owner,b,status)
 let instant=Date.parse('2026-10-22T10:00:00Z');await h.advanceClock(new Date(instant).toISOString());edge.setTime(instant)
 await api('business.configure',{...await api('business'),timezone:'UTC'})
 const factor=await api('mfa.totp.start',{});await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,instant)});await api('mfa.policy',{scope:'all'})
 const customer=(await api('customer.create',{external_id:'synthetic-nectar-churn',name:'Cedar ended account',billing_email:'ended@example.test'})).id
 await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:'synthetic-nectar-native-customer-1',confirm:true})
 const product=(await api('product.create',{code:'retry-plan',name:'Monthly retry plan'})).id
 const price=(await api('price.create',{product,kind:'flat',unit_amount:'100',taxable:false})).id
 await api('retry.policy.configure',{max_attempts:4,window_days:7,confirm:true})
 await api('retry.policy.configure',{plan:price,max_attempts:2,window_days:7,confirm:true})
 const sub=(await api('subscription.create',{customer,start_date:'2026-09-01',price:[price],quantity:['1']})).id
 const run=await api('billrun.prepare',{period:'2026-09'}),invoice=(await api(`runs/${run.id}`)).invoices.find(i=>i.subscription_id===sub).id
 await api('portal.configure',{hosts:[h.origin],parents:[]})
 const request=await api('automatic.collection.prepare',{invoice,issue_date:'2026-10-22',enable_retries:true})
 assert.equal(request.quote.retryPolicy.maxAttempts,2,'The invoice price override precedes the default')
 assert.equal(request.quote.retryPolicy.scope,`plan:${price}`)
 const session=await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
 assert.equal((await h.raw(`/portal/automatic-collections/${request.id}?session=${encodeURIComponent(session.token)}`,{body:{request:request.id,basis_hash:request.basis,accept:true}})).status,200)
 await api('automatic.collection.decide',{request:request.id,basis_hash:request.basis,decision:'approved',confirm:true,confirm_single:true})
 edge.rules.set('synthetic-nectar-native-card-1',{code:'do_not_honor',recoverAt:Infinity})
 await api('invoice.approve',{invoice,acknowledge:true});await api('invoice.finalise',{invoice,issue_date:'2026-10-22'})
 // A later broader default never widens customer-approved terms.
 await api('retry.policy.configure',{max_attempts:8,window_days:14,confirm:true})
 instant+=86400000;edge.setTime(instant);await h.advanceClock(new Date(instant).toISOString())
 assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent('* * * * *')}`)).status,200)
 assert.equal((await api(`invoices/${invoice}`)).attempt_count,2);assert.equal((await api(`invoices/${invoice}`)).next_payment_attempt,null)
 await api('mfa.verify',{code:totp(factor.secret,instant)})
 await api('retry.churn.record',{invoice,subscription_revision:(await api(`subscriptions/${sub}`)).revision,end_date:'2026-10-23',confirm:true},409)
 assert.equal((await api('recovery')).involuntaryChurn.count,0)
 await api('subscription.end',{subscription:sub,end_date:'2026-10-23',reason:'Ended after unpaid failed renewal'})
 const ended=await api(`subscriptions/${sub}`),before=await api(`invoices/${invoice}`)
 await onState({state:'churn-candidate',invoice})
 await api('retry.churn.record',{invoice,subscription_revision:ended.revision,end_date:ended.end_date,confirm:true})
 const report=await api('recovery');assert.equal(report.involuntaryChurn.count,1)
 assert.equal(report.involuntaryChurn.records[0].subscription_id,sub)
 assert.equal(report.totals.failedInvoices,1);assert.equal(report.totals.failedAmountCents,10000);assert.equal(report.totals.recoveredAmountCents,0)
 await api('retry.churn.record',{invoice,subscription_revision:ended.revision,end_date:ended.end_date,confirm:true},409)
 assert.equal((await api(`invoices/${invoice}`)).balanceCents,before.balanceCents)
 await onState({state:'churn-recorded',invoice})
 console.log('retryPlanChurnFlow: frozen plan override and confirmed actual ended-subscription churn without changing cash or invoice facts')
}
