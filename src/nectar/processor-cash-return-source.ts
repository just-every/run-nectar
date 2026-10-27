import type { Bindings } from '../auth.server'
import { requireMember, requireOwner, type Actor } from './actor'
import { fingerprint, guard, insist, one, type Row } from './core'
import { creditPolicy } from './credit-policy'
import { requireFreshFactor } from './mfa'
import { providerReference, stripeForAccount, type StripeClient } from './payments/stripe'
import { completeList, processorBinding, ref } from './processor-source'
import { reconcileProcessorCash } from './processor-cash'
import { processorCashObservation } from './processor-cash-queue'

export async function cashReturnAuthority(env:Bindings,actor:Actor,owner=false) {
 requireMember(actor,'approve');if(owner)requireOwner(actor)
 insist(actor.role==='owner'||!owner&&actor.role==='finance','forbidden',403)
 await requireFreshFactor(env,actor)
}
export function cashReturnActorGuard(env:Bindings,actor:Actor,owner=false) {
 return guard(env,'processor_cash_return_authority_changed',`EXISTS(SELECT 1 FROM nc_members m JOIN oa_operators o ON o.email=m.email
 WHERE m.id=? AND m.status='active' AND m.role IN (${owner?"'owner'":"'owner','finance'"}) AND o.status='active' AND (m.role<>'owner' OR o.role='owner'))`,actor.id)
}
export async function cashReturnSnapshot(stripe:StripeClient,customerRef:string) {
 const [customer,cash,transactions]=await Promise.all([stripe(`/customers/${encodeURIComponent(customerRef)}`),stripe(`/customers/${encodeURIComponent(customerRef)}/cash_balance`),completeList(stripe,`/customers/${encodeURIComponent(customerRef)}/cash_balance_transactions`)])
 insist(customer.object==='customer'&&customer.id===customerRef&&!customer.deleted&&customer.livemode===false&&typeof customer.email==='string'&&customer.email.includes('@'),'processor_cash_return_customer_invalid',409)
 insist(cash.object==='cash_balance'&&ref(cash.customer)===customerRef&&cash.livemode===false&&cash.settings?.reconciliation_mode==='manual','processor_cash_manual_reconciliation_required',409)
 const available=cash.available??{}
 insist(available&&typeof available==='object'&&!Array.isArray(available)&&Object.entries(available).every(([currency,amount])=>/^[a-z]{3}$/.test(currency)&&Number.isSafeInteger(amount)&&Number(amount)>=0),'processor_cash_return_snapshot_invalid',409)
 const balances:Record<string,number>={}
 for(const t of [...transactions].reverse()){
  insist(t.object==='customer_cash_balance_transaction'&&ref(t.customer)===customerRef&&t.livemode===false&&/^[a-z]{3}$/.test(t.currency)&&Number.isSafeInteger(t.net_amount)&&Number.isSafeInteger(t.ending_balance)&&Number.isSafeInteger(t.created)&&t.created>0,'processor_cash_return_snapshot_invalid',409)
  providerReference(t.id);providerReference(t.type)
  balances[t.currency]=(balances[t.currency]??0)+t.net_amount
  insist(balances[t.currency]===t.ending_balance&&t.ending_balance>=0,'processor_cash_history_changed',409)
 }
 insist([...new Set([...Object.keys(available),...Object.keys(balances)])].every(currency=>(available[currency]??0)===(balances[currency]??0)),'processor_cash_history_changed',409)
 // Full provider objects bind the decision, but provider payloads and addresses
 // never enter saved JSON, audit records or the public return view.
 return {available,transactions,sourceHash:await fingerprint({customer,cash,transactions})}
}
export async function cashReturnSource(env:Bindings,customer:string,account:string,currency:string,amount:number) {
 const binding=await one(env,`SELECT b.*,c.revision AS customer_revision,c.currency FROM nc_stripe_customer_bindings b JOIN nc_customers c ON c.id=b.customer_id
 WHERE b.customer_id=? AND b.account_ref=? AND c.status='active' AND c.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(b.id,c.id))`,customer,account)
 insist(binding&&binding.currency.toLowerCase()===currency,'processor_cash_return_binding_required',409)
 const selected=await stripeForAccount(env,account),snapshot=await cashReturnSnapshot(selected.stripe,binding.stripe_customer_ref),policy=await creditPolicy(env)
 insist(Number.isSafeInteger(amount)&&amount>0&&amount<=(snapshot.available[currency]??0),'processor_cash_return_exceeds_available',409)
 const quote={customer,accountRef:account,customerRef:binding.stripe_customer_ref,bindingId:binding.id,bindingRevision:binding.revision,customerRevision:binding.customer_revision,
  currency,amountCents:amount,availableCents:snapshot.available[currency]??0,sourceHash:snapshot.sourceHash,policyRevision:policy.revision,thresholdCents:policy.two_person_above_cents}
 return {...selected,snapshot,quote,basis:await fingerprint(quote)}
}
export function cashReturnSourceGuards(env:Bindings,q:Row) {
 return [guard(env,'processor_cash_return_stale','COALESCE((SELECT revision FROM nc_credit_policy WHERE singleton=1),0)=?',q.policyRevision),
  guard(env,'processor_cash_return_stale',`EXISTS(SELECT 1 FROM nc_stripe_customer_bindings b JOIN nc_customers c ON c.id=b.customer_id WHERE b.id=? AND b.revision=? AND b.customer_id=? AND b.account_ref=? AND b.stripe_customer_ref=? AND c.revision=? AND c.status='active' AND c.erased_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(?,?))`,q.bindingId,q.bindingRevision,q.customer,q.accountRef,q.customerRef,q.customerRevision,q.bindingId,q.customer),
  guard(env,'processor_cash_return_application_uncertain',"NOT EXISTS(SELECT 1 FROM nc_processor_cash_applications WHERE account_ref=? AND stripe_customer_ref=? AND status='uncertain') AND NOT EXISTS(SELECT 1 FROM nc_processor_cash_imported_applications WHERE account_ref=? AND stripe_customer_ref=? AND status='uncertain')",q.accountRef,q.customerRef,q.accountRef,q.customerRef)]
}
export async function cashReturnObservation(env:Bindings,q:Row,stripe:StripeClient) {
 const binding=await processorBinding(env,q.accountRef,q.customerRef)
 insist(binding.customer_id===q.customer,'processor_cash_return_binding_required',409)
 const cash=await reconcileProcessorCash(env,stripe,q.accountRef,binding,false)
 return {statements:await processorCashObservation(env,q.accountRef,q.customer,cash),availableCents:cash.availableByCurrency[q.currency]??0}
}
export async function storedCashReturn(env:Bindings,id:string) {
 const row=await one(env,'SELECT r.* FROM nc_processor_cash_returns r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=? AND c.status=\'active\' AND c.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(r.id,c.id))',id)
 insist(row,'processor_cash_return_not_found',404);return row
}
export function cashReturnView(r:Row) {
 return {id:r.id,customer:r.customer_id,accountRef:r.account_ref,customerRef:r.stripe_customer_ref,currency:r.currency,amountCents:r.amount_cents,status:r.status,basis:r.basis_hash,needsSecondApprover:!!r.needs_second,
  preparedBy:r.prepared_by_id,preparedAt:r.prepared_at,approvedBy:r.approved_by_id,approvedAt:r.approved_at,claimedAt:r.claimed_at,refundRef:r.refund_ref,error:r.error_code,
  completedAt:r.completed_at,providerCreatedAt:r.provider_created_at,cashAmountCents:r.status==='succeeded'?-r.amount_cents:0,providerOutcome:['prepared','superseded','stopped'].includes(r.status)?'not-attempted':r.status,source:`/app/processor-events?customer=${r.customer_id}`}
}
