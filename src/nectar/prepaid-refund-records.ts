// Refund custody keeps original receipts and grants immutable. A held whole
// unused lot is removed only from rating operands, never from financial reads.
import type { Bindings } from '../auth.server'
import { requireMember, requireRead, type Actor } from './actor'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, canonical, fingerprint, guard, insist, one, parseJson, type Row } from './core'
import { today, localDate } from './dates'
import { boundaryEntries, lotStates } from './prepaid-math'
import { prepaidSnapshot } from './prepaid-records'
import type { PrepaidBasis } from './prepaid-types'
export interface PrepaidRefundQuote {
  grant:string; subscription:string; customer:string; revision:number; amountN:number; amountCents:number; kind:'money'|'units'
  invoice:string; purchaseLine:string; sourceFingerprint:string; payment:string; funding:string
  accountRef:string; customerRef:string; paymentMethodRef:string; paymentIntentRef:string; chargeRef:string
  originalAmountCents:number; refundedBeforeCents:number; livemode:boolean; timezone:string
  routeJson:string; entityId:string|null; customerRevision:string|number; businessRevision:number; sourceHash:string
}
export const refundQuote=(row:Row)=>parseJson<PrepaidRefundQuote>(row.quote_json,null as never)
export async function prepaidRefundHolds(env:Bindings,subscription:string){
  return (await all(env,"SELECT r.id,r.grant_id,r.amount_n,r.amount_cents FROM nc_prepaid_refunds r WHERE subscription_id=? AND status IN ('approved','claimed','uncertain')",subscription)).map(row=>({refundId:row.id,grantId:row.grant_id,amountN:row.amount_n,liabilityCents:row.amount_cents}))
}
export async function prepaidRefundSpendableBasis(env:Bindings,basis:PrepaidBasis){
  const held=new Set((await prepaidRefundHolds(env,basis.subscription)).map(hold=>hold.grantId))
  return held.size?{...basis,grants:basis.grants.filter(grant=>!held.has(grant.id)),entries:basis.entries.filter(entry=>!held.has(entry.grantId))}:basis
}
export async function prepaidRefundSource(env:Bindings,grantId:string,allowHeld?:string){
  const grant=await one(env,`SELECT g.*,f.payment_id,f.provider_ref,f.amount_cents AS funding_amount,f.status AS funding_status,p.method,p.evidence,p.amount_cents AS payment_amount,
    i.source_fingerprint,i.calculation_json,i.billing_route_json,i.billing_entity_id,i.total_cents,i.tax_cents,i.status AS invoice_status,
    c.revision AS customer_revision,c.billing_entity_id AS customer_entity,c.erased_at,c.status AS customer_status
    FROM nc_prepaid_grants g JOIN nc_prepaid_funding_intents f ON f.id=g.funding_id JOIN nc_payments p ON p.id=f.payment_id
    JOIN nc_invoices i ON i.id=g.purchase_invoice_id JOIN nc_customers c ON c.id=g.customer_id WHERE g.id=?`,grantId)
  insist(grant&&grant.source==='purchase'&&grant.funding_status==='funded'&&grant.invoice_status==='issued'&&grant.customer_status==='active'&&!grant.erased_at,'prepaid_refund_paid_card_required',409)
  insist(grant.method==='card_external'&&grant.payment_amount===grant.value_cents&&grant.funding_amount===grant.value_cents&&grant.total_cents===grant.value_cents&&grant.tax_cents===0,'prepaid_refund_paid_card_required',409)
  const receipt=(await one(env,"SELECT proof_json FROM nc_native_collections WHERE payment_id=? AND status='collected' UNION ALL SELECT proof_json FROM nc_prepaid_topup_claims WHERE payment_id=? AND status='collected'",grant.payment_id,grant.payment_id))
  const proof=receipt?parseJson<Row>(receipt.proof_json,{}):null
  insist(proof?.proof==='succeeded-payment-intent-and-captured-charge'&&proof.amountCents===grant.value_cents&&proof.currency==='usd'&&proof.paymentIntentRef===grant.provider_ref&&['accountRef','customerRef','paymentMethodRef','chargeRef'].every(key=>typeof proof[key]==='string'),'prepaid_refund_verified_capture_required',409)
  insist(await one(env,'SELECT 1 FROM nc_allocations WHERE payment_id=? AND invoice_id=? AND amount_cents=?',grant.payment_id,grant.purchase_invoice_id,grant.value_cents),'prepaid_refund_verified_capture_required',409)
  const basis=await prepaidSnapshot(env,grant.subscription_id);insist(basis,'prepaid_account_not_found',404)
  const lot=lotStates(basis).find(lot=>lot.grant.id===grantId)!,business=await requireBusiness(env),date=today(business.timezone,clockInstant(env))
  insist(lot.remainingN>0&&lot.liabilityCents>0&&lot.grant.effectiveDate<=date&&(!lot.grant.expiresDate||lot.grant.expiresDate>date)&&!boundaryEntries({...lot},date).some(entry=>entry.amountN<0),'prepaid_refund_unused_value_required',409)
  insist(!await one(env,"SELECT 1 FROM nc_prepaid_refunds WHERE grant_id=? AND status IN ('approved','claimed','uncertain') AND id<>?",grantId,allowHeld??''),'prepaid_refund_reserved',409)
  const unbilled=await all(env,"SELECT occurred_at,meter_id FROM nc_usage_events e WHERE customer_id=? AND status='active' AND invoice_id IS NULL AND occurred_at<=? AND NOT EXISTS(SELECT 1 FROM nc_usage_voids v WHERE v.event_id=e.event_id)",grant.customer_id,clockInstant(env))
  insist(!unbilled.some(event=>(!grant.meter_id||event.meter_id===grant.meter_id)&&localDate(event.occurred_at,business.timezone)>=grant.effective_date),'prepaid_unbilled_service',409)
  insist((grant.customer_entity??null)===(grant.billing_entity_id??null),'prepaid_refund_entity_changed',409)
  const sourceHash=await fingerprint({grant,lot,proof,businessRevision:business.revision})
  return {grant,basis,lot,business,proof:proof!,date,sourceHash}
}
export async function storedPrepaidRefund(env:Bindings,id:string){const row=await one(env,'SELECT r.* FROM nc_prepaid_refunds r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=? AND c.erased_at IS NULL',id);insist(row,'prepaid_refund_not_found',404);return row}
export const refundActorGuard=(env:Bindings,actor:Actor)=>{requireMember(actor,'approve');return guard(env,'forbidden',"EXISTS(SELECT 1 FROM nc_members m JOIN oa_operators o ON o.email=m.email WHERE m.id=? AND m.status='active' AND m.role IN ('owner','finance') AND o.status='active')",actor.id)}
export function refundApprovalGuard(env:Bindings,row:Row){return guard(env,'prepaid_refund_approval_changed',`EXISTS(SELECT 1 FROM nc_prepaid_refunds r JOIN nc_members p ON p.id=r.prepared_by_id JOIN oa_operators o ON o.email=p.email JOIN nc_members a ON a.id=r.approved_by_id
 WHERE r.id=? AND r.basis_hash=? AND r.status IN ('approved','claimed','uncertain') AND p.role='owner' AND p.status='active' AND o.role='owner' AND o.status='active' AND a.role IN ('owner','finance') AND a.status='active')`,row.id,row.basis_hash)}
