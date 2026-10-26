// A replacement card authorizes one confirmation of the existing exact intent.
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, type Actor } from './actor'
import { automaticAuthority, storedAutomaticCollection, validateAutomaticBasis, type AutomaticQuote } from './automatic-collection-records'
import { assertMethodUsable, HARD_CARD_DECLINES, unusableMethodGuard } from './card-lifecycle'
import { collectionHold } from './cadence-holds'
import { clockInstant } from './clock'
import { canonical, commit, fingerprint, guard, insist, newId, one, parseJson, stmt, type Row } from './core'
import { setupOwner, setupOwnerFence } from './hosted-setup-basis'
import type { Input } from './input'
import { customerText } from './locale'
import { STEP_UP_MS } from './mfa'
import { savedCollectionMethod } from './payments/default-method'
import { readIntent, refusedPayment, stripeForAccount, type PaymentIdentity } from './payments/stripe'
import { nativeCollectionSource, nativeSourceGuard } from './payments/source'
import { customerSession, PORTAL_LIFETIME, type CustomerSession } from './portal-session'
import { DAY } from './retry-policy'

const other="SELECT 1 FROM nc_members WHERE id<>? AND role IN ('owner','finance') AND status='active'"
const joined=`FROM nc_retry_method_recoveries r JOIN nc_retry_method_recovery_authorizations z ON z.id=r.id AND z.quote_hash=r.quote_hash`
export const recoveryText = (language: string | null) => {
 const L=customerText(language)
 return {tag:L.tag,heading:L.t('retry.recovery.heading'),accept:L.t('retry.recovery.accept'),confirm:L.t('retry.recovery.confirm'),withdraw:L.t('retry.recovery.withdraw'),unavailable:L.t('retry.recovery.unavailable'),
 awaiting_customer:L.t('retry.recovery.awaiting_customer'),pending_approval:L.t('retry.recovery.pending_approval'),active:L.t('retry.recovery.active'),rejected:L.t('retry.recovery.rejected'),withdrawn:L.t('retry.recovery.withdrawn'),consumed:L.t('retry.recovery.consumed'),historical:L.t('retry.recovery.historical'),
 consent:(merchant:string,amount:string,invoice:string,last4:string)=>L.t('retry.recovery.consent',{merchant,amount,invoice,last4})}
}

