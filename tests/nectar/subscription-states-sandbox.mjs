// Held-key card lifecycle proof outside push Verify. No production authority.
import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { stripeSandbox, check, safeError } from './stripe-sandbox-client.mjs'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { totp } from './mfa.mjs'
const day=86400000,actual=Date.now(),end=new Date(actual).toISOString().slice(0,10)
const delivered=[],paymentEventSecret='synthetic-nectar-sandbox-events'
let instant=Date.parse(end+'T12:00:00Z')-day,clock,providerCustomer,h,owner,factor,stripe,phase='sources'
const receipt={head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),clause:'SUB-001',clauseComplete:false,status:'running',states:[],cleanup:[],limitations:['The added finite-schedule authority remains an adopted conservative default pending ct; no open-ended renewal or mail authority is claimed.']}
const date=()=>new Date(instant).toISOString().slice(0,10)
const api=(p,b,status)=>h.api(p.startsWith('subscriptions/')?p+'?include_state=true':p,owner,b,status)
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
 h=await harness({localTime:new Date(instant).toISOString(),stripeSecret:process.env.STRIPE_SECRET_KEY,stripeWebhookSecret:paymentEventSecret,stripeFetch:r=>stripe.forward(r),webhookFetch:async request=>{delivered.push(await request.json());return new Response(null,{status:200})}})
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
 const anchor=new Date(actual);anchor.setUTCMonth(anchor.getUTCMonth()-1)
 const subscription=(await api('subscription.create',{customer,start_date:date(),billing_anchor_date:anchor.toISOString().slice(0,10),anchor_day:Math.min(28,Number(end.slice(8))),trial_end:end,trial_payment:'card',price:[price],quantity:['1']})).id
 receipt.subscription=subscription
 await state(subscription,'trialing')
 phase='trial-card-capture'
 const prepared=await api('trial.collection.prepare',{subscription});await api('trial.collection.confirm',{...prepared.instructions.confirm,confirm_single:true})
 // Prepare every native authority before the trial converts. The provider
 // default switches below are fixture controls, never new native permission.
 const nextDate=prepared.quote.window.nominalEnd
 const bad=await stripe.request('POST','/v1/payment_methods',{type:'card','card[token]':'tok_chargeCustomerFail'})
 await stripe.request('POST',`/v1/payment_methods/${bad.id}/attach`,{customer:providerCustomer})
 await stripe.request('POST',`/v1/customers/${providerCustomer}`,{'invoice_settings[default_payment_method]':bad.id})
 await api('retry.policy.configure',{max_attempts:1,window_days:2,confirm:true})
 const terms=await api('collection.schedule.prepare',{subscription,periods:[nextDate.slice(0,7)],issue_dates:[nextDate],unpaid_days:2,confirm:true})
 const session=await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
 check((await h.raw(`/portal/automatic-collections/${terms.id}?session=${encodeURIComponent(session.token)}`,{body:{request:terms.id,basis_hash:terms.basis,accept:true}})).status===200,'customer_acceptance_missing')
 await api('automatic.collection.decide',{request:terms.id,basis_hash:terms.basis,decision:'approved',confirm:true,confirm_single:true})
 await stripe.request('POST',`/v1/customers/${providerCustomer}`,{'invoice_settings[default_payment_method]':good.id})
 receipt.schedule={id:terms.schedule,invoice:terms.invoice,issueDate:nextDate,amountCents:terms.amountCents}
 await move(actual);await state(subscription,'active')
 const trial=(await api(`trial-collections?subscription=${subscription}`))[0];check(trial.status==='collected','trial_card_capture_missing')
 const trialFact=(await api(`customers/${customer}`)).billingRecord.processorPayments.find(row=>row.invoice===trial.invoice)
 check(trialFact?.captured&&trialFact.amountCents>0,'trial_capture_public_evidence_missing')
 const trialIntent=await stripe.request('GET',`/v1/payment_intents/${trialFact.paymentIntentRef}`)
 check(trialIntent.status==='succeeded'&&trialIntent.amount_received===trialFact.amountCents,'provider_trial_capture_missing')
 receipt.trial={invoice:trial.invoice,paymentIntent:trialFact.paymentIntentRef,charge:trialFact.chargeRef,amountCents:trialFact.amountCents,status:trial.status}
 phase='renewal-failure'
 await stripe.request('POST',`/v1/customers/${providerCustomer}`,{'invoice_settings[default_payment_method]':bad.id})
 await move(Date.parse(nextDate+'T12:00:00Z'));await state(subscription,'past_due')
 const invoice=await api('invoices/'+terms.invoice)
 const failed=(await api('automatic-collections')).find(row=>row.id===terms.id)
 check(invoice.status==='issued'&&invoice.balanceCents===terms.amountCents&&failed?.status==='refused','scheduled_renewal_failure_missing')
 await move(instant+2*day);await state(subscription,'unpaid')
 check((await api('dunning')).series.some(row=>row.invoice_id===invoice.id&&row.status==='mark_unpaid'),'scheduled_unpaid_missing')
 phase='card-recovery'
 // A customer's external payment recovers the original intent. Native
 // processing performs only authenticated provider reads and cash allocation.
 const payment=await stripe.request('POST',`/v1/payment_intents/${failed.paymentIntentRef}/confirm`,{payment_method:good.id,off_session:true})
 check(payment.status==='succeeded'&&payment.amount_received===invoice.total_cents,'recovery_capture_missing')
 const recoveryCharge=await stripe.request('GET',`/v1/charges/${payment.latest_charge}`)
 check(recoveryCharge.paid&&recoveryCharge.captured&&recoveryCharge.amount_captured===invoice.total_cents,'recovery_charge_capture_missing')
 const captureDate=new Date(recoveryCharge.created*1000).toISOString().slice(0,10)
 receipt.captureTiming={nativeClock:instant,providerCapturedAt:recoveryCharge.created*1000,providerClockAligned:recoveryCharge.created*1000>=instant-day}
 if(!receipt.captureTiming.providerClockAligned)receipt.limitations.push('Stripe card capture time did not advance with the owned test clock; the actual provider date is retained. Clock-aligned processor recovery remains unproved.')
 const events=await stripe.list('/v1/events',{type:'payment_intent.succeeded'})
 const event=events.data.find(row=>row.data?.object?.id===payment.id)
 check(event,'provider_recovery_event_missing')
 const text=JSON.stringify(event),seconds=Math.floor(instant/1000),signature=`t=${seconds},v1=${createHmac('sha256',paymentEventSecret).update(`${seconds}.${text}`).digest('hex')}`
 for(let n=0;n<2;n++) {
  const response=await h.raw('/api/nectar/stripe/payment-events',{form:text,headers:{'content-type':'application/json','stripe-signature':signature}})
  check(response.status===200,'provider_recovery_intake_failed')
 }
 const recovered=await api('invoices/'+invoice.id)
 check(recovered.paidCents===invoice.total_cents&&recovered.balanceCents===0&&recovered.allocations.length===1,'provider_recovery_allocation_missing')
 const recorded={payment:recovered.allocations[0].payment_id}
 receipt.recoveryEvent=event.id
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