export function prepaidRefundView(row:Row){const q=refundQuote(row);return {id:row.id,status:row.status,basis:row.basis_hash,quote:q,reason:row.reason,preparedBy:row.prepared_by_id,approvedBy:row.approved_by_id,refundRef:row.refund_ref,credit:row.credit_id,cashAmountCents:row.status==='refunded'?-row.amount_cents:0,proof:parseJson(row.proof_json,null),source:`/app/prepaid/refunds/${row.id}`}}
export async function readPrepaidRefunds(env:Bindings,actor:Actor,subscription?:string){requireRead(actor,'payments');requireRead(actor,'invoices');return (await all(env,`SELECT r.* FROM nc_prepaid_refunds r JOIN nc_customers c ON c.id=r.customer_id WHERE c.erased_at IS NULL ${subscription?'AND r.subscription_id=?':''} ORDER BY r.prepared_at,r.id`,...(subscription?[subscription]:[]))).map(prepaidRefundView)}
export async function prepaidRefundCashFacts(env:Bindings,invoice?:string){return (await all(env,`SELECT id,customer_id,subscription_id,purchase_invoice_id,payment_id,amount_cents,refunded_on,refund_ref,credit_id FROM nc_prepaid_refunds WHERE status='refunded' ${invoice?'AND purchase_invoice_id=?':''}`, ...(invoice?[invoice]:[]))).map(row=>({id:row.id,customer:row.customer_id,subscription:row.subscription_id,invoice:row.purchase_invoice_id,payment:row.payment_id,date:row.refunded_on,amountCents:-row.amount_cents,refundRef:row.refund_ref,credit:row.credit_id,source:`/app/prepaid/refunds/${row.id}`}))}
