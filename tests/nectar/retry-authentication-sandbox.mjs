// Outside push Verify. The held-key injector supplies STRIPE_SECRET_KEY.
// Every provider response and hosted authentication page is genuine test mode.
import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { stripeSandbox, check, reference, safeError } from './stripe-sandbox-client.mjs'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { totp } from './mfa.mjs'
const instant=Math.floor(Date.now()/1000)*1000-60000,day=new Date(instant).toISOString().slice(0,10)
const result={clause:'DUN-001',status:'running',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),checks:{},cleanup:[]}
const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/retry-authentication-sandbox'
let stripe,h,browser,customerRef,methodRef,clockRef,intentRef,owner,phase='provider-setup'
const writes=[]
async function api(path,body){const r=await h.raw('/api/nectar/'+path,{cookie:owner,body});const value=await r.json();check(r.status===200,value?.error??'native_request_failed');return value}
try{
 stripe=stripeSandbox(process.env.STRIPE_SECRET_KEY)
 const account=await stripe.request('GET','/v1/account')
 const clock=await stripe.request('POST','/v1/test_helpers/test_clocks',{frozen_time:instant/1000,name:'synthetic-nectar-authentication-1'});clockRef=clock.id
 const providerCustomer=await stripe.request('POST','/v1/customers',{test_clock:clockRef,name:'synthetic-nectar-authentication-2','metadata[nectar_run]':stripe.run});customerRef=providerCustomer.id
 const method=await stripe.request('POST','/v1/payment_methods/pm_card_authenticationRequired/attach',{customer:customerRef});methodRef=method.id
 check(reference(method.customer)===customerRef&&method.livemode===false,'test_method_attachment_unconfirmed')
 await stripe.request('POST',`/v1/customers/${customerRef}`,{'invoice_settings[default_payment_method]':methodRef})
 h=await harness({assets:true,localTime:new Date(instant).toISOString(),stripeSecret:process.env.STRIPE_SECRET_KEY,stripeFetch:request=>stripe.forward(request,entry=>{
  if(entry.method==='GET')return
  check(entry.path==='/v1/payment_intents'||/^\/v1\/payment_intents\/[^/]+\/confirm$/.test(entry.path),'unexpected_worker_provider_write')
  check(entry.idempotencyKey&&!entry.fields.has('receipt_email'),'unsafe_worker_payment_parameters')
  if(entry.path.endsWith('/confirm'))check(entry.fields.get('off_session')==='false'&&entry.fields.get('use_stripe_sdk')==='false'&&new URL(entry.fields.get('return_url')).search==='','unsafe_authentication_parameters')
  else check(entry.fields.get('off_session')==='true','unsafe_original_collection')
  writes.push({path:entry.path,key:entry.idempotencyKey})
 })})
 phase='exact-native-authority'
 check((await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Synthetic Nectar owner'}})).status===303,'bootstrap_failed')
 owner=await h.signIn(h.vars.OWNER_EMAIL)
 await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
 await api('business.configure',{legal_name:'Synthetic Nectar authentication',timezone:'UTC',invoice_prefix:'AUTH',payment_terms_days:30})
 await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Synthetic reviewed sandbox'})
 await api('tax.review',{revision:(await api('business')).revision})
 const factor=await api('mfa.totp.start',{});await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,instant)});await api('mfa.policy',{scope:'all'})
 const customer=(await api('customer.create',{external_id:'synthetic-nectar-authentication-3',name:'Cedar authentication sandbox',billing_email:'authentication@example.test',language:'en'})).id
 await api('collection.customer.bind',{customer,account_ref:account.id,stripe_customer_ref:customerRef,confirm:true})
 await api('portal.configure',{hosts:[h.origin],parents:[]})
 const charge=await api('charge.add',{customer,amount:'12.00',description:'Synthetic authentication service',effective_date:day,taxable:false})
 const invoice=(await api('invoice.manual',{customer,charges:[charge.charge],service_date:day})).id
 const original=await api('automatic.collection.prepare',{invoice,issue_date:day,enable_retries:true})
 const session=await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
 const initial=await h.raw(`/portal/automatic-collections/${original.id}?session=${encodeURIComponent(session.token)}`,{body:{request:original.id,basis_hash:original.basis,accept:true}});check(initial.status===200,'customer_initial_consent_failed')
 await api('automatic.collection.decide',{request:original.id,basis_hash:original.basis,decision:'approved',confirm:true,confirm_single:true})
 await api('invoice.approve',{invoice,acknowledge:true});await api('invoice.finalise',{invoice,issue_date:day})
 let failed=(await api('automatic-collections')).find(row=>row.id===original.id);intentRef=failed.paymentIntentRef
 result.initialAttempt={status:failed.status,errorCode:failed.errorCode,writes:writes.length}
 if(failed.status==='uncertain'){
  // An explicitly requested reconciliation reads the existing claimed intent.
  // Search propagation never authorizes another provider write.
  const before=writes.length
  failed=await api('automatic.collection.reconcile',{request:original.id})
  check(writes.length===before,'initial_reconciliation_wrote_payment')
  result.reconciledAttempt={status:failed.status,errorCode:failed.errorCode,writes:writes.length}
 }
 check(failed.status==='refused'&&failed.errorCode==='authentication_required'&&intentRef&&writes.length===1,'authentication_failure_unproved')
 const recovery=await api('retry.method.prepare',{request:original.id,authenticate:true,confirm:true})
 check(recovery.quote.method.paymentMethodRef===methodRef,'authentication_changed_method')
 const path=`/portal/retry-method-recoveries/${recovery.id}?session=${encodeURIComponent(session.token)}`
 check((await h.raw(path,{body:{recovery:recovery.id,quote_hash:recovery.quoteHash,accept:true}})).status===200,'separate_customer_consent_failed')
 await api('retry.method.decide',{recovery:recovery.id,quote_hash:recovery.quoteHash,decision:'approved',confirm:true,confirm_single:true})
 check(writes.length===1,'approval_made_provider_write')
 await mkdir(directory,{recursive:true})
 browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
 const page=await(await browser.newContext()).newPage()
 const shot=async label=>{for(const width of [1440,390]){await page.setViewportSize({width,height:1000});check(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),'native_viewport_overflow');await page.screenshot({path:`${directory}/${width}-${label}.png`,fullPage:true})}}
 await page.goto(h.origin+path);await shot('live-authentication-authorized')
 phase='genuine-bank-authentication'
 const form=page.locator('form').filter({has:page.locator('[name=authenticate]')})
 await Promise.all([page.waitForURL('https://hooks.stripe.com/**'),form.getByRole('button').click()])
 check(writes.length===2,'authentication_confirmation_missing')
 // Stripe's published test authentication UI, not a substituted application.
 // The issuer may put its challenge inside a cross-origin frame.
 let complete
 const challengeDeadline=Date.now()+30000
 while(!complete&&Date.now()<challengeDeadline){
  for(const frame of page.frames()){
   const button=frame.getByRole('button',{name:/complete|authorize/i}).first()
   if(await button.isVisible()){complete=button;break}
  }
  if(!complete)await page.waitForTimeout(250)
 }
 check(complete,'hosted_bank_control_unavailable')
 await Promise.all([page.waitForURL(url=>url.origin===h.origin&&url.pathname===`/portal/retry-method-recoveries/${recovery.id}`),complete.click()])
 check(new URL(page.url()).search==='','provider_return_parameters_not_discarded')
 await shot('live-authentication-returned')
 phase='captured-settlement'
 const checkForm=page.locator('form').filter({has:page.locator('[name=check]')})
 await Promise.all([page.waitForNavigation(),checkForm.getByRole('button').click()])
 await shot('live-authentication-collected')
 const paid=await api(`invoices/${invoice}`),provider=await stripe.request('GET',`/v1/payment_intents/${intentRef}`)
 check(paid.balanceCents===0&&paid.paidCents===1200&&paid.allocations.length===1&&paid.attempt_count===2&&provider.status==='succeeded'&&provider.amount_received===1200&&reference(provider.payment_method)===methodRef,'captured_authentication_not_reconciled')
 check((await h.raw(path,{body:{recovery:recovery.id,quote_hash:recovery.quoteHash,authenticate:true}})).status===200&&writes.length===2,'repeated_authentication_wrote_again')
 result.checks={sameMethod:true,sameIntent:true,actualHostedAuthentication:true,cleanReturn:true,amountCents:1200,onceOnlyCash:true,attempts:2}
 result.references={account:account.id,customer:customerRef,method:methodRef,intent:intentRef,invoice}
 result.status='passed'
}catch(error){result.status='failed';result.failure={phase,...safeError(error)};process.exitCode=1}
finally{
 await browser?.close();await h?.close()
 if(stripe&&intentRef)try{const intent=await stripe.request('GET',`/v1/payment_intents/${intentRef}`);if(intent.status!=='succeeded'&&intent.status!=='canceled')await stripe.request('POST',`/v1/payment_intents/${intentRef}/cancel`);result.cleanup.push({resource:'intent',status:intent.status==='succeeded'?'captured-test-payment':'cancelled-or-terminal'})}catch(error){result.cleanup.push({resource:'intent',status:'failed',...safeError(error)});process.exitCode=1}
 if(stripe&&methodRef)try{await stripe.request('POST',`/v1/payment_methods/${methodRef}/detach`);result.cleanup.push({resource:'method',status:'detached'})}catch(error){result.cleanup.push({resource:'method',status:'failed',...safeError(error)});process.exitCode=1}
 if(stripe&&clockRef)try{await stripe.request('DELETE',`/v1/test_helpers/test_clocks/${clockRef}`);result.cleanup.push({resource:'clock',status:'deleted'})}catch(error){result.cleanup.push({resource:'clock',status:'failed',...safeError(error)});process.exitCode=1}
 if(stripe&&customerRef)try{const current=await stripe.request('GET',`/v1/customers/${customerRef}`);if(!current.deleted)await stripe.request('DELETE',`/v1/customers/${customerRef}`);result.cleanup.push({resource:'customer',status:'deleted'})}catch(error){if(error?.status!==404){result.cleanup.push({resource:'customer',status:'failed',...safeError(error)});process.exitCode=1}}
 result.requests=stripe?.requests??[]
 if(process.exitCode&&result.status==='passed')result.status='cleanup_failed'
 console.log(JSON.stringify(result))
}
