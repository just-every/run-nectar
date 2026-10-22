// Stored customer authorization and one immutable attempt per balance crossing.
import type { Bindings } from '../auth.server'
import { requireMember, requireOwner, type Actor } from './actor'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, canonical, commit, fingerprint, guard, insist, newId, one, parseJson, stmt, type Row } from './core'
import { today } from './dates'
import { invoiceContent, type InvoiceContent } from './invoice-content'
import { lotStates } from './prepaid-math'
import { prepaidSnapshot } from './prepaid-records'
import type { PrepaidTerms } from './prepaid-types'
import { savedCard, stripeForAccount } from './payments/stripe'
export interface TopupQuote {
  subscription:string; customer:string; consent:string; request:string; owner:string
  terms:PrepaidTerms; consentTermsJson:string; thresholdN:number; amountCents:number; periodCapCents:number; period:'business_calendar_month'
  timezone:string; businessRevision:number; customerRevision:string
  startDate:string; endDate:string; bindingId:string; bindingRevision:string; accountRef:string; customerRef:string
  paymentMethodRef:string; livemode:boolean; card:{brand:string;last4:string;expMonth:number;expYear:number}
  content:InvoiceContent; revokePath:string; fundingEffective:'purchase-date'; capRule:'all claimed amounts, including unknown outcomes'
}
export const topupQuote=(row:Row)=>parseJson<TopupQuote>(row.quote_json,null as never)
export async function storedTopupAuthorization(env:Bindings,id:string){
  const row=await one(env,'SELECT a.* FROM nc_prepaid_topup_authorizations a JOIN nc_customers c ON c.id=a.customer_id WHERE a.id=? AND c.erased_at IS NULL',id)
  insist(row,'topup_authorization_not_found',404);return row
}
export function topupAuthorizationGuard(env:Bindings,row:Row){
  const q=topupQuote(row),at=clockInstant(env)
  return guard(env,'topup_authorization_changed',`EXISTS(SELECT 1 FROM nc_prepaid_topup_authorizations a
    JOIN nc_prepaid_consents p ON p.id=a.consent_id JOIN nc_members m ON m.id=a.prepared_by_id
    JOIN oa_operators o ON o.email=m.email JOIN nc_members f ON f.id=a.approved_by_id
    JOIN nc_customers c ON c.id=a.customer_id
    JOIN nc_stripe_customer_bindings b ON b.id=?
    WHERE a.id=? AND a.status='active' AND a.basis_hash=? AND a.accepted_basis_hash=a.basis_hash
    AND p.status='active' AND p.terms_json=? AND p.threshold_n=? AND m.role='owner' AND m.status='active' AND o.role='owner' AND o.status='active'
    AND f.status='active' AND f.role IN ('owner','finance') AND a.customer_session_id IS NOT NULL AND a.accepted_at IS NOT NULL AND c.status='active' AND c.erased_at IS NULL
    AND b.customer_id=a.customer_id AND b.account_ref=? AND b.stripe_customer_ref=? AND b.revision=?
    AND a.start_date<=? AND a.end_date>? AND a.approved_at<=?)`,q.bindingId,row.id,row.basis_hash,q.consentTermsJson,q.thresholdN,q.accountRef,q.customerRef,q.bindingRevision,today(q.timezone,at),today(q.timezone,at),at)
}
export async function topupBalance(env:Bindings,q:TopupQuote){
  const basis=await prepaidSnapshot(env,q.subscription);insist(basis,'prepaid_account_not_found',404)
  const date=today((await requireBusiness(env)).timezone,clockInstant(env))
  const balance=lotStates(basis).filter(lot=>lot.grant.kind===q.terms.kind&&lot.grant.meterId===q.terms.meterId&&lot.grant.effectiveDate<=date&&(!lot.grant.expiresDate||lot.grant.expiresDate>date)).reduce((sum,lot)=>sum+lot.remainingN,0)
  return {basis,balance,date}
}
export async function currentTopupAuthorization(env:Bindings,id:string){
  const row=await storedTopupAuthorization(env,id),q=topupQuote(row),business=await requireBusiness(env)
  const date=today(business.timezone,clockInstant(env))
  insist(business.timezone===q.timezone&&business.revision===q.businessRevision,'topup_content_changed',409)
  insist(row.status==='active','topup_authorization_inactive',409)
  if(date>=q.endDate){await endTopupAuthorization(env,row,'expired');insist(false,'topup_authorization_expired',409)}
  insist(date>=q.startDate,'topup_authorization_not_started',409)
  const consent=await one(env,"SELECT * FROM nc_prepaid_consents WHERE id=? AND status='active'",q.consent)
  insist(consent&&canonical(parseJson(consent.terms_json,{}))===canonical(q.terms)&&consent.threshold_n===q.thresholdN,'topup_terms_changed',409)
  insist(await fingerprint(q)===row.basis_hash&&canonical(await invoiceContent(env,business,q.customer))===canonical(q.content),'topup_content_changed',409)
  insist(await one(env,'SELECT 1 FROM nc_customers WHERE id=? AND revision=? AND erased_at IS NULL',q.customer,q.customerRevision),'topup_content_changed',409)
  const binding=await one(env,'SELECT * FROM nc_stripe_customer_bindings WHERE id=? AND revision=? AND customer_id=? AND account_ref=? AND stripe_customer_ref=?',q.bindingId,q.bindingRevision,q.customer,q.accountRef,q.customerRef)
  insist(binding,'topup_card_binding_changed',409)
  const selected=await stripeForAccount(env,q.accountRef),card=await savedCard(selected.stripe,q.customerRef)
  if(canonical(card)!==canonical({customerRef:q.customerRef,paymentMethodRef:q.paymentMethodRef,livemode:q.livemode,card:q.card})){
    await endTopupAuthorization(env,row,'card_changed');insist(false,'topup_card_changed',409)
  }
  return {row,q,selected,...await topupBalance(env,q)}
}
export async function endTopupAuthorization(env:Bindings,row:Row,status:'revoked'|'card_changed'|'expired',actor='prepaid-policy'){
  if(!['active','awaiting_customer','pending'].includes(row.status))return
  await commit(env,[stmt(env,"UPDATE nc_prepaid_topup_authorizations SET status=?,ended_at=? WHERE id=? AND status IN ('active','awaiting_customer','pending')",status,clockInstant(env),row.id)],{actor,action:`prepaid.topup.${status}`,subject:row.id,detail:{customer:row.customer_id}})
}
export function publicTopupQuote(q:TopupQuote){
  return {subscription:q.subscription,customer:q.customer,terms:q.terms,thresholdN:q.thresholdN,amountCents:q.amountCents,periodCapCents:q.periodCapCents,period:q.period,timezone:q.timezone,startDate:q.startDate,endDate:q.endDate,accountRef:q.accountRef,customerRef:q.customerRef,paymentMethodRef:q.paymentMethodRef,livemode:q.livemode,card:q.card,revokePath:q.revokePath,fundingEffective:q.fundingEffective,capRule:q.capRule,paymentTermsDays:q.content.paymentTermsDays}
}
export async function readPrepaidTopupAuthorizations(env:Bindings,actor:Actor,subscription?:string){
  requireMember(actor,'approve')
  const rows=await all(env,`SELECT a.* FROM nc_prepaid_topup_authorizations a JOIN nc_customers c ON c.id=a.customer_id WHERE c.erased_at IS NULL ${subscription?'AND a.subscription_id=?':''} ORDER BY a.prepared_at,a.id`,...(subscription?[subscription]:[]))
  return rows.map(row=>({id:row.id,status:row.status,basis:row.basis_hash,quote:publicTopupQuote(topupQuote(row)),preparedBy:row.prepared_by_id,acceptedAt:row.accepted_at,approvedAt:row.approved_at,acceptance:row.customer_session_id?{kind:'authenticated-portal-acceptance',sourceId:row.customer_session_id,customer:row.customer_id,basis:row.accepted_basis_hash,acceptedAt:row.accepted_at}:null,source:row.customer_session_id?`/app/prepaid/topup-authorizations/${row.id}`:null}))
}
export async function readPrepaidTopupClaims(env:Bindings,actor:Actor,subscription?:string){
  requireOwner(actor)
  return all(env,`SELECT x.id,x.authorization_id,x.subscription_id,x.period,x.cycle,x.amount_cents,x.status,x.invoice_id,x.payment_id,x.error_code,x.claimed_at,x.payment_intent_ref,x.charge_ref FROM nc_prepaid_topup_claims x JOIN nc_customers c ON c.id=x.customer_id WHERE c.erased_at IS NULL ${subscription?'AND x.subscription_id=?':''} ORDER BY x.claimed_at,x.id`,...(subscription?[subscription]:[]))
}
export const topupRuntimeOwner=(env:Bindings,actor:Actor)=>{requireOwner(actor);return guard(env,'forbidden',"EXISTS(SELECT 1 FROM nc_members m JOIN oa_operators o ON o.email=m.email WHERE m.id=? AND m.role='owner' AND m.status='active' AND o.role='owner' AND o.status='active')",actor.id)}
