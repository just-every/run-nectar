import assert from 'node:assert/strict'
import { retryEdge } from './retry-edge.mjs'
import { totp } from './mfa.mjs'
import { file } from './harness.mjs'
let edge
export const harnessOptions=()=>{edge=retryEdge();return {assets:true,localTime:'2026-10-22T10:00:00Z',stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1'}}
export async function retryMethodsFlow(h,owner,{onState=async()=>{},prepareRecovery,acceptRecovery,approveRecovery}={}){
 const api=(p,b,status)=>h.api(p,owner,b,status),instant=Date.parse('2026-10-22T10:00:00Z');edge.setTime(instant)
 await api('business.configure',{...await api('business'),timezone:'UTC'})
 const factor=await api('mfa.totp.start',{});await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,instant)});await api('mfa.policy',{scope:'all'})
 const customer=(await api('customer.create',{external_id:'synthetic-nectar-replacement',name:'Cedar card recovery',billing_email:'replacement@example.test',language:'es-US'})).id
 const other=(await api('customer.create',{external_id:'synthetic-nectar-unrelated',name:'Another company',billing_email:'unrelated@example.test'})).id
 await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:'synthetic-nectar-native-customer-1',confirm:true})
 await api('portal.configure',{hosts:[h.origin],parents:[]})
 const product=(await api('product.create',{code:'recover-monthly',name:'Monthly service'})).id
 const price=(await api('price.create',{product,kind:'flat',unit_amount:'100',taxable:false})).id
 const sub=(await api('subscription.create',{customer,start_date:'2026-09-01',price:[price],quantity:['1']})).id
 const run=await api('billrun.prepare',{period:'2026-09'}),invoice=(await api(`runs/${run.id}`)).invoices.find(i=>i.subscription_id===sub).id
 const original=await api('automatic.collection.prepare',{invoice,issue_date:'2026-10-22',enable_retries:true})
 const session=await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'}),foreign=await api('portal.session.issue',{customer:other,origin:h.origin,audience:'hosted'})
 assert.equal((await h.raw(`/portal/automatic-collections/${original.id}?session=${encodeURIComponent(session.token)}`,{body:{request:original.id,basis_hash:original.basis,accept:true}})).status,200)
 await api('automatic.collection.decide',{request:original.id,basis_hash:original.basis,decision:'approved',confirm:true,confirm_single:true})
 edge.rules.set('synthetic-nectar-native-card-1',{code:'stolen_card',recoverAt:Infinity,advice:'do_not_try_again'})
 await api('invoice.approve',{invoice,acknowledge:true});await api('invoice.finalise',{invoice,issue_date:'2026-10-22'})
 assert.equal((await api(`invoices/${invoice}`)).next_payment_attempt,null)
 const writes=edge.writes.length
 await api('retry.method.prepare',{request:original.id,confirm:true},409)
 assert.equal(edge.writes.length,writes,'The refused card can never become its own replacement')
 edge.customers.get('synthetic-nectar-native-customer-1').method='synthetic-nectar-new-card'
 const recoveryInput={request:original.id,confirm:true}
 const prepared=prepareRecovery?await prepareRecovery({input:recoveryInput,invoice,session}):await api('retry.method.prepare',recoveryInput)
 assert.equal(prepared.quote.method.paymentMethodRef,'synthetic-nectar-new-card');assert.equal(prepared.paymentIntentRef,edge.writes[0].id)
 assert.equal(prepared.status,'awaiting_customer')
 const path=`/portal/retry-method-recoveries/${prepared.id}?session=${encodeURIComponent(session.token)}`
 assert.equal((await h.raw(`/portal/retry-method-recoveries/${prepared.id}?session=${encodeURIComponent(foreign.token)}`)).status,404)
 assert.equal((await h.raw(path,{headers:{accept:'application/json'}})).status,200)
 await onState({state:'new-card-consent',invoice,path,prepared})
 if(acceptRecovery)await acceptRecovery({path,prepared})
 else assert.equal((await h.raw(path,{body:{recovery:prepared.id,quote_hash:prepared.quoteHash,accept:true}})).status,200)
 assert.equal(edge.writes.length,writes,'Consent alone creates no charge')
 // An independent finance approver is now available and must decide this recovery.
 await api('access.give',{email:'recovery-finance@example.test',name:'Recovery finance',role:'finance'})
 const finance=await h.signIn('recovery-finance@example.test',{requested:true}),financeFactor=await h.api('mfa.totp.start',finance,{})
 await h.api('mfa.totp.confirm',finance,{factor:financeFactor.factor,code:totp(financeFactor.secret,instant)})
 await api('retry.method.decide',{recovery:prepared.id,quote_hash:prepared.quoteHash,decision:'approved',confirm:true,confirm_single:true},409)
 const decision={recovery:prepared.id,quote_hash:prepared.quoteHash,decision:'approved',confirm:true}
 if(approveRecovery)await approveRecovery({decision,finance,invoice})
 else await h.api('retry.method.decide',finance,decision)
 assert.equal((await api(`invoices/${invoice}`)).next_payment_attempt,instant)
 await onState({state:'new-card-authorized',invoice,path,prepared})
 const tick=()=>h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent('* * * * *')}`)
 assert.equal((await tick()).status,200);assert.equal((await tick()).status,200)
 const paid=await api(`invoices/${invoice}`)
 assert.equal(paid.balanceCents,0);assert.equal(paid.paidCents,10000);assert.equal(paid.allocations.length,1);assert.equal(paid.attempt_count,2);assert.equal(paid.retry_status,'paid')
 assert.equal(edge.writes.length,writes+1);assert.equal(new Set(edge.writes.map(w=>w.id)).size,1,'Replacement confirms the existing PaymentIntent')
 const attempts=(await api('automatic-collections')).find(r=>r.id===original.id)
 assert.equal(attempts.quote.method.paymentMethodRef,original.quote.method.paymentMethodRef,'Earlier approved terms are immutable')
 assert.equal(attempts.recoveries[0].status,'consumed')
 const record=await api(`customers/${customer}`)
 assert.equal(record.billingRecord.automaticCollections[0].recoveries[0].id,prepared.id)
 assert.ok(record.billingRecord.auditEvents.some(e=>e.subject===prepared.id))
 await onState({state:'new-card-recovered',invoice,path,prepared})
 const report=await api('recovery');assert.equal(report.totals.failedInvoices,1);assert.equal(report.totals.recoveredAmountCents,10000)
 await api('retry.method.decide',decision,409)
 assert.equal((await h.raw(path,{body:{recovery:prepared.id,quote_hash:prepared.quoteHash,accept:true}})).status,409)
 const erasure=await api('erasure.request',{customer});await api('erasure.verify',{request:erasure.id,reason:'Independently verified identity',evidence:file('retry-identity.txt','Synthetic verified identity','text/plain')});await api('erasure.approve',{request:erasure.id,confirm:true})
 assert.equal((await h.raw(path)).status,401)
 assert.equal(edge.writes.length,writes+1)
 console.log('retryMethodsFlow: hard-decline replacement, new exact customer consent, independent approval, same intent, one cash allocation, customer source and erasure parity')
}

export async function retryAuthenticationFlow(h,owner,{onState=async()=>{},prepareRecovery,acceptRecovery,approveRecovery,confirmAuthentication,checkAuthentication}={}){
 const api=(p,b,status)=>h.api(p,owner,b,status),instant=Date.parse('2026-10-22T10:00:00Z');edge.setTime(instant)
 await api('business.configure',{...await api('business'),timezone:'UTC'})
 const factor=await api('mfa.totp.start',{});await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,instant)});await api('mfa.policy',{scope:'all'})
 await api('portal.configure',{hosts:[h.origin],parents:[]})
 let finance,financeFactor
 const scenario=async(index,code='authentication_required')=>{
  const ref=`synthetic-nectar-auth-customer-${index}`,method=`synthetic-nectar-auth-card-${index}`
  edge.customers.set(ref,{account:1,method})
  const customer=(await api('customer.create',{external_id:`synthetic-nectar-auth-${index}`,name:`Cedar authentication ${index}`,billing_email:`auth-${index}@example.test`,language:index===1?'es-US':'en'})).id
  await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:ref,confirm:true})
  const product=(await api('product.create',{code:`auth-${index}`,name:'Monthly authentication service'})).id
  const price=(await api('price.create',{product,kind:'flat',unit_amount:'100',taxable:false})).id
  const subscription=(await api('subscription.create',{customer,start_date:'2026-09-01',price:[price],quantity:['1']})).id
  const run=await api('billrun.prepare',{period:'2026-09'}),invoice=(await api(`runs/${run.id}`)).invoices.find(row=>row.subscription_id===subscription).id
  const original=await api('automatic.collection.prepare',{invoice,issue_date:'2026-10-22',enable_retries:true})
  const session=await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
  assert.equal((await h.raw(`/portal/automatic-collections/${original.id}?session=${encodeURIComponent(session.token)}`,{body:{request:original.id,basis_hash:original.basis,accept:true}})).status,200)
  if(finance)await h.api('automatic.collection.decide',finance,{request:original.id,basis_hash:original.basis,decision:'approved',confirm:true})
  else await api('automatic.collection.decide',{request:original.id,basis_hash:original.basis,decision:'approved',confirm:true,confirm_single:true})
  edge.rules.set(method,{code,...(index===1?{declineCode:'authentication_not_handled'}:{}),recoverAt:Infinity,authenticate:true})
  await api('invoice.approve',{invoice,acknowledge:true});await api('invoice.finalise',{invoice,issue_date:'2026-10-22'})
  assert.equal((await api(`invoices/${invoice}`)).next_payment_attempt,null)
  return {original,customer,method,session,invoice}
 }
 const authorize=async(source,browser=false)=>{
  const input={request:source.original.id,authenticate:true,confirm:true}
  const prepared=browser&&prepareRecovery?await prepareRecovery({...source,input}):await api('retry.method.prepare',input)
  assert.equal(prepared.authentication,true);assert.equal(prepared.quote.method.paymentMethodRef,source.method)
  const path=`/portal/retry-method-recoveries/${prepared.id}?session=${encodeURIComponent(source.session.token)}`
  const body={recovery:prepared.id,quote_hash:prepared.quoteHash,accept:true}
  if(browser&&acceptRecovery)await acceptRecovery({path,prepared})
  else assert.equal((await h.raw(path,{body})).status,200)
  const decision={recovery:prepared.id,quote_hash:prepared.quoteHash,decision:'approved',confirm:true}
  if(!finance){
   await api('access.give',{email:'authentication-finance@example.test',name:'Authentication finance',role:'finance'})
   finance=await h.signIn('authentication-finance@example.test',{requested:true});financeFactor=await h.api('mfa.totp.start',finance,{})
   await h.api('mfa.totp.confirm',finance,{factor:financeFactor.factor,code:totp(financeFactor.secret,instant)})
  }
  await api('retry.method.decide',{...decision,confirm_single:true},409)
  if(browser&&approveRecovery)await approveRecovery({...source,decision,finance})
  else await h.api('retry.method.decide',finance,decision)
  return {...source,prepared,path,body:{recovery:prepared.id,quote_hash:prepared.quoteHash,authenticate:true}}
 }
 const first=await scenario(1),writes=edge.writes.length
 const recovery=await authorize(first,true)
 assert.equal(edge.writes.length,writes,'Human approval never confirms the card')
 const tick=()=>h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent('* * * * *')}`)
 await tick();assert.equal(edge.writes.length,writes,'Authentication is never scheduled off session')
 await onState({...recovery,state:'authentication-authorized'})
 assert.equal((await h.raw(recovery.path,{body:recovery.body,headers:{origin:'https://unrelated.example.test'}})).status,403)
 const foreign=await scenario(2)
 assert.equal((await h.raw(`/portal/retry-method-recoveries/${recovery.prepared.id}?session=${encodeURIComponent(foreign.session.token)}`,{body:recovery.body})).status,404)
 let response
 if(confirmAuthentication)response=await confirmAuthentication({...recovery,edge})
 else{
  const priorWrites=edge.writes.length
  const concurrent=await Promise.all([h.raw(recovery.path,{body:recovery.body}),h.raw(recovery.path,{body:recovery.body})])
  assert.ok(concurrent.every(r=>[200,409].includes(r.status)))
  response=concurrent.find(r=>r.status===200)
  assert.ok(response);assert.equal(edge.writes.length,priorWrites+1,'Concurrent customer confirmations claim one provider write')
 }
 assert.equal(response.status,200)
 const action=await response.json()
 assert.equal(action.status,'requires_action');assert.equal(new URL(action.redirect).hostname,'hooks.stripe.com')
 const confirmation=edge.writes.at(-1)
 assert.equal(confirmation.id,edge.writes[0].id);assert.equal(confirmation.form.off_session,'false')
 assert.equal(confirmation.form.use_stripe_sdk,'false');assert.equal(confirmation.form.receipt_email,undefined)
 assert.equal(new URL(confirmation.form.return_url).search,'','The bank return URL contains no customer capability')
 const count=edge.writes.length
 const replay=await h.raw(recovery.path,{body:recovery.body});assert.equal(replay.status,200);assert.equal(edge.writes.length,count,'Repeated customer confirmation only reads the existing intent')
 await tick();assert.equal(edge.writes.length,count)
 assert.equal((await api(`invoices/${first.invoice}`)).balanceCents,10000)
 await onState({...recovery,state:'authentication-pending'})
 if(!confirmAuthentication)edge.authenticate(confirmation.id)
 const secret='synthetic-nectar-redirect-secret'
 const callback=await h.raw(`/portal/retry-method-recoveries/${recovery.prepared.id}/return?payment_intent=${confirmation.id}&payment_intent_client_secret=${secret}`)
 assert.equal(callback.status,303);assert.equal(callback.headers.get('location'),`/portal/retry-method-recoveries/${recovery.prepared.id}`)
 assert.equal((await callback.text()).includes(secret),false)
 if(checkAuthentication)await checkAuthentication({...recovery,edge,intent:confirmation.id})
 else{
  const cookie=response.headers.get('set-cookie').split(';')[0]
  assert.match(response.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/)
  const check=await h.raw(callback.headers.get('location'),{cookie,body:{recovery:recovery.prepared.id,quote_hash:recovery.prepared.quoteHash,check:true}})
  assert.equal(check.status,200);assert.equal((await check.json()).status,'collected')
 }
 await tick();await tick()
 const paid=await api(`invoices/${first.invoice}`)
 assert.equal(paid.balanceCents,0);assert.equal(paid.paidCents,10000);assert.equal(paid.allocations.length,1);assert.equal(paid.attempt_count,2)
 assert.equal(edge.writes.length,count)
 assert.equal((await api('automatic-collections')).find(r=>r.id===first.original.id).quote.method.paymentMethodRef,first.method)
 assert.equal((await api(`customers/${first.customer}`)).billingRecord.automaticCollections[0].recoveries[0].id,recovery.prepared.id)
 const recoveryReport=await api('recovery')
 assert.equal(recoveryReport.totals.failedInvoices,2);assert.equal(recoveryReport.totals.failedAmountCents,first.original.amountCents+foreign.original.amountCents)
 assert.equal(recoveryReport.totals.recoveredAmountCents,paid.paidCents,'Authentication recovery reports only its actual allocated cash')
 await onState({...recovery,state:'authentication-collected'})
 const cancelled=await authorize(foreign)
 assert.equal((await h.raw(cancelled.path,{body:cancelled.body})).status,200)
 const cancelledIntent=edge.writes.at(-1).id;edge.authenticate(cancelledIntent,false)
 const cancelledCount=edge.writes.length
 assert.equal((await h.raw(cancelled.path,{body:{...cancelled.body,check:true}})).status,200)
 await tick();assert.equal((await api(`invoices/${foreign.invoice}`)).balanceCents,10000);assert.equal((await api(`invoices/${foreign.invoice}`)).next_payment_attempt,null)
 assert.equal(edge.writes.length,cancelledCount)
 await onState({...cancelled,state:'authentication-cancelled'})
 const stolen=await scenario(3,'stolen_card');await api('retry.method.prepare',{request:stolen.original.id,authenticate:true,confirm:true},409)
 const lost=await authorize(await scenario(4));edge.lose()
 assert.equal((await h.raw(lost.path,{body:lost.body})).status,200)
 const lostWrites=edge.writes.length,lostIntent=edge.writes.at(-1).id;edge.authenticate(lostIntent)
 assert.equal((await h.raw(lost.path,{body:{...lost.body,check:true}})).status,200);assert.equal(edge.writes.length,lostWrites)
 assert.equal((await api(`invoices/${lost.invoice}`)).balanceCents,0)
 const disputed=await authorize(await scenario(5))
 const line=(await api(`invoices/${disputed.invoice}`)).lines[0]
 await api('cadence.dispute',{invoice:disputed.invoice,line:line.id,amount:'100',reason:'Customer dispute'})
 const beforeDispute=edge.writes.length
 assert.equal((await h.raw(disputed.path,{body:disputed.body})).status,409);assert.equal(edge.writes.length,beforeDispute)
 const unsafe=await authorize(await scenario(7))
 edge.rules.get(unsafe.method).redirect='https://unrelated.example.test/authenticate'
 const unsafeBefore=edge.writes.length
 assert.equal((await h.raw(unsafe.path,{body:unsafe.body})).status,409)
 assert.equal((await h.raw(unsafe.path,{body:unsafe.body})).status,409)
 assert.equal(edge.writes.length,unsafeBefore+1,'An unsupported action cannot cause a second confirmation or an external redirect')
 const erased=await authorize(await scenario(6))
 const erasure=await api('erasure.request',{customer:erased.customer});await api('erasure.verify',{request:erasure.id,reason:'Independently verified identity',evidence:file('auth-identity.txt','Synthetic verified identity','text/plain')});await api('erasure.approve',{request:erasure.id,confirm:true})
 assert.equal((await h.raw(erased.path,{body:erased.body})).status,401)
 await onState({...erased,state:'authentication-erased'})
 console.log('retryAuthenticationFlow: exact customer-confirmed original-card authentication, once-only intent and cash, cancellation, lost response, dispute and erasure custody')
}
