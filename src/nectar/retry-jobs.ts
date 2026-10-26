import { effectiveRetryQuote,claimRetryMethodRecovery } from './retry-method-recovery'
import { bankReturnCode } from './retry-policy'
import { refusedPaymentWithLifecycle } from './payments/refusal'
import type { Bindings } from '../auth.server'
import { all,canonical,commit,guard,insist,newId,one,stmt,NectarError } from './core'
import { clockInstant } from './clock'
import { collectionHold } from './cadence-holds'
import { automaticAuthority,storedAutomaticCollection,validateAutomaticBasis } from './automatic-collection-records'
import { identityFor,settleAutomaticIntent } from './automatic-collection-jobs'
import { nativeCollectionSource,nativeSourceGuard } from './payments/source'
import { savedCollectionMethod } from './payments/default-method'
import { assertMethodUsable,HARD_CARD_DECLINES,unusableMethodGuard } from './card-lifecycle'
import { NativeStripeError,readIntent,stripeForAccount } from './payments/stripe'

export async function runPaymentRetries(env:Bindings){
 const at=clockInstant(env)
 for(const series of await all(env,"SELECT * FROM nc_retry_series WHERE status='scheduled' AND next_at<=? ORDER BY next_at,collection_id",at)){
  try{
   const row=await storedAutomaticCollection(env,series.collection_id),q=await effectiveRetryQuote(env,row),hold=await collectionHold(env,row.invoice_id)
   if(hold.disputedCents||hold.hold||hold.collectibleCents!==q.amountCents)continue
   if(at>series.deadline){await commit(env,[stmt(env,"UPDATE nc_retry_series SET status='exhausted',next_at=NULL,revision=? WHERE collection_id=? AND revision=?",newId(),row.id,series.revision)],{actor:'system:retries',action:'retry.exhausted',subject:row.invoice_id});continue}
   insist(q.retryPolicy&&['refused','returned'].includes(row.status)&&series.attempts<q.retryPolicy.maxAttempts,'retry_not_authorized',409)
   const source=await nativeCollectionSource(env,row.invoice_id),{stripe}=await stripeForAccount(env,q.accountRef)
   insist(canonical(await savedCollectionMethod(stripe,q.method.customerRef,q.method.mandateRef??undefined))===canonical(q.method),'retry_method_changed',409)
   const identity=await identityFor(env,row),observed=await readIntent(stripe,identity,row.payment_intent_ref,row.claimed_at,at)
   if(observed.status!=='requires_payment_method'){
    await settleAutomaticIntent(env,row,stripe,observed,identity)
    continue
   }
   const history=await stripe(`/charges?${new URLSearchParams({payment_intent:row.payment_intent_ref,limit:'100'})}`)
   insist(observed.amount_received===0&&history.object==='list'&&history.has_more===false&&Array.isArray(history.data)&&history.data.every((c:Record<string,unknown>)=>c.status==='failed'&&c.paid===false&&c.captured!==true),'retry_prior_outcome_unconfirmed',409)
   if(q.method.kind==='card'){
    const refusal=await refusedPaymentWithLifecycle(env,stripe,observed,identity)
    insist(refusal&&(!refusal.retryProhibited||q.method.paymentMethodRef!==identity.paymentMethodRef&&HARD_CARD_DECLINES.has(refusal.declineCode??refusal.errorCode))&&(refusal.declineCode??refusal.errorCode)===series.decline_code,'retry_reason_changed',409)
   }
   if(q.method.kind==='us_bank_account')insist(bankReturnCode(observed.last_payment_error?.code)===series.decline_code,'retry_reason_changed',409)
   const attempt=series.attempts+1,claimAt=clockInstant(env)
   insist(claimAt<=series.deadline,'retry_window_expired',409)
   await commit(env,[automaticAuthority(env,row),...await claimRetryMethodRecovery(env,row,q),nativeSourceGuard(env,source),unusableMethodGuard(env,q.accountRef,q.method.customerRef,q.method.paymentMethodRef),
    guard(env,'retry_disputed','NOT EXISTS(SELECT 1 FROM nc_cadence_disputes WHERE invoice_id=? AND resolved_at IS NULL)',row.invoice_id),
    guard(env,'retry_state_changed',"EXISTS(SELECT 1 FROM nc_retry_series WHERE collection_id=? AND revision=? AND status='scheduled' AND next_at<=? AND deadline>=?)",row.id,series.revision,claimAt,claimAt),
    stmt(env,"UPDATE nc_retry_series SET attempts=?,next_at=NULL,status='uncertain',revision=? WHERE collection_id=?",attempt,newId(),row.id),
    stmt(env,"INSERT INTO nc_retry_attempts(collection_id,invoice_id,customer_id,attempt,attempted_at,outcome,amount_cents) VALUES(?,?,?,?,?,'claimed',?)",row.id,row.invoice_id,row.customer_id,attempt,claimAt,row.amount_cents),
    stmt(env,"UPDATE nc_automatic_collections SET status='claimed',revision=? WHERE id=?",newId(),row.id)],
    {actor:'system:retries',action:'retry.claim',subject:row.invoice_id,detail:{attempt,policy:q.retryPolicy}})
   const current=await storedAutomaticCollection(env,row.id)
   await assertMethodUsable(env,q.accountRef,q.method.customerRef,q.method.paymentMethodRef)
   let intent
   insist(clockInstant(env)<=series.deadline,'retry_window_expired',409)
   try{intent=await stripe(`/payment_intents/${encodeURIComponent(row.payment_intent_ref)}/confirm`,new URLSearchParams({payment_method:q.method.paymentMethodRef,off_session:'true',...(q.method.kind==='card'?{error_on_requires_action:'true'}:{mandate:q.method.mandateRef!})}),`nectar-retry-${row.id}-${attempt}`)}catch(error){
    if(!(error instanceof NativeStripeError)||!error.intentRef)continue
    intent=await readIntent(stripe,identity,error.intentRef,current.claimed_at,at)
   }
   await settleAutomaticIntent(env,current,stripe,intent,await identityFor(env,current))
  }catch(error){
   // Refusal before a durable claim makes no write; an interrupted claimed
   // attempt is reconciled by ordinary collection reads, never repeated.
   if(!(error instanceof NectarError))throw error
   const current=await one(env,'SELECT status FROM nc_retry_series WHERE collection_id=?',series.collection_id)
   if(current?.status==='scheduled')await commit(env,[stmt(env,"UPDATE nc_retry_series SET status='blocked',next_at=NULL,revision=? WHERE collection_id=? AND revision=?",newId(),series.collection_id,series.revision)],{actor:'system:retries',action:'retry.blocked',subject:series.invoice_id,detail:{code:error.code}})
  }
 }
}
