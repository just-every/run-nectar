import assert from 'node:assert/strict'
import { retryEdge } from './retry-edge.mjs'
import { totp } from './mfa.mjs'
import { file } from './harness.mjs'
let edge
const start=Date.parse('2026-10-22T10:00:00Z')
export const harnessOptions=()=>{edge=retryEdge();return {assets:true,localTime:new Date(start).toISOString(),stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1'}}
export async function dunningCustodyFlow(h,owner,{onState=async()=>{}}={}) {
 const api=(p,b,s)=>h.api(p,owner,b,s)
 let instant=start
 await api('business.configure',{...await api('business'),timezone:'UTC'})
 const factor=await api('mfa.totp.start',{});await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,instant)});await api('mfa.policy',{scope:'all'})
 await api('portal.configure',{hosts:[h.origin],parents:[]})
 const refresh=async at=>{instant=at;edge.setTime(at);await h.advanceClock(new Date(at).toISOString());await api('mfa.verify',{code:totp(factor.secret,at)})}
 const policy=await api('dunning.policy.create',{name:'Reviewed invoice messages',scope:'default',offsets:'0,1',end_day:21,end_action:'keep_active',invoice_only:true,confirm:true})
 const customer=(await api('customer.create',{external_id:'synthetic-nectar-custody',name:'Cedar messages',billing_email:'custody@example.test'})).id
 await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:'synthetic-nectar-native-customer-1',confirm:true})
 const invoice=async code=>{
  const charge=await api('charge.add',{customer,amount:'100',description:'Reviewed service',effective_date:'2026-10-22',taxable:false})
  const draft=await api('invoice.manual',{customer,charges:[charge.charge],service_date:'2026-10-22'})
  const collection=await api('automatic.collection.prepare',{invoice:draft.id,issue_date:'2026-10-22',enable_retries:true})
  const session=await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
  await h.raw(`/portal/automatic-collections/${collection.id}?session=${encodeURIComponent(session.token)}`,{body:{request:collection.id,basis_hash:collection.basis,accept:true}})
  await api('automatic.collection.decide',{request:collection.id,basis_hash:collection.basis,decision:'approved',confirm:true,confirm_single:true})
  edge.rules.set('synthetic-nectar-native-card-1',{code,recoverAt:Infinity})
  await api('invoice.approve',{invoice:draft.id,acknowledge:true});await api('invoice.finalise',{invoice:draft.id,issue_date:'2026-10-22'})
  const series=await api('dunning.enroll',{invoice:draft.id,policy:policy.id,confirm:true})
  return {invoice:draft.id,series:series.id}
 }
 const stale=await invoice('processing_error'),expired=await invoice('processing_error'),uncertain=await invoice('processing_error'),concurrent=await invoice('processing_error'),paid=await invoice('processing_error'),held=await invoice('processing_error'),promised=await invoice('processing_error')
 const prepare=record=>api('dunning.mail.prepare',{series:record.series,step:1,confirm:true})
 const payload=m=>({delivery:m.id,basis_hash:m.basisHash,confirm:true})
 const staleMessage=await prepare(stale),expiredMessage=await prepare(expired),unknownMessage=await prepare(uncertain),concurrentMessage=await prepare(concurrent),paidMessage=await prepare(paid)
 const count=h.mails.length
 await api('access.give',{email:'dunning-finance@example.test',name:'Finance Member',role:'finance'})
 const finance=await h.signIn('dunning-finance@example.test',{requested:true})
 const financeFactor=await h.api('mfa.totp.start',finance,{})
 await h.api('mfa.totp.confirm',finance,{factor:financeFactor.factor,code:totp(financeFactor.secret,instant)})
 for(const action of ['dunning.policy.create','dunning.enroll','dunning.mail.prepare','dunning.mail.send','dunning.end','dunning.withdraw']){
  assert.equal((await h.api(action,finance,{},403)).error,'owner_required');await h.api(action,undefined,{},401)
 }
 await h.api('dunning',finance,undefined,403)
 const foreign=await h.raw('/api/nectar/dunning.mail.send',{cookie:owner,body:payload(concurrentMessage),headers:{origin:'https://synthetic-nectar-foreign.example'}})
 assert.equal(foreign.status,403)
 const row=await api(`customers/${customer}`)
 await api('customer.update',{customer,revision:row.revision,name:row.name,billing_email:'updated@example.test'})
 await api('dunning.mail.send',payload(staleMessage),409)
 assert.equal(h.mails.length,count+1,'Only the separately requested finance invitation sent')
 // A revised recipient invalidates every earlier preparation; no replacement bypass.
 await api('dunning.mail.prepare',{series:stale.series,step:1,confirm:true},409)
 await onState({state:'stale',record:stale,report:await api('dunning')})
 await refresh(start+15*60000)
 await api('dunning.mail.send',payload(expiredMessage),409)
 await onState({state:'expired',record:expired,report:await api('dunning')})
 // Day-one preparations freeze the new recipient and use the current owner factor.
 await refresh(start+86400000)
 const next=async record=>api('dunning.mail.prepare',{series:record.series,step:2,confirm:true})
 const unknown=await next(uncertain),race=await next(concurrent),settled=await next(paid),disputed=await next(held),paused=await next(promised)
 const disputedInvoice=await api(`invoices/${held.invoice}`)
 await api('cadence.dispute',{invoice:held.invoice,line:disputedInvoice.lines[0].id,amount_cents:10000,reason:'Customer disputes this entire service amount'})
 await api('cadence.promise',{invoice:promised.invoice,pay_date:'2026-10-24',note:'Customer promised payment on this date'})
 await api('dunning.mail.send',payload(disputed),409);await api('dunning.mail.send',payload(paused),409)
 assert.equal((await api('dunning')).series.find(s=>s.id===held.series).held,true)
 assert.equal((await api('dunning')).series.find(s=>s.id===promised.series).held,true)
 await onState({state:'disputed',record:held,report:await api('dunning')})
 await onState({state:'promised',record:promised,report:await api('dunning')})
 const external=await api('payment.record',{customer,amount:'100',received_on:'2026-10-23',method:'bank_transfer',reference:'synthetic-nectar-custody-settlement'})
 await api('payment.allocate',{payment:external.payment,invoice:paid.invoice,amount:'100'})
 await api('dunning.mail.send',payload(settled),409)
 await onState({state:'settled-before-send',record:paid,report:await api('dunning')})
 h.mailResponses.push({to:'updated@example.test',status:500,body:{name:'provider_error'}})
 const uncertainResult=await api('dunning.mail.send',payload(unknown))
 assert.equal(uncertainResult.status,'uncertain')
 const after=h.mails.length
 await api('dunning.mail.send',payload(unknown),409)
 await api('dunning.mail.prepare',{series:uncertain.series,step:2,confirm:true},409)
 assert.equal(h.mails.length,after)
 const outcomes=await Promise.all([h.raw('/api/nectar/dunning.mail.send',{cookie:owner,body:payload(race)}),h.raw('/api/nectar/dunning.mail.send',{cookie:owner,body:payload(race)})])
 assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,409])
 assert.equal(h.mails.length,after+1,'Concurrent confirmations submit exactly one provider request')
 const audit=await api('audit')
 for(const message of [unknown,race])for(const action of ['dunning.mail.prepare','dunning.mail.claim','dunning.mail.outcome'])assert.equal(audit.filter(e=>e.action===action&&e.subject===message.id).length,1)
 await onState({state:'uncertain',record:uncertain,report:await api('dunning')})
 await api('dunning.withdraw',{series:concurrent.series,confirm:true})
 assert.equal((await api('dunning')).series.find(s=>s.id===concurrent.series).status,'withdrawn')
 await api('dunning.mail.send',payload(race),409)
 const erasure=await api('erasure.request',{customer})
 await api('erasure.verify',{request:erasure.id,reason:'Verified own-customer request',evidence:file('dunning-identity.txt','Synthetic identity verification','text/plain')})
 await api('erasure.approve',{request:erasure.id,confirm:true})
 assert.deepEqual((await api('dunning')).series,[])
 await api('dunning.mail.send',payload(race),409)
 assert.equal(h.mails.length,after+1)
 console.log('dunningCustodyFlow: current owner only, exact recipient and source, inclusive expiry, paid stop, no uncertain resend or preparation bypass, concurrent once-only claim, exact audit and erasure withdrawal')
}
