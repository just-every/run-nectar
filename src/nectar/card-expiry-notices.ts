// Exact owner-reviewed expiry warnings. Preparation never queues a send;
// claiming is once-only, and provider acceptance never means mailbox delivery.
import type { Bindings } from '../auth.server'
import { operatorMail } from '../mail.server.mjs'
import { actorLabel, requireRead, type Actor } from './actor'
import { assertMethodUsable } from './card-lifecycle'
import { clockInstant } from './clock'
import { all, canonical, commit, fingerprint, guard, insist, NectarError, newId, one, parseJson, stmt, type Row } from './core'
import { addDays, localDate } from './dates'
import { setupOwner, setupOwnerFence } from './hosted-setup-basis'
import { Input } from './input'
import { customerText } from './locale'
import { STEP_UP_MS } from './mfa'
import { savedCard, stripeForAccount } from './payments/stripe'
import { issuePortalSession } from './portal-policy'
import { esc } from './ui/html'

const VERSION='nectar-card-expiry-1'
interface ExpirySource extends Row { method:Awaited<ReturnType<typeof savedCard>>;from:string;provider:string;dueDate:string }
const sourceQuery=`SELECT c.id customer,c.revision customerRevision,c.billing_email recipient,c.language,c.currency,
 s.id subscription,s.revision subscriptionRevision,t.id term,t.revision termRevision,t.cycle,t.end_date renewalDate,
 h.id setup,h.created_by owner,h.owner_session_id ownerSession,h.factor_verified_at factorAt,h.factor_ref factorRef,
 b.id binding,b.revision bindingRevision,b.account_ref accountRef,b.stripe_customer_ref customerRef,
 biz.revision businessRevision,biz.legal_name merchant,biz.timezone
 FROM nc_customers c JOIN nc_subscriptions s ON s.customer_id=c.id
 JOIN nc_renewal_terms t ON t.subscription_id=s.id JOIN nc_hosted_setups h ON h.customer_id=c.id
 JOIN nc_stripe_customer_bindings b ON b.id=h.binding_id AND b.customer_id=c.id
 JOIN nc_business biz ON biz.singleton=1
 WHERE c.id=? AND s.id=? AND h.id=? AND c.status='active' AND c.erased_at IS NULL
 AND s.billing_mode='live' AND s.end_date=t.end_date AND t.status='active' AND t.auto_renew=1 AND t.cancelled_at IS NULL
 AND h.status='prepared' AND h.method='card' AND h.livemode=0 AND h.customer_revision=c.revision
 AND h.binding_revision=b.revision AND h.account_ref=b.account_ref AND h.customer_ref=b.stripe_customer_ref
 AND h.created_by=? AND h.owner_session_id=? AND h.factor_verified_at BETWEEN ? AND ?
 AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(c.id,s.id,t.id,h.id,b.id))
 AND NOT EXISTS(SELECT 1 FROM nc_portal_method_action_history WHERE account_ref=b.account_ref AND customer_ref=b.stripe_customer_ref AND status='uncertain')`
