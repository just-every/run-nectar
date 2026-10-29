// Customer-confirmed capture is separate from historical method observations.
import type { Bindings } from '../auth.server'
import { actorLabel, type Actor } from './actor'
import { all, commit, guard, insist, newId, one, parseJson, stmt, type Row } from './core'
import { clockInstant } from './clock'
import type { Input } from './input'
import { setupOwner, setupOwnerFence, setupSessionFence } from './hosted-setup-basis'
import { setupConsent } from './hosted-setup-consent'
import { createSetupReturn, setupReturnGuard, consumeSetupReturn, type SetupReturn } from './hosted-setup-return'
import type { CustomerSession } from './portal-session'
import { providerReference, providerUnavailable, stripeForAccount } from './payments/stripe'
import { createHostedSetup, readHostedSetup, setHostedDefault, expiredHostedSetup } from './payments/hosted-setup'

export async function prepareHostedSetup(env: Bindings, actor: Actor, input: Input) {
  const factor=await setupOwner(env, actor)
  input.only(['customer','binding','method','confirm','returnTo'])
  insist(input.flag('confirm'), 'hosted_setup_confirmation_required')
  const method = input.text('method'), customer = input.text('customer'), binding = input.text('binding')
  insist(['card','us_bank_account'].includes(method), 'invalid_payment_method')
  const row = await one(env, `SELECT b.*,c.currency,c.revision AS customer_revision FROM nc_stripe_customer_bindings b JOIN nc_customers c ON c.id=b.customer_id
    WHERE b.id=? AND b.customer_id=? AND c.erased_at IS NULL AND c.status='active'
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (b.id,c.id))`, binding, customer)
  insist(row, 'native_customer_binding_required', 409)
  insist(!await one(env,"SELECT 1 FROM nc_hosted_setup_history WHERE customer_id=? AND status NOT IN ('complete','failed') AND NOT EXISTS(SELECT 1 FROM nc_hosted_setups WHERE id=nc_hosted_setup_history.id)",customer),'hosted_setup_historical_uncertainty',409)
  insist(method !== 'us_bank_account' || row.currency === 'USD', 'ach_usd_required', 409)
  const { stripe } = await stripeForAccount(env, row.account_ref).catch(providerUnavailable)
  const source = await stripe(`/customers/${encodeURIComponent(row.stripe_customer_ref)}`).catch(providerUnavailable)
  insist(source.object === 'customer' && source.id === row.stripe_customer_ref && !source.deleted && typeof source.livemode === 'boolean', 'stripe_customer_evidence_invalid', 409)
  // This capture door is confined to the approved test-mode setup slice.
  insist(source.livemode === false, 'hosted_setup_test_mode_required', 409)
  insist(!await one(env,"SELECT 1 FROM nc_portal_method_action_history WHERE account_ref=? AND customer_ref=? AND status='uncertain'",row.account_ref,row.stripe_customer_ref),'portal_method_uncertain',409)
  const id = newId()
  await commit(env, [...setupOwnerFence(env, actor),
    guard(env, 'hosted_setup_source_changed', `EXISTS(SELECT 1 FROM nc_stripe_customer_bindings b JOIN nc_customers c ON c.id=b.customer_id WHERE b.id=? AND b.revision=? AND c.id=? AND c.revision=? AND c.erased_at IS NULL AND c.status='active' AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(b.id,c.id)))`, binding, row.revision, customer, row.customer_revision),
    stmt(env, `INSERT INTO nc_hosted_setups(id,customer_id,binding_id,binding_revision,method,status,livemode,created_by,created_at,customer_revision,account_ref,customer_ref,factor_ref,factor_verified_at,owner_session_id) VALUES(?,?,?,?,?,'prepared',0,?,?,?,?,?,?,?,?)`, id, customer, binding, row.revision, method, actor.id, clockInstant(env),row.customer_revision,row.account_ref,row.stripe_customer_ref,factor.reference,factor.verifiedAt,actor.sessionId),
  ], { actor: actorLabel(actor), action: 'checkout.setup.prepare', subject: id, detail: { customer, method, testMode: true, account:row.account_ref, sourceRevision:row.customer_revision, factorVerification:factor.reference, factorVerifiedAt:factor.verifiedAt } })
  return { id, customer, method, status: 'prepared' }
}

