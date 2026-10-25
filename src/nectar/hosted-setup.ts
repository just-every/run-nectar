// Customer-confirmed capture is separate from historical method observations.
import type { Bindings } from '../auth.server'
import { actorLabel, type Actor } from './actor'
import { all, commit, guard, insist, newId, one, parseJson, stmt, type Row } from './core'
import { clockInstant } from './clock'
import type { Input } from './input'
import { collectionAuthority, collectionOwner } from './movein/collection-state'
import type { CustomerSession } from './portal-session'
import { providerReference, providerUnavailable, stripeForAccount } from './payments/stripe'
import { createHostedSetup, readHostedSetup, setHostedDefault } from './payments/hosted-setup'

export async function prepareHostedSetup(env: Bindings, actor: Actor, input: Input) {
  await collectionOwner(env, actor)
  input.only(['customer','binding','method','confirm','returnTo'])
  insist(input.flag('confirm'), 'hosted_setup_confirmation_required')
  const method = input.text('method'), customer = input.text('customer'), binding = input.text('binding')
  insist(['card','us_bank_account'].includes(method), 'invalid_payment_method')
  const row = await one(env, `SELECT b.*,c.currency FROM nc_stripe_customer_bindings b JOIN nc_customers c ON c.id=b.customer_id
    WHERE b.id=? AND b.customer_id=? AND c.erased_at IS NULL AND c.status='active'
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (b.id,c.id))`, binding, customer)
  insist(row, 'native_customer_binding_required', 409)
  insist(method !== 'us_bank_account' || row.currency === 'USD', 'ach_usd_required', 409)
  const { stripe } = await stripeForAccount(env, row.account_ref).catch(providerUnavailable)
  const source = await stripe(`/customers/${encodeURIComponent(row.stripe_customer_ref)}`).catch(providerUnavailable)
  insist(source.object === 'customer' && source.id === row.stripe_customer_ref && !source.deleted && typeof source.livemode === 'boolean', 'stripe_customer_evidence_invalid', 409)
  // This first capture slice is confined to test mode until its policy is ruled.
  insist(source.livemode === false, 'hosted_setup_test_mode_required', 409)
  const id = newId()
  await commit(env, [collectionAuthority(env, actor),
    guard(env, 'hosted_setup_source_changed', `EXISTS(SELECT 1 FROM nc_stripe_customer_bindings b JOIN nc_customers c ON c.id=b.customer_id WHERE b.id=? AND b.revision=? AND c.id=? AND c.erased_at IS NULL AND c.status='active' AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(b.id,c.id)))`, binding, row.revision, customer),
    stmt(env, `INSERT INTO nc_hosted_setups(id,customer_id,binding_id,binding_revision,method,status,livemode,created_by,created_at) VALUES(?,?,?,?,?,'prepared',0,?,?)`, id, customer, binding, row.revision, method, actor.id, clockInstant(env)),
  ], { actor: actorLabel(actor), action: 'checkout.setup.prepare', subject: id, detail: { customer, method, testMode: true } })
  return { id, customer, method, status: 'prepared' }
}