const sourceParams=(actor:Actor,customer:string,subscription:string,setup:string,at:number)=>[customer,subscription,setup,actor.id,actor.sessionId,at-STEP_UP_MS,at]
async function source(env:Bindings,actor:Actor,customer:string,subscription:string,setup:string):Promise<ExpirySource> {
  const at=clockInstant(env),row=await one(env,sourceQuery,...sourceParams(actor,customer,subscription,setup,at))
  insist(row,'card_expiry_source_unavailable',409)
  insist(localDate(at,row.timezone)===addDays(row.renewalDate,-14),'card_expiry_not_due',409)
  insist(typeof row.recipient==='string' && row.recipient.length<=200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.recipient),'customer_billing_email_required',409)
  const {stripe}=await stripeForAccount(env,row.accountRef),method=await savedCard(stripe,row.customerRef)
  insist(method.livemode===false,'hosted_setup_test_mode_required',409)
  insist(method.card.expMonth>=1 && method.card.expMonth<=12 && method.card.expYear>=2000 && method.card.expYear<=9999,'card_expiry_method_invalid',409)
  await assertMethodUsable(env,row.accountRef,row.customerRef,method.paymentMethodRef)
  const expires=`${method.card.expYear}-${String(method.card.expMonth).padStart(2,'0')}`
  insist(expires<row.renewalDate.slice(0,7),'card_expiry_warning_unnecessary',409)
  insist(!/[\r\n]/.test(row.merchant),'business_identity_required',409)
  return {...row,method,from:env.MAIL_FROM??'',provider:env.MAIL_PROVIDER??'',dueDate:localDate(at,row.timezone)}
}
function sourceFence(env:Bindings,actor:Actor,s:Row) {
  const at=clockInstant(env)
  return guard(env,'card_expiry_source_changed',`EXISTS(SELECT 1 FROM (${sourceQuery}) current
    WHERE current.customerRevision=? AND current.subscriptionRevision=? AND current.termRevision=? AND current.cycle=?
    AND current.renewalDate=? AND current.bindingRevision=? AND current.businessRevision=? AND current.factorAt=? AND current.factorRef=?)`,
  ...sourceParams(actor,s.customer,s.subscription,s.setup,at),s.customerRevision,s.subscriptionRevision,s.termRevision,s.cycle,s.renewalDate,s.bindingRevision,s.businessRevision,s.factorAt,s.factorRef)
}
function view(row:Row,authority:Row|null=null) {
  return {id:row.id,customer:row.customer_id,subscription:row.subscription_id,term:row.term_id,setup:row.setup_id,
    binding:row.binding_id,accountRef:row.account_ref,methodRef:row.payment_method_ref,renewalDate:row.renewal_date,dueDate:row.due_date,
    recipient:row.recipient,language:row.language,last4:row.last4,expMonth:row.exp_month,expYear:row.exp_year,
    wordingVersion:row.wording_version,basis:row.basis_hash,preparedBy:row.prepared_by,preparedAt:row.prepared_at,expiresAt:row.expires_at,
    status:row.status==='sending'?'uncertain':row.status,claimedAt:row.claimed_at,finishedAt:row.finished_at,
    providerRef:row.provider_ref,errorCode:row.error_code,historical:!authority,debitAuthority:false,
    preview:authority?{recipient:row.recipient,from:authority.from_address,subject:authority.subject,text:authority.body,html:authority.html}:null}
}
async function notice(env:Bindings,id:string) {
  const row=await one(env,`SELECT n.* FROM nc_card_expiry_notices n JOIN nc_customers c ON c.id=n.customer_id
    WHERE n.id=? AND c.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(n.id,c.id))`,id)
  insist(row,'card_expiry_notice_not_found',404)
  return row
}
export async function readCardExpiryNotices(env:Bindings,actor:Actor,customer:string) {
  requireRead(actor,'payments');requireRead(actor,'invoices')
  const rows=await all(env,`SELECT n.* FROM nc_card_expiry_notices n JOIN nc_customers c ON c.id=n.customer_id
    WHERE n.customer_id=? AND c.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(n.id,c.id)) ORDER BY n.prepared_at,n.id`,customer)
  let previewAllowed=false
  if(actor.kind==='member' && actor.role==='owner')try{await setupOwner(env,actor);previewAllowed=true}catch(error){if(!(error instanceof NectarError))throw error}
  return Promise.all(rows.map(async row=>view(row,previewAllowed && row.prepared_by===actor.id && row.status==='prepared' && row.expires_at>clockInstant(env)
    ?await one(env,'SELECT * FROM nc_card_expiry_notice_authority WHERE id=? AND owner_session_id=?',row.id,actor.sessionId):null)))
}

