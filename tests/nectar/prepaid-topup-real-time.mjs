// Outside push Verify. Parent builds the candidate and supplies the held US
// STRIPE_SECRET_KEY through _od08-env.py. All Stripe responses below are real;
// this file never reads a key file, inserts database rows or substitutes results.
// Build and commit first. Run with a held test key:
// node tests/nectar/prepaid-topup-real-time.mjs start ABSOLUTE_PRIVATE_DIRECTORY
// Reinvoke resume after nextEligibleAt on the SAME clean SHA. status needs no
// key. cleanup closes an incomplete run; it never claims qualification.
// The directory contains private installation keys and D1. Never publish it.
// Waiting exits successfully with status=waiting, which is incomplete evidence.
// An interrupted mutation stops rather than replaying a financial request.
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, readFile, rename, chmod, rm, realpath, open } from 'node:fs/promises'
import { join, resolve, isAbsolute, sep } from 'node:path'
import { stripeSandbox, check, reference, safeError, SandboxFailure } from './stripe-sandbox-client.mjs'
import { csvRows } from './financial-reports.mjs'
import { prepaidRefreshParity, prepaidReportParity } from './prepaid-report-parity.mjs'
import { totp } from './mfa.mjs'

const [command, stateArgument] = process.argv.slice(2)
check(['start','resume','status','cleanup'].includes(command) && stateArgument && isAbsolute(stateArgument), 'usage_command_and_absolute_private_state_directory_required')
const evidence=resolve(stateArgument), checkout=await realpath(process.cwd())
check(evidence!==checkout&&!evidence.startsWith(checkout+sep), 'state_must_be_outside_checkout')
let receipt={version:2,journey:'Real-time customer-authorized prepaid topup',status:'running',head:null,runId:null,checks:{},ids:{},amounts:{},purchases:[],workerRequests:[],clockCreated:false,cleanup:{confirmed:false}}
let privateState={}, lock, ownsLock=false, writable=false
const workerRequests=[]
let saving=Promise.resolve()
function save(){return saving=saving.then(async()=>{
  receipt.updatedAt=new Date().toISOString()
  receipt.counts={workerPaymentAttempts:posts(),stripeThisInvocation:stripe?.counts??null}
  receipt.workerRequests=workerRequests
  for(const [name,value] of [['receipt.json',receipt],['runtime.json',privateState]]){
    const path=join(evidence,name),temporary=path+'.new'
    await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});await chmod(temporary,0o600);await rename(temporary,path)
  }
})}
async function boundary(next){receipt.stage=next;receipt.inflight=null;await save()}
async function perform(name,action){receipt.inflight=name;await save();await action()}
function waitUntil(day){receipt.status='waiting';receipt.nextEligibleAt=day+'T00:00:00.000Z';receipt.incompleteReason='Actual funded daily service periods have not elapsed';console.log(`Prepaid real time: incomplete; next eligible ${receipt.nextEligibleAt}`)}
const date=instant=>new Date(instant).toISOString().slice(0,10)
const dayOffset=(day,n)=>date(Date.parse(`${day}T00:00:00Z`)+n*86400000)
const sum=values=>values.reduce((total,value)=>total+value,0)
const csvCents=value=>Math.round(Number(String(value).replace(/^'/,''))*100)
let phase='held-test-key',stripe,providerCustomer,method,account,h,owner,finance,factor,verifiedAt=0,today,row,fundedOn
const step=name=>{phase=name;console.log(`Prepaid real time: ${name}`)}
async function safeApi(path,who,body,status=200){
  const action=path.split(/[/?]/)[0].replace(/[^A-Za-z0-9_.-]/g,'').slice(0,60)
  const auth=typeof who==='string'?{cookie:who}:who??{}
  const response=await h.raw(`/api/nectar/${path}`,{...auth,body})
  if(response.status!==status){receipt.apiFailure={action,status:response.status,expectedStatus:status};throw new SandboxFailure(`api_${action.replace(/[^A-Za-z0-9_]/g,'_')}`,response.status)}
  if(response.status===204)return null
  try{return await response.json()}catch{throw new SandboxFailure('api_invalid_json',response.status)}
}
const api=(path,body,status)=>safeApi(path,owner,body,status)
const posts=()=>workerRequests.filter(entry=>entry.method==='POST').length
async function now(){
  today=date(Date.now())
  check(!h || !('NECTAR_LOCAL_TIME' in h.vars),'worker_must_use_actual_wall_time')
  if(factor&&Date.now()-verifiedAt>10*60*1000){await api('mfa.verify',{code:totp(factor,Date.now())});verifiedAt=Date.now()}
}
async function forward(request){
  const url=new URL(request.url),path=url.pathname
  const fixed=['/v1/account',`/v1/customers/${providerCustomer.id}`,`/v1/payment_methods/${method}`,'/v1/payment_intents','/v1/payment_intents/search','/v1/charges']
  check(fixed.includes(path)||request.method==='GET'&&/^\/v1\/payment_intents\/[A-Za-z0-9_]+$/.test(path),'unexpected_worker_stripe_path')
  check(request.headers.get('Stripe-Version')==='2025-03-31.basil','unexpected_worker_stripe_version')
  return stripe.forward(request,async entry=>{
    if(entry.method==='POST'){
      check(entry.path==='/v1/payment_intents','unexpected_worker_stripe_mutation')
      check(!entry.fields.has('receipt_email')&&entry.fields.get('confirm')==='true'&&entry.fields.get('off_session')==='true'&&entry.fields.get('payment_method_types[0]')==='card','unexpected_worker_payment_parameters')
      check(entry.fields.get('customer')===providerCustomer.id&&entry.fields.get('payment_method')===method&&entry.fields.get('currency')==='usd','foreign_worker_payment_binding')
      check([1000000,500000].includes(Number(entry.fields.get('amount'))),'unexpected_worker_payment_amount')
      check(entry.idempotencyKey&&!workerRequests.some(prior=>prior.method==='POST'&&prior.key===entry.idempotencyKey),'duplicate_worker_payment_attempt')
    }
    if(entry.method==='GET'&&entry.path==='/v1/payment_intents')check(entry.fields.get('customer')===providerCustomer.id&&entry.fields.has('created[gte]')&&entry.fields.has('created[lte]'),'unscoped_worker_intent_list')
    workerRequests.push({method:entry.method,path:entry.path,key:entry.idempotencyKey,amountCents:entry.method==='POST'?Number(entry.fields.get('amount')):null,attemptedAt:new Date().toISOString()});await save()
  })
}
async function providerProof(collection,amount){
  const intent=await stripe.request('GET',`/v1/payment_intents/${collection.payment_intent_ref}`)
  const history=await stripe.list('/v1/charges',{customer:providerCustomer.id}),charges=history.data.filter(charge=>reference(charge.payment_intent)===intent.id)
  check(charges.length===1,'exactly_one_charge_per_intent_required')
  const charge=charges[0]
  check(intent.status==='succeeded'&&intent.amount===amount&&intent.amount_received===amount&&intent.currency==='usd'&&intent.livemode===false&&reference(intent.customer)===providerCustomer.id&&reference(intent.payment_method)===method&&reference(intent.latest_charge)===charge.id&&!intent.receipt_email,'actual_intent_proof_mismatch')
  check(charge.id===collection.charge_ref&&charge.status==='succeeded'&&charge.paid===true&&charge.captured===true&&charge.amount===amount&&charge.amount_captured===amount&&charge.amount_refunded===0&&!charge.refunded&&!charge.disputed&&charge.currency==='usd'&&charge.livemode===false&&reference(charge.customer)===providerCustomer.id&&reference(charge.payment_method)===method&&!charge.receipt_email,'actual_captured_charge_proof_mismatch')
  check(date(charge.created*1000)===date(Date.now())&&charge.created*1000<=Date.now(),'actual_capture_date_mismatch')
  const invoice=await api(`invoices/${collection.invoice_id}`),payments=(await api('payments')).filter(payment=>payment.id===collection.payment_id)
  check(invoice.balanceCents===0&&invoice.paidCents===amount&&invoice.allocations.length===1&&invoice.allocations[0].payment_id===collection.payment_id&&invoice.allocations[0].amount_cents===amount,'purchase_not_allocated_exactly_once')
  check(payments.length===1&&payments[0].amount_cents===amount&&payments[0].reference===`stripe:${account.id}:${intent.id}`&&payments[0].method==='card_external','actual_receipt_not_recorded_exactly_once')
  return {invoiceId:invoice.id,paymentId:collection.payment_id,paymentIntentId:intent.id,chargeId:charge.id,amountCents:amount,capturedAt:charge.created*1000,capturedOn:date(charge.created*1000)}
}
async function parity(expectedBalance,expectedLiability){
  const state=await api(`prepaid/${row.subscription}`)
  check(sum(state.balances.map(balance=>balance.remainingN))===expectedBalance&&sum(state.grants.map(grant=>grant.liabilityCents))===expectedLiability,'prepaid_balance_or_paid_liability_mismatch')
  check(state.grants.filter(grant=>grant.source==='promotion').every(grant=>grant.liabilityCents===0),'promotion_entered_paid_liability')
  await prepaidReportParity(h,owner,row);await prepaidRefreshParity(h,owner,row)
  const response=await h.raw(`/app/exports/prepaid/${row.subscription}.csv`,{cookie:owner});check(response.status===200,'prepaid_csv_unavailable')
  const csv=csvRows(await response.text());check(csv.length===state.entries.length,'ledger_csv_entry_count_mismatch')
  for(const entry of state.entries){
    const source=await api(`prepaid/${row.subscription}/entries/${encodeURIComponent(entry.id)}`),exported=csv.find(item=>item.entry_id===entry.id)
    check(source.entry.amountN===entry.amountN&&source.entry.liabilityCents===entry.liabilityCents&&source.entry.recognitionCents===entry.recognitionCents,'prepaid_source_ledger_mismatch')
    check(exported&&csvCents(exported.signed_quantity)===entry.amountN&&csvCents(exported.liability_change)===entry.liabilityCents&&csvCents(exported.recognized)===entry.recognitionCents&&exported.purchase_invoice===(entry.purchaseInvoice??''),'prepaid_csv_values_mismatch')
    if(entry.purchaseInvoice){
      const proof=receipt.purchases.find(purchase=>purchase.invoiceId===entry.purchaseInvoice),grant=state.grants.find(grant=>grant.id===entry.grantId)
      check(proof&&grant?.effectiveDate===proof.capturedOn&&state.grants.filter(grant=>grant.purchaseInvoice===proof.invoiceId).length===1&&source.funding?.payment_id===proof.paymentId&&source.funding.provider_ref===proof.paymentIntentId&&source.funding.amount_cents===proof.amountCents,'ledger_funding_not_backed_by_actual_stripe_receipt')
    }
  }
  return state
}
async function setup(){
  step('create-owned-us-test-customer-without-clock')
  today=date(Date.now())
  check(dayOffset(today,2).slice(0,7)===dayOffset(today,3).slice(0,7),'start_date_cannot_keep_topup_and_cap_in_one_month')
  account=await stripe.request('GET','/v1/account');check(account.object==='account'&&account.country==='US','us_test_account_required')
  receipt.ids.accountId=account.id;await save()
  method=(await stripe.request('POST','/v1/payment_methods',{type:'card','card[token]':'tok_visa'})).id
  receipt.ids.paymentMethodId=method;await save()
  providerCustomer=await stripe.request('POST','/v1/customers',{name:`Nectar prepaid sandbox ${stripe.run}`,payment_method:method,'invoice_settings[default_payment_method]':method,'metadata[nectar_run]':stripe.run})
  receipt.ids.customerId=providerCustomer.id;await save()
  check(!providerCustomer.test_clock&&!providerCustomer.email&&reference(providerCustomer.invoice_settings.default_payment_method)===method,'owned_default_card_not_established')
  receipt.checks.ownedUsTestAccountAndNoEmailCustomer=true
  step('bootstrap-real-worker-owner-finance-and-route')
  const {harness}=await import('./harness.mjs'),{applyPolicy}=await import('./policy-helper.mjs')
  h=await harness({wallTime:true,persistence:join(evidence,'worker'),stripeSecret:process.env.STRIPE_SECRET_KEY,stripeFetch:forward})
  privateState.settings=Object.fromEntries(['SESSION_SECRET','SETUP_TOKEN','MFA_KEY','PORTAL_KEY'].map(key=>[key,h.vars[key]]));await save()
  h.api=safeApi
  check((await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Prepaid Sandbox Owner'}})).status===303,'owner_bootstrap_failed')
  owner=await h.signIn(h.vars.OWNER_EMAIL)
  check((await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})).status===303,'owner_setup_failed')
  await api('business.configure',{legal_name:'Synthetic prepaid sandbox',address:'1 Synthetic Way, CA, US',timezone:'UTC',invoice_prefix:'PREPAID',payment_terms_days:30})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Owned real test-mode prepaid topup; no tax service requested'})
  await api('tax.review',{revision:(await api('business')).revision})
  await api('access.give',{email:['synthetic-nectar-'+stripe.run,'example.test'].join('@'),name:'Synthetic independent finance',role:'finance'})
  finance=await h.signIn(['synthetic-nectar-'+stripe.run,'example.test'].join('@'),{requested:true})
  const started=await api('mfa.totp.start',{});factor=started.secret;verifiedAt=Date.now()
  privateState.factor=factor;await save();await api('mfa.totp.confirm',{factor:started.factor,code:totp(factor,verifiedAt)})
  await api('mfa.policy',{scope:'roles',roles:['owner']})
  const external=`synthetic-nectar-${stripe.run}`,customer=(await api('customer.create',{external_id:external,name:'Synthetic prepaid sandbox customer',billing_email:[external,'example.test'].join('@')})).id
  const entity=(await api('entity.create',{revision:(await api('business')).revision,legal_name:'Synthetic prepaid entity',address:'1 Synthetic Way, CA, US',ein:'12-3456789',invoice_prefix:'PREPAID',invoice_number_width:4,payment_terms_days:30,processor_account_ref:account.id,ledger_company_ref:'synthetic-unconnected-ledger-1',tax_registration:'Synthetic sandbox registration'})).id
  await api('customer.entity',{revision:(await api('business')).revision,customer,entity,confirm:true})
  await api('collection.customer.bind',{customer,account_ref:account.id,stripe_customer_ref:providerCustomer.id,confirm:true})
  const product=(await api('product.create',{code:'synthetic-nectar-701',name:'Synthetic daily prepaid service'})).id
  const meterCode='synthetic-nectar-702',meter=(await api('meter.create',{code:meterCode,name:'Synthetic daily units',unit_label:'units'})).id
  const price=(await api('price.create',{product,meter,kind:'unit',unit_amount:'1',taxable:false,billing_interval:'daily',billing_timing:'arrears'})).id
  const subscription=(await api('subscription.create',{customer,start_date:today,price:[price]})).id
  row={customer,subscription,external,meterCode,entity};privateState.row=row;await save();receipt.ids={...receipt.ids,nativeCustomerId:customer,subscriptionId:subscription,entityId:entity}
  await api('portal.configure',{hosts:[h.origin],parents:[]})
}
async function fundAndAuthorize(){
  step('approved-initial-purchase-real-owner-confirmed-10000-dollar-charge')
  await now()
  const terms={subscription:row.subscription,mode:'grant',kind:'money',source:'purchase',amount:'10000',effective_date:today,expires_date:dayOffset(today,90),priority:10,expiry_consent:true}
  const paid=await api('prepaid.prepare',terms)
  await h.api('prepaid.decide',finance,{request:paid.request,decision:'approved'})
  const purchase=await api('prepaid.purchase.prepare',{intent:paid.request,issue_date:today})
  await api('invoice.approve',{invoice:purchase.invoice,acknowledge:true});await api('invoice.finalise',{invoice:purchase.invoice,issue_date:today})
  await now()
  const prepared=await api('collection.prepare',{invoice:purchase.invoice})
  check(prepared.review.amountCents===1000000&&prepared.review.accountRef===account.id&&prepared.review.customerRef===providerCustomer.id&&prepared.review.paymentMethodRef===method&&!prepared.review.livemode,'initial_exact_owner_review_mismatch')
  const collected=await api('collection.confirm',prepared.instructions.confirm);check(collected.status==='collected','initial_real_purchase_not_collected')
  receipt.purchases=[await providerProof(collected,1000000)]
  fundedOn=receipt.purchases[0].capturedOn;receipt.fundingDate=fundedOn
  const initialPosts=posts();await api('collection.confirm',prepared.instructions.confirm,409)
  check((await api('collection.reconcile',{request:collected.id})).payment_id===collected.payment_id&&posts()===initialPosts,'initial_purchase_replay_created_provider_write')
  const promo=await api('prepaid.prepare',{...terms,source:'promotion',amount:'1000',priority:0,expires_date:dayOffset(today,30)});await h.api('prepaid.decide',finance,{request:promo.request,decision:'approved'})
  await parity(1100000,1000000)
  const consent=await api('prepaid.prepare',{...terms,mode:'consent',amount:'5000',threshold:'1000',funding_consent:true});await h.api('prepaid.decide',finance,{request:consent.request,decision:'approved'})
  step('signed-customer-acceptance-and-independent-exact-policy-approval-before-consumption')
  const authorization=await api('prepaid.topup.prepare',{consent:consent.request,period_cap:'5000',start_date:today,end_date:dayOffset(today,60),account_ref:account.id})
  const session=await api('portal.session.issue',{customer:row.customer,origin:h.origin,audience:'hosted'})
  const quoteResponse=await h.raw(`/portal/prepaid-topups/${authorization.id}?session=${encodeURIComponent(session.token)}`);check(quoteResponse.status===200,'customer_topup_quote_unavailable')
  const quote=await quoteResponse.json()
  check(quote.basis===authorization.basis&&quote.quote.amountCents===500000&&quote.quote.thresholdN===100000&&quote.quote.periodCapCents===500000&&quote.quote.period==='business_calendar_month'&&quote.quote.accountRef===account.id&&quote.quote.customerRef===providerCustomer.id&&quote.quote.paymentMethodRef===method,'customer_exact_topup_quote_mismatch')
  const accepted=await h.raw(`/portal/prepaid-topup.accept?session=${encodeURIComponent(session.token)}`,{body:{authorization:authorization.id,basis_hash:authorization.basis,accept:true}});check(accepted.status===200,'signed_customer_topup_acceptance_failed')
  const financeQuote=(await h.api(`prepaid/topup-authorizations?subscription=${row.subscription}`,finance)).find(item=>item.id===authorization.id)
  check(financeQuote.basis===authorization.basis&&financeQuote.acceptance?.basis===authorization.basis&&financeQuote.quote.amountCents===500000&&financeQuote.quote.periodCapCents===500000,'independent_finance_acceptance_quote_mismatch')
  await h.api('prepaid.topup.decide',finance,{authorization:authorization.id,basis_hash:authorization.basis,decision:'approved'})
  check((await api('prepaid.topup.run',{authorization:authorization.id})).status==='above_threshold'&&posts()===1,'policy_charged_before_balance_crossing')
  receipt.ids.authorizationId=authorization.id;receipt.checks.customerAcceptedExactCardAndCap=true;receipt.checks.independentFinanceApprovedBeforeConsumption=true
  privateState.authorization=authorization;await save();return authorization
}
async function consume(){
  step('issue-only-two-completed-daily-usage-windows')
  const days=[fundedOn,dayOffset(fundedOn,1)],amounts=[6000,4100]
  step('verify-two-funded-service-days-have-genuinely-elapsed')
  await now()
  check(today>=dayOffset(fundedOn,2),'completed_funded_service_days_required')
  check(today.slice(0,7)===dayOffset(today,1).slice(0,7),'topup_and_cap_must_fit_same_month')
  const firstUsage=receipt.purchases[0].capturedAt+1000
  check(date(firstUsage)===fundedOn,'funding_too_close_to_day_boundary')
  await api('usage.submit',{events:days.map((day,index)=>({event_id:`synthetic-nectar-${710+index}`,customer:row.external,meter:row.meterCode,quantity:String(amounts[index]),occurred_at:index===0?new Date(firstUsage).toISOString():`${day}T12:00:00Z`}))})
  const issued=[]
  for(const [index,day] of days.entries()){
    const due=dayOffset(day,1),run=await api('billrun.prepare',{period:due.slice(0,7)}),candidates=(await api(`runs/${run.id}`)).invoices.filter(invoice=>invoice.customer_id===row.customer&&invoice.period_start===day&&invoice.period_end===due)
    check(candidates.length===1,'exact_completed_daily_window_missing')
    const invoice=candidates[0]
    await api('invoice.approve',{invoice:invoice.id,acknowledge:true});await api('invoice.finalise',{invoice:invoice.id,issue_date:today})
    const saved=await api(`invoices/${invoice.id}`)
    check(saved.status==='issued'&&saved.total_cents===0&&saved.period_start===day&&saved.period_end===due&&saved.calculation.inputs.billing.dueDate===due,'completed_daily_invoice_mismatch')
    check(sum(saved.lines.filter(line=>line.kind==='prepaid_drawdown').map(line=>line.amount_cents))===-amounts[index]*100,'daily_usage_drawdown_mismatch')
    issued.push(saved.id)
    await parity(index===0?500000:90000,index===0?500000:90000)
  }
  check(posts()===1,'consumption_sent_unapproved_provider_charge')
  const invoices=(await api(`invoices?customer=${row.customer}`)).data
  check(invoices.filter(invoice=>invoice.customer_id===row.customer&&invoice.status==='issued'&&invoice.invoice_kind==='recurring').length===2,'extra_daily_invoice_was_issued')
  receipt.ids.usageInvoiceIds=issued;receipt.amounts.balanceBeforeTopupCents=90000;receipt.checks.onlyTwoCompletedDailyWindowsIssued=true
}
async function topup(authorization){
  step('actual-automatic-5000-dollar-topup-and-receipt-ledger-parity')
  await now()
  const mailCount=h.mails.length,result=await api('prepaid.topup.run',{authorization:authorization.id})
  check(result.status==='collected','automatic_real_topup_not_collected')
  const claims=await api(`prepaid/topup-claims?subscription=${row.subscription}`)
  check(claims.length===1&&claims[0].id===result.id&&claims[0].status==='collected'&&claims[0].amount_cents===500000,'automatic_crossing_claim_not_exactly_once')
  const proof=await providerProof(result,500000);receipt.purchases.push(proof);receipt.ids.topupClaimId=result.id
  check(proof.paymentIntentId!==receipt.purchases[0].paymentIntentId,'distinct_initial_purchase_and_topup_intents_required')
  const state=await parity(590000,590000)
  check(sum(state.entries.map(entry=>entry.recognitionCents))===910000,'paid_service_recognition_mismatch')
  check(sum(state.grants.filter(grant=>grant.source==='purchase').map(grant=>grant.valueCents))===1500000,'paid_grants_do_not_equal_actual_receipts')
  const before=posts();await api('prepaid.topup.run',{authorization:authorization.id})
  check(posts()===before,'repeat_topup_created_second_intent')
  check((await api('prepaid.topup.reconcile',{claim:result.id})).payment_id===result.payment_id&&posts()===before,'terminal_topup_reconciliation_changed_payment')
  check(posts()===2,'exactly_two_provider_writes_required')
  const actual=await stripe.list('/v1/payment_intents',{customer:providerCustomer.id}),charges=await stripe.list('/v1/charges',{customer:providerCustomer.id})
  check(actual.data.length===2&&charges.data.length===2&&sum(actual.data.map(intent=>intent.amount_received))===1500000,'actual_provider_payment_count_or_amount_mismatch')
  check(h.mails.length===mailCount,'automatic_topup_sent_unrequested_customer_mail')
  await parity(590000,590000)
  receipt.amounts={...receipt.amounts,initialPaidCents:1000000,promotionalCents:100000,usageCents:1010000,automaticTopupCents:500000,totalActualReceiptsCents:1500000,closingBalanceCents:590000,closingPaidLiabilityCents:590000,recognizedPaidCents:910000}
  receipt.checks.actualInitialAndAutomaticCapturedPayments=true;receipt.checks.paidLiabilityAndSourceCsvMatchActualReceipts=true;receipt.checks.sameBalanceReplayNoSecondTopupIntent=true;receipt.checks.noProviderReceiptEmail=true
}
async function resumeWorker(){
  const {harness}=await import('./harness.mjs')
  h=await harness({wallTime:true,persistence:join(evidence,'worker'),applyMigrations:false,settings:privateState.settings,stripeSecret:process.env.STRIPE_SECRET_KEY,stripeFetch:forward})
  h.api=safeApi
  owner=await h.signIn(h.vars.OWNER_EMAIL)
  finance=await h.signIn(['synthetic-nectar-'+stripe.run,'example.test'].join('@'))
  factor=privateState.factor;row=privateState.row;fundedOn=receipt.fundingDate
  // Renew through ordinary email-link sign-in and TOTP. No cookie, portal
  // token or previous factor verification is restored from scratch.
  await now()
  await api('portal.configure',{hosts:[h.origin],parents:[]})
  account={id:receipt.ids.accountId};providerCustomer={id:receipt.ids.customerId};method=receipt.ids.paymentMethodId
  const actualAccount=await stripe.request('GET','/v1/account')
  check(actualAccount.id===account.id&&actualAccount.country==='US','original_us_account_required')
  const actualCustomer=await stripe.request('GET',`/v1/customers/${providerCustomer.id}`)
  check(actualCustomer.metadata?.nectar_run===stripe.run&&!actualCustomer.test_clock,'original_owned_customer_without_clock_required')
}
async function capAndRevoke(){
  step('issue-further-completed-usage-for-a-real-second-crossing')
  await now()
  const first=receipt.purchases[1],serviceDay=first.capturedOn,due=dayOffset(serviceDay,1)
  check(today>=due&&today.slice(0,7)===serviceDay.slice(0,7),'cap_probe_requires_completed_service_in_original_cap_month')
  check(receipt.capUsageAt>=first.capturedAt&&receipt.capUsageAt<=Date.now(),'cap_usage_must_follow_actual_topup')
  const before=posts(),intentsBefore=await stripe.list('/v1/payment_intents',{customer:providerCustomer.id}),chargesBefore=await stripe.list('/v1/charges',{customer:providerCustomer.id})
  await api('usage.submit',{events:[{event_id:`synthetic-nectar-${stripe.run}-cap`,customer:row.external,meter:row.meterCode,quantity:'5000',occurred_at:new Date(receipt.capUsageAt).toISOString()}]})
  const run=await api('billrun.prepare',{period:due.slice(0,7)}),invoices=(await api(`runs/${run.id}`)).invoices.filter(invoice=>invoice.subscription_id===row.subscription&&invoice.period_start===serviceDay&&invoice.period_end===due)
  check(invoices.length===1,'cap_completed_daily_window_missing')
  const invoice=invoices[0]
  await api('invoice.approve',{invoice:invoice.id,acknowledge:true});await api('invoice.finalise',{invoice:invoice.id,issue_date:today})
  const saved=await api(`invoices/${invoice.id}`)
  check(saved.status==='issued'&&saved.total_cents===0&&sum(saved.lines.filter(line=>line.kind==='prepaid_drawdown').map(line=>line.amount_cents))===-500000,'second_crossing_invoice_drawdown_mismatch')
  receipt.ids.capUsageInvoiceId=invoice.id
  await parity(90000,90000)
  const refused=await api('prepaid.topup.run',{authorization:privateState.authorization.id},409)
  check(refused.error==='topup_monthly_cap'&&posts()===before,'second_crossing_must_refuse_at_monthly_cap_without_provider_write')
  receipt.checks.secondGenuineCrossingRefusedAtMonthlyCap=true
  const session=await api('portal.session.issue',{customer:row.customer,origin:h.origin,audience:'hosted'})
  const revoked=await h.raw(`/portal/prepaid-topup.revoke?session=${encodeURIComponent(session.token)}`,{body:{authorization:privateState.authorization.id}})
  check(revoked.status===200,'customer_revocation_failed')
  const revokedRun=await api('prepaid.topup.run',{authorization:privateState.authorization.id},409)
  check(revokedRun.error==='topup_authorization_inactive'&&posts()===before,'revocation_must_refuse_without_provider_write')
  const intents=await stripe.list('/v1/payment_intents',{customer:providerCustomer.id}),charges=await stripe.list('/v1/charges',{customer:providerCustomer.id})
  check(JSON.stringify(intents.data.map(i=>i.id).sort())===JSON.stringify(intentsBefore.data.map(i=>i.id).sort())&&JSON.stringify(charges.data.map(i=>i.id).sort())===JSON.stringify(chargesBefore.data.map(i=>i.id).sort()),'cap_or_revocation_changed_provider_payments')
  const claims=await api(`prepaid/topup-claims?subscription=${row.subscription}`)
  check(claims.length===1&&claims[0].status==='collected','refusal_created_another_claim')
  await parity(90000,90000)
  receipt.checks.customerRevocationNoProviderWrite=true
  receipt.amounts.closingBalanceCents=90000;receipt.amounts.closingPaidLiabilityCents=90000;receipt.amounts.usageCents=1510000;receipt.amounts.recognizedPaidCents=1410000
}
async function cleanup(){
  step('confirmed-owned-test-resource-cleanup')
  const original=await stripe.request('GET','/v1/account')
  check(original.id===receipt.ids.accountId,'cleanup_original_account_required')
  if(receipt.ids.customerId&&!receipt.cleanup.customerDeleted){
    const customer=await stripe.request('GET',`/v1/customers/${receipt.ids.customerId}`)
    if(!customer.deleted){
      check(customer.metadata?.nectar_run===stripe.run&&!customer.test_clock,'cleanup_foreign_customer_refused')
      const deleted=await stripe.request('DELETE',`/v1/customers/${customer.id}`)
      check(deleted.id===customer.id&&deleted.deleted===true,'owned_customer_cleanup_unconfirmed')
    }
    const confirmed=await stripe.request('GET',`/v1/customers/${receipt.ids.customerId}`)
    check(confirmed.deleted===true,'owned_customer_deletion_not_confirmed')
    receipt.cleanup.customerDeleted=true;await save()
  }
  if(receipt.ids.paymentMethodId){
    const card=await stripe.request('GET',`/v1/payment_methods/${receipt.ids.paymentMethodId}`)
    check(card.customer===null,'owned_method_not_detached');receipt.cleanup.methodDetached=true
  }
  receipt.cleanup={...receipt.cleanup,confirmed:true,confirmedAt:new Date().toISOString(),clock:'not created; both systems used wall time'}
  if(h){await h.close();h=null}
  await rm(join(evidence,'worker'),{recursive:true,force:true});privateState={}
}
try{
  await mkdir(evidence,{recursive:true,mode:0o700})
  check(await realpath(evidence)===evidence,'state_directory_symlink_refused');await chmod(evidence,0o700)
  lock=await open(join(evidence,'journey.lock'),'wx',0o600);ownsLock=true
  if(command==='start'){
    let exists=false;try{await readFile(join(evidence,'receipt.json'));exists=true}catch(error){if(error.code!=='ENOENT')throw error}
    check(!exists,'existing_run_refused');writable=true
    receipt.head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
    check(/^[a-f0-9]{40}$/.test(receipt.head),'candidate_head_required')
    check(!execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim(),'clean_committed_candidate_required')
    stripe=stripeSandbox(process.env.STRIPE_SECRET_KEY);receipt.runId=stripe.run;receipt.startedAt=new Date().toISOString()
    await perform('initial_funding_and_authorization',async()=>{await setup();await fundAndAuthorize()})
    await boundary('funded');waitUntil(dayOffset(fundedOn,2))
  }else{
    receipt=JSON.parse(await readFile(join(evidence,'receipt.json'),'utf8'));workerRequests.push(...receipt.workerRequests)
    privateState=JSON.parse(await readFile(join(evidence,'runtime.json'),'utf8'))
    if(command==='status'){console.log(JSON.stringify(receipt,null,2))}
    else{
      stripe=stripeSandbox(process.env.STRIPE_SECRET_KEY,{run:receipt.runId})
      if(command==='cleanup'){
        writable=true;await cleanup();receipt.status=receipt.stage==='qualified'?'passed':'incomplete';receipt.inflight=null
      }else{
        check(receipt.head===execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()&&!execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim(),'original_clean_candidate_required')
        check(!receipt.inflight&&!['failed','incomplete','passed'].includes(receipt.status),'interrupted_or_closed_run_needs_inspection_no_retry')
        check(!receipt.cleanup.confirmed,'cleaned_up_run_cannot_resume')
        writable=true;receipt.status='running'
        await resumeWorker()
        if(receipt.stage==='funded'){
          if(date(Date.now())<dayOffset(fundedOn,2))waitUntil(dayOffset(fundedOn,2))
          else{
            await perform('completed_usage_and_topup',async()=>{await consume();await topup(privateState.authorization)})
            receipt.capUsageAt=Date.now()
            check(date(receipt.capUsageAt)===receipt.purchases[1].capturedOn,'topup_too_close_to_service_day_boundary')
            await boundary('topped_up');waitUntil(dayOffset(receipt.purchases[1].capturedOn,1))
          }
        }else if(receipt.stage==='topped_up'){
          const due=dayOffset(receipt.purchases[1].capturedOn,1)
          if(date(Date.now())<due)waitUntil(due)
          else{await perform('second_crossing_and_revocation',capAndRevoke);await boundary('qualified');await cleanup();receipt.status='passed';receipt.incompleteReason=null;receipt.nextEligibleAt=null}
        }else throw new SandboxFailure('unknown_persistent_stage')
      }
    }
  }
}catch(error){
  if(writable){receipt.status='failed';receipt.failure={phase,...safeError(error)}}
  process.exitCode=1
  console.error(`Prepaid real time: failed phase=${phase} code=${safeError(error).code} status=${safeError(error).status??'none'}`)
}finally{
  if(h)try{await h.close()}catch(error){receipt.status='failed';receipt.runtimeCleanup=safeError(error);process.exitCode=1}
  if(ownsLock){
    if(writable)await save();await lock.close();await rm(join(evidence,'journey.lock'))
    console.log(`Prepaid real time: ${receipt.status}; stage=${receipt.stage??'initializing'}; receipt=${join(evidence,'receipt.json')}`)
  }
}
