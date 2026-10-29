// Outside Verify: inject the held Stripe test source as STRIPE_SECRET_KEY.
// Only safe object references, request IDs and assertion outcomes reach stdout.
import {mkdir} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {chromium} from '@playwright/test'
import {harness} from './harness.mjs'
import {applyPolicy} from './policy-helper.mjs'
import {totp} from './mfa.mjs'
import {seedPartialInvoice} from './invoice-partial-payments.mjs'
import {stripeSandbox,check,reference,safeError,SandboxFailure} from './stripe-sandbox-client.mjs'

const facts={head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),journey:'INV-007 genuine partial card and dated ACH instruction',checks:{},providerFailures:[],cleanup:[]}
const stripe=stripeSandbox(process.env.STRIPE_SECRET_KEY),workerWrites=[]
let h,browser,page,customerRef,owner,factor,phase='provider-customer'
let at=Math.floor(Date.now()/30000)*30000
const day=()=>new Date(at).toISOString().slice(0,10)
async function api(path,body,status=200){
  const response=await h.raw(`/api/nectar/${path}`,{cookie:owner,body})
  const result=await response.json()
  if(response.status!==status)throw new SandboxFailure(result?.error??'native_status_mismatch',response.status)
  return result
}
const forward=async request=>{
  const response=await stripe.forward(request,entry=>{
    check(entry.method!=='POST'||['/v1/checkout/sessions','/v1/payment_intents'].includes(entry.path),'unexpected_worker_provider_write')
    if(entry.method==='POST'){
      check(!entry.fields.has('receipt_email')&&!entry.fields.has('setup_future_usage')&&!entry.fields.has('payment_intent_data[setup_future_usage]'),'unexpected_future_authority')
      workerWrites.push({path:entry.path,key:entry.idempotencyKey})
    }
  })
  if(response.ok&&new URL(request.url).pathname==='/v1/checkout/sessions'&&request.method==='POST'){
    const returned=await response.clone().json(),url=new URL(returned.url)
    facts.checkoutShape={object:returned.object,mode:returned.mode,livemode:returned.livemode,currency:returned.currency,amountCents:returned.amount_total,
      ownCustomer:reference(returned.customer)===customerRef,hasFragment:!!url.hash,hasCredentials:!!(url.username||url.password),stripeOrigin:url.origin==='https://checkout.stripe.com'}
  }
  if(!response.ok){const value=await response.clone().json();facts.providerFailures.push(safeError({code:value?.error?.code??value?.error?.type,param:value?.error?.param,status:response.status}))}
  return response
}
try{
  const account=await stripe.request('GET','/v1/account')
  const customer=await stripe.request('POST','/v1/customers',{name:'synthetic-nectar-partial-1','metadata[nectar_run]':stripe.run})
  customerRef=customer.id;check(customer.livemode===false,'test_customer_required')
  phase='native-prepare'
  h=await harness({assets:true,localTime:new Date(at).toISOString(),stripeSecret:process.env.STRIPE_SECRET_KEY,stripeFetch:forward})
  check((await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Synthetic owner'}})).status===303,'owner_bootstrap_failed')
  owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await api('business.configure',{legal_name:'Synthetic partial merchant',timezone:'UTC',invoice_prefix:'SYNTH',payment_terms_days:30})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Synthetic held-source payment qualification'})
  await api('tax.review',{revision:(await api('business')).revision})
  const enrolled=await api('mfa.totp.start',{});factor=enrolled.secret
  await api('mfa.totp.confirm',{factor:enrolled.factor,code:totp(factor,at)})
  const native=(await api('customer.create',{external_id:`synthetic-nectar-${stripe.run}`,name:'Synthetic partial customer',billing_email:['synthetic-nectar-'+stripe.run,'example.test'].join(String.fromCharCode(64))})).id
  const invoice=await seedPartialInvoice(h,owner,native,{issueDate:day()})
  await api('collection.customer.bind',{customer:native,account_ref:account.id,stripe_customer_ref:customerRef,confirm:true})
  await api('portal.configure',{hosts:[h.origin],parents:[]})
  let session=await api('portal.session.issue',{customer:native,origin:h.origin,audience:'hosted'})
  const partial=await api('invoice.partial.prepare',{invoice:invoice.id,amount_cents:40000})
  await api('invoice.partial.confirm',partial.confirm)
  browser=await chromium.launch({headless:true,executablePath:process.env.NECTAR_CHROMIUM_PATH??'/usr/bin/chromium',args:['--no-sandbox','--use-mock-keychain','--password-store=basic'],
    ...(process.env.HTTPS_PROXY?{proxy:{server:process.env.HTTPS_PROXY,bypass:'localhost,127.0.0.1'}}:{})})
  const context=await browser.newContext();page=await context.newPage();page.setDefaultTimeout(30000)
  await page.goto(`${h.origin}/portal/invoices/${invoice.id}?session=${session.token}`)
  const consent=page.locator(`[data-partial="${partial.id}"] form`).first()
  await consent.locator('[name=accept]').check()
  const checkoutResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/portal/invoice-payment/start'&&r.request().method()==='POST')
  await consent.locator('button').click()
  const checkoutHeaders=await (await checkoutResponse).allHeaders()
  check(checkoutHeaders.location?.startsWith('https://checkout.stripe.com/'),'native_checkout_destination_unavailable')
  phase='processor-hosted-card'
  await page.waitForURL('https://checkout.stripe.com/**',{timeout:60000})
  phase='processor-card-number'
  await page.locator('#cardNumber').fill('4242424242424242')
  phase='processor-card-expiry'
  await page.locator('#cardExpiry').fill('1235');await page.locator('#cardCvc').fill('123')
  const email=page.locator('#email');if(await email.count())await email.fill(['synthetic-nectar-'+stripe.run,'example.test'].join(String.fromCharCode(64)))
  const country=page.locator('#billingCountry');if(await country.count())await country.selectOption('US')
  const name=page.locator('#billingName');if(await name.count())await name.fill('Synthetic partial customer')
  const postal=page.locator('#billingPostalCode');if(await postal.count())await postal.fill('94105')
  const link=page.locator('#enableStripePass');if(await link.count())await link.uncheck()
  phase='processor-card-submit'
  await page.locator('button[type=submit]').click();await page.waitForURL(`${h.origin}/portal/invoice-payment/return`,{timeout:60000})
  phase='native-capture'
  // Keep native and processor time aligned without extending customer authority.
  at=Date.now();await h.advanceClock(new Date(at).toISOString())
  const captured=await api('invoice.partial.reconcile',{request:partial.id})
  check(captured.status==='collected','card_capture_required')
  const paid=await api(`invoices/${invoice.id}`),ledger=(await api(`customers/${native}`)).ledger
  check(paid.total_cents===100000&&paid.paidCents===40000&&paid.balanceCents===60000&&paid.allocations.length===1,'partial_invoice_totals_mismatch')
  check(ledger.paidCents===40000&&ledger.balanceCents===60000,'partial_customer_totals_mismatch')
  const source=await stripe.request('GET',`/v1/customers/${customerRef}`)
  check(!source.invoice_settings?.default_payment_method,'one_time_card_became_default')
  await api('invoice.partial.reconcile',{request:partial.id})
  check(workerWrites.length===1,'card_checkout_replayed')
  facts.checks.card={amountCents:40000,balanceCents:60000,payment:captured.payment,invoice:invoice.id,checkoutWrites:1,defaultMethod:null}
  phase='verified-bank-fixture'
  let setup=await stripe.request('POST','/v1/setup_intents',{customer:customerRef,payment_method:'pm_usBankAccount_success','payment_method_types[0]':'us_bank_account',usage:'off_session',confirm:'true',
    'mandate_data[customer_acceptance][type]':'online','mandate_data[customer_acceptance][accepted_at]':Math.floor(Date.now()/1000),
    'mandate_data[customer_acceptance][online][ip_address]':'127.0.0.1','mandate_data[customer_acceptance][online][user_agent]':'synthetic-nectar-partial'})
  if(setup.status==='requires_action'){
    const verification=setup.next_action?.verify_with_microdeposits
    check(setup.next_action?.type==='verify_with_microdeposits'&&verification,'bank_verification_unavailable')
    setup=await stripe.request('POST',`/v1/setup_intents/${setup.id}/verify_microdeposits`,verification.microdeposit_type==='descriptor_code'?{descriptor_code:'SMT86W'}:{'amounts[0]':32,'amounts[1]':45})
  }
  check(setup.status==='succeeded'&&setup.livemode===false,'verified_bank_required')
  const method=reference(setup.payment_method),mandate=reference(setup.mandate)
  await stripe.request('POST',`/v1/customers/${customerRef}`,{'invoice_settings[default_payment_method]':method})
  phase='dated-ach-consent'
  // The local date is pinned to today's actual provider date. This is an
  // explicit human submission, never a claim of accelerated ACH settlement.
  at=Math.floor(Date.now()/30000)*30000+30000;await h.advanceClock(new Date(at).toISOString())
  await api('mfa.verify',{code:totp(factor,at)})
  const scheduled=await api('invoice.partial.schedule.prepare',{invoice:invoice.id,scheduled_on:day(),mandate_ref:mandate})
  await api('invoice.partial.confirm',scheduled.confirm)
  session=await api('portal.session.issue',{customer:native,origin:h.origin,audience:'hosted'})
  const acceptance=await h.raw(`/portal/invoice-payment/schedule?session=${session.token}`,{body:{request:scheduled.id,basis_hash:scheduled.basisHash,accept:true}})
  check(acceptance.status===200,'own_customer_bank_acceptance_failed');await acceptance.json()
  const submission={request:scheduled.id,basis_hash:scheduled.basisHash,scheduled_on:day(),amount_cents:60000,payment_method_ref:method,confirm:true}
  const pending=await api('invoice.partial.schedule.execute',submission)
  check(['open','uncertain'].includes(pending.status),'ach_pending_required')
  const reconciled=await api('invoice.partial.reconcile',{request:scheduled.id})
  check(reconciled.status==='open'&&!reconciled.payment,'ach_pending_cash_refused')
  await api('invoice.partial.schedule.execute',submission,409)
  const stillOwed=await api(`invoices/${invoice.id}`)
  check(stillOwed.paidCents===40000&&stillOwed.balanceCents===60000&&stillOwed.allocations.length===1,'pending_ach_invented_cash')
  check(workerWrites.length===2,'ach_submission_replayed')
  facts.checks.ach={amountCents:60000,state:reconciled.status,recordedCashCents:40000,balanceCents:60000,submissions:1,settlement:'unproved-real-time-provider-boundary'}
  facts.status='passed-current-provider-boundary'
}catch(error){
  facts.status='not-qualified';facts.failure={phase,...safeError(error),errorClass:['TimeoutError','Error'].includes(error?.name)?error.name:'other'}
  const transport=String(error?.message??'').match(/net::(ERR_[A-Z_]+)/);if(transport)facts.failure.transport=transport[1]
  if(page){
    facts.browserFields=await page.locator('input:not([type=hidden])').evaluateAll(nodes=>nodes.map(n=>({id:n.id,name:n.name,type:n.type}))).catch(()=>[])
    if(process.env.NECTAR_EVIDENCE_DIR){await mkdir(process.env.NECTAR_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:process.env.NECTAR_EVIDENCE_DIR+'/provider-boundary.png',fullPage:true}).catch(()=>{})}
  }
  process.exitCode=1
}
finally{
  await browser?.close();await h?.close()
  if(customerRef){
    try{const sessions=await stripe.list('/v1/checkout/sessions',{customer:customerRef});for(const session of sessions.data)if(session.status==='open')await stripe.request('POST',`/v1/checkout/sessions/${session.id}/expire`,{})}catch(error){facts.cleanup.push({phase:'expire-owned-checkout',...safeError(error)})}
    try{const intents=await stripe.list('/v1/payment_intents',{customer:customerRef});for(const intent of intents.data)if(['processing','requires_payment_method','requires_confirmation','requires_action'].includes(intent.status))await stripe.request('POST',`/v1/payment_intents/${intent.id}/cancel`,{})}catch(error){facts.cleanup.push({phase:'cancel-owned-pending-intent',...safeError(error)})}
    try{await stripe.request('DELETE',`/v1/customers/${customerRef}`);facts.cleanup.push({customer:customerRef,deleted:true})}catch(error){facts.cleanup.push({phase:'delete-owned-customer',...safeError(error)})}
  }
  facts.requests=stripe.requests
  console.log(JSON.stringify(facts))
}