export async function prepareCardExpiryNotice(env:Bindings,actor:Actor,input:Input) {
  await setupOwner(env,actor)
  input.only(['customer','subscription','setup','confirm','returnTo'])
  insist(input.flag('confirm'),'card_expiry_confirmation_required')
  const s=await source(env,actor,input.text('customer',{max:100}),input.text('subscription',{max:100}),input.text('setup',{max:100}))
  insist(!await one(env,'SELECT 1 FROM nc_card_expiry_notices WHERE term_id=? AND cycle=?',s.term,s.cycle),'card_expiry_notice_exists',409)
  const session=await issuePortalSession(env,actor,Input.of({customer:s.customer,origin:env.AUTH_ORIGIN,audience:'hosted'}))
  const expiresAt=Math.min(session.expiresAt,s.factorAt+STEP_UP_MS)
  insist(expiresAt>clockInstant(env),'card_expiry_link_expired',409)
  const link=new URL('/portal/payment-methods',env.AUTH_ORIGIN);link.searchParams.set('session',session.token)
  const L=customerText(s.language,s.currency)
  const expiryMonth=new Intl.DateTimeFormat(L.tag,{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(`${s.method.card.expYear}-${String(s.method.card.expMonth).padStart(2,'0')}-01T00:00:00Z`))
  const values={merchant:s.merchant,last4:s.method.card.last4,expiry:expiryMonth,renewal:L.day(s.renewalDate),
    expires:new Intl.DateTimeFormat(L.tag,{dateStyle:'long',timeStyle:'short',timeZone:s.timezone}).format(new Date(expiresAt)),timezone:s.timezone}
  const subject=L.t('cardExpiry.subject',values),intro=L.t('cardExpiry.body',values),expiry=L.t('cardExpiry.linkExpiry',values),button=L.t('cardExpiry.button')
  const body=[intro,link.href,expiry,L.t('checkout.explain')].join('\n\n')
  const html=`<!doctype html><html lang="${esc(L.tag)}"><body style="margin:0;padding:16px;font:16px/1.5 system-ui,sans-serif"><main style="max-width:560px;margin:auto;overflow-wrap:anywhere"><p>${esc(intro)}</p><p><a href="${esc(link.href)}" style="display:inline-block;min-height:44px;box-sizing:border-box;padding:12px 18px;background:#245c46;color:white;border-radius:6px">${esc(button)}</a></p><p>${esc(expiry)}</p><p>${esc(L.t('checkout.explain'))}</p></main></body></html>`
  const basis=await fingerprint({source:s,subject,body,html,expiresAt,wordingVersion:VERSION}),id=newId(),at=clockInstant(env)
  await commit(env,[...setupOwnerFence(env,actor),sourceFence(env,actor,s),
    stmt(env,`INSERT INTO nc_card_expiry_notices(id,customer_id,subscription_id,term_id,cycle,setup_id,binding_id,account_ref,payment_method_ref,renewal_date,due_date,recipient,language,last4,exp_month,exp_year,wording_version,basis_hash,prepared_by,prepared_at,expires_at,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared')`,id,s.customer,s.subscription,s.term,s.cycle,s.setup,s.binding,s.accountRef,s.method.paymentMethodRef,s.renewalDate,s.dueDate,s.recipient,L.tag,s.method.card.last4,s.method.card.expMonth,s.method.card.expYear,VERSION,basis,actor.id,at,expiresAt),
    stmt(env,'INSERT INTO nc_card_expiry_notice_authority(id,customer_id,owner_session_id,portal_session_id,source_json,subject,body,html,from_address,mail_provider) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id,s.customer,actor.sessionId,session.id,canonical(s),subject,body,html,s.from,s.provider)],
  {actor:actorLabel(actor),action:'card.expiry.prepare',subject:s.customer,detail:{notice:id,subscription:s.subscription,setup:s.setup,dueDate:s.dueDate,renewalDate:s.renewalDate,basis,wordingVersion:VERSION,expiresAt}})
  return view(await notice(env,id),await one(env,'SELECT * FROM nc_card_expiry_notice_authority WHERE id=?',id))
}

export async function sendCardExpiryNotice(env:Bindings,actor:Actor,input:Input) {
  await setupOwner(env,actor)
  input.only(['notice','basis_hash','confirm','returnTo'])
  insist(input.flag('confirm'),'card_expiry_confirmation_required')
  const row=await notice(env,input.text('notice',{max:100}))
  insist(row.prepared_by===actor.id,'card_expiry_preparer_required',403)
  insist(input.text('basis_hash',{max:100})===row.basis_hash,'card_expiry_basis_changed',409)
  if(row.status!=='prepared')return {...view(row),replayed:true}
  const authority=await one(env,'SELECT * FROM nc_card_expiry_notice_authority WHERE id=? AND owner_session_id=?',row.id,actor.sessionId)
  insist(authority,'card_expiry_historical_only',409)
  const frozen=parseJson<Row>(authority.source_json,{})
  let current:Row|null=null,reason:string|null=null
  try{
    insist(row.expires_at>clockInstant(env),'card_expiry_link_expired',409)
    current=await source(env,actor,row.customer_id,row.subscription_id,row.setup_id)
    insist(canonical(current)===canonical(frozen),'card_expiry_source_changed',409)
    insist(await fingerprint({source:frozen,subject:authority.subject,body:authority.body,html:authority.html,expiresAt:row.expires_at,wordingVersion:row.wording_version})===row.basis_hash,'card_expiry_basis_changed',409)
    insist(await one(env,`SELECT 1 FROM nc_portal_sessions p JOIN nc_portal_policy policy ON policy.singleton=1 AND policy.revision=p.policy_revision
      WHERE p.id=? AND p.customer_id=? AND p.revoked_at IS NULL AND p.expires_at>?`,authority.portal_session_id,row.customer_id,clockInstant(env)),'card_expiry_session_revoked',409)
  }catch(error){
    if(!(error instanceof NectarError))throw error
    reason=error.code
  }
  const at=clockInstant(env),status=reason?'suppressed':'sending'
  await commit(env,[...setupOwnerFence(env,actor),...(current && !reason?[sourceFence(env,actor,current)]:[]),
    ...(!reason?[guard(env,'card_expiry_session_revoked',`? > ? AND EXISTS(SELECT 1 FROM nc_portal_sessions p JOIN nc_portal_policy policy ON policy.singleton=1 AND policy.revision=p.policy_revision
      WHERE p.id=? AND p.customer_id=? AND p.revoked_at IS NULL AND p.expires_at>?)`,row.expires_at,at,authority.portal_session_id,row.customer_id,at)]:[]),
    guard(env,'card_expiry_already_claimed',"EXISTS(SELECT 1 FROM nc_card_expiry_notices n JOIN nc_customers c ON c.id=n.customer_id JOIN nc_card_expiry_notice_authority a ON a.id=n.id WHERE n.id=? AND n.status='prepared' AND n.basis_hash=? AND a.owner_session_id=? AND c.erased_at IS NULL)",row.id,row.basis_hash,actor.sessionId),
    stmt(env,'UPDATE nc_card_expiry_notices SET status=?,claimed_at=?,error_code=?,finished_at=? WHERE id=?',status,at,reason,reason?at:null,row.id)],
  {actor:actorLabel(actor),action:reason?'card.expiry.suppressed':'card.expiry.claim',subject:row.customer_id,detail:{notice:row.id,basis:row.basis_hash,status,reason}})
  if(reason)return view(await notice(env,row.id))
  let outcome='suppressed',provider:string|null=null
  try{
    const mail=operatorMail(env)
    if(mail && env.MAIL_FROM){
      outcome='uncertain'
      const result=await mail.send({deliveryId:`card-expiry-${row.id}`,from:authority.from_address,to:[row.recipient],subject:authority.subject,text:authority.body,html:authority.html,headers:{'Auto-Submitted':'auto-generated'}})
      outcome=result.status==='accepted'?'accepted':result.status==='development'?'suppressed':['rejected','rate_limited'].includes(result.status)?'failed':'uncertain'
      provider=result.providerMessageId??null
    }
  }catch{/* A lost response cannot establish rejection. Never retry this claim. */}
  await commit(env,[guard(env,'card_expiry_outcome_changed',"EXISTS(SELECT 1 FROM nc_card_expiry_notices WHERE id=? AND status='sending')",row.id),
    stmt(env,'UPDATE nc_card_expiry_notices SET status=?,provider_ref=?,finished_at=? WHERE id=?',outcome,provider,clockInstant(env),row.id)],
  {actor:actorLabel(actor),action:'card.expiry.outcome',subject:row.customer_id,detail:{notice:row.id,status:outcome,providerRef:provider}})
  return view(await notice(env,row.id))
}
