// A separately approved link policy installs the existing native renewal term.
// Customer cancellation and optional retention stay in the existing public
// renewal engine; this module grants no payment or member action authority.
import type { Bindings } from '../auth.server'
import { clockInstant } from './clock'
import { canonical, commit, guard, insist, newId, one, parseJson, stmt, type Audit, type Row } from './core'
import { requireDate, today } from './dates'
import { Input } from './input'
import { frozenPaymentLinkTerms, activeLinkGuard, linkOwnerGuard } from './payment-links'
import { attemptGuard } from './payment-links-state'
import { newCancellationLink, renewalSettings } from './renewal-terms'
import { prepareSaveOffer } from './retention-offers'

export interface PaymentLinkRenewalSettings {
  months: number
  auto_renew: 0|1
  notice_days: number
  uplift_percent: string
}

/** Owner choices are explicit, including a false renewal choice and zero
 * uplift. The validation-only calendar is discarded when no start is supplied;
 * no subscription date or commercial default is invented here. */
export function paymentLinkRenewalSettings(input:Input,start?:string):PaymentLinkRenewalSettings {
  for(const field of ['months','auto_renew','notice_days','uplift_percent'])insist(input.has(field),`missing_${field}`)
  const auto=input.json('auto_renew')
  insist(auto===true||auto===false,'invalid_auto_renew')
  const settings=renewalSettings(Input.of({months:input.integer('months',{min:1,max:120}),auto_renew:auto,
    notice_days:input.integer('notice_days',{min:1,max:365}),uplift_percent:input.text('uplift_percent',{max:24})}),
    start===undefined?'2000-01-01':requireDate(start,'term_start'))
  return {months:settings.months,auto_renew:settings.auto_renew?1:0,notice_days:settings.notice_days,uplift_percent:settings.uplift_percent}
}

function configuredRenewal(terms:Row,start:string) {
  const saved=terms.renewal
  insist(saved&&typeof saved==='object'&&!Array.isArray(saved)
    &&(saved.auto_renew===0||saved.auto_renew===1),'payment_link_renewal_required',409)
  const normalized=paymentLinkRenewalSettings(Input.of({...saved,auto_renew:saved.auto_renew===1}),start)
  insist(canonical(normalized)===canonical(saved),'payment_link_terms_changed',409)
  return renewalSettings(Input.of({...normalized,auto_renew:normalized.auto_renew===1}),start)
}

function renewalPolicyGuard(env:Bindings,link:Row) {
  return guard(env,'payment_link_approval_changed',`EXISTS(SELECT 1 FROM nc_payment_links l
    JOIN nc_members p ON p.id=l.created_by JOIN oa_operators po ON lower(po.email)=p.email
    JOIN nc_members a ON a.id=l.approved_by JOIN oa_operators ao ON lower(ao.email)=a.email
    WHERE l.id=? AND l.basis_hash=? AND l.status='active' AND l.created_by=? AND l.approved_by=?
    AND l.approval_mode=? AND l.approved_at=? AND p.status='active' AND p.role='owner'
    AND po.status='active' AND po.role='owner' AND a.status='active' AND a.role IN ('owner','finance')
    AND ao.status='active' AND ((a.role='owner' AND ao.role='owner') OR (a.role='finance' AND ao.role IN ('owner','operator')))
    AND ((l.approval_mode='two-person' AND l.created_by<>l.approved_by)
      OR (l.approval_mode='single-approver' AND l.created_by=l.approved_by)))`,
    link.id,link.basis_hash,link.created_by,link.approved_by,link.approval_mode,link.approved_at)
}

/** Append after the new native customer and subscription inserts, inside their
 * atomic batch. The subscription must already carry this returned endDate and
 * the supplied exact revision. The parent's link approval owns the independent
 * approval or explicit sole-owner second confirmation; this is its execution. */