function factorFence(env:Bindings,member:string,session:string,verified:number,owner=false){
 const at=clockInstant(env)
 return guard(env,'retry_recovery_factor_changed',`? BETWEEN ? AND ? AND EXISTS(SELECT 1 FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id
 JOIN nc_members m ON m.email=lower(o.email) JOIN nc_mfa_sessions f ON f.session_id=s.id AND f.member_id=m.id
 WHERE s.id=? AND m.id=? AND m.status='active' AND m.role ${owner?"='owner'":"IN ('owner','finance')"}
 AND o.status='active' AND ((m.role='owner' AND o.role='owner') OR (m.role='finance' AND o.role IN ('owner','member')))
 AND o.version=s.operator_version AND s.revoked_at IS NULL AND s.expires_at>CAST(strftime('%s','now') AS INTEGER)*1000
 AND f.method IN ('totp','passkey') AND f.verified_at>=? AND f.verified_at BETWEEN ? AND ?)`,verified,at-STEP_UP_MS,at,session,member,verified,at-STEP_UP_MS,at)
}
async function freshApprover(env:Bindings,actor:Actor){
 requireMember(actor,'approve');insist(actor.sessionId,'person_required',403)
 const at=clockInstant(env),factor=await one(env,"SELECT verified_at FROM nc_mfa_sessions WHERE member_id=? AND session_id=? AND method IN ('totp','passkey') AND verified_at BETWEEN ? AND ?",actor.id,actor.sessionId,at-STEP_UP_MS,at)
 insist(factor,'mfa_step_up_required',403);return factor.verified_at as number
}
function portalFence(env:Bindings,session:CustomerSession){
 const at=clockInstant(env)
 insist(session.audience==='hosted'&&session.parent===''&&session.iss===env.AUTH_ORIGIN,'hosted_session_required',403)
 return guard(env,'customer_session_changed',`EXISTS(SELECT 1 FROM nc_portal_sessions p JOIN nc_portal_policy policy ON policy.singleton=1 AND policy.revision=p.policy_revision
 JOIN nc_customers c ON c.id=p.customer_id WHERE p.id=? AND p.customer_id=? AND p.origin=? AND p.audience='hosted' AND p.parent_origin=''
 AND p.issued_at=? AND p.expires_at=? AND p.issued_at<=? AND p.expires_at>? AND p.expires_at-p.issued_at=? AND p.revoked_at IS NULL
 AND c.status='active' AND c.erased_at IS NULL AND EXISTS(SELECT 1 FROM json_each(policy.hosts_json) WHERE value=p.origin)
 AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(p.id,c.id)))`,session.jti,session.customer,session.origin,session.iat,session.exp,at,at,PORTAL_LIFETIME)
}
async function checkedQuote(row:Row,proposal:Row){
 const original=await validateAutomaticBasis(row),quote=parseJson<AutomaticQuote>(proposal.quote_json,null as never)
 insist(quote&&await fingerprint(quote)===proposal.quote_hash&&proposal.collection_id===row.id&&proposal.original_basis_hash===row.basis_hash
 &&proposal.payment_intent_ref===row.payment_intent_ref&&quote.method.kind==='card'&&quote.method.customerRef===original.method.customerRef
 &&quote.method.paymentMethodRef!==original.method.paymentMethodRef&&quote.method.paymentMethodRef!==proposal.previous_method_ref
 &&quote.wordingVersion==='exact-invoice-new-card-1'&&canonical({...quote,method:original.method,wording:original.wording,wordingVersion:original.wordingVersion})===canonical(original),'retry_recovery_basis_changed',409)
 return quote
}
export async function retryMethodRecovery(env:Bindings,id:string){
 const row=await one(env,`SELECT r.*,COALESCE(z.status,'historical') AS status,z.revision,z.owner_session_id,z.owner_verified_at,z.customer_session_id,z.customer_origin,z.accepted_at,z.approved_by,z.approver_session_id,z.approver_verified_at,z.approval_mode
 FROM nc_retry_method_recoveries r LEFT JOIN nc_retry_method_recovery_authorizations z ON z.id=r.id AND z.quote_hash=r.quote_hash WHERE r.id=?
 AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(r.id,r.collection_id,r.customer_id,r.invoice_id))`,id)
 insist(row,'retry_recovery_not_found',404);return row
}
export function retryMethodRecoveryView(row:Row){
 return {id:row.id,collection:row.collection_id,invoice:row.invoice_id,customer:row.customer_id,status:row.status,quoteHash:row.quote_hash,
 quote:parseJson<AutomaticQuote>(row.quote_json,null as never),paymentIntentRef:row.payment_intent_ref,expectedAttempt:row.expected_attempt+1,deadline:row.deadline,preparedAt:row.prepared_at,acceptedAt:row.accepted_at}
}
// The last claimed method is the identity to use when reading a refused intent.
export async function retryAttemptQuote(env:Bindings,row:Row):Promise<AutomaticQuote>{
 const prior=await one(env,`SELECT r.* ${joined} WHERE r.collection_id=? AND z.status='consumed' ORDER BY r.expected_attempt DESC LIMIT 1`,row.id)
 return prior?checkedQuote(row,prior):validateAutomaticBasis(row)
}
export async function effectiveRetryQuote(env:Bindings,row:Row):Promise<AutomaticQuote>{
 const proposal=await one(env,`SELECT r.* ${joined} WHERE r.collection_id=? AND z.status='active'`,row.id)
 return proposal?checkedQuote(row,proposal):retryAttemptQuote(env,row)
}
function proposalFence(env:Bindings,row:Row,proposal:Row,status:string){
 const at=clockInstant(env),q=parseJson<AutomaticQuote>(proposal.quote_json,null as never),policy=q.retryPolicy!
 return guard(env,'retry_recovery_state_changed',`EXISTS(SELECT 1 ${joined} JOIN nc_retry_series s ON s.collection_id=r.collection_id
 JOIN nc_automatic_collections a ON a.id=r.collection_id WHERE r.id=? AND z.revision=? AND z.status=? AND r.quote_hash=?
 AND a.revision=r.original_revision AND a.revision=? AND a.basis_hash=r.original_basis_hash AND a.payment_intent_ref=r.payment_intent_ref
 AND a.status='refused' AND a.payment_id IS NULL AND a.charge_ref IS NULL AND s.status IN ('blocked','scheduled')
 AND s.attempts=r.expected_attempt AND s.attempts<? AND s.deadline=r.deadline AND s.deadline>=? AND s.decline_code=r.decline_code
 AND s.policy_json=? AND NOT EXISTS(SELECT 1 FROM nc_retry_attempts t WHERE t.collection_id=a.id AND t.outcome='claimed')
 AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(r.id,r.customer_id,r.collection_id,r.invoice_id)))`,proposal.id,proposal.revision,status,proposal.quote_hash,row.revision,Math.min(policy.maxAttempts,8),at,canonical(policy))
}
export async function recoveryAuthority(env:Bindings,row:Row,quote:AutomaticQuote){
 const original=await validateAutomaticBasis(row)
 if(canonical(quote)===canonical(original))return []
 const proposal=await one(env,`SELECT r.*,z.* ${joined} WHERE r.collection_id=? AND z.status='active' AND r.quote_json=?`,row.id,canonical(quote))
 insist(proposal,'retry_recovery_not_authorized',409);await checkedQuote(row,proposal)
 const source=await nativeCollectionSource(env,row.invoice_id),hold=await collectionHold(env,row.invoice_id)
 insist(source.payerId===quote.customer&&source.row.total_cents===quote.amountCents&&source.collectibleCents===quote.amountCents&&!hold.hold&&!hold.disputedCents&&hold.collectibleCents===quote.amountCents,'retry_recovery_invoice_changed',409)
 const session=await one(env,'SELECT * FROM nc_portal_sessions WHERE id=?',proposal.customer_session_id)
 insist(session,'customer_session_changed',409)
 const guards=[automaticAuthority(env,row),nativeSourceGuard(env,source),proposalFence(env,row,proposal,'active'),
 factorFence(env,proposal.prepared_by,proposal.owner_session_id,proposal.owner_verified_at,true),
 factorFence(env,proposal.approved_by,proposal.approver_session_id,proposal.approver_verified_at),
 portalFence(env,{v:1,iss:env.AUTH_ORIGIN,jti:session.id,customer:row.customer_id,origin:proposal.customer_origin,audience:'hosted',parent:'',iat:session.issued_at,exp:session.expires_at,language:'',currency:'USD'}),
 unusableMethodGuard(env,quote.accountRef,quote.method.customerRef,quote.method.paymentMethodRef),
 guard(env,'payment_method_removal_claimed',`NOT EXISTS(SELECT 1 FROM nc_portal_method_action_history WHERE account_ref=? AND customer_ref=? AND method_ref=? AND operation='remove' AND status IN ('uncertain','complete'))`,quote.accountRef,quote.method.customerRef,quote.method.paymentMethodRef),
 guard(env,'retry_recovery_consent_changed',`EXISTS(SELECT 1 FROM nc_retry_method_recovery_events e WHERE e.recovery_id=? AND e.kind='accepted' AND json_extract(e.detail_json,'$.quoteHash')=?)
 AND EXISTS(SELECT 1 FROM nc_retry_method_recovery_events e WHERE e.recovery_id=? AND e.kind='approved' AND json_extract(e.detail_json,'$.quoteHash')=?)
 AND NOT EXISTS(SELECT 1 FROM nc_retry_method_recovery_events WHERE recovery_id=? AND kind IN ('withdrawn','rejected','claimed'))`,proposal.id,proposal.quote_hash,proposal.id,proposal.quote_hash,proposal.id)]
 if(proposal.approval_mode==='single-approver')guards.push(guard(env,'second_approver_required',`?=? AND NOT EXISTS(${other})`,proposal.approved_by,proposal.prepared_by,proposal.prepared_by))
 else guards.push(guard(env,'second_approver_required','?<>?',proposal.approved_by,proposal.prepared_by))
 return guards
}
export async function claimRetryMethodRecovery(env:Bindings,row:Row,quote:AutomaticQuote){
 const original=await validateAutomaticBasis(row);if(canonical(quote)===canonical(original))return []
 const guards=await recoveryAuthority(env,row,quote),proposal=await one(env,`SELECT r.* ${joined} WHERE r.collection_id=? AND z.status='active'`,row.id)
 insist(proposal,'retry_recovery_not_authorized',409)
 return [...guards,stmt(env,"UPDATE nc_retry_method_recovery_authorizations SET status='consumed',revision=? WHERE id=?",newId(),proposal.id),event(env,proposal,'claimed','system:retries',{quoteHash:proposal.quote_hash,attempt:proposal.expected_attempt+1})]
}
function event(env:Bindings,row:Row,kind:string,actor:string,detail:Row){return stmt(env,'INSERT INTO nc_retry_method_recovery_events(id,recovery_id,customer_id,kind,actor,at,detail_json) VALUES(?,?,?,?,?,?,?)',newId(),row.id,row.customer_id,kind,actor,clockInstant(env),canonical(detail))}

