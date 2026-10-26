import { paymentLinkRenewalStatements } from './payment-links-renewals'
// Native records are installed together only after verified hosted capture.
// Public consent grants this exact signup, never member privileges or a debit.
import type { Bindings } from '../auth.server'
import { clockInstant } from './clock'
import { canonical, commit, guard, insist, newId, one, type Row, stmt } from './core'
import { activeLinkGuard, currentLinkTerms, linkOwnerGuard, linkTermsGuards } from './payment-links'
import { attemptGuard, paymentLinkAttemptView } from './payment-links-state'
import type { HostedSetupMethod } from './payments/hosted-setup'
import { paymentLinkPromotionStatements } from './payment-links-promotions'

export async function completePaymentLink(env: Bindings, link: Row, attempt: Row, method: HostedSetupMethod) {
  const terms=await currentLinkTerms(env,link)
  insist(attempt.customer_ref && attempt.session_ref && method.kind==='card','payment_link_evidence_mismatch',409)
  insist(!await one(env,'SELECT 1 FROM nc_customers WHERE lower(billing_email)=?',attempt.billing_email),'payment_link_existing_customer',409)
  const customer=newId(),subscription=newId(),binding=newId(),subRevision=newId(),at=clockInstant(env),by='customer:payment-link'
  const anchor=Math.min(Number(attempt.start_date.slice(8)),28)
  const safeMethod={methodRef:method.methodRef,type:'card',brand:method.brand,last4:method.last4,expMonth:method.expMonth,expYear:method.expYear}
  const renewal=await paymentLinkRenewalStatements(env,link,attempt,customer,subscription,subRevision,at)
  const promotion=await paymentLinkPromotionStatements(env,terms.promotion,attempt,customer,subscription,terms.items)
  await commit(env,[activeLinkGuard(env,link),linkOwnerGuard(env,link),attemptGuard(env,attempt),...linkTermsGuards(env,terms),
    guard(env,'payment_link_existing_customer','NOT EXISTS(SELECT 1 FROM nc_customers WHERE lower(billing_email)=?)',attempt.billing_email),
    stmt(env,`INSERT INTO nc_customers(id,external_id,name,billing_email,address,language,currency,origin,revision,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'USD','native',?,?,?)`,customer,`PL-${attempt.id}`,attempt.name,attempt.billing_email,attempt.address,attempt.language,newId(),at,at),
    stmt(env,`INSERT INTO nc_subscriptions(id,customer_id,anchor_day,start_date,trial_end,trial_payment,billing_anchor_date,end_date,billing_mode,origin,revision,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,'live','native',?,?,?,?)`,subscription,customer,anchor,attempt.start_date,attempt.trial_end,attempt.trial_end?'card':null,attempt.start_date,renewal.endDate,subRevision,by,at,at),
    ...terms.items.map(item=>stmt(env,"INSERT INTO nc_items(id,subscription_id,price_id,quantity,effective_from,origin,created_at) VALUES(?,?,?,?,?,'native',?)",newId(),subscription,item.price,item.quantity,attempt.start_date,at)),
    ...promotion,...renewal.statements,
    stmt(env,'INSERT INTO nc_stripe_customer_bindings(id,customer_id,account_ref,stripe_customer_ref,revision,created_by,created_at) VALUES(?,?,?,?,?,?,?)',binding,customer,link.account_ref,attempt.customer_ref,newId(),by,at),
    stmt(env,`INSERT INTO nc_payment_link_attributions(id,link_id,customer_id,subscription_id,account_ref,customer_ref,session_ref,method_json,consent_hash,default_choice,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,attempt.id,link.id,customer,subscription,link.account_ref,attempt.customer_ref,attempt.session_ref,canonical(safeMethod),attempt.consent_hash,attempt.default_choice,at),
    stmt(env,"UPDATE nc_payment_link_attempts SET status='complete',customer_id=?,subscription_id=?,method_json=?,completed_at=?,revision=? WHERE id=?",customer,subscription,canonical(safeMethod),at,newId(),attempt.id),
    guard(env,'payment_link_state_changed','EXISTS(SELECT 1 FROM nc_payment_links WHERE id=? AND reserved_count>0)',link.id),
    stmt(env,'UPDATE nc_payment_links SET used_count=used_count+1,reserved_count=reserved_count-1 WHERE id=?',link.id)],
    [...renewal.audits,{actor:by,action:'customer.create',subject:customer,detail:{link:link.id,language:attempt.language}},
      {actor:by,action:'subscription.create',subject:subscription,detail:{customer,link:link.id,start:attempt.start_date,trialEnd:attempt.trial_end,items:terms.items.map(item=>({price:item.price,quantity:item.quantity})),debitAuthority:false}},
      {actor:by,action:'collection.customer.bind',subject:binding,detail:{customer,accountRef:link.account_ref}},
      {actor:by,action:'payment_link.complete',subject:attempt.id,detail:{customer,subscription,link:link.id,consentHash:attempt.consent_hash,debitAuthority:false}}])
  return paymentLinkAttemptView((await one(env,'SELECT * FROM nc_payment_link_attempts WHERE id=?',attempt.id))!)
}
