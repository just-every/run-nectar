// Held Stripe test account only. This proves real hard declines, not a network
// updater event, expiry mail, or unattended renewal authority.
import {execFileSync} from 'node:child_process'
import {stripeSandbox,check,safeError} from './stripe-sandbox-client.mjs'
import {harness} from './harness.mjs'
import {applyPolicy} from './policy-helper.mjs'
import {totp} from './mfa.mjs'
const stripe=stripeSandbox(process.env.STRIPE_SECRET_KEY)
const result={journey:'PAY-005 real stolen-card prohibition',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),outcome:'running',cleanup:false}
let h,customer,phase='provider-fixtures'
try {
 const account=await stripe.request('GET','/v1/account');result.account=account.id
 customer=await stripe.request('POST','/v1/customers',{name:'Synthetic Nectar lifecycle customer','metadata[nectar_run]':stripe.run})
 const card=await stripe.request('POST','/v1/payment_methods',{type:'card','card[token]':'tok_chargeDeclinedStolenCard'})
 await stripe.request('POST',`/v1/payment_methods/${card.id}/attach`,{customer:customer.id})
 await stripe.request('POST',`/v1/customers/${customer.id}`,{'invoice_settings[default_payment_method]':card.id})
 let attempts=0
 h=await harness({stripeSecret:process.env.STRIPE_SECRET_KEY,stripeFetch:request=>stripe.forward(request,entry=>{if(entry.method==='POST'&&entry.path==='/v1/payment_intents')attempts++})})
 await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
 const owner=await h.signIn(h.vars.OWNER_EMAIL)
 await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
 const api=(path,body,status)=>h.api(path,owner,body,status)
 await api('business.configure',{legal_name:'Synthetic Nectar lifecycle merchant',timezone:'UTC',invoice_prefix:'LIFE',payment_terms_days:30})
 await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed lifecycle proof'})
 await api('tax.review',{revision:(await api('business')).revision})
 const factor=await api('mfa.totp.start',{});await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,Date.now())})
 const native=await api('customer.create',{external_id:'synthetic-nectar-875',name:'Synthetic Nectar lifecycle customer',billing_email:'synthetic-nectar-875@example.test'})
 await api('collection.customer.bind',{customer:native.id,account_ref:account.id,stripe_customer_ref:customer.id,confirm:true})
 const day=new Date().toISOString().slice(0,10)
 const invoice=async()=>{
  const charge=await api('charge.add',{customer:native.id,amount:'10',description:'Lifecycle next invoice',effective_date:day,taxable:false})
  const draft=await api('invoice.manual',{customer:native.id,charges:[charge.charge],service_date:day})
  await api('invoice.approve',{invoice:draft.id,acknowledge:true});await api('invoice.finalise',{invoice:draft.id,issue_date:day})
  return draft.id
 }
 const confirm=(prepared,status)=>api('collection.confirm',prepared.instructions.confirm,status)
 phase='hard-decline'
 const first=await api('collection.prepare',{invoice:await invoice()}),stale=await api('collection.prepare',{invoice:await invoice()})
 const declined=await confirm(first)
 check(declined.status==='declined','real_stolen_card_not_declined')
 const lifecycle=(await api(`customers/${native.id}`)).billingRecord.cardLifecycle
 check(lifecycle.some(row=>row.methodRef===card.id&&!row.usable&&row.unusableReason==='stolen_card'),'real_stolen_card_not_blocked')
 check(attempts===1,'unexpected_payment_attempt_count')
 phase='no-retry'
 await confirm(stale,409)
 await api('collection.prepare',{invoice:await invoice()},409)
 check(attempts===1,'blocked_method_was_retried')
 phase='replacement'
 const replacement=await stripe.request('POST','/v1/payment_methods',{type:'card','card[token]':'tok_visa'})
 await stripe.request('POST',`/v1/payment_methods/${replacement.id}/attach`,{customer:customer.id})
 await stripe.request('POST',`/v1/customers/${customer.id}`,{'invoice_settings[default_payment_method]':replacement.id})
 const next=await api('collection.prepare',{invoice:await invoice()})
 check(next.review.paymentMethodRef===replacement.id,'replacement_not_selected')
 const paid=await confirm(next)
 check(paid.status==='collected'&&attempts===2,'replacement_not_collected_once')
 await h.assertStorageExcludes([process.env.STRIPE_SECRET_KEY])
 result.outcome='passed';result.blockedMethod=card.id;result.replacement=replacement.id;result.paymentIntent=paid.payment_intent_ref;result.attempts=attempts
} catch(error) {result.outcome='failed';result.phase=phase;result.error=safeError(error);process.exitCode=1}
finally {
 await h?.close()
 if(customer){try{const deleted=await stripe.request('DELETE',`/v1/customers/${customer.id}`);result.cleanup=deleted.deleted===true}catch{}}
 if(!result.cleanup){result.outcome='failed';process.exitCode=1}
 console.log(JSON.stringify({...result,requests:stripe.requests}))
}
