import { deliverPrepaidRefundNotice } from './prepaid-refund-mail'
// Human authorization is distinct from the processor attempt and its receipt.
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, type Actor } from './actor'
import { clockInstant } from './clock'
import { canonical, commit, fingerprint, guard, insist, newId, one, stmt } from './core'
import type { Input } from './input'
import { requireFreshFactor } from './mfa'
import { canReadPrepaidRefundPrivate } from './prepaid-refund-access'
import { refundIntakeForPreparation } from './prepaid-refund-intake'
import { prepaidRevisionGuard } from './prepaid-records'
import { inspectRefundCharge, executePrepaidRefund } from './prepaid-refund-processor'
import { prepaidRefundSource, prepaidRefundView, refundActorGuard, refundQuote, storedPrepaidRefund, type PrepaidRefundQuote } from './prepaid-refund-records'
export async function preparePrepaidRefund(env:Bindings,actor:Actor,input:Input){
  requireMember(actor,'approve');insist(await canReadPrepaidRefundPrivate(env,actor),'forbidden',403);await requireFreshFactor(env,actor)
  const intake=input.has('refund')?await refundIntakeForPreparation(env,input.text('refund',{max:100})):null
  const source=await prepaidRefundSource(env,intake?.grant_id??input.text('grant',{max:100})),{grant,lot,basis,proof,business}=source
  insist(intake||!await one(env,"SELECT 1 FROM nc_prepaid_refund_intakes WHERE grant_id=? AND status='pending'",grant.id),'prepaid_refund_intake_review_required',409)
  const reason=input.text('reason',{max:500}),live=await inspectRefundCharge(env,{accountRef:proof.accountRef,customerRef:proof.customerRef,paymentMethodRef:proof.paymentMethodRef,paymentIntentRef:proof.paymentIntentRef,chargeRef:proof.chargeRef,originalAmountCents:grant.value_cents,amountCents:lot.liabilityCents,livemode:proof.livemode})
  const quote:PrepaidRefundQuote={grant:grant.id,subscription:grant.subscription_id,customer:grant.customer_id,revision:basis.revision,amountN:lot.remainingN,amountCents:lot.liabilityCents,kind:grant.kind,invoice:grant.purchase_invoice_id,purchaseLine:grant.purchase_line_id,sourceFingerprint:grant.source_fingerprint,payment:grant.payment_id,funding:grant.funding_id,accountRef:proof.accountRef,customerRef:proof.customerRef,paymentMethodRef:proof.paymentMethodRef,paymentIntentRef:proof.paymentIntentRef,chargeRef:proof.chargeRef,originalAmountCents:grant.value_cents,refundedBeforeCents:live.charge.amount_refunded,livemode:proof.livemode,timezone:business.timezone,routeJson:grant.billing_route_json,entityId:grant.billing_entity_id??null,customerRevision:grant.customer_revision,businessRevision:business.revision,sourceHash:source.sourceHash}
  const id=intake?.id??newId(),hash=await fingerprint(quote)
  await commit(env,[refundActorGuard(env,actor),...(intake?[guard(env,'prepaid_refund_not_pending',"EXISTS(SELECT 1 FROM nc_prepaid_refund_intakes WHERE id=? AND status='pending')",intake.id),stmt(env,"UPDATE nc_prepaid_refund_intakes SET status='prepared' WHERE id=?",intake.id)]:[]),prepaidRevisionGuard(env,quote.subscription,basis.revision),stmt(env,"INSERT INTO nc_prepaid_refunds(id,grant_id,subscription_id,customer_id,purchase_invoice_id,payment_id,amount_n,amount_cents,quote_json,basis_hash,reason,prepared_by_id,prepared_at,status,intent_key,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)",id,quote.grant,quote.subscription,quote.customer,quote.invoice,quote.payment,quote.amountN,quote.amountCents,canonical(quote),hash,reason,actor.id,clockInstant(env),newId(),newId())],{actor:actorLabel(actor),action:'prepaid.refund.prepare',subject:id,detail:{basis:hash,grant:quote.grant,amountN:quote.amountN,amountCents:quote.amountCents}})
  return prepaidRefundView((await one(env,'SELECT r.*,t.requested_by_id,t.requested_by_kind,t.requested_at FROM nc_prepaid_refunds r LEFT JOIN nc_prepaid_refund_intakes t ON t.id=r.id WHERE r.id=?',id))!)
}
export async function decidePrepaidRefund(env:Bindings,actor:Actor,input:Input){
  requireMember(actor,'approve');await requireFreshFactor(env,actor)
  const row=await storedPrepaidRefund(env,input.text('refund',{max:100})),decision=input.text('decision',{max:10})
  insist(row.status==='pending'&&['approved','rejected'].includes(decision),'prepaid_refund_not_pending',409)
  const pending=guard(env,'prepaid_refund_not_pending',"EXISTS(SELECT 1 FROM nc_prepaid_refunds WHERE id=? AND status='pending')",row.id)
  if(decision==='rejected'){await commit(env,[refundActorGuard(env,actor),pending,stmt(env,"UPDATE nc_prepaid_refunds SET status='rejected',approved_by_id=?,approved_at=? WHERE id=?",actor.id,clockInstant(env),row.id)],{actor:actorLabel(actor),action:'prepaid.refund.reject',subject:row.id});return {id:row.id,status:'rejected'}}
  const quote=refundQuote(row),source=await prepaidRefundSource(env,quote.grant)
  insist(input.text('basis_hash',{max:100})===row.basis_hash&&await fingerprint(quote)===row.basis_hash&&source.sourceHash===quote.sourceHash,'prepaid_refund_stale',409)
  insist(actor.id!==row.prepared_by_id,'second_approver_required',409)
  await inspectRefundCharge(env,quote)
  await commit(env,[refundActorGuard(env,actor),pending,prepaidRevisionGuard(env,quote.subscription,quote.revision),guard(env,'prepaid_refund_preparer_changed',"EXISTS(SELECT 1 FROM nc_members m JOIN oa_operators o ON o.email=m.email WHERE m.id=? AND m.role IN ('owner','finance') AND m.status='active' AND o.status='active' AND (m.role<>'owner' OR o.role='owner'))",row.prepared_by_id),
    guard(env,'prepaid_refund_reserved',"NOT EXISTS(SELECT 1 FROM nc_prepaid_refunds WHERE grant_id=? AND status IN ('approved','claimed','uncertain'))",quote.grant),stmt(env,"UPDATE nc_prepaid_refunds SET status='approved',approved_by_id=?,approved_at=?,approval_mode=?,revision=? WHERE id=?",actor.id,clockInstant(env),'two-person',newId(),row.id),stmt(env,'UPDATE nc_prepaid_accounts SET revision=revision+1 WHERE subscription_id=?',quote.subscription)],{actor:actorLabel(actor),action:'prepaid.refund.approve',subject:row.id,detail:{basis:row.basis_hash,reservedAmountN:quote.amountN,reservedLiabilityCents:quote.amountCents}})
  const result=await executePrepaidRefund(env,actor,row.id)
  await deliverPrepaidRefundNotice(env,row.id)
  return result
}
export async function reconcilePrepaidRefund(env:Bindings,actor:Actor,input:Input){requireMember(actor,'approve');await requireFreshFactor(env,actor);const {reconcileRefund}=await import('./prepaid-refund-processor');const id=input.text('refund',{max:100}),result=await reconcileRefund(env,actor,id);await deliverPrepaidRefundNotice(env,id);return result}
