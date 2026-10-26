import { customerText } from './locale'
// Explicit customer choices over completed hosted setup, never debit authority.
import type { Bindings } from '../auth.server'
import { actorLabel, type Actor } from './actor'
import { clockInstant } from './clock'
import { all, commit, fingerprint, guard, insist, newId, one, stmt, type Row } from './core'
import { customerHostedSetups } from './hosted-setup'
import { setupOwner, setupOwnerFence } from './hosted-setup-basis'
import type { Input } from './input'
import { STEP_UP_MS } from './mfa'
import { providerReference, providerUnavailable, stripeForAccount, type StripeClient } from './payments/stripe'
import { PORTAL_LIFETIME, type CustomerSession } from './portal-session'

const source = `FROM nc_portal_method_actions a
 JOIN nc_customers c ON c.id=a.customer_id
 JOIN nc_stripe_customer_bindings b ON b.id=a.binding_id AND b.customer_id=c.id
 JOIN nc_hosted_setups s ON s.id=a.setup_id AND s.customer_id=c.id AND s.binding_id=b.id`
const current = `c.status='active' AND c.erased_at IS NULL AND c.revision=a.customer_revision
 AND b.revision=a.binding_revision AND b.account_ref=a.account_ref AND b.stripe_customer_ref=a.customer_ref
 AND s.status='complete' AND s.livemode=0 AND s.binding_revision=a.binding_revision AND s.account_ref=a.account_ref AND s.customer_ref=a.customer_ref
 AND s.method_json=a.method_json AND a.livemode=0
 AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(a.id,c.id,b.id,s.id))`
const liveOwner = `a.factor_verified_at BETWEEN ? AND ? AND EXISTS(
 SELECT 1 FROM oa_sessions os JOIN oa_operators oo ON oo.id=os.operator_id
 JOIN nc_members om ON om.email=lower(oo.email) JOIN nc_mfa_sessions f ON f.session_id=os.id AND f.member_id=om.id
 WHERE os.id=a.owner_session_id AND om.id=a.created_by AND om.role='owner' AND om.status='active'
 AND oo.role='owner' AND oo.status='active' AND oo.version=os.operator_version AND os.revoked_at IS NULL
 AND os.expires_at>CAST(strftime('%s','now') AS INTEGER)*1000 AND f.method IN ('totp','passkey')
 AND f.verified_at>=a.factor_verified_at AND f.verified_at BETWEEN ? AND ?)`
const portal = `EXISTS(SELECT 1 FROM nc_portal_sessions p JOIN nc_portal_policy policy ON policy.singleton=1 AND policy.revision=p.policy_revision
 WHERE p.id=? AND p.customer_id=? AND p.origin=? AND p.audience='hosted' AND p.parent_origin=''
 AND p.issued_at=? AND p.expires_at=? AND p.issued_at<=? AND p.expires_at>? AND p.expires_at-p.issued_at=?
 AND p.revoked_at IS NULL AND EXISTS(SELECT 1 FROM json_each(policy.hosts_json) WHERE value=p.origin)
 AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=p.id))`
const portalParams = (session: CustomerSession, at: number) => [session.jti,session.customer,session.origin,session.iat,session.exp,at,at,PORTAL_LIFETIME]
const ownerParams = (at: number) => [at-STEP_UP_MS,at,at-STEP_UP_MS,at]

function sessionShape(env: Bindings, session: CustomerSession) {
  insist(session.v===1 && session.iss===env.AUTH_ORIGIN && session.audience==='hosted' && session.parent==='', 'hosted_session_required',403)
}
function actionFence(env: Bindings, session: CustomerSession, row: Row, status: string) {
  const at=clockInstant(env)
  return guard(env,'portal_method_source_changed',`EXISTS(SELECT 1 ${source} WHERE a.id=? AND a.customer_id=? AND a.status=? AND ${current} AND ${liveOwner}) AND ${portal}`,
    row.id,session.customer,status,...ownerParams(at),...portalParams(session,at))
}

