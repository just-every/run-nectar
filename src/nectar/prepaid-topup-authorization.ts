import { unusableMethodGuard } from './card-lifecycle'
// Owner-reviewed quote plus the customer's signed portal acceptance. A merchant
// factor alone never supplies permission for an off-session customer charge.
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, type Actor } from './actor'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { canonical, commit, fingerprint, guard, insist, newId, one, stmt } from './core'
import { cents } from './decimal'
import { requireDate, today } from './dates'
import type { Input } from './input'
import { invoiceContent } from './invoice-content'
import { requireFreshFactor } from './mfa'
import { collectionAuthority, collectionOwner } from './movein/collection-state'
import { customerSession } from './portal-session'
import { prepaidTerms } from './prepaid-records'
import { savedCard, stripeForAccount, providerReference } from './payments/stripe'
import { endTopupAuthorization, storedTopupAuthorization, topupQuote, type TopupQuote } from './prepaid-topup-records'
const other="SELECT 1 FROM nc_members WHERE role IN ('owner','finance') AND status='active' AND id<>?"
export async function preparePrepaidTopupAuthorization(env:Bindings,actor:Actor,input:Input){
  await collectionOwner(env,actor)
  const consent=await one(env,"SELECT * FROM nc_prepaid_consents WHERE id=? AND status='active'",input.text('consent',{max:100}))
  insist(consent,'prepaid_consent_not_found',404)
  const terms=prepaidTerms(consent),business=await requireBusiness(env),date=today(business.timezone,clockInstant(env))
  insist(business.currency==='USD','topup_currency_unsupported',409)
  const startDate=requireDate(input.text('start_date',{max:10}),'start_date'),endDate=requireDate(input.text('end_date',{max:10}),'end_date')
  const periodCapCents=cents(input.text('period_cap',{max:20}),'period_cap'),accountRef=providerReference(input.text('account_ref',{max:255}))
  insist(startDate>=date&&endDate>startDate&&(!terms.expiresDate||endDate<=terms.expiresDate)&&terms.source==='purchase'&&terms.valueCents>=50&&terms.valueCents<=99999999&&periodCapCents>=terms.valueCents&&Number.isSafeInteger(periodCapCents),'topup_terms_invalid')
  const binding=await one(env,'SELECT * FROM nc_stripe_customer_bindings WHERE customer_id=? AND account_ref=?',consent.customer_id,accountRef)
  insist(binding,'native_customer_binding_required',409)
  const selected=await stripeForAccount(env,accountRef),card=await savedCard(selected.stripe,binding.stripe_customer_ref),content=await invoiceContent(env,business,consent.customer_id)
  insist(!content.billingEntity||content.billingEntity.route.processorAccountRef===accountRef,'topup_entity_account_changed',409)
  const customer=await one(env,'SELECT revision FROM nc_customers WHERE id=? AND erased_at IS NULL',consent.customer_id);insist(customer,'customer_not_found',404)
  const id=newId(),quote:TopupQuote={subscription:consent.subscription_id,customer:consent.customer_id,consent:consent.id,request:consent.request_id,owner:actor.id,terms,consentTermsJson:consent.terms_json,timezone:business.timezone,businessRevision:business.revision,customerRevision:customer.revision,thresholdN:consent.threshold_n,amountCents:terms.valueCents,periodCapCents,period:'business_calendar_month',currency:'usd',startDate,endDate,bindingId:binding.id,bindingRevision:binding.revision,accountRef,customerRef:card.customerRef,paymentMethodRef:card.paymentMethodRef,livemode:card.livemode,card:card.card,content,revokePath:'/portal/prepaid-topup.revoke',fundingEffective:'captured-payment-date',capRule:'all claimed amounts, including unknown outcomes'}
  const basis=await fingerprint(quote),at=clockInstant(env)
  await commit(env,[collectionAuthority(env,actor),unusableMethodGuard(env,accountRef,card.customerRef,card.paymentMethodRef),guard(env,'topup_terms_changed',"EXISTS(SELECT 1 FROM nc_prepaid_consents WHERE id=? AND status='active' AND terms_json=? AND threshold_n=?)",consent.id,consent.terms_json,consent.threshold_n),
    stmt(env,"INSERT INTO nc_prepaid_topup_authorizations(id,consent_id,subscription_id,customer_id,quote_json,basis_hash,start_date,end_date,prepared_by_id,prepared_at,status) VALUES(?,?,?,?,?,?,?,?,?,?,'awaiting_customer')",id,consent.id,consent.subscription_id,consent.customer_id,canonical(quote),basis,startDate,endDate,actor.id,at)],{actor:actorLabel(actor),action:'prepaid.topup.authorization.prepare',subject:id,detail:{basis,customer:consent.customer_id,amountCents:terms.valueCents,periodCapCents}})
  return {id,status:'awaiting_customer',basis,quote}
}
export async function portalPrepaidTopupAuthorization(env:Bindings,request:Request,id:string){
  const session=await customerSession(env,request),row=await storedTopupAuthorization(env,id)
  insist(row.customer_id===session.customer,'topup_authorization_not_found',404)
  const q=topupQuote(row)
  return {id:row.id,status:row.status,basis:row.basis_hash,quote:{subscription:q.subscription,kind:q.terms.kind,grantAmountN:q.terms.amountN,thresholdN:q.thresholdN,amountCents:q.amountCents,periodCapCents:q.periodCapCents,period:q.period,currency:q.currency,timezone:q.timezone,startDate:q.startDate,endDate:q.endDate,accountRef:q.accountRef,customerRef:q.customerRef,paymentMethodRef:q.paymentMethodRef,card:q.card,grantTerms:q.terms,revokePath:q.revokePath,capRule:q.capRule}}
}
export async function acceptPrepaidTopupAuthorization(env:Bindings,request:Request,input:Input){
  const session=await customerSession(env,request)
  insist(request.method==='POST'&&request.headers.get('origin')===session.origin,'forbidden',403)
  const row=await storedTopupAuthorization(env,input.text('authorization',{max:100})),basis=input.text('basis_hash',{max:100})
  insist(row.customer_id===session.customer,'topup_authorization_not_found',404)
  insist(input.flag('accept')&&row.status==='awaiting_customer'&&basis===row.basis_hash,'topup_acceptance_changed',409)
  const at=clockInstant(env)
  await commit(env,[guard(env,'topup_acceptance_changed',"EXISTS(SELECT 1 FROM nc_prepaid_topup_authorizations WHERE id=? AND status='awaiting_customer' AND basis_hash=?) AND EXISTS(SELECT 1 FROM nc_portal_sessions WHERE id=? AND customer_id=? AND revoked_at IS NULL AND issued_at<=? AND expires_at>?)",row.id,basis,session.jti,session.customer,at,at),
    stmt(env,"UPDATE nc_prepaid_topup_authorizations SET status='pending',customer_session_id=?,accepted_at=?,accepted_basis_hash=? WHERE id=?",session.jti,at,basis,row.id)],{actor:`customer:${session.customer}`,action:'prepaid.topup.authorization.accept',subject:row.id,detail:{basis,source:'authenticated-portal-acceptance',session:session.jti}})
  return {id:row.id,status:'pending',basis}
}
export async function decidePrepaidTopupAuthorization(env:Bindings,actor:Actor,input:Input){
  requireMember(actor,'approve');await requireFreshFactor(env,actor)
  const row=await storedTopupAuthorization(env,input.text('authorization',{max:100})),decision=input.text('decision',{max:10})
  insist(['approved','rejected'].includes(decision)&&row.status==='pending','topup_authorization_not_pending',409)
  insist(input.text('basis_hash',{max:100})===row.basis_hash&&row.accepted_basis_hash===row.basis_hash&&await fingerprint(topupQuote(row))===row.basis_hash,'topup_acceptance_changed',409)
  const single=actor.id===row.prepared_by_id
  if(single){await collectionOwner(env,actor);insist(input.flag('confirm_single')&&!await one(env,other,actor.id),'second_approver_required',409)}
  const at=clockInstant(env),statements=[guard(env,'topup_authorization_not_pending',"EXISTS(SELECT 1 FROM nc_prepaid_topup_authorizations WHERE id=? AND status='pending' AND basis_hash=? AND accepted_basis_hash=basis_hash)",row.id,row.basis_hash),
    guard(env,'forbidden',"EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','finance')) AND EXISTS(SELECT 1 FROM nc_members m JOIN oa_operators o ON o.email=m.email WHERE m.id=? AND m.role='owner' AND m.status='active' AND o.role='owner' AND o.status='active')",actor.id,row.prepared_by_id),...(single?[guard(env,'second_approver_required',`NOT EXISTS(${other})`,actor.id)]:[]),
    stmt(env,'UPDATE nc_prepaid_topup_authorizations SET status=?,approved_by_id=?,approved_at=?,approval_mode=? WHERE id=?',decision==='approved'?'active':'rejected',actor.id,at,single?'single-approver':'two-person',row.id)]
  if(decision==='approved')statements.push(stmt(env,'INSERT INTO nc_prepaid_topup_states(authorization_id,customer_id,subscription_id,armed,cycle,revision) VALUES(?,?,?,1,0,0)',row.id,row.customer_id,row.subscription_id))
  await commit(env,statements,{actor:actorLabel(actor),action:`prepaid.topup.authorization.${decision}`,subject:row.id,detail:{basis:row.basis_hash,customerAcceptance:row.customer_session_id,approvalMode:single?'single-approver':'two-person'}})
  return {id:row.id,status:decision==='approved'?'active':'rejected',basis:row.basis_hash}
}
export async function revokePrepaidTopupAuthorization(env:Bindings,actor:Actor,input:Input){await collectionOwner(env,actor);const row=await storedTopupAuthorization(env,input.text('authorization',{max:100}));await endTopupAuthorization(env,row,'revoked',actorLabel(actor));return {id:row.id,status:'revoked'}}
export async function revokePortalPrepaidTopupAuthorization(env:Bindings,request:Request,input:Input){
  const session=await customerSession(env,request);insist(request.method==='POST'&&request.headers.get('origin')===session.origin,'forbidden',403)
  const row=await storedTopupAuthorization(env,input.text('authorization',{max:100}));insist(row.customer_id===session.customer,'topup_authorization_not_found',404)
  await endTopupAuthorization(env,row,'revoked',`customer:${session.customer}`);return {id:row.id,status:'revoked'}
}