export async function paymentLinkRenewalStatements(env:Bindings,link:Row,row:Row,customerId:string,subscriptionId:string,subRevision:string,at:number) {
  const terms=await frozenPaymentLinkTerms(link,row) as unknown as Row
  insist(terms.kind==='subscription'&&row.link_id===link.id,'payment_link_terms_changed',409)
  const settings=configuredRenewal(terms,row.start_date),consent=parseJson<Row>(row.consent_json,{})
  insist(canonical(consent.renewal)===canonical(terms.renewal),'payment_link_terms_changed',409)
  insist(!row.trial_end||row.trial_end<settings.end_date,'invalid_trial_end')
  insist(typeof link.approved_by==='string'&&link.approved_by&&Number.isSafeInteger(link.approved_at)
    &&link.approved_at>0&&link.approved_at<=at&&['single-approver','two-person'].includes(link.approval_mode),'payment_link_approval_required',409)
  insist(link.approval_mode==='single-approver'?link.approved_by===link.created_by:link.approved_by!==link.created_by,'second_approver_required',409)
  const [preparer,approver]=await Promise.all([
    one(env,"SELECT id,email FROM nc_members WHERE id=? AND status='active' AND role='owner'",link.created_by),
    one(env,"SELECT id,email FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','finance')",link.approved_by),
  ])
  insist(preparer&&approver,'payment_link_approval_changed',409)
  const termId=newId(),revision=newId(),quote=canonical({source:'payment-link',link:link.id,basis:link.basis_hash,consentHash:row.consent_hash,renewal:terms.renewal})
  const statements=[activeLinkGuard(env,link),linkOwnerGuard(env,link),renewalPolicyGuard(env,link),attemptGuard(env,row),
    guard(env,'payment_link_terms_changed',`EXISTS(SELECT 1 FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id
      WHERE s.id=? AND s.customer_id=? AND s.revision=? AND s.start_date=? AND s.billing_anchor_date=?
      AND s.end_date=? AND s.billing_mode='live' AND c.status='active' AND c.erased_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM nc_renewal_terms WHERE subscription_id=? AND status='active')`,
      subscriptionId,customerId,subRevision,row.start_date,row.start_date,settings.end_date,subscriptionId),
    stmt(env,`INSERT INTO nc_renewal_terms(id,subscription_id,subscription_revision,start_date,end_date,months,auto_renew,notice_days,uplift_percent,status,prepared_by_id,prepared_by,created_at,revision,quote,decided_by,decided_at,approval_mode)
      VALUES(?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?,?,?,?)`,termId,subscriptionId,subRevision,settings.start_date,settings.end_date,settings.months,settings.auto_renew,settings.notice_days,settings.uplift_percent,
      preparer.id,preparer.email,at,revision,quote,approver.email,link.approved_at,link.approval_mode)]
  const audits:Audit[]=[
    {actor:preparer.email,action:'term.prepare',subject:termId,detail:{subscription:subscriptionId,link:link.id,policyBasis:link.basis_hash,...settings}},
    {actor:approver.email,action:'term.approved',subject:termId,detail:{subscription:subscriptionId,link:link.id,mode:link.approval_mode,preparedBy:preparer.id,approvedBy:approver.id,policyApprovedAt:link.approved_at,consentHash:row.consent_hash}},
    {actor:'customer:payment-link',action:'payment_link.renewal.install',subject:subscriptionId,detail:{term:termId,link:link.id,end:settings.end_date,debitAuthority:false}},
  ]
  return {statements,audits,termId,endDate:settings.end_date}
}

/** Internal caller first resolves paymentLinkAttempt from the request's opaque
 * cookie and enforces same-origin POST. Never call from GET: token rotation and
 * preparing the optional approved save are mutations. No raw token is audited
 * or persisted; the returned URL goes only to this customer's response. */
export async function issuePaymentLinkCancellation(env:Bindings,link:Row,attempt:Row) {
  const at=clockInstant(env),terms=await frozenPaymentLinkTerms(link,attempt) as unknown as Row
  insist(terms.kind==='subscription'&&attempt.link_id===link.id&&attempt.status==='complete'
    &&attempt.customer_id&&attempt.subscription_id&&typeof attempt.token_hash==='string'
    &&/^[a-f0-9]{64}$/.test(attempt.token_hash)&&attempt.expires_at>at,'payment_link_return_required',401)
  const term=await one(env,`SELECT t.* FROM nc_renewal_terms t
    JOIN nc_subscriptions s ON s.id=t.subscription_id JOIN nc_customers c ON c.id=s.customer_id
    JOIN nc_payment_link_attempts a ON a.subscription_id=s.id AND a.customer_id=c.id
    WHERE a.id=? AND a.link_id=? AND a.token_hash=? AND a.status='complete' AND a.expires_at>?
    AND c.id=? AND s.id=? AND c.status='active' AND c.erased_at IS NULL AND s.billing_mode='live'
    AND t.status='active' AND t.cancelled_at IS NULL AND s.end_date=t.end_date
    AND json_extract(t.quote,'$.source')='payment-link' AND json_extract(t.quote,'$.link')=?
    AND json_extract(t.quote,'$.basis')=?
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(a.id,c.id,s.id,t.id))`,
    attempt.id,link.id,attempt.token_hash,at,attempt.customer_id,attempt.subscription_id,link.id,link.basis_hash)
  insist(term&&today(terms.timezone,at)<term.end_date,'term_not_found',404)
  const cancellation=await newCancellationLink(env,term)
  await commit(env,[attemptGuard(env,attempt),guard(env,'stale',`EXISTS(SELECT 1 FROM nc_renewal_terms t JOIN nc_subscriptions s ON s.id=t.subscription_id
      WHERE t.id=? AND t.subscription_id=? AND t.revision=? AND t.status='active' AND t.cancelled_at IS NULL
      AND t.end_date=? AND s.customer_id=? AND s.end_date=t.end_date
      AND json_extract(t.quote,'$.link')=? AND json_extract(t.quote,'$.basis')=?)`,
      term.id,attempt.subscription_id,term.revision,term.end_date,attempt.customer_id,link.id,link.basis_hash),
    stmt(env,'UPDATE nc_renewal_terms SET token_hash=? WHERE id=?',cancellation.hash,term.id)],
    {actor:'customer:payment-link',action:'term.link.rotate',subject:term.id,detail:{subscription:attempt.subscription_id,link:link.id,attempt:attempt.id}})
  await prepareSaveOffer(env,{...term,token_hash:cancellation.hash})
  return {id:attempt.subscription_id,term:term.id,cancelUrl:cancellation.url}
}