// Include pending and uncertain attempts: a method cannot be detached while an
// already accepted debit could still complete. Historical cash is never edited.
const noAuthority = `NOT EXISTS(SELECT 1 FROM nc_automatic_collections x
 WHERE x.account_ref=? AND x.stripe_customer_ref=? AND x.payment_method_ref=?
 AND (x.status IN ('claimed','uncertain','pending_settlement') OR
 (x.status IN ('awaiting_customer','pending_approval','active') AND EXISTS(SELECT 1 FROM nc_automatic_collection_authorizations z WHERE z.id=x.id AND z.basis_hash=x.basis_hash))))
 AND NOT EXISTS(SELECT 1 FROM nc_prepaid_topup_authorizations t
 WHERE json_extract(t.quote_json,'$.accountRef')=? AND json_extract(t.quote_json,'$.customerRef')=? AND json_extract(t.quote_json,'$.paymentMethodRef')=?
 AND (t.status IN ('awaiting_customer','pending','active') OR EXISTS(SELECT 1 FROM nc_prepaid_topup_claims x WHERE x.authorization_id=t.id AND x.status IN ('reserved','issued','claimed','uncertain'))))
 AND NOT EXISTS(SELECT 1 FROM nc_native_collections n WHERE n.account_ref=? AND n.stripe_customer_ref=? AND n.payment_method_ref=? AND n.status IN ('pending','claimed','uncertain'))
 AND NOT EXISTS(SELECT 1 FROM nc_trial_collections t WHERE json_extract(t.quote_json,'$.accountRef')=? AND json_extract(t.quote_json,'$.customerRef')=?
 AND json_extract(t.quote_json,'$.paymentMethodRef')=? AND t.status IN ('pending_owner','pending_approval','active','claimed','uncertain'))`
const authorityParams = (row: Row) => Array.from({length:4},()=>[row.account_ref,row.customer_ref,row.method_ref]).flat()
function removalFence(env: Bindings, row: Row) {
  return guard(env,'portal_method_collection_authority',noAuthority,...authorityParams(row))
}
async function noRemovalAuthority(env: Bindings, row: Row) {
  insist(await one(env,`SELECT 1 WHERE ${noAuthority}`,...authorityParams(row)),'portal_method_collection_authority',409)
}
function defaultRef(customer: Row) {
  insist(customer.invoice_settings && Object.hasOwn(customer.invoice_settings,'default_payment_method'),'portal_method_evidence_mismatch',409)
  const value=customer.invoice_settings.default_payment_method
  return value===null?null:providerReference(value)
}
async function readCustomer(stripe: StripeClient, row: Row) {
  const customer=await stripe(`/customers/${encodeURIComponent(row.customer_ref)}`).catch(providerUnavailable)
  insist(customer.object==='customer' && customer.id===row.customer_ref && !customer.deleted && customer.livemode===false,'portal_method_evidence_mismatch',409)
  return {customer,defaultMethod:defaultRef(customer)}
}
function verifyMethod(method: Row, row: Row, detached=false) {
  insist(method.object==='payment_method' && method.id===row.method_ref && method.livemode===false
    && method.type===row.method && (detached?method.customer===null:providerReference(method.customer)===row.customer_ref),'portal_method_evidence_mismatch',409)
}
function view(row: Row, historical=false) {
  return {id:row.id,customer:row.customer_id,setup:row.setup_id,operation:row.operation,status:row.status,
    methodRef:row.method_ref,previousDefaultRef:row.previous_default_ref,createdAt:row.created_at,
    acceptedAt:row.accepted_at,completedAt:row.completed_at,historical,debitAuthority:false}
}

export async function methodActionConsent(env: Bindings, session: CustomerSession, operation: string) {
  const merchant=await one(env,'SELECT legal_name FROM nc_business WHERE singleton=1')
  insist(merchant?.legal_name,'business_identity_required',409)
  const L=customerText(session.language,session.currency)
  const wording={version:'nectar-method-choice-1',merchant:merchant.legal_name,language:session.language,operation,text:L.t(operation==='default'?'methods.confirm.default':'methods.confirm.remove')}
  return {wording,hash:await fingerprint(wording)}
}