export async function customerHostedSetups(env: Bindings, customer: string) {
  const rows=await all(env, `SELECT s.id,s.method,s.status,s.method_json,s.completed_at,s.default_choice,s.consent_hash,0 AS historical FROM nc_hosted_setups s JOIN nc_customers c ON c.id=s.customer_id
    JOIN nc_stripe_customer_bindings b ON b.id=s.binding_id AND b.revision=s.binding_revision
    WHERE s.customer_id=? AND c.erased_at IS NULL AND c.status='active'
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (s.id,c.id,b.id))
    UNION ALL SELECT h.id,h.method,h.status,h.method_json,h.completed_at,h.default_choice,h.consent_hash,1 FROM nc_hosted_setup_history h JOIN nc_customers c ON c.id=h.customer_id
    WHERE h.customer_id=? AND c.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM nc_hosted_setups WHERE id=h.id)
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(h.id,c.id)) ORDER BY 5,1`, customer,customer)
  return rows.map(row=>{
    insist(['card','us_bank_account'].includes(row.method)&&['prepared','creating','open','updating','complete','failed'].includes(row.status),'hosted_setup_evidence_invalid',409)
    let paymentMethod=null
    if(row.method_json){
      const value=parseJson<Row>(row.method_json,{})
      insist(value.kind===row.method&&typeof value.last4==='string'&&/^\d{4}$/.test(value.last4),'hosted_setup_evidence_invalid',409)
      const methodRef=providerReference(value.methodRef)
      // Older retained evidence may lack these facts. Absence stays unknown;
      // neither restore nor a historical read invents provider acceptance.
      const setupIntentRef=value.setupIntentRef==null?null:providerReference(value.setupIntentRef)
      if(row.method==='card'){
        insist(['amex','cartes_bancaires','diners','discover','eftpos_au','interac','jcb','link','mastercard','unionpay','visa','unknown'].includes(value.brand)
          &&Number.isSafeInteger(value.expMonth)&&value.expMonth>=1&&value.expMonth<=12&&Number.isSafeInteger(value.expYear)&&value.expYear>=2000&&value.expYear<=9999,'hosted_setup_evidence_invalid',409)
        paymentMethod={methodRef,setupIntentRef,kind:'card',brand:value.brand,last4:value.last4,expMonth:value.expMonth,expYear:value.expYear,bankName:null,accountType:null,mandateRef:null,mandateText:null,mandateTextVersion:null,mandateStatus:null,mandateAcceptedAt:null,mandateAcceptanceType:null}
      }else{
        insist(typeof value.bankName==='string'&&value.bankName.trim().length>0&&value.bankName.length<=100&&!/[\u0000-\u001f\u007f]|\d{12}/.test(value.bankName)&&['checking','savings'].includes(value.accountType),'hosted_setup_evidence_invalid',409)
        const mandateStatus=value.mandateStatus??null,mandateAcceptedAt=value.mandateAcceptedAt??null,mandateAcceptanceType=value.mandateAcceptanceType??null
        insist((mandateStatus===null||mandateStatus==='active')&&(mandateAcceptedAt===null||Number.isSafeInteger(mandateAcceptedAt)&&mandateAcceptedAt>0)
          &&(mandateAcceptanceType===null||mandateAcceptanceType==='online'),'hosted_setup_evidence_invalid',409)
        paymentMethod={methodRef,setupIntentRef,kind:'us_bank_account',brand:null,last4:value.last4,expMonth:null,expYear:null,bankName:value.bankName,accountType:value.accountType,mandateRef:providerReference(value.mandateRef),mandateText:null,mandateTextVersion:null,mandateStatus,mandateAcceptedAt,mandateAcceptanceType}
      }
    }
    return {id:row.id,method:row.method,status:row.status,paymentMethod,completedAt:row.completed_at,defaultChoice:row.default_choice===1,consentHash:row.consent_hash,historical:row.historical===1,debitAuthority:false}
  })
}
export async function operateHostedSetup(env: Bindings, session: CustomerSession, input: Input, operation: 'start' | 'finish' | 'reconcile', capability: SetupReturn | null = null, onCookie: (cookie:string)=>void = ()=>{}) {
  input.only(['setup','confirm','make_default','consent_hash'])
  insist(session.audience === 'hosted', 'hosted_session_required', 403)
  insist(input.flag('confirm'), 'hosted_setup_confirmation_required')
  const row = await one(env, `SELECT s.*,b.stripe_customer_ref FROM nc_hosted_setups s
    JOIN nc_stripe_customer_bindings b ON b.id=s.binding_id AND b.revision=s.binding_revision AND b.account_ref=s.account_ref AND b.stripe_customer_ref=s.customer_ref
    JOIN nc_customers c ON c.id=s.customer_id AND c.revision=s.customer_revision WHERE s.id=? AND s.customer_id=? AND c.erased_at IS NULL AND c.status='active'
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (s.id,c.id,b.id))`, input.text('setup'), session.customer)
  insist(row, 'hosted_setup_not_found', 404)
  const by = `customer:portal:${session.customer}`
  const { stripe } = await stripeForAccount(env,row.account_ref).catch(providerUnavailable)
  const source=await stripe(`/customers/${encodeURIComponent(row.customer_ref)}`).catch(providerUnavailable)
  insist(source.object==='customer' && source.id===row.customer_ref && !source.deleted && source.livemode===false && row.livemode===0,'hosted_setup_evidence_mismatch',409)
  if (operation === 'start') {
    insist(row.status === 'prepared', 'hosted_setup_already_started', 409)
    const consent=await setupConsent(env,session,row.method),wantsDefault=input.flag('make_default'),at=clockInstant(env)
    insist(input.text('consent_hash')===consent.hash,'hosted_setup_consent_changed',409)
    const previous=source.invoice_settings?.default_payment_method
    const previousRef=previous?providerReference(previous):null
    const returned=await createSetupReturn(env,session,row.id,row.account_ref,false)
    onCookie(returned.cookie)
    await commit(env,[setupSessionFence(env,session,row,'prepared'),stmt(env,"UPDATE nc_hosted_setups SET status='creating',consent_json=?,consent_hash=?,accepted_at=?,default_choice=?,previous_default_ref=? WHERE id=?",JSON.stringify(consent.wording),consent.hash,at,wantsDefault?1:0,previousRef,row.id),stmt(env,"INSERT INTO nc_hosted_setup_history(id,customer_id,method,status,consent_json,consent_hash,accepted_at,default_choice,previous_default_ref,account_ref,customer_ref) VALUES(?,?,?,'creating',?,?,?,?,?,?,?)",row.id,row.customer_id,row.method,JSON.stringify(consent.wording),consent.hash,at,wantsDefault?1:0,previousRef,row.account_ref,row.customer_ref)],{actor:by,action:'checkout.setup.start',subject:row.id,detail:{customer:session.customer,wording:consent.wording,wordingHash:consent.hash,defaultChoice:wantsDefault,account:row.account_ref,testMode:true,acceptedAt:at}})
    // A lost create response is reconciled by the original claim, never repeated.
    const created = await createHostedSetup(stripe,{id:row.id,customerRef:row.customer_ref,method:row.method,language:session.language,currency:session.currency,returnUrl:`${session.origin}/portal/payment-methods`}).catch(providerUnavailable)
    await commit(env,[setupSessionFence(env,session,row,'creating'),stmt(env,"UPDATE nc_hosted_setups SET status='open',session_ref=? WHERE id=?",created.sessionRef,row.id),stmt(env,"UPDATE nc_hosted_setup_history SET status='open',session_ref=? WHERE id=?",created.sessionRef,row.id)],{actor:by,action:'checkout.setup.open',subject:row.id,detail:{sessionRef:created.sessionRef,account:row.account_ref,testMode:true}})
    return { id:row.id, status:'open', url:created.url }
  }
  insist(capability && capability.setup===row.id && capability.session.jti===session.jti,'hosted_setup_return_required',401)
  const fence=()=>setupReturnGuard(env,capability.hash,row.id,session)
  if(operation==='reconcile' && row.status==='creating') {
    const params=new URLSearchParams({customer:row.customer_ref,limit:'100'})
    const listed=await stripe(`/checkout/sessions?${params}`).catch(providerUnavailable)
    insist(listed.object==='list' && Array.isArray(listed.data) && listed.has_more===false,'hosted_setup_uncertain',409)
    const matches=listed.data.filter((item:Row)=>item.metadata?.nectar_setup_id===row.id)
    insist(matches.length===1,'hosted_setup_uncertain',409)
    const found=matches[0]
    insist(found.object==='checkout.session' && found.mode==='setup' && providerReference(found.customer)===row.customer_ref && found.livemode===false,'hosted_setup_evidence_mismatch',409)
    const sessionRef=providerReference(found.id)
    let destination:URL
    try{destination=new URL(found.url)}catch{insist(false,'hosted_setup_uncertain',409)}
    insist(destination.protocol==='https:' && destination.hostname==='checkout.stripe.com' && !destination.username && !destination.password && !destination.port,'hosted_setup_evidence_mismatch',409)
    await commit(env,[setupSessionFence(env,session,row,'creating'),fence(),stmt(env,"UPDATE nc_hosted_setups SET status='open',session_ref=? WHERE id=?",sessionRef,row.id),stmt(env,"UPDATE nc_hosted_setup_history SET status='open',session_ref=? WHERE id=?",sessionRef,row.id)],{actor:by,action:'checkout.setup.reconcile',subject:row.id,detail:{sessionRef,outcome:'open'}})
    return {id:row.id,status:'open',url:destination.href}
  }
  insist(['open','updating'].includes(row.status),'hosted_setup_unavailable',409)
  if(operation==='reconcile' && row.status==='open') {
    const expired=await expiredHostedSetup(stripe,{id:row.id,customerRef:row.customer_ref,method:row.method,sessionRef:row.session_ref}).catch(providerUnavailable)
    insist(expired,'hosted_setup_pending',409)
    await commit(env,[setupSessionFence(env,session,row,'open'),fence(),consumeSetupReturn(env,capability.hash),stmt(env,"UPDATE nc_hosted_setups SET status='failed' WHERE id=?",row.id),stmt(env,"UPDATE nc_hosted_setup_history SET status='failed' WHERE id=?",row.id)],{actor:by,action:'checkout.setup.expired',subject:row.id,detail:{customer:session.customer,account:row.account_ref,sessionRef:row.session_ref,outcome:'expired-with-no-completable-intent'}})
    return {id:row.id,status:'failed'}
  }
  const method=await readHostedSetup(stripe,{id:row.id,sessionRef:row.session_ref,customerRef:row.customer_ref,method:row.method,livemode:false}).catch(providerUnavailable)
  const providerFacts={methodRef:method.methodRef,setupIntentRef:method.setupIntentRef,mandateRef:method.mandateRef,mandateStatus:method.mandateStatus,mandateAcceptedAt:method.mandateAcceptedAt,mandateAcceptanceType:method.mandateAcceptanceType}
  const reconciled=row.status==='updating'
  if(reconciled) {
    insist(operation==='reconcile' && source.invoice_settings?.default_payment_method===method.methodRef,'hosted_setup_uncertain',409)
  } else {
    insist(operation==='finish','hosted_setup_pending',409)
    if(row.default_choice===1) {
      const current=source.invoice_settings?.default_payment_method
      insist((current?providerReference(current):null)===row.previous_default_ref,'hosted_setup_default_changed',409)
      // Durable claim before the one default POST. Lost responses are read back.
      await commit(env,[setupSessionFence(env,session,row,'open'),fence(),stmt(env,"UPDATE nc_hosted_setups SET status='updating',method_json=? WHERE id=?",JSON.stringify(method),row.id),stmt(env,"UPDATE nc_hosted_setup_history SET status='updating',method_json=? WHERE id=?",JSON.stringify(method),row.id)],{actor:by,action:'checkout.setup.default',subject:row.id,detail:{customer:session.customer,...providerFacts,previous:row.previous_default_ref,selected:method.methodRef,account:row.account_ref,testMode:true}})
      await setHostedDefault(stripe,row.customer_ref,method.methodRef,row.id).catch(providerUnavailable)
    }
  }
  const at=clockInstant(env),status=reconciled||row.default_choice===1?'updating':'open'
  await commit(env,[setupSessionFence(env,session,row,status),fence(),consumeSetupReturn(env,capability.hash),
    stmt(env,"UPDATE nc_hosted_setups SET status='complete',method_json=?,completed_at=? WHERE id=?",JSON.stringify(method),at,row.id),
    stmt(env,"UPDATE nc_hosted_setup_history SET status='complete',method_json=?,completed_at=? WHERE id=?",JSON.stringify(method),at,row.id),
  ],{actor:by,action:reconciled?'checkout.setup.reconciled':'checkout.setup.complete',subject:row.id,detail:{customer:session.customer,...providerFacts,defaultChoice:!!row.default_choice,previous:row.previous_default_ref,selected:row.default_choice?method.methodRef:row.previous_default_ref,account:row.account_ref,testMode:true}})
  return { id:row.id, status:'complete' }
}
