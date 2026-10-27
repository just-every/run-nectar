import assert from 'node:assert/strict'
import { retryEdge } from './retry-edge.mjs'
import { hostedSetupEdge } from './customer-payment-methods.mjs'
import { assertRecoveryBuckets } from './recovery-assertions.mjs'
import { totp } from './mfa.mjs'
import { file } from './harness.mjs'
let edge,setup,received
const first=Date.parse('2026-10-22T10:00:00Z'),day=86400000
export const harnessOptions=()=>{
 received=[]
 edge=retryEdge()
 setup=hostedSetupEdge(async request=>{
  const url=new URL(request.url)
  if(request.method==='GET'&&url.pathname.startsWith('/v1/payment_methods/')){
   const row=[...setup.sessions.values()].find(s=>url.pathname.endsWith('/'+s.method.id))
   if(row)return Response.json(row.method)
  }
  return edge.fetch(request)
 })
 const fetch=async request=>{
  const url=new URL(request.url)
  const response=url.pathname==='/v1/customers/synthetic-nectar-native-customer-3'?await edge.fetch(request):await setup.fetch(request)
  if(request.method==='POST'&&new URL(request.url).pathname.startsWith('/v1/customers/')){
   const value=await response.clone().json()
   edge.customers.get(value.id).method=value.invoice_settings.default_payment_method
  }
  return response
 }
 return {webhookFetch:async request=>{received.push(await request.json());return new Response(null,{status:200})},assets:true,localTime:new Date(first).toISOString(),stripeFetch:fetch,stripeSecret:'synthetic-nectar-1'}
}
export async function dunningSequenceFlow(h,owner,{onState=async()=>{},createPolicy,enroll,prepareMail,sendMail,finish,updateMethod,prepareRecovery,acceptRecovery,approveRecovery,cancelSubscription}={}) {
 const api=(p,b,status)=>h.api(p,owner,b,status)
 let instant=first
 await api('business.configure',{...await api('business'),timezone:'UTC'})
 const factor=await api('mfa.totp.start',{});await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,instant)});await api('mfa.policy',{scope:'all'})
 await api('webhook.register',{url:'https://receiver.nectar-app.com/events',consent:true})
 await api('portal.configure',{hosts:[h.origin],parents:[]})
 const move=async offset=>{
  instant=first+offset*day;edge.setTime(instant);await h.advanceClock(new Date(instant).toISOString())
  await api('mfa.verify',{code:totp(factor.secret,instant)})
 }
 const policy=createPolicy??(p=>api('dunning.policy.create',p))
 const register=enroll??(p=>api('dunning.enroll',p))
 const prepare=prepareMail??(p=>api('dunning.mail.prepare',p))
 const send=sendMail??(p=>api('dunning.mail.send',p))
 const end=finish??(p=>api('dunning.end',p))
 const standard=await policy({name:'Standard recovery',scope:'default',scope_ref:'',offsets:'0,3,7,21',end_day:21,end_action:'restrict',confirm:true})
 const product=(await api('product.create',{code:'dunning-service',name:'Cedar workspace'})).id
 await api('feature.grant',{product,feature:'api_access'})
 const price=(await api('price.create',{product,kind:'flat',unit_amount:'100',taxable:false})).id
 const enterpriseProduct=(await api('product.create',{code:'enterprise-invoice',name:'Enterprise workspace'})).id
 await api('feature.grant',{product:enterpriseProduct,feature:'api_access'})
 const enterprisePrice=(await api('price.create',{product:enterpriseProduct,kind:'flat',unit_amount:'100',taxable:false})).id
 const enterprise=await policy({name:'Enterprise invoice terms',scope:'plan',scope_ref:enterprisePrice,offsets:'2,10,20',end_day:28,end_action:'keep_active',invoice_only:true,confirm:true})
 const unpaidPolicy=await policy({name:'Unpaid service',scope:'default',scope_ref:'',offsets:'21',end_day:21,end_action:'mark_unpaid',invoice_only:false,confirm:true})
 edge.customers.set('synthetic-nectar-dunning-unpaid',{account:1,method:'synthetic-nectar-dunning-card-4'})
 const cancelPolicy=await policy({name:'Reviewed cancellation',scope:'default',scope_ref:'',offsets:'21',end_day:21,end_action:'cancel',confirm:true})
 edge.customers.set('synthetic-nectar-dunning-cancel',{account:1,method:'synthetic-nectar-dunning-card-5'})
 const histories=new Map()
 const observe=async(record,expected)=>{
  for(let n=0;n<2;n++){const response=await h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent('* * * * *')}`);assert.equal(response.status,200,await response.text())}
  const view=await api(`subscriptions/${record.sub}`),history=view.stateHistory
  assert.equal(view.state,expected,'Current lifecycle state follows native financial facts')
  const customerRecord=await api(`customers/${view.customer_id}`)
  assert.equal(customerRecord.subscriptions.find(s=>s.id===record.sub).state,expected,'Customer composition shares the observed subscription state')
  assert.deepEqual(customerRecord.billingRecord.subscriptionHistory.find(s=>s.id===record.sub).record.stateHistory,history,'Customer source history agrees with the subscription public door')
  assert.equal(history.at(-1).state,expected,'Scheduled observation records the exact expected state')
  assert.equal(history.at(-1).observed_at,instant,'Observation time is the pinned scheduled clock')
  assert.equal(history.at(-1).cause.day,new Date(instant).toISOString().slice(0,10))
  assert.equal(history.at(-1).cause.timezone,'UTC')
  for(const [index,row] of history.entries()){assert.equal(row.previous_id,index?history[index-1].id:null);assert.equal(row.previous_state,index?history[index-1].state:null)}
  assert.deepEqual(history.slice(0,(histories.get(record.sub)??[]).length),histories.get(record.sub)??[],'Earlier cause history remains byte-for-byte unchanged')
  assert.equal(new Set(history.map(row=>row.id)).size,history.length)
  for(const row of history){
   const event=received.find(e=>e.id===row.id&&e.type==='subscription.state_changed')
   assert.ok(event,'Each observed transition reaches the configured webhook receiver')
   assert.deepEqual(event.data,{subscription_id:record.sub,customer_id:view.customer_id,transition_id:row.id,previous_state:row.previous_state,state:row.state,cause:row.cause,observed_at:row.observed_at})
  }
  histories.set(record.sub,structuredClone(history));await onState({state:'subscription-state-'+(expected==='active'&&history.at(-1).previous_state==='unpaid'?'recovered':expected),record:{...record,customer:view.customer_id},view});return history
 }
 const trialCustomer=(await api('customer.create',{external_id:'synthetic-nectar-state-trial',name:'Synthetic lifecycle trial',billing_email:'synthetic-nectar-state-trial@example.test'})).id
 const trial={sub:(await api('subscription.create',{customer:trialCustomer,start_date:'2026-10-01',trial_end:'2026-10-23',trial_payment:'card',price:[price],quantity:['1']})).id}
 await observe(trial,'trialing')
 const trialTerms=await api(`subscriptions/${trial.sub}`)
 const pause=await api('subscription.pause',{subscription:trial.sub,revision:trialTerms.revision,effective_date:'2026-10-22',resume_date:'2026-10-23',access:'suspend',reason:'Synthetic scheduled lifecycle pause'})
 const paused=await observe(trial,'paused')
 assert.equal(paused.at(-1).cause.lifecycle[0].id,pause.transition)
 const records=[]
 for(const [index,name,p,ref] of [[1,'Cedar recovery',price,'synthetic-nectar-native-customer-1'],[2,'Cedar overdue',price,'synthetic-nectar-native-customer-4'],[3,'Cedar enterprise',enterprisePrice,'synthetic-nectar-native-customer-3'],[4,'Cedar unpaid',price,'synthetic-nectar-dunning-unpaid'],[5,'Cedar cancellation',price,'synthetic-nectar-dunning-cancel']]){
  // Every failed invoice starts with a distinct usable card and exact consent.
  const method=`synthetic-nectar-dunning-card-${index}`
  edge.customers.get(ref).method=method;edge.rules.set(method,{code:'stolen_card',recoverAt:Infinity})
  const customer=(await api('customer.create',{external_id:`synthetic-nectar-dunning-${index}`,name,billing_email:`dunning-${index}@example.test`,language:index===2?'es-US':'en'})).id
  await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:ref,confirm:true})
  const sub=(await api('subscription.create',{customer,start_date:'2026-09-01',price:[p],quantity:['1']})).id
  await observe({sub},'active')
  const run=await api('billrun.prepare',{period:'2026-09'}),invoice=(await api(`runs/${run.id}`)).invoices.find(i=>i.subscription_id===sub).id
  const collection=await api('automatic.collection.prepare',{invoice,issue_date:'2026-10-22',enable_retries:true})
  const session=await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
  assert.equal((await h.raw(`/portal/automatic-collections/${collection.id}?session=${encodeURIComponent(session.token)}`,{body:{request:collection.id,basis_hash:collection.basis,accept:true}})).status,200)
  await api('automatic.collection.decide',{request:collection.id,basis_hash:collection.basis,decision:'approved',confirm:true,confirm_single:true})
  await api('invoice.approve',{invoice,acknowledge:true});await api('invoice.finalise',{invoice,issue_date:'2026-10-22'})
  assert.equal((await api(`invoices/${invoice}`)).balanceCents,10000)
  const failedHistory=await observe({sub},'past_due')
  assert.deepEqual(failedHistory.at(-1).cause.payment.failures.map(f=>[f.invoice,f.status]),[[invoice,'refused']],'The actual declined automatic collection is the cause before the due date')
  if(index===3)await api('dunning.enroll',{invoice,policy:standard.id,confirm:true},409)
  const policyId=index===3?enterprise.id:index===4?unpaidPolicy.id:index===5?cancelPolicy.id:standard.id
  const series=await register({invoice,policy:policyId,confirm:true})
  records.push({customer,sub,invoice,collection,series,policy:policyId,email:`dunning-${index}@example.test`})
 }
 const [recover,overdue,enterpriseRecord,unpaid,canceled]=records
 const report=()=>api('dunning')
 await onState({state:'enrolled',records,report:await report()})
 const sent=[]
 const mail=async(record,step)=>{
  const before=h.mails.length
  const message={...await prepare({series:record.series.id,step,confirm:true}),key:`dunning:${record.policy}:${step}`}
  assert.equal(h.mails.length,before,'Preparation sends nothing')
  await onState({state:'prepared',record,message,report:await report()})
  const response=await send({delivery:message.id,basis_hash:message.basisHash,confirm:true})
  assert.equal(response.status,'accepted')
  assert.equal(h.mails.length,before+1)
  const actual=h.mails.at(-1)
  assert.deepEqual(actual.to,[record.email]);assert.equal(actual.subject,message.subject);assert.equal(actual.text,message.body)
  assert.equal((await api(`invoices/${record.invoice}`)).balanceCents,10000)
  const link=message.body.match(/https?:\/\/\S+\/portal\/payment-methods\?session=\S+/)?.[0]
  if(link){assert.equal(actual.html.match(/<a href="([^"]+)"/)?.[1].replaceAll('&amp;','&'),link);assert.equal((await h.raw(new URL(link).pathname+new URL(link).search)).status,200);assert.match(message.body,/100\.00/)}
  else assert.equal(record,enterpriseRecord,'Only invoice-only messages omit a setup link')
  sent.push({...message,invoice:record.invoice,link})
  await api('dunning.mail.send',{delivery:message.id,basis_hash:message.basisHash,confirm:true},409)
  await onState({state:'sent',record,message,link,emailHtml:actual.html,report:await report()})
  return {message,link}
 }
 instant=first+14*60000;edge.setTime(instant);await h.advanceClock(new Date(instant).toISOString())
 const firstMessage=await mail(recover,1);await mail(overdue,1)
 const initialPage=await (await h.raw(new URL(firstMessage.link).pathname+new URL(firstMessage.link).search)).text()
 const oldSetup=initialPage.match(/name="setup" value="([^"]+)"/)?.[1],oldHash=initialPage.match(/name="consent_hash" value="([^"]+)"/)?.[1]
 const initialStart=await h.raw(`/portal/payment-methods/start${new URL(firstMessage.link).search}`,{body:{setup:oldSetup,consent_hash:oldHash,make_default:true,confirm:true},headers:{accept:'application/json'}})
 assert.equal(initialStart.status,200)
 const oldReturn=initialStart.headers.getSetCookie().find(v=>v.startsWith('nectar_setup_return=')).split(';')[0]
 instant=first+15*60000;edge.setTime(instant);await h.advanceClock(new Date(instant).toISOString())
 assert.equal((await h.raw(new URL(firstMessage.link).pathname+new URL(firstMessage.link).search)).status,401,'The original factor deadline expires a later-issued emailed session')
 assert.equal((await h.raw('/portal/payment-methods',{cookie:oldReturn})).status,401,'The opaque return cannot extend the earlier dunning deadline')
 assert.equal((await h.raw('/portal/payment-methods/finish',{cookie:oldReturn,body:{setup:oldSetup,confirm:true},headers:{accept:'application/json'}})).status,401)
 const sends=h.mails.length,writes=edge.writes.length
 await move(2)
 assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent('* * * * *')}`)).status,200)
 assert.equal(h.mails.length,sends,'Scheduler never grants new outbound authority')
 assert.equal(edge.writes.length,writes)
 for(const prior of sent.filter(s=>s.link)){const url=new URL(prior.link);assert.equal((await h.raw(url.pathname+url.search)).status,401,'The original update capability expires rather than extending with a later owner factor')}
 await mail(enterpriseRecord,1)
 await move(3)
 const providerWrites=()=>setup.calls.filter(c=>['create','default'].includes(c.operation)).length
 const beforeRetirement=providerWrites()
 await api('dunning.mail.prepare',{series:recover.series.id,step:2,confirm:true},409)
 assert.equal(providerWrites(),beforeRetirement,'An open original processor setup is not replaced or retried')
 setup.expire(oldSetup)
 await mail(recover,2);await mail(overdue,2)
 assert.equal(providerWrites(),beforeRetirement,'Retiring a definitively expired or never-started setup makes no provider write')
 assert.ok((await api('audit')).some(e=>e.action==='dunning.setup.retire'&&e.subject===oldSetup&&JSON.parse(e.detail).reason==='provider-expired'))
 await move(7)
 const recoveryMail=await mail(recover,3);await mail(overdue,3)
 const path=new URL(recoveryMail.link).pathname+new URL(recoveryMail.link).search
 const methodPage=await (await h.raw(path)).text()
 const setupId=methodPage.match(/name="setup" value="([^"]+)"/)?.[1],hash=methodPage.match(/name="consent_hash" value="([^"]+)"/)?.[1]
 assert.ok(setupId&&hash)
 const update=async()=>{
  const start=await h.raw(`/portal/payment-methods/start${new URL(recoveryMail.link).search}`,{body:{setup:setupId,consent_hash:hash,make_default:true,confirm:true},headers:{accept:'application/json'}})
  assert.equal(start.status,200);const cookie=start.headers.getSetCookie().find(v=>v.startsWith('nectar_setup_return=')).split(';')[0]
  setup.complete(setupId)
  const finish=await h.raw(`/portal/payment-methods/finish${new URL(recoveryMail.link).search}`,{cookie,body:{setup:setupId,confirm:true},headers:{accept:'application/json'}})
  assert.equal(finish.status,200)
 }
 if(updateMethod)await updateMethod({record:recover,path,setupId,complete:()=>setup.complete(setupId)})
 else await update()
 assert.equal(edge.writes.length,writes,'Saving the replacement grants no debit authority')
 const wrongMessage=sent.find(s=>s.invoice===overdue.invoice&&s.step===3)
 await api('retry.method.prepare',{request:recover.collection.id,dunning_delivery:wrongMessage.id,confirm:true},409)
 const proposal=await (prepareRecovery??(p=>api('retry.method.prepare',p)))({request:recover.collection.id,dunning_delivery:recoveryMail.message.id,confirm:true})
 const sessionToken=new URL(recoveryMail.link).searchParams.get('session'),acceptPath=`/portal/retry-method-recoveries/${proposal.id}?session=${encodeURIComponent(sessionToken)}`
 if(acceptRecovery)await acceptRecovery({path:acceptPath,proposal})
 else assert.equal((await h.raw(acceptPath,{body:{recovery:proposal.id,quote_hash:proposal.quoteHash,accept:true}})).status,200)
 if(approveRecovery)await approveRecovery({invoice:recover.invoice,proposal})
 else await api('retry.method.decide',{recovery:proposal.id,quote_hash:proposal.quoteHash,decision:'approved',confirm:true,confirm_single:true})
 assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent('* * * * *')}`)).status,200)
 const paid=await api(`invoices/${recover.invoice}`)
 assert.equal(paid.balanceCents,0);assert.equal(paid.allocations.length,1);assert.equal(paid.paidCents,10000)
 assert.equal(edge.writes.length,writes+1);assert.equal(edge.writes.at(-1).id,edge.writes[0].id,'Recovery reconfirms the original intent')
 assert.equal((await report()).series.find(s=>s.id===recover.series.id).status,'settled')
 await api('dunning.mail.prepare',{series:recover.series.id,step:2,confirm:true},409)
 await observe(trial,'active')
 assert.deepEqual((await api(`subscriptions/${trial.sub}`)).stateHistory.map(row=>row.state),['trialing','paused','active'])
 await observe(recover,'active')
 await onState({state:'recovered',record:recover,report:await report()})
 await move(10);await mail(enterpriseRecord,2)
 await move(20);await mail(enterpriseRecord,3)
 await api('dunning.end',{series:overdue.series.id,action:'restrict',confirm:true},409)
 const entitlement=record=>api(`entitlements/${record.customer}?feature=api_access`)
 assert.equal((await entitlement(overdue)).allowed,true)
 await move(21);await api('dunning.mail.prepare',{series:recover.series.id,step:4,confirm:true},409);await mail(overdue,4)
 assert.equal((await entitlement(overdue)).allowed,true,'No destructive action occurs without explicit final confirmation')
 await end({series:overdue.series.id,action:'restrict',confirm:true})
 assert.equal((await entitlement(overdue)).allowed,false)
 assert.equal((await entitlement(enterpriseRecord)).allowed,true)
 await end({series:unpaid.series.id,action:'mark_unpaid',confirm:true})
 assert.equal((await entitlement(unpaid)).paths[0].state.payment.status,'unpaid')
 assert.equal((await entitlement(unpaid)).allowed,true,'Marking unpaid does not imply feature restriction')
 const unpaidHistory=await observe(unpaid,'unpaid')
 assert.deepEqual(unpaidHistory.at(-1).cause.dunning.map(d=>[d.id,d.policy_id,d.status]),[[unpaid.series.id,unpaidPolicy.id,'mark_unpaid']])
 await onState({state:'unpaid',record:unpaid,report:await report()})
 await api('dunning.end',{series:canceled.series.id,action:'cancel',confirm:true},409)
 const beforeCancel=await api(`subscriptions/${canceled.sub}`)
 await (cancelSubscription??(input=>api('subscription.cancel',input)))({subscription:canceled.sub,revision:beforeCancel.revision,mode:'immediate',effective_date:new Date(instant).toISOString().slice(0,10),reason:'Owner reviewed the exhausted dunning policy'})
 await end({series:canceled.series.id,action:'cancel',confirm:true})
 assert.equal((await entitlement(canceled)).allowed,false)
 assert.equal((await api(`invoices/${canceled.invoice}`)).balanceCents,10000,'Cancellation never forgives the original debt')
 await observe(canceled,'ended')
 await onState({state:'canceled',record:canceled,report:await report()})
 await onState({state:'restricted',record:overdue,report:await report()})
 await move(28);await end({series:enterpriseRecord.series.id,action:'keep_active',confirm:true})
 assert.equal((await entitlement(enterpriseRecord)).allowed,true)
 assert.equal(sent.filter(s=>s.invoice===overdue.invoice).length,4)
 assert.deepEqual(sent.filter(s=>s.invoice===overdue.invoice).map(s=>s.due),[0,3,7,21].map(n=>new Date(first+n*day).toISOString().slice(0,10)))
 const recovery=await api('recovery')
 assert.deepEqual([recovery.totals.failedInvoices,recovery.totals.recoveredInvoices,recovery.totals.failedAmountCents,recovery.totals.recoveredAmountCents,recovery.totals.recoveryRate,recovery.totals.amountRecoveryRate],[5,1,50000,10000,1/5,1/5])
 for(const message of sent){
  const bucket=recovery.byDunningStep.find(b=>b.key===message.key),recovered=message.key===recoveryMail.message.key
  assert.equal(recovery.invoices.find(i=>i.invoice===message.invoice).stepDetails.find(s=>s.key===message.key).step,message.step)
  const exposed=new Set(sent.filter(s=>s.key===message.key).map(s=>s.invoice)).size
  assert.ok(bucket);assert.deepEqual([bucket.failedInvoices,bucket.failedAmountCents,bucket.recoveredInvoices,bucket.recoveredAmountCents,bucket.recoveryRate,bucket.amountRecoveryRate],[exposed,exposed*10000,recovered?1:0,recovered?10000:0,recovered?1/exposed:0,recovered?1/exposed:0])
 }
 const expected=records.map((record,index)=>{
  const intent=edge.writes[index].id,attempts=edge.writes.filter(w=>w.id===intent).map((w,n)=>({attempt:n+1,at:w.at,step:n===1?recoveryMail.message.key:null}))
  const recovered=record===recover
  return {currency:'USD',declineCode:'stolen_card',failedAmountCents:10000,recoveredAmountCents:recovered?10000:0,attempts,steps:sent.filter(s=>s.invoice===record.invoice).map(s=>s.key),recoveries:recovered?[{amountCents:10000,attempt:2,step:recoveryMail.message.key}]:[]}
 })
 assertRecoveryBuckets(recovery,expected)
 const allocation=paid.allocations[0],source=recovery.invoices.find(i=>i.invoice===recover.invoice)
 assert.equal(source.recoveries[0].attempt,2);assert.equal(source.recoveries[0].payment,allocation.payment_id);assert.equal(source.recoveries[0].step,recoveryMail.message.key)
 assert.equal(recovery.byDunningStep.find(b=>b.key==='unrecorded').recoveredAmountCents,0)
 await onState({state:'complete',records,report:await report()})
 const payment=await api('payment.record',{customer:overdue.customer,amount:'100',received_on:'2026-11-19',method:'bank_transfer',reference:'synthetic-nectar-dunning-settlement'})
 await api('payment.allocate',{payment:payment.payment,invoice:overdue.invoice,amount:'100'})
 assert.equal((await entitlement(overdue)).allowed,true,'Actual settlement restores only the dunning restriction')
 const afterExternal=await api('recovery')
 assert.deepEqual([afterExternal.totals.recoveredInvoices,afterExternal.totals.recoveredAmountCents,afterExternal.totals.recoveryRate],[2,20000,2/5])
 assert.equal(afterExternal.byDunningStep.find(b=>b.key==='unrecorded').recoveredAmountCents,10000,'An external allocation never acquires the latest email attribution')
 for(const message of sent.filter(s=>s.invoice===overdue.invoice))assert.equal(afterExternal.byDunningStep.find(b=>b.key===message.key).recoveredAmountCents,recovery.byDunningStep.find(b=>b.key===message.key).recoveredAmountCents)
 await onState({state:'restored',record:overdue,report:await report()})
 const recoveryPayment=await api('payment.record',{customer:unpaid.customer,amount:'100',received_on:'2026-11-19',method:'bank_transfer',reference:'synthetic-nectar-state-recovery'})
 await api('payment.allocate',{payment:recoveryPayment.payment,invoice:unpaid.invoice,amount:'100'})
 const priorUnpaid=await api(`subscriptions/${unpaid.sub}`)
 await h.rejectAudit('subscription.state.observe')
 const refusedObservation=await h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent('* * * * *')}`)
 assert.equal(refusedObservation.status,500,'Audit refusal fails the whole scheduled observation')
 assert.deepEqual((await api(`subscriptions/${unpaid.sub}`)).stateHistory,priorUnpaid.stateHistory,'No state history is published without its audit')
 await h.rejectAudit(null)
 const restored=await observe(unpaid,'active')
 assert.deepEqual(restored.at(-1).cause.allocations.map(a=>[a.invoice_id,a.payment_id,a.amount_cents]),[[unpaid.invoice,recoveryPayment.payment,10000]])
 assert.deepEqual(restored.map(row=>row.state),['active','past_due','unpaid','active'])
 const role=await api('role.define',{name:'Lifecycle state reader',capabilities:['read.subscriptions']})
 await api('access.give',{email:'synthetic-nectar-state-reader@example.test',name:'Lifecycle reader',role:'custom',custom_role:role.id})
 const reader=await h.signIn('synthetic-nectar-state-reader@example.test',{requested:true}),readerFactor=await h.api('mfa.totp.start',reader,{})
 await h.api('mfa.totp.confirm',reader,{factor:readerFactor.factor,code:totp(readerFactor.secret,instant)})
 const limited=await h.api(`subscriptions/${unpaid.sub}`,reader)
 assert.deepEqual(limited.stateHistory.map(row=>Object.keys(row.cause).sort()),limited.stateHistory.map(()=>['day','timezone']),'Subscription-only readers receive no financial cause facts')
 await h.api(`subscriptions/${unpaid.sub}`,undefined,undefined,401)
 const erasure=await api('erasure.request',{customer:unpaid.customer})
 await api('erasure.verify',{request:erasure.id,reason:'Synthetic verified identity',evidence:file('identity.txt','Synthetic verified identity','text/plain')})
 const erased=await api('erasure.approve',{request:erasure.id,confirm:true})
 assert.ok(erased.receipt.changed.some(change=>change.kind==='nc_subscription_states'),'Erasure receipt names the withdrawn operational history')
 await api(`subscriptions/${unpaid.sub}`,undefined,410)
 console.log('dunningSequenceFlow: four exact dated messages, working update links, consented same-intent cash and stop, scoped restriction and restoration, independent invoice-only policy, recorded-step amounts and rates')
}
