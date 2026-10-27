// Held-key card lifecycle proof outside push Verify. No production authority.
import { execFileSync } from 'node:child_process'
import { stripeSandbox, check, safeError } from './stripe-sandbox-client.mjs'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { totp } from './mfa.mjs'
const day=86400000,actual=Date.now(),end=new Date(actual).toISOString().slice(0,10)
const delivered=[]
let instant=Date.parse(end+'T12:00:00Z')-day,clock,providerCustomer,h,owner,factor,stripe,phase='sources'
const receipt={head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),clause:'SUB-001',clauseComplete:false,status:'running',states:[],cleanup:[],limitations:['Dunning final action remains owner-confirmed; this is not unattended exhaustion proof.','Native renewal collection uses exact per-invoice customer consent and approval.']}
const date=()=>new Date(instant).toISOString().slice(0,10)
const api=(p,b,status)=>h.api(p,owner,b,status)
const tick=async()=>{check((await h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent('0 14 * * *')}`)).status===200,'scheduled_tick_failed')}
async function move(at){await stripe.advance(clock,Math.floor(at/1000),'subscription-state');instant=at;await h.advanceClock(new Date(instant).toISOString());await api('mfa.verify',{code:totp(factor.secret,instant)})}
async function state(subscription,expected){await tick();await tick();const row=await api(`subscriptions/${subscription}`);for(const transition of row.stateHistory)check(delivered.some(event=>event.id===transition.id&&event.type==='subscription.state_changed'&&event.data.state===transition.state&&event.data.transition_id===transition.id),'state_webhook_missing');check(row.state===expected&&row.stateHistory.at(-1).state===expected,'lifecycle_state_mismatch');receipt.states.push({state:expected,transition:row.stateHistory.at(-1).id,cause:row.stateHistory.at(-1).cause});return row}
try{
 stripe=stripeSandbox(process.env.STRIPE_SECRET_KEY)
 const account=await stripe.request('GET','/v1/account');check(account.country==='US','us_account_required');receipt.account=account.id
 const source=await stripe.request('POST','/v1/test_helpers/test_clocks',{frozen_time:instant/1000,name:'synthetic-nectar-lifecycle-1'});clock=source.id;receipt.clock=clock
 const good=await stripe.request('POST','/v1/payment_methods',{type:'card','card[token]':'tok_visa'})
 providerCustomer=(await stripe.request('POST','/v1/customers',{name:'synthetic-nectar-lifecycle-2',test_clock:clock})).id
 await stripe.request('POST',`/v1/payment_methods/${good.id}/attach`,{customer:providerCustomer})
 await stripe.request('POST',`/v1/customers/${providerCustomer}`,{'invoice_settings[default_payment_method]':good.id})
 h=await harness({localTime:new Date(instant).toISOString(),stripeSecret:process.env.STRIPE_SECRET_KEY,stripeFetch:r=>stripe.forward(r),webhookFetch:async request=>{delivered.push(await request.json());return new Response(null,{status:200})}})
 await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Synthetic owner'}});owner=await h.signIn(h.vars.OWNER_EMAIL)
 await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
 await api('business.configure',{legal_name:'Synthetic lifecycle business',timezone:'UTC',invoice_prefix:'LIFE',payment_terms_days:30})
 await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Synthetic lifecycle proof'})
 await api('tax.review',{revision:(await api('business')).revision})
 factor=await api('mfa.totp.start',{});await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,instant)});await api('mfa.policy',{scope:'all'})
 await api('webhook.register',{url:'https://receiver.nectar-app.com/events',consent:true})
 await api('portal.configure',{hosts:[h.origin],parents:[]})
 const customer=(await api('customer.create',{external_id:'synthetic-nectar-lifecycle-3',name:'Synthetic lifecycle customer',billing_email:'synthetic-nectar-lifecycle-3@example.test'})).id
 await api('collection.customer.bind',{customer,account_ref:account.id,stripe_customer_ref:providerCustomer,confirm:true})
 const product=(await api('product.create',{code:'synthetic-nectar-lifecycle-4',name:'Synthetic lifecycle service'})).id
 const price=(await api('price.create',{product,kind:'flat',unit_amount:'12',taxable:false,billing_timing:'advance'})).id
 const subscription=(await api('subscription.create',{customer,start_date:date(),trial_end:end,trial_payment:'card',price:[price],quantity:['1']})).id
 receipt.subscription=subscription
 await state(subscription,'trialing')
 phase='trial-card-capture'
 const prepared=await api('trial.collection.prepare',{subscription});await api('trial.collection.confirm',{...prepared.instructions.confirm,confirm_single:true})
 await move(actual);await state(subscription,'active')
 const trial=(await api(`trial-collections?subscription=${subscription}`))[0];check(trial.status==='collected','trial_card_capture_missing')
 const trialFact=(await api(`customers/${customer}`)).billingRecord.processorPayments.find(row=>row.invoice===trial.invoice)
 check(trialFact?.captured&&trialFact.amountCents>0,'trial_capture_public_evidence_missing')
 const trialIntent=await stripe.request('GET',`/v1/payment_intents/${trialFact.paymentIntentRef}`)
 check(trialIntent.status==='succeeded'&&trialIntent.amount_received===trialFact.amountCents,'provider_trial_capture_missing')
 receipt.trial={invoice:trial.invoice,paymentIntent:trialFact.paymentIntentRef,charge:trialFact.chargeRef,amountCents:trialFact.amountCents,status:trial.status}
 phase='renewal-failure'
 const bad=await stripe.request('POST','/v1/payment_methods',{type:'card','card[token]':'tok_chargeCustomerFail'})
 await stripe.request('POST',`/v1/payment_methods/${bad.id}/attach`,{customer:providerCustomer})
 await stripe.request('POST',`/v1/customers/${providerCustomer}`,{'invoice_settings[default_payment_method]':bad.id})
 const next=new Date(instant);next.setUTCMonth(next.getUTCMonth()+1);await move(next.getTime())
 const run=await api('billrun.prepare',{period:date().slice(0,7)}),invoices=(await api(`runs/${run.id}`)).invoices
 const invoice=invoices.find(i=>i.subscription_id===subscription&&i.status==='draft');check(invoice,'renewal_invoice_missing')
 const terms=await api('automatic.collection.prepare',{invoice:invoice.id,issue_date:date(),enable_retries:true})
 const session=await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
 check((await h.raw(`/portal/automatic-collections/${terms.id}?session=${encodeURIComponent(session.token)}`,{body:{request:terms.id,basis_hash:terms.basis,accept:true}})).status===200,'customer_acceptance_missing')
 await api('automatic.collection.decide',{request:terms.id,basis_hash:terms.basis,decision:'approved',confirm:true,confirm_single:true})
 await api('invoice.approve',{invoice:invoice.id,acknowledge:true});await api('invoice.finalise',{invoice:invoice.id,issue_date:date()})
 await state(subscription,'past_due')
 const policy=await api('dunning.policy.create',{name:'Synthetic unpaid policy',scope:'default',scope_ref:'',offsets:'1',end_day:1,end_action:'mark_unpaid',confirm:true})
 const series=await api('dunning.enroll',{invoice:invoice.id,policy:policy.id,confirm:true})
 await move(instant+day);await api('dunning.end',{series:series.id,action:'mark_unpaid',confirm:true});await state(subscription,'unpaid')
 phase='card-recovery'
 const payment=await stripe.request('POST','/v1/payment_intents',{customer:providerCustomer,payment_method:good.id,amount:invoice.total_cents,currency:'usd',confirm:true,off_session:true,'metadata[nectar_run]':stripe.run})
 check(payment.status==='succeeded'&&payment.amount_received===invoice.total_cents,'recovery_capture_missing')
 const recoveryCharge=await stripe.request('GET',`/v1/charges/${payment.latest_charge}`)
 check(recoveryCharge.paid&&recoveryCharge.captured&&recoveryCharge.amount_captured===invoice.total_cents,'recovery_charge_capture_missing')
 const captureDate=new Date(recoveryCharge.created*1000).toISOString().slice(0,10)
 receipt.captureTiming={nativeClock:instant,providerCapturedAt:recoveryCharge.created*1000,providerClockAligned:recoveryCharge.created*1000>=instant-day}
 if(!receipt.captureTiming.providerClockAligned)receipt.limitations.push('Standalone card capture time did not advance with the Stripe test clock; the provider capture date is retained without substitution. This does not prove clock-aligned renewal recovery.')
 const recorded=await api('payment.record',{customer,amount:(invoice.total_cents/100).toFixed(2),received_on:captureDate,method:'card_external',reference:payment.id})
 await api('payment.allocate',{payment:recorded.payment,invoice:invoice.id,amount:(invoice.total_cents/100).toFixed(2)})
 await state(subscription,'active')
 phase='governed-cancellation'
 const current=await api(`subscriptions/${subscription}`);const cancellation=await api('subscription.cancel',{subscription,revision:current.revision,mode:'immediate',effective_date:date(),reason:'Synthetic lifecycle cancellation'})
 if(cancellation.status==='pending')await api('subscription.cancel.decide',{cancellation:cancellation.cancellation,decision:'approved'})
 const ended=await state(subscription,'ended');check(JSON.stringify(ended.stateHistory.map(s=>s.state))===JSON.stringify(['trialing','active','past_due','unpaid','active','ended']),'complete_state_sequence_missing')
 receipt.recovery={paymentIntent:payment.id,payment:recorded.payment,amountCents:payment.amount_received,captureDate};receipt.webhookEventIds=delivered.filter(event=>event.type==='subscription.state_changed').map(event=>event.id);receipt.status='passed'
}catch(error){receipt.status='failed';receipt.failure={phase,...safeError(error)};process.exitCode=1}
finally{
 if(h)await h.close()
 if(stripe&&clock)try{await stripe.request('DELETE',`/v1/test_helpers/test_clocks/${clock}`);receipt.cleanup.push({clock,status:'deleted'})}catch(error){receipt.cleanup.push({clock,...safeError(error)});process.exitCode=1}
 receipt.requests=stripe?.requests;console.log(JSON.stringify(receipt,null,2))
}