export async function preparePortalMethodAction(env: Bindings, actor: Actor, input: Input) {
  const factor=await setupOwner(env,actor)
  input.only(['customer','binding','setup','operation','confirm','returnTo'])
  insist(input.flag('confirm'),'portal_method_confirmation_required')
  const customer=input.text('customer'),binding=input.text('binding'),setup=input.text('setup'),operation=input.text('operation')
  insist(['default','remove'].includes(operation),'invalid_portal_method_operation')
  const row=await one(env,`SELECT s.*,b.revision AS current_binding_revision,b.account_ref,b.stripe_customer_ref AS customer_ref,c.revision AS current_customer_revision
    FROM nc_hosted_setups s JOIN nc_stripe_customer_bindings b ON b.id=s.binding_id AND b.customer_id=s.customer_id
    JOIN nc_customers c ON c.id=s.customer_id WHERE s.id=? AND s.customer_id=? AND b.id=? AND b.revision=s.binding_revision
    AND b.account_ref=s.account_ref AND b.stripe_customer_ref=s.customer_ref AND s.status='complete' AND s.livemode=0
    AND c.status='active' AND c.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(s.id,b.id,c.id))`,setup,customer,binding)
  insist(row,'portal_method_setup_required',409)
  const method=(await customerHostedSetups(env,customer)).find(value=>value.id===setup && !value.historical)?.paymentMethod
  insist(method,'portal_method_setup_required',409)
  row.method_ref=method.methodRef
  insist(!await one(env,`SELECT 1 FROM nc_portal_method_action_history h WHERE h.account_ref=? AND h.customer_ref=? AND h.status='uncertain'
    AND NOT EXISTS(SELECT 1 FROM nc_portal_method_actions a WHERE a.id=h.id)`,row.account_ref,row.customer_ref),'portal_method_historical_uncertainty',409)
  const {stripe}=await stripeForAccount(env,row.account_ref).catch(providerUnavailable)
  const {defaultMethod}=await readCustomer(stripe,row)
  const attached=await stripe(`/payment_methods/${encodeURIComponent(row.method_ref)}`).catch(providerUnavailable)
  verifyMethod(attached,row)
  if(operation==='remove') {
    insist(defaultMethod!==row.method_ref,'portal_method_choose_replacement_first',409)
    await noRemovalAuthority(env,row)
  }
  const id=newId(),at=clockInstant(env)
  await commit(env,[...setupOwnerFence(env,actor),
    guard(env,'portal_method_source_changed',`EXISTS(SELECT 1 FROM nc_hosted_setups s JOIN nc_stripe_customer_bindings b ON b.id=s.binding_id
      JOIN nc_customers c ON c.id=s.customer_id WHERE s.id=? AND s.status='complete' AND s.method_json=? AND s.livemode=0
      AND b.id=? AND b.customer_id=c.id AND b.revision=? AND b.account_ref=? AND b.stripe_customer_ref=?
      AND c.id=? AND c.revision=? AND c.status='active' AND c.erased_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(s.id,b.id,c.id)))`,setup,row.method_json,binding,row.current_binding_revision,row.account_ref,row.customer_ref,customer,row.current_customer_revision),
    guard(env,'portal_method_uncertain',`NOT EXISTS(SELECT 1 FROM nc_portal_method_action_history WHERE account_ref=? AND customer_ref=? AND status='uncertain')`,row.account_ref,row.customer_ref),
    ...(operation==='remove'?[removalFence(env,row)]:[]),
    stmt(env,"UPDATE nc_portal_method_action_history SET status='superseded' WHERE id IN(SELECT id FROM nc_portal_method_actions WHERE binding_id=? AND status='prepared')",binding),
    stmt(env,"UPDATE nc_portal_method_actions SET status='superseded' WHERE binding_id=? AND status='prepared'",binding),
    stmt(env,`INSERT INTO nc_portal_method_actions(id,customer_id,binding_id,binding_revision,customer_revision,setup_id,account_ref,customer_ref,method_ref,method_json,livemode,operation,status,previous_default_ref,created_by,created_at,owner_session_id,factor_ref,factor_verified_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,0,?,'prepared',?,?,?,?,?,?)`,id,customer,binding,row.current_binding_revision,row.current_customer_revision,setup,row.account_ref,row.customer_ref,row.method_ref,row.method_json,operation,defaultMethod,actor.id,at,actor.sessionId,factor.reference,factor.verifiedAt),
    stmt(env,`INSERT INTO nc_portal_method_action_history(id,customer_id,setup_id,account_ref,customer_ref,method_ref,operation,status,previous_default_ref,created_at)
      VALUES(?,?,?,?,?,?,?,'prepared',?,?)`,id,customer,setup,row.account_ref,row.customer_ref,row.method_ref,operation,defaultMethod,at),
  ],{actor:actorLabel(actor),action:'portal.method.prepare',subject:id,detail:{customer,setup,operation,account:row.account_ref,testMode:true,sourceRevision:row.current_customer_revision,bindingRevision:row.current_binding_revision,factorVerification:factor.reference,factorVerifiedAt:factor.verifiedAt,previous:defaultMethod,selected:row.method_ref}})
  return {id,customer,setup,operation,status:'prepared'}
}

export async function customerPortalMethodActions(env: Bindings, session: CustomerSession) {
  sessionShape(env,session)
  insist(await one(env,`SELECT 1 FROM nc_customers c WHERE c.id=? AND c.status='active' AND c.erased_at IS NULL AND ${portal}`,session.customer,...portalParams(session,clockInstant(env))),'invalid_customer_session',401)
  const rows=await all(env,`SELECT a.*,0 AS historical FROM nc_portal_method_actions a WHERE a.customer_id=?
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(a.id,a.setup_id,a.binding_id,a.customer_id))
    UNION ALL SELECT h.id,h.customer_id,NULL,NULL,NULL,h.setup_id,h.account_ref,h.customer_ref,h.method_ref,NULL,0,h.operation,h.status,h.previous_default_ref,NULL,h.created_at,NULL,NULL,NULL,NULL,h.accepted_at,h.completed_at,1
    FROM nc_portal_method_action_history h WHERE h.customer_id=? AND NOT EXISTS(SELECT 1 FROM nc_portal_method_actions a WHERE a.id=h.id)
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(h.id,h.setup_id,h.customer_id)) ORDER BY created_at,id`,session.customer,session.customer)
  return Promise.all(rows.map(async row=>({...view(row,row.historical===1),consentHash:(await methodActionConsent(env,session,row.operation)).hash})))
}

