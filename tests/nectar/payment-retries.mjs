import assert from 'node:assert/strict'
import { retryEdge } from './retry-edge.mjs'
import { totp } from './mfa.mjs'
import { assertComparisons, assertRecoveryBuckets, retryPolicyWrites } from './recovery-assertions.mjs'
import { assertTimingTable } from './retry-comparison-description.mjs'

let edge

export const harnessOptions=()=>{edge=retryEdge();return {assets:true,localTime:'2026-10-22T10:00:00Z',stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1',webhookFetch:async request=>{edge.delivered.push(await request.json());return Response.json({accepted:true})}}}

export async function paymentRetriesFlow(h,owner,{onState=async()=>{},prepareCollection,acceptCollection}={}){
 const api=(path,body,status)=>h.api(path,owner,body,status),first=Date.parse('2026-10-22T10:00:00Z'),day=86400000
 const policies=retryPolicyWrites(api)
 const observedTimings=new Map()
 let instant=first
 await api('business.configure',{...await api('business'),timezone:'UTC'})
 const factor=await api('mfa.totp.start',{});await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,instant)});await api('mfa.policy',{scope:'all'})
 await api('portal.configure',{hosts:[h.origin],parents:[]})
 await api('webhook.register',{url:'https://receiver.nectar-app.com/retries',consent:true})
 const customers=[],createdInvoices=[],failureLedger=[]
 for(const n of [1,3,4]){
  const c=(await api('customer.create',{external_id:`synthetic-nectar-retry-${n}`,name:`Cedar retry customer ${n}`,billing_email:`retry-${n}@example.test`,language:n===3?'es-US':'en'})).id
  customers.push(c);await api('collection.customer.bind',{customer:c,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:`synthetic-nectar-native-customer-${n}`,confirm:true})
 }
 const move=async at=>{instant=at;edge.setTime(at);await h.advanceClock(new Date(at).toISOString())}
 let verifiedAt=first
 const fresh=async()=>{if(instant-verifiedAt>=14*60000){await api('mfa.verify',{code:totp(factor.secret,instant)});verifiedAt=instant}}
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
  const initial=await api(`invoices/${id}`)
  const observedCode=n===1&&code==='insufficient_funds'?'ach_insufficient_funds':code
  if(enabled&&!observedTimings.has(observedCode))observedTimings.set(observedCode,{delayHours:initial.next_payment_attempt?(initial.next_payment_attempt-instant)/3600000:null,...request.quote.retryPolicy})
  failureLedger.push({invoice:id,currency:'USD',firstFailedAt:instant,failedAmountCents:10000,declineCode:n===1&&code==='insufficient_funds'?'ach_insufficient_funds':code,intent:edge.writes.at(-1).id})
  createdInvoices.push(id)
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
 for(const code of ['R01','R09','insufficient_funds','R02','R03','R05','R07','R10','R29']){
  const bank=await create(code,{customer:customers[1]})
  const initial=await parity(bank)
  const intent=edge.intents.get(edge.writes.at(-1).id).value,charge=edge.charges.get(intent.latest_charge).value
  const event={object:'event',id:`synthetic-nectar-${8000+edge.events.size}`,type:'charge.failed',livemode:false,created:instant/1000,data:{object:structuredClone(charge)}}
  edge.events.set(event.id,event)
  await api('processor.event.consume',{account_ref:'synthetic-nectar-native-account-1',event_ref:event.id})
  assert.equal((await api('processor.event.consume',{account_ref:'synthetic-nectar-native-account-1',event_ref:event.id})).replayed,true)
  const observed=(await api(`processor-events?customer=${customers[1]}`)).objects
  const raw=code==='insufficient_funds'?null:code
  assert.equal(observed.find(row=>row.object_ref===charge.id&&row.kind==='ach_return').code,raw,'Current raw network return identity is retained independently of the normalized provider error')
  assert.equal(observed.find(row=>row.object_ref===intent.id&&row.kind==='payment_intent').code,intent.last_payment_error.code)
  assert.equal((await parity(bank)).next_payment_attempt,initial.next_payment_attempt,'Processor return intake preserves the consented retry timing')
  assert.equal(initial.next_payment_attempt,['R01','R09','insufficient_funds'].includes(code)?instant+3*day:null)
  if(initial.next_payment_attempt){
   const before=edge.writes.length
   await tick(initial.next_payment_attempt);const second=await parity(bank);await tick(second.next_payment_attempt)
   assert.equal((await parity(bank)).attempt_count,3);assert.equal((await api(`invoices/${bank.id}`)).next_payment_attempt,null)
   await tick(instant+day);assert.equal(edge.writes.length,before+2)
  }
 }
 const prohibitedBank=await create('R01',{customer:customers[1],advice:'do_not_try_again'})
 assert.equal((await parity(prohibitedBank)).next_payment_attempt,null,'A bank return eligible by network code still obeys explicit processor retry prohibition')
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
 await fresh();await policies.configure({max_attempts:4,window_days:7,confirm:true})
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
 assert.deepEqual(report.invoices.map(i=>i.invoice).sort(),createdInvoices.slice().sort())
 assert.equal(report.totals.failedAmountCents,createdInvoices.length*10000)
 const payments=await api('payments')
 assert.equal(report.totals.recoveredAmountCents,payments.reduce((sum,p)=>sum+p.amount_cents,0))
 for(const record of report.invoices){const invoice=await api(`invoices/${record.invoice}`);assert.equal(record.recoveredAmountCents,invoice.allocations.reduce((sum,a)=>sum+a.amount_cents,0))}
 const expected=[]
 for(const failure of failureLedger){
  const invoice=await api(`invoices/${failure.invoice}`),writes=edge.writes.filter(w=>w.id===failure.intent)
  const cash=invoice.allocations.reduce((sum,a)=>sum+a.amount_cents,0)
  const attempts=writes.map((write,index)=>({attempt:index+1,at:write.at,step:null}))
  const recoveries=cash?[{amountCents:cash,attempt:writes.length,step:null}]:[]
  const actual=report.invoices.find(r=>r.invoice===failure.invoice)
  assert.deepEqual([actual.firstFailedAt,actual.failedAmountCents,actual.declineCode],[failure.firstFailedAt,failure.failedAmountCents,failure.declineCode])
  assert.deepEqual(actual.attempts.map(a=>({attempt:a.attempt,at:a.at,step:a.step})),attempts)
  expected.push({...failure,attempts,recoveries,recoveredAmountCents:cash})
 }
 assertRecoveryBuckets(report,expected)
 await assertComparisons(await api('retry-comparison'),policies.expected)
 await assertTimingTable(observedTimings)

 assert.equal(report.totals.recoveredInvoices,3)
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
 edge.customers.get('synthetic-nectar-native-customer-1').method='synthetic-nectar-native-card-1'
 const overdue=await create('processing_error'),overdueWrites=edge.writes.length
 await move(instant+15*day)
 const expired=await api(`invoices/${overdue.id}`);assert.equal(expired.next_payment_attempt,null);assert.equal(expired.retry_status,'exhausted')
 await tick(instant);assert.equal(edge.writes.length,overdueWrites,'An expired window cannot send even when the scheduler missed its earlier due time')
 console.log('paymentRetriesFlow: consented policy, exact timing, hard and ACH prohibitions, caps, dispute hold, once-only cash and page API webhook parity')
}
