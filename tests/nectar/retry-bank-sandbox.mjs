// Outside push Verify. Build first; inject the held US test key as STRIPE_SECRET_KEY.
// Only real Stripe responses establish outcomes. Nectar clock changes never advance ACH.
// Fixtures: https://docs.stripe.com/payments/ach-direct-debit/accept-a-payment?payment-ui=direct-api#test-account-numbers
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { stripeSandbox,check,reference,safeError,SandboxFailure } from './stripe-sandbox-client.mjs'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { totp } from './mfa.mjs'
import { bankEvidence } from './retry-bank-evidence.mjs'
const initial=Math.floor(Date.now()/1000)*1000-60000,day=new Date(initial).toISOString().slice(0,10),DAY=86400000
const sources=['pm_usBankAccount_insufficientFunds','pm_usBankAccount_accountClosed','pm_usBankAccount_noAccount'].map((fixture,index)=>({fixture,index,writes:[]}))
const result={clause:'DUN-001',status:'running',head:null,checks:{},sources:[],limitations:[],cleanup:[]}
let stripe,h,owner,factor,evidence,instant=initial,verifiedAt=initial,phase='candidate',mailCount
const budget=Number(process.env.NECTAR_BANK_OBSERVE_MS??180000)
async function api(path,body){
 const response=await h.raw(`/api/nectar/${path}`,{cookie:owner,body});let value
 try{value=await response.json()}catch{throw new SandboxFailure('native_invalid_json',response.status)}
 if(response.status!==200)throw new SandboxFailure(safeError({code:value?.error??value?.code}).code,response.status)
 return value
}
const invoice=source=>api(`invoices/${source.invoiceRef}`)
async function clock(at){instant=at;await h.advanceClock(new Date(at).toISOString());if(at-verifiedAt>=14*60000){await api('mfa.verify',{code:totp(factor,at)});verifiedAt=at}}
async function tick(){check((await h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent('* * * * *')}`)).status===200,'scheduler_failed')}
async function forward(request){
 let source
 const response=await stripe.forward(request,entry=>{
  if(entry.method!=='POST')return
  source=sources.find(s=>entry.path==='/v1/payment_intents'?s.customerRef===entry.fields.get('customer'):entry.path===`/v1/payment_intents/${s.intentRef}/confirm`)
  check(source&&source.writes.length<3,'unexpected_worker_payment_write')
  const fields=entry.fields,n=source.writes.length+1
  check(fields.get('payment_method')===source.methodRef&&fields.get('mandate')===source.mandateRef&&fields.get('off_session')==='true'
   &&!fields.has('receipt_email')&&![...fields.keys()].some(k=>k.startsWith('payment_method_data')),'unsafe_bank_payment_parameters')
  check(n===1?entry.path==='/v1/payment_intents'&&fields.get('confirm')==='true'&&fields.get('amount')==='1200'
   &&fields.get('currency')==='usd'&&entry.idempotencyKey===`nectar-automatic-${fields.get('metadata[nectar_native_collection_key]')}`
   :entry.idempotencyKey===`nectar-retry-${source.requestRef}-${n}`,'bank_intent_or_idempotency_changed')
  source.writes.push({path:entry.path,key:entry.idempotencyKey})
 })
 if(source){let value;try{value=await response.clone().json()}catch{};source.intentRef??=reference(value?.object==='payment_intent'?value:value?.error?.payment_intent)}
 return response
}
async function setup(source){
 const customer=await stripe.request('POST','/v1/customers',{name:`synthetic-nectar-${source.index+1}`,'metadata[nectar_run]':stripe.run});source.customerRef=customer.id
 check(customer.livemode===false&&!customer.email,'test_customer_required')
 let setup=await stripe.request('POST','/v1/setup_intents',{customer:customer.id,payment_method:source.fixture,'payment_method_types[0]':'us_bank_account',usage:'off_session',confirm:true,
  'mandate_data[customer_acceptance][type]':'online','mandate_data[customer_acceptance][accepted_at]':initial/1000,
  'mandate_data[customer_acceptance][online][ip_address]':'127.0.0.1','mandate_data[customer_acceptance][online][user_agent]':'synthetic-nectar-4'})
 source.setupRef=setup.id;source.methodRef=reference(setup.payment_method)
 if(setup.status==='requires_action'){
  const verification=setup.next_action?.verify_with_microdeposits
  check(setup.next_action?.type==='verify_with_microdeposits'&&['descriptor_code','amounts'].includes(verification?.microdeposit_type),'unsupported_setup_action')
  setup=await stripe.request('POST',`/v1/setup_intents/${setup.id}/verify_microdeposits`,verification.microdeposit_type==='descriptor_code'?{descriptor_code:'SMT86W'}:{'amounts[0]':32,'amounts[1]':45})
 }
 check(setup.status==='succeeded'&&setup.livemode===false&&reference(setup.customer)===customer.id,'verified_setup_required')
 source.methodRef=reference(setup.payment_method);source.mandateRef=reference(setup.mandate)
 check(source.methodRef&&source.mandateRef,'verified_bank_mandate_missing')
 const mandate=await stripe.request('GET',`/v1/mandates/${source.mandateRef}`)
 check(mandate.status==='active'&&mandate.type==='multi_use'&&mandate.livemode===false&&reference(mandate.payment_method)===source.methodRef&&mandate.customer_acceptance?.type==='online','active_verified_mandate_required')
 await stripe.request('POST',`/v1/customers/${customer.id}`,{'invoice_settings[default_payment_method]':source.methodRef})
 const method=await stripe.request('GET',`/v1/payment_methods/${source.methodRef}`)
 check(method.type==='us_bank_account'&&method.livemode===false&&reference(method.customer)===customer.id,'saved_verified_bank_required')
}
async function authorize(source,account){
 const customer=(await api('customer.create',{external_id:`synthetic-nectar-${source.index+10}`,name:`synthetic-nectar-${source.index+20}`,billing_email:`synthetic-nectar-${source.index+30}@example.test`})).id
 await api('collection.customer.bind',{customer,account_ref:account,stripe_customer_ref:source.customerRef,confirm:true})
 const charge=await api('charge.add',{customer,amount:'12.00',description:`synthetic-nectar-${source.index+40}`,effective_date:day,taxable:false})
 source.invoiceRef=(await api('invoice.manual',{customer,charges:[charge.charge],service_date:day})).id
 const prepared=await api('automatic.collection.prepare',{invoice:source.invoiceRef,issue_date:day,mandate_ref:source.mandateRef,enable_retries:true});source.requestRef=prepared.id;source.policy=prepared.quote?.retryPolicy
 check(prepared.status==='awaiting_customer'&&prepared.amountCents===1200&&prepared.quote.issueDate===day&&prepared.quote.accountRef===account&&source.policy
  &&prepared.quote.method.paymentMethodRef===source.methodRef&&prepared.quote.method.mandateRef===source.mandateRef,'exact_retry_terms_missing')
 const session=await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'}),path=`/portal/automatic-collections/${prepared.id}?session=${encodeURIComponent(session.token)}`
 check((await h.raw(path)).status===200,'customer_consent_page_missing')
 const response=await h.raw(path,{body:{request:prepared.id,basis_hash:prepared.basis,accept:true}})
 check(response.status===200&&(await response.json()).status==='pending_approval','customer_exact_consent_missing')
 const approved=await api('automatic.collection.decide',{request:prepared.id,basis_hash:prepared.basis,decision:'approved',confirm:true,confirm_single:true})
 check(approved.status==='active'&&approved.acceptedAt&&approved.approvedAt&&approved.approvalMode==='single-approver'&&source.writes.length===0,'owner_second_confirmation_missing')
 await api('invoice.approve',{invoice:source.invoiceRef,acknowledge:true});await api('invoice.finalise',{invoice:source.invoiceRef,issue_date:day})
 check(source.intentRef&&source.writes.length===1,'one_original_intent_required')
}
async function observe(source){
 const deadline=Date.now()+budget,before=source.writes.length
 while(Date.now()<deadline){
  const intent=await stripe.request('GET',`/v1/payment_intents/${source.intentRef}`,{},Math.min(20000,Math.max(1,deadline-Date.now())))
  check(intent.livemode===false&&reference(intent.customer)===source.customerRef&&intent.amount===1200,'provider_identity_changed')
  if(intent.status==='requires_payment_method'&&intent.amount_received===0&&intent.last_payment_error){
   const code=safeError({code:intent.last_payment_error.code}).code;check(code!=='sandbox_failure','provider_failure_code_missing')
   const row=await api('automatic.collection.reconcile',{request:source.requestRef})
   check(row.status==='returned'&&row.paymentIntentRef===source.intentRef&&row.errorCode===(code==='insufficient_funds'?'ach_insufficient_funds':code),'native_return_not_provider_derived')
   check(source.writes.length===before,'reconciliation_made_payment_write')
   source.providerCode=code;source.errorCode=row.errorCode;return invoice(source)
  }
  check(intent.status==='processing','unexpected_provider_bank_outcome')
  await delay(Math.min(5000,Math.max(1,deadline-Date.now())))
 }
 throw new SandboxFailure('provider_failure_observation_timeout')
}
async function exercise(){
 for(const source of sources){
  const state=await observe(source);check(state.paidCents===0&&state.balanceCents===1200&&state.attempt_count===1,'failed_bank_recorded_cash')
  if(source.index===0){source.firstFailedAt=instant;check(Number.isSafeInteger(state.next_payment_attempt)&&state.next_payment_attempt>instant&&state.next_payment_attempt<=instant+Math.min(source.policy.windowDays,180)*DAY,'insufficient_funds_schedule_unbounded')}
  else check(state.next_payment_attempt===null,'closed_or_missing_account_scheduled')
  await evidence.capture(source,source.index?'blocked':'scheduled')
 }
 const source=sources[0]
 for(let retry=0;retry<2;retry++){
  const scheduled=await invoice(source);if(scheduled.next_payment_attempt===null)break
  await clock(scheduled.next_payment_attempt-1);const before=source.writes.length;await tick();check(source.writes.length===before,'bank_retry_before_due')
  const mandate=await stripe.request('GET',`/v1/mandates/${source.mandateRef}`)
  await clock(scheduled.next_payment_attempt);await tick();await tick()
  if(mandate.status!=='active'){
   check(source.writes.length===before&&(await invoice(source)).next_payment_attempt===null,'inactive_mandate_retried')
   result.limitations.push({code:'provider_invalidated_bank_mandate',mandateStatus:mandate.status,unproved:'two_same_intent_reinitiations'});break
  }
  if(source.writes.length!==before+1){
   const state=await invoice(source),collection=(await api('automatic-collections')).find(row=>row.id===source.requestRef)
   result.stoppedRetry={retryStatus:state.retry_status,nextAttempt:state.next_payment_attempt,attempts:state.attempt_count,collectionStatus:collection.status,errorCode:collection.errorCode,mandateStatus:mandate.status,
    reasons:(await api('audit')).filter(row=>row.action==='retry.blocked'&&row.subject===source.invoiceRef).map(row=>typeof row.detail==='string'?JSON.parse(row.detail):row.detail)}
  }
  check(source.writes.length===before+1,'due_bank_retry_not_once')
  const failed=await observe(source);check(failed.attempt_count===source.writes.length&&failed.paidCents===0&&failed.balanceCents===1200,'retry_failure_not_recorded')
  const count=source.writes.length;await tick();await tick();check(source.writes.length===count,'repeated_tick_reinitiated_bank')
 }
 check((await invoice(source)).next_payment_attempt===null&&source.writes.length<=3,'bank_retry_limit_unproved')
 const counts=sources.map(s=>s.writes.length);await clock(instant+181*DAY);await tick();await tick()
 check(sources.every((s,i)=>s.writes.length===counts[i])&&sources.slice(1).every(s=>s.writes.length===1),'later_bank_write_after_terminal_failure')
 for(const item of sources){check((await invoice(item)).next_payment_attempt===null,'terminal_bank_schedule_present');await evidence.capture(item,'terminal')}
 check(h.mails.length===mailCount,'bank_journey_sent_notice')
 result.checks={verifiedSavedBankAndActiveMandate:true,exactCustomerConsentAndOwnerSecondConfirmation:true,threeGenuineProviderFailures:true,closedAndMissingNeverRetried:true,nativeDueBoundary:true,repeatedTickSafe:true,twoSameIntentRetries:source.writes.length===3,noNotice:true}
}
async function clean(resource,ref,action){if(!ref)return;try{await action();result.cleanup.push({resource,ref,status:'cleaned'})}catch(error){result.cleanup.push({resource,ref,status:'failed',...safeError(error)});process.exitCode=1}}
try{
 result.head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();check(/^[a-f0-9]{40}$/.test(result.head),'candidate_head_required')
 check(Number.isInteger(budget)&&budget>=30000&&budget<=600000,'invalid_observation_budget')
 phase='verified-provider-bank-setup';stripe=stripeSandbox(process.env.STRIPE_SECRET_KEY);const account=await stripe.request('GET','/v1/account');check(account.country==='US','us_test_account_required')
 const setups=await Promise.allSettled(sources.map(setup));for(const item of setups)if(item.status==='rejected')throw item.reason
 phase='native-exact-authority';h=await harness({assets:true,localTime:new Date(initial).toISOString(),stripeSecret:process.env.STRIPE_SECRET_KEY,stripeFetch:forward})
 check((await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'synthetic-nectar-50'}})).status===303,'owner_bootstrap_failed');owner=await h.signIn(h.vars.OWNER_EMAIL)
 check((await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})).status===303,'owner_setup_failed')
 await api('business.configure',{legal_name:'synthetic-nectar-51',address:'synthetic-nectar-52',timezone:'UTC',invoice_prefix:'SYNTH',payment_terms_days:30})
 await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'synthetic-nectar-53'});await api('tax.review',{revision:(await api('business')).revision})
 const enrollment=await api('mfa.totp.start',{});factor=enrollment.secret;await api('mfa.totp.confirm',{factor:enrollment.factor,code:totp(factor,instant)});await api('mfa.policy',{scope:'all'})
 await api('portal.configure',{hosts:[h.origin],parents:[]});mailCount=h.mails.length
 for(const source of sources)await authorize(source,account.id)
 evidence=await bankEvidence(h.origin,owner);phase='genuine-bank-failures-and-native-retries';await exercise();result.status=result.limitations.length?'partial':'passed'
 if(result.status==='partial')process.exitCode=1
}catch(error){result.status='failed';result.failure={phase,...safeError(error)};process.exitCode=1}
finally{
 await clean('browser',evidence?'owned':null,()=>evidence.close());await clean('worker',h?'owned':null,()=>h.close())
 for(const source of sources.toReversed()){
  await clean('intent',source.intentRef,async()=>{const intent=await stripe.request('GET',`/v1/payment_intents/${source.intentRef}`);if(!['succeeded','canceled'].includes(intent.status))await stripe.request('POST',`/v1/payment_intents/${source.intentRef}/cancel`)})
  await clean('setup',source.setupRef,async()=>{const setup=await stripe.request('GET',`/v1/setup_intents/${source.setupRef}`);if(!['succeeded','canceled'].includes(setup.status))await stripe.request('POST',`/v1/setup_intents/${source.setupRef}/cancel`)})
  await clean('method',source.methodRef,async()=>{const method=await stripe.request('GET',`/v1/payment_methods/${source.methodRef}`);if(reference(method.customer))await stripe.request('POST',`/v1/payment_methods/${source.methodRef}/detach`)})
  await clean('customer',source.customerRef,()=>stripe.request('DELETE',`/v1/customers/${source.customerRef}`))
 }
 result.sources=sources.map(({index,customerRef,methodRef,mandateRef,setupRef,invoiceRef,intentRef,providerCode,errorCode,writes})=>({index,customerRef,methodRef,mandateRef,setupRef,invoiceRef,intentRef,providerCode,errorCode,attempts:writes.length}))
 result.requests=stripe?.requests??[];if(process.exitCode&&result.status==='passed')result.status='cleanup_failed';console.log(JSON.stringify(result))
}