export async function operatePortalMethodAction(env: Bindings, session: CustomerSession, input: Input, operation: 'confirm'|'reconcile') {
  sessionShape(env,session)
  input.only(['action','confirm','consent_hash'])
  insist(input.flag('confirm'),'portal_method_confirmation_required')
  const row=await one(env,`SELECT a.*,s.method ${source} WHERE a.id=? AND a.customer_id=? AND ${current}`,input.text('action'),session.customer)
  insist(row,'portal_method_not_found',404)
  insist(operation==='confirm'?row.status==='prepared':row.status==='uncertain','portal_method_already_claimed',409)
  const consent=await methodActionConsent(env,session,row.operation)
  insist(input.text('consent_hash')===consent.hash,'portal_method_consent_changed',409)
  const at=clockInstant(env)
  insist(await one(env,`SELECT 1 ${source} WHERE a.id=? AND ${current} AND ${liveOwner} AND ${portal}`,row.id,...ownerParams(at),...portalParams(session,at)),'portal_method_source_changed',409)
  const {stripe}=await stripeForAccount(env,row.account_ref).catch(providerUnavailable)
  const {defaultMethod}=await readCustomer(stripe,row)
  const method=await stripe(`/payment_methods/${encodeURIComponent(row.method_ref)}`).catch(providerUnavailable)
  if(operation==='confirm') {
    verifyMethod(method,row)
    insist(defaultMethod===row.previous_default_ref,'portal_method_default_changed',409)
    if(row.operation==='remove') {
      insist(defaultMethod!==row.method_ref,'portal_method_choose_replacement_first',409)
      await noRemovalAuthority(env,row)
    }
    // The uncertain state is the durable once-only claim, written before POST.
    await commit(env,[actionFence(env,session,row,'prepared'),...(row.operation==='remove'?[removalFence(env,row)]:[]),
      stmt(env,"UPDATE nc_portal_method_actions SET status='uncertain',customer_session_id=?,accepted_at=? WHERE id=?",session.jti,at,row.id),
      stmt(env,"UPDATE nc_portal_method_action_history SET status='uncertain',accepted_at=? WHERE id=?",at,row.id),
    ],{actor:`customer:portal:${session.customer}`,action:'portal.method.claim',subject:row.id,detail:{customer:session.customer,setup:row.setup_id,operation:row.operation,account:row.account_ref,testMode:true,previous:row.previous_default_ref,selected:row.method_ref,acceptedAt:at,wording:consent.wording,wordingHash:consent.hash}})
    if(row.operation==='default') {
      const result=await stripe(`/customers/${encodeURIComponent(row.customer_ref)}`,new URLSearchParams({'invoice_settings[default_payment_method]':row.method_ref}),`nectar-portal-method-${row.id}`).catch(providerUnavailable)
      insist(result.object==='customer' && result.id===row.customer_ref && !result.deleted && result.livemode===false && defaultRef(result)===row.method_ref,'portal_method_uncertain',409)
    } else {
      const result=await stripe(`/payment_methods/${encodeURIComponent(row.method_ref)}/detach`,new URLSearchParams(),`nectar-portal-method-${row.id}`).catch(providerUnavailable)
      verifyMethod(result,row,true)
    }
  } else {
    // A negative or mismatched observation never releases a claim for retry.
    if(row.operation==='default') {
      verifyMethod(method,row)
      insist(defaultMethod===row.method_ref,'portal_method_uncertain',409)
    } else {
      verifyMethod(method,row,true)
      insist(defaultMethod!==row.method_ref,'portal_method_uncertain',409)
    }
  }
  const completedAt=clockInstant(env)
  await commit(env,[actionFence(env,session,row,'uncertain'),
    stmt(env,"UPDATE nc_portal_method_actions SET status='complete',completed_at=? WHERE id=?",completedAt,row.id),
    stmt(env,"UPDATE nc_portal_method_action_history SET status='complete',completed_at=? WHERE id=?",completedAt,row.id),
  ],{actor:`customer:portal:${session.customer}`,action:operation==='reconcile'?'portal.method.reconciled':'portal.method.complete',subject:row.id,detail:{customer:session.customer,setup:row.setup_id,operation:row.operation,account:row.account_ref,testMode:true,previous:row.previous_default_ref,selected:row.method_ref,outcome:row.operation==='default'?'default-selected':'detached',completedAt}})
  return {id:row.id,status:'complete',operation:row.operation}
}
