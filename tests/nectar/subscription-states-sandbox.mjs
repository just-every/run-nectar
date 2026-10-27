// Explicitly governed native card lifecycle on a real Stripe test clock.
// This does not prove unattended dunning or standing renewal authority.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {harness} from './harness.mjs'
import {applyPolicy} from './policy-helper.mjs'
import {totp} from './mfa.mjs'
import {stripeSandbox,safeError} from './stripe-sandbox-client.mjs'
const stripe=stripeSandbox(process.env.STRIPE_SECRET_KEY)
const actual=new Date(),month=Date.UTC(actual.getUTCFullYear(),actual.getUTCMonth()-1,1),start=month-86400000
const issue=Math.floor(Date.now()/1000)*1000,day=86400000,iso=at=>new Date(at).toISOString(),date=at=>iso(at).slice(0,10)
const result={journey:'SUB-001 governed native card clock',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),outcome:'running',states:[],cleanup:false,boundary:'Owner-confirmed unpaid and cancellation; no unattended dunning claim'}
let h,clock,customer,owner,factor,instant=start,secret,phase='provider-fixtures'
const received=[],writes=[]
try{
 const account=await stripe.request('GET','/v1/account')
 clock=await stripe.request('POST','/v1/test_helpers/test_clocks',{frozen_time:start/1000,name:'synthetic-nectar-state-1'})
 customer=await stripe.request('POST','/v1/customers',{name:'synthetic-nectar-state-1',test_clock:clock.id,'metadata[nectar_run]':stripe.run})
 const card=await stripe.request('POST','/v1/payment_methods',{type:'card','card[token]':'tok_visa_chargeCustomerFailLostCard'})
 await stripe.request('POST',`/v1/payment_methods/${card.id}/attach`,{customer:customer.id})
 await stripe.request('POST',`/v1/customers/${customer.id}`,{'invoice_settings[default_payment_method]':card.id})
 h=await harness({localTime:iso(start),stripeSecret:process.env.STRIPE_SECRET_KEY,stripeFetch:request=>stripe.forward(request,entry=>{if(entry.method==='POST')writes.push({path:entry.path,key:entry.idempotencyKey})}),webhookFetch:async request=>{received.push(await request.json());return new Response(null,{status:204})}})
 await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Synthetic owner'}})
 owner=await h.signIn(h.vars.OWNER_EMAIL);await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
 const api=async(path,body,status=200)=>{const response=await h.raw(`/api/nectar/${path}`,{cookie:owner,body});const value=await response.json();if(response.status!==status)throw Object.assign(new Error('Native refusal'),{code:value.error,status:response.status});return value}
 await api('business.configure',{legal_name:'Synthetic merchant',timezone:'UTC',invoice_prefix:'LIFE',payment_terms_days:30})
 await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Synthetic reviewed card proof'})
 await api('tax.review',{revision:(await api('business')).revision})
 factor=await api('mfa.totp.start',{});await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,start)});await api('mfa.policy',{scope:'all'})
 secret=(await api('webhook.register',{url:'https://receiver.nectar-app.com/states',consent:true})).secret
 await api('portal.configure',{hosts:[h.origin],parents:[]})
 const native=(await api('customer.create',{external_id:'synthetic-nectar-state-1',name:'Synthetic clock customer',billing_email:'states@example.test'})).id
 await api('collection.customer.bind',{customer:native,account_ref:account.id,stripe_customer_ref:customer.id,confirm:true})
 const product=(await api('product.create',{code:'synthetic-nectar-state-1',name:'Synthetic card service'})).id
 const price=(await api('price.create',{product,kind:'flat',unit_amount:'100',taxable:false})).id
 const subscription=(await api('subscription.create',{customer:native,start_date:date(start),anchor_day:1,trial_end:date(month),trial_payment:'card',price:[price]})).id
 const tick=async(cron='* * * * *')=>assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent(cron)}`)).status,200)
 const move=async at=>{await stripe.advance(clock.id,Math.floor(at/1000),date(at));instant=at;await h.advanceClock(iso(at));await api('mfa.verify',{code:totp(factor.secret,at)})}
 const observe=async state=>{
  await tick();result.states.push(state)
  const history=(await api(`subscriptions/${subscription}`)).stateHistory
  assert.deepEqual(history.map(row=>row.state),result.states)
  assert.deepEqual(received.filter(event=>event.data.transition_id&&event.data.id===subscription).map(event=>event.data.state),result.states)
  assert.deepEqual(received.filter(event=>event.data.transition_id&&event.data.id===subscription).map(event=>event.data.cause),history.map(row=>row.cause))
  await tick();assert.deepEqual((await api(`subscriptions/${subscription}`)).stateHistory,history)
 }
 phase='trial';await observe('trialing');await move(month);await tick('0 14 * * *');await observe('active')
 await move(issue)
 const run=await api('billrun.prepare',{period:date(month).slice(0,7)}),invoice=(await api(`runs/${run.id}`)).invoices.find(row=>row.subscription_id===subscription).id
 const original=await api('automatic.collection.prepare',{invoice,issue_date:date(issue),enable_retries:true})
 const session=await api('portal.session.issue',{customer:native,origin:h.origin,audience:'hosted'})
 assert.equal((await h.raw(`/portal/automatic-collections/${original.id}?session=${encodeURIComponent(session.token)}`,{body:{request:original.id,basis_hash:original.basis,accept:true}})).status,200)
 await api('automatic.collection.decide',{request:original.id,basis_hash:original.basis,decision:'approved',confirm:true,confirm_single:true})
 await api('invoice.approve',{invoice,acknowledge:true});phase='renewal-failure';await api('invoice.finalise',{invoice,issue_date:date(issue)})
 assert.equal((await api(`invoices/${invoice}`)).balanceCents,10000);await observe('past_due')
 const policy=await api('dunning.policy.create',{name:'Synthetic one-day policy',scope:'default',scope_ref:'',offsets:'1',end_day:1,end_action:'mark_unpaid',confirm:true})
 const series=await api('dunning.enroll',{invoice,policy:policy.id,confirm:true})
 await move(issue+day);phase='unpaid';await api('dunning.end',{series:series.id,action:'mark_unpaid',confirm:true});await observe('unpaid')
 phase='card-recovery'
 const replacement=await stripe.request('POST','/v1/payment_methods',{type:'card','card[token]':'tok_visa'})
 await stripe.request('POST',`/v1/payment_methods/${replacement.id}/attach`,{customer:customer.id})
 await stripe.request('POST',`/v1/customers/${customer.id}`,{'invoice_settings[default_payment_method]':replacement.id})
 const recovery=await api('retry.method.prepare',{request:original.id,confirm:true})
 const recoverySession=await api('portal.session.issue',{customer:native,origin:h.origin,audience:'hosted'})
 assert.equal((await h.raw(`/portal/retry-method-recoveries/${recovery.id}?session=${encodeURIComponent(recoverySession.token)}`,{body:{recovery:recovery.id,quote_hash:recovery.quoteHash,accept:true}})).status,200)
 await api('retry.method.decide',{recovery:recovery.id,quote_hash:recovery.quoteHash,decision:'approved',confirm:true,confirm_single:true})
 await observe('active')
 const paid=await api(`invoices/${invoice}`);assert.equal(paid.balanceCents,0);assert.equal(paid.paidCents,10000);assert.equal(paid.allocations.length,1)
 const detail=await api(`subscriptions/${subscription}`)
 await api('subscription.cancel',{subscription,revision:detail.revision,mode:'immediate',effective_date:date(instant),reason:'Synthetic reviewed cancellation'})
 phase='ended';await observe('ended')
 assert.equal(writes.length,2);assert.ok(writes[1].path.endsWith('/confirm'));assert.ok(writes.every(row=>row.key))
 result.invoice=invoice;result.paymentIntent=recovery.paymentIntentRef;result.amountCents=paid.paidCents;result.outcome='passed'
 await h.assertStorageExcludes([process.env.STRIPE_SECRET_KEY])
}catch(error){result.outcome='failed';result.phase=phase;result.error=safeError(error);if(error.code==='ERR_ASSERTION')result.assertion=String(error.stack).split('\n').find(line=>line.includes('subscription-states-sandbox.mjs:'))?.trim();process.exitCode=1}
finally{
 await h?.close()
 if(clock){try{result.cleanup=(await stripe.request('DELETE',`/v1/test_helpers/test_clocks/${clock.id}`)).deleted===true}catch{}}
 if(!result.cleanup){result.outcome='failed';process.exitCode=1}
 console.log(JSON.stringify({...result,requests:stripe.requests}))
}
