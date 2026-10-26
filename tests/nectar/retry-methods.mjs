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
 edge.rules.set('synthetic-nectar-native-card-1',{code:'stolen_card',recoverAt:Infinity})
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
 assert.equal(paid.balanceCents,0);assert.equal(paid.paidCents,10000);assert.equal(paid.allocations.length,1);assert.equal(paid.attempt_count,2)
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