export async function prepareRetryMethodRecovery(env:Bindings,actor:Actor,input:Input){
 const factor=await setupOwner(env,actor);input.only(['request','confirm','returnTo']);insist(input.flag('confirm'),'retry_recovery_confirmation_required')
 const row=await storedAutomaticCollection(env,input.text('request',{max:100})),original=await validateAutomaticBasis(row),at=clockInstant(env)
 const series=await one(env,'SELECT * FROM nc_retry_series WHERE collection_id=?',row.id),prior=await retryAttemptQuote(env,row)
 insist(original.retryPolicy&&original.method.kind==='card'&&row.status==='refused'&&row.payment_intent_ref&&!row.payment_id&&!row.charge_ref
 &&series&&['blocked','scheduled'].includes(series.status)&&series.attempts<Math.min(original.retryPolicy.maxAttempts,8)&&at<=series.deadline
 &&series.deadline<=series.first_failed_at+Math.min(original.retryPolicy.windowDays,14)*DAY&&canonical(original.retryPolicy)===series.policy_json
 &&HARD_CARD_DECLINES.has(series.decline_code),'retry_recovery_not_eligible',409)
 const {stripe}=await stripeForAccount(env,original.accountRef),identity:PaymentIdentity={accountRef:original.accountRef,customerRef:prior.method.customerRef,paymentMethodRef:prior.method.paymentMethodRef,livemode:false,invoiceId:row.invoice_id,requestId:row.id,key:await fingerprint(['nectar-automatic-collection-1',original.accountRef,row.invoice_id]),amountCents:original.amountCents,currency:'usd'}
 const observed=await readIntent(stripe,identity,row.payment_intent_ref,row.claimed_at,at),refusal=await refusedPayment(stripe,observed,identity)
 insist(refusal&&!refusal.retryProhibited&&refusal.paymentIntentRef===row.payment_intent_ref&&(refusal.declineCode??refusal.errorCode)===series.decline_code,'retry_prior_outcome_unconfirmed',409)
 const history=await stripe(`/charges?${new URLSearchParams({payment_intent:row.payment_intent_ref,limit:'100'})}`)
 insist(history.object==='list'&&history.has_more===false&&Array.isArray(history.data)&&history.data.every((charge:Row)=>charge.object==='charge'&&charge.status==='failed'&&charge.paid===false&&charge.captured!==true),'retry_prior_outcome_unconfirmed',409)
 const method=await savedCollectionMethod(stripe,original.method.customerRef)
 insist(method.kind==='card'&&method.paymentMethodRef!==original.method.paymentMethodRef&&method.paymentMethodRef!==prior.method.paymentMethodRef,'retry_recovery_new_card_required',409)
 await assertMethodUsable(env,original.accountRef,method.customerRef,method.paymentMethodRef)
 const business=await one(env,'SELECT * FROM nc_business WHERE singleton=1'),customer=await one(env,'SELECT language FROM nc_customers WHERE id=?',row.customer_id),source=await nativeCollectionSource(env,row.invoice_id),hold=await collectionHold(env,row.invoice_id)
 insist(business&&business.revision===original.businessRevision,'retry_recovery_basis_changed',409)
 const L=customerText(customer?.language),quote:AutomaticQuote={...original,method,wordingVersion:'exact-invoice-new-card-1',wording:recoveryText(customer?.language).consent(business.legal_name,L.money(original.amountCents),source.row.number,method.summary.last4)}
 const id=newId(),hash=await fingerprint(quote)
 insist(source.payerId===original.customer&&source.row.total_cents===original.amountCents&&source.collectibleCents===original.amountCents&&!hold.hold&&!hold.disputedCents&&hold.collectibleCents===original.amountCents,'retry_recovery_invoice_changed',409)
 const proposal={id,customer_id:row.customer_id,revision:newId(),quote_json:canonical(quote),quote_hash:hash}
 await commit(env,[...setupOwnerFence(env,actor),automaticAuthority(env,row),nativeSourceGuard(env,source),unusableMethodGuard(env,quote.accountRef,method.customerRef,method.paymentMethodRef),
 guard(env,'retry_recovery_state_changed',`EXISTS(SELECT 1 FROM nc_retry_series WHERE collection_id=? AND revision=? AND attempts=? AND deadline>=? AND status IN ('blocked','scheduled'))
 AND NOT EXISTS(SELECT 1 FROM nc_retry_attempts WHERE collection_id=? AND outcome='claimed')`,row.id,series.revision,series.attempts,clockInstant(env),row.id),
 guard(env,'retry_recovery_original_method_required',`EXISTS(SELECT 1 FROM nc_card_lifecycle WHERE account_ref=? AND stripe_customer_ref=? AND payment_method_ref=? AND unusable_at IS NOT NULL AND unusable_reason=?)`,original.accountRef,prior.method.customerRef,prior.method.paymentMethodRef,series.decline_code),
 stmt(env,`INSERT INTO nc_retry_method_recoveries(id,collection_id,invoice_id,customer_id,original_basis_hash,original_revision,payment_intent_ref,previous_method_ref,quote_json,quote_hash,prepared_by,prepared_at,expected_attempt,deadline,decline_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,row.id,row.invoice_id,row.customer_id,row.basis_hash,row.revision,row.payment_intent_ref,prior.method.paymentMethodRef,canonical(quote),hash,actor.id,at,series.attempts,series.deadline,series.decline_code),
 stmt(env,`INSERT INTO nc_retry_method_recovery_authorizations(id,collection_id,customer_id,quote_hash,status,owner_session_id,owner_verified_at,revision) VALUES(?,?,?,?,'awaiting_customer',?,?,?)`,id,row.id,row.customer_id,hash,actor.sessionId,factor.verifiedAt,proposal.revision)],{actor:actorLabel(actor),action:'retry.method.prepare',subject:id,detail:{collection:row.id,quoteHash:hash,paymentIntentRef:row.payment_intent_ref}})
 return retryMethodRecoveryView(await retryMethodRecovery(env,id))
}

export async function acceptRetryMethodRecovery(env:Bindings,request:Request,input:Input){
 const session=await customerSession(env,request);input.only(['recovery','quote_hash','accept','withdraw'])
 insist(request.method==='POST'&&request.headers.get('origin')===session.origin,'forbidden',403)
 const proposal=await retryMethodRecovery(env,input.text('recovery',{max:100}));insist(proposal.customer_id===session.customer,'retry_recovery_not_found',404)
 const row=await storedAutomaticCollection(env,proposal.collection_id);await checkedQuote(row,proposal)
 const withdraw=input.flag('withdraw');insist(input.text('quote_hash',{max:100})===proposal.quote_hash&&(withdraw?['awaiting_customer','pending_approval','active'].includes(proposal.status):proposal.status==='awaiting_customer'&&input.flag('accept')),'retry_recovery_consent_changed',409)
 await commit(env,[automaticAuthority(env,row),portalFence(env,session),
 ...(withdraw?[guard(env,'retry_recovery_already_claimed',`EXISTS(SELECT 1 FROM nc_retry_method_recovery_authorizations WHERE id=? AND revision=? AND status IN ('awaiting_customer','pending_approval','active'))`,proposal.id,proposal.revision)]:[proposalFence(env,row,proposal,'awaiting_customer'),factorFence(env,proposal.prepared_by,proposal.owner_session_id,proposal.owner_verified_at,true)]),
 stmt(env,`UPDATE nc_retry_method_recovery_authorizations SET status=?,customer_session_id=?,customer_origin=?,accepted_at=?,revision=? WHERE id=?`,withdraw?'withdrawn':'pending_approval',session.jti,session.origin,clockInstant(env),newId(),proposal.id),
 event(env,proposal,withdraw?'withdrawn':'accepted',`customer:${session.customer}`,{quoteHash:proposal.quote_hash,wording:JSON.parse(proposal.quote_json).wording})],{actor:`customer:${session.customer}`,action:withdraw?'retry.method.withdraw':'retry.method.accept',subject:proposal.id,detail:{quoteHash:proposal.quote_hash}})
 return retryMethodRecoveryView(await retryMethodRecovery(env,proposal.id))
}
export async function decideRetryMethodRecovery(env:Bindings,actor:Actor,input:Input){
 const verified=await freshApprover(env,actor);input.only(['recovery','quote_hash','decision','confirm','confirm_single','returnTo'])
 const proposal=await retryMethodRecovery(env,input.text('recovery',{max:100})),row=await storedAutomaticCollection(env,proposal.collection_id),decision=input.text('decision',{max:10})
 await checkedQuote(row,proposal);insist(input.flag('confirm')&&proposal.status==='pending_approval'&&input.text('quote_hash',{max:100})===proposal.quote_hash&&['approved','rejected'].includes(decision),'retry_recovery_approval_changed',409)
 const single=actor.id===proposal.prepared_by
 if(single){await setupOwner(env,actor);insist(input.flag('confirm_single')&&!await one(env,other,actor.id),'second_approver_required',409)}
 await commit(env,[automaticAuthority(env,row),proposalFence(env,row,proposal,'pending_approval'),factorFence(env,proposal.prepared_by,proposal.owner_session_id,proposal.owner_verified_at,true),factorFence(env,actor.id,actor.sessionId!,verified),
 ...(single?[guard(env,'second_approver_required',`NOT EXISTS(${other})`,actor.id)]:[]),
 stmt(env,`UPDATE nc_retry_method_recovery_authorizations SET status=?,approved_by=?,approver_session_id=?,approver_verified_at=?,approval_mode=?,revision=? WHERE id=?`,decision==='approved'?'active':'rejected',actor.id,actor.sessionId,verified,single?'single-approver':'two-person',newId(),proposal.id),
 ...(decision==='approved'?[stmt(env,"UPDATE nc_retry_series SET status='scheduled',next_at=?,revision=? WHERE collection_id=?",clockInstant(env),newId(),row.id)]:[]),
 event(env,proposal,decision,actorLabel(actor),{quoteHash:proposal.quote_hash,approvalMode:single?'single-approver':'two-person'})],{actor:actorLabel(actor),action:`retry.method.${decision}`,subject:proposal.id,detail:{quoteHash:proposal.quote_hash}})
 return retryMethodRecoveryView(await retryMethodRecovery(env,proposal.id))
}