export async function customerHostedSetups(env: Bindings, customer: string) {
  const rows=await all(env, `SELECT s.id,s.method,s.status,s.method_json,s.completed_at FROM nc_hosted_setups s JOIN nc_customers c ON c.id=s.customer_id
    JOIN nc_stripe_customer_bindings b ON b.id=s.binding_id AND b.revision=s.binding_revision
    WHERE s.customer_id=? AND c.erased_at IS NULL AND c.status='active'
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (s.id,c.id,b.id)) ORDER BY s.created_at,s.id`, customer)
  return rows.map(row=>{
    insist(['card','us_bank_account'].includes(row.method)&&['prepared','creating','open','updating','complete'].includes(row.status),'hosted_setup_evidence_invalid',409)
    let paymentMethod=null
    if(row.method_json){
      const value=parseJson<Row>(row.method_json,{})
      insist(value.kind===row.method&&typeof value.last4==='string'&&/^\d{4}$/.test(value.last4),'hosted_setup_evidence_invalid',409)
      const methodRef=providerReference(value.methodRef)
      if(row.method==='card'){
        insist(['amex','cartes_bancaires','diners','discover','eftpos_au','interac','jcb','link','mastercard','unionpay','visa','unknown'].includes(value.brand)
          &&Number.isSafeInteger(value.expMonth)&&value.expMonth>=1&&value.expMonth<=12&&Number.isSafeInteger(value.expYear)&&value.expYear>=2000&&value.expYear<=9999,'hosted_setup_evidence_invalid',409)
        paymentMethod={methodRef,kind:'card',brand:value.brand,last4:value.last4,expMonth:value.expMonth,expYear:value.expYear,bankName:null,accountType:null,mandateRef:null,mandateText:null}
      }else{
        insist(typeof value.bankName==='string'&&value.bankName.trim().length>0&&value.bankName.length<=100&&!/[\u0000-\u001f\u007f]|\d{12}/.test(value.bankName)&&['checking','savings'].includes(value.accountType),'hosted_setup_evidence_invalid',409)
        paymentMethod={methodRef,kind:'us_bank_account',brand:null,last4:value.last4,expMonth:null,expYear:null,bankName:value.bankName,accountType:value.accountType,mandateRef:providerReference(value.mandateRef),mandateText:null}
      }
    }
    return {id:row.id,method:row.method,status:row.status,paymentMethod,completedAt:row.completed_at}
  })
}
function sessionFence(env: Bindings, session: CustomerSession, row: Row, status: string) {
  return guard(env, 'hosted_setup_source_changed', `EXISTS(SELECT 1 FROM nc_hosted_setups s JOIN nc_customers c ON c.id=s.customer_id
    JOIN nc_stripe_customer_bindings b ON b.id=s.binding_id AND b.revision=s.binding_revision
    JOIN nc_portal_sessions p ON p.customer_id=c.id JOIN nc_portal_policy policy ON policy.singleton=1 AND policy.revision=p.policy_revision
    WHERE s.id=? AND s.status=? AND s.customer_id=? AND c.erased_at IS NULL AND c.status='active' AND p.id=? AND p.revoked_at IS NULL AND p.expires_at>?
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (s.id,c.id,b.id)))`, row.id,status,session.customer,session.jti,clockInstant(env))
}
export async function operateHostedSetup(env: Bindings, session: CustomerSession, input: Input, operation: 'start' | 'finish') {
  input.only(['setup','confirm'])
  insist(session.audience === 'hosted', 'hosted_session_required', 403)
  insist(input.flag('confirm'), 'hosted_setup_confirmation_required')
  const row = await one(env, `SELECT s.*,b.account_ref,b.stripe_customer_ref FROM nc_hosted_setups s
    JOIN nc_stripe_customer_bindings b ON b.id=s.binding_id AND b.revision=s.binding_revision
    JOIN nc_customers c ON c.id=s.customer_id WHERE s.id=? AND s.customer_id=? AND c.erased_at IS NULL AND c.status='active'
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (s.id,c.id,b.id))`, input.text('setup'), session.customer)
  insist(row, 'hosted_setup_not_found', 404)
  if (operation === 'finish' && row.status === 'complete') return { id: row.id, status: 'complete' }
  const by = `customer:portal:${session.customer}`
  const { stripe } = await stripeForAccount(env,row.account_ref).catch(providerUnavailable)
  if (operation === 'start') {
    insist(row.status === 'prepared', 'hosted_setup_already_started', 409)
    await commit(env,[sessionFence(env,session,row,'prepared'),stmt(env,"UPDATE nc_hosted_setups SET status='creating' WHERE id=?",row.id)],{actor:by,action:'checkout.setup.start',subject:row.id,detail:{customer:session.customer}})
    // No repeat provider POST after a lost response. A new session is never guessed.
    const created = await createHostedSetup(stripe,{id:row.id,customerRef:row.stripe_customer_ref,method:row.method,language:session.language,currency:session.currency,returnUrl:`${session.origin}/portal/payment-methods`}).catch(providerUnavailable)
    await commit(env,[sessionFence(env,session,row,'creating'),stmt(env,"UPDATE nc_hosted_setups SET status='open',session_ref=? WHERE id=?",created.sessionRef,row.id)],{actor:by,action:'checkout.setup.open',subject:row.id})
    return { id:row.id, status:'open', url:created.url }
  }
  insist(row.status === 'open', 'hosted_setup_unavailable', 409)
  const method = await readHostedSetup(stripe,{id:row.id,sessionRef:row.session_ref,customerRef:row.stripe_customer_ref,method:row.method,livemode:!!row.livemode}).catch(providerUnavailable)
  // Reserve before changing the default. An uncertain update is never reissued.
  await commit(env,[sessionFence(env,session,row,'open'),stmt(env,"UPDATE nc_hosted_setups SET status='updating',method_json=? WHERE id=?",JSON.stringify(method),row.id)],{actor:by,action:'checkout.setup.default',subject:row.id,detail:{customer:session.customer,method:method.kind}})
  await setHostedDefault(stripe,row.stripe_customer_ref,method.methodRef,row.id).catch(providerUnavailable)
  await commit(env,[sessionFence(env,session,row,'updating'),stmt(env,"UPDATE nc_hosted_setups SET status='complete',completed_at=? WHERE id=?",clockInstant(env),row.id)],{actor:by,action:'checkout.setup.complete',subject:row.id,detail:{customer:session.customer,method:method.kind}})
  return { id:row.id, status:'complete' }
}
