// Verified card observations and no-retry prohibitions. Neither grants debit
// authority, changes a default, rewrites approved quotes, or sends notices.
import type { Bindings } from '../auth.server'
import { actorLabel, requireRead, type Actor } from './actor'
import { clockInstant } from './clock'
import { all, commit, guard, insist, NectarError, newId, one, stmt, type Row } from './core'
import { setupOwner, setupOwnerFence } from './hosted-setup-basis'
import type { Input } from './input'
import { providerReference, providerUnavailable, stripeForAccount, type PaymentIdentity } from './payments/stripe'

// DUN-001 and Stripe's published hard-decline list. Authentication remains
// blocked here until a separately authorized customer-confirmation flow exists.
export const HARD_CARD_DECLINES = new Set(['incorrect_number','lost_card','pickup_card','stolen_card',
  'revocation_of_authorization','revocation_of_all_authorizations','authentication_required','highest_risk_level','transaction_not_allowed'])
const brands = new Set(['amex','cartes_bancaires','diners','discover','eftpos_au','interac','jcb','link','mastercard','unionpay','visa','unknown'])
const methodWhere = 'account_ref=? AND stripe_customer_ref=? AND payment_method_ref=?'
const tuple = (account: string, customer: string, method: string) => [providerReference(account),providerReference(customer),providerReference(method)]

/** Check again with unusableMethodGuard inside the transaction claiming a POST. */
export async function assertMethodUsable(env: Bindings, accountRef: string, customerRef: string, methodRef: string) {
  insist(!await one(env,`SELECT 1 FROM nc_card_lifecycle WHERE ${methodWhere} AND unusable_at IS NOT NULL`,...tuple(accountRef,customerRef,methodRef)), 'payment_method_unusable',409)
}
export function unusableMethodGuard(env: Bindings, accountRef: string, customerRef: string, methodRef: string) {
  return guard(env,'payment_method_unusable',`NOT EXISTS(SELECT 1 FROM nc_card_lifecycle WHERE ${methodWhere} AND unusable_at IS NOT NULL)`,...tuple(accountRef,customerRef,methodRef))
}
function bindingGuard(env: Bindings, row: Row) {
  return guard(env,'card_lifecycle_binding_changed',`EXISTS(SELECT 1 FROM nc_stripe_customer_bindings b JOIN nc_customers c ON c.id=b.customer_id
    WHERE b.id=? AND b.revision=? AND b.customer_id=? AND b.account_ref=? AND b.stripe_customer_ref=?
    AND c.erased_at IS NULL AND c.status='active' AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(b.id,c.id)))`,
  row.id,row.revision,row.customer_id,row.account_ref,row.stripe_customer_ref)
}
function cardSummary(method: Row, methodRef: string, customerRef: string) {
  const card=method?.card
  insist(method?.object==='payment_method' && method.id===methodRef && method.type==='card' && method.livemode===false
    && providerReference(method.customer)===customerRef && card && brands.has(card.brand) && typeof card.last4==='string' && /^\d{4}$/.test(card.last4)
    && Number.isSafeInteger(card.exp_month) && card.exp_month>=1 && card.exp_month<=12
    && Number.isSafeInteger(card.exp_year) && card.exp_year>=2000 && card.exp_year<=9999,'card_lifecycle_method_invalid',409)
  return {brand:card.brand as string,last4:card.last4 as string,expMonth:card.exp_month as number,expYear:card.exp_year as number}
}
function lifecycleView(row: Row) {
  return {id:row.id,customer:row.customer_id,binding:row.binding_id,accountRef:row.account_ref,customerRef:row.stripe_customer_ref,
    methodRef:row.payment_method_ref,usable:row.unusable_at===null,unusableReason:row.unusable_reason,unusableAt:row.unusable_at,
    card:row.brand===null?null:{brand:row.brand,last4:row.last4,expMonth:row.exp_month,expYear:row.exp_year},
    sourceEventRef:row.source_event_ref,sourceCreatedAt:row.source_created_at,observedAt:row.observed_at,debitAuthority:false}
}
/** Customer composition uses the same authorization as saved-method snapshots. */
export async function readCardLifecycle(env: Bindings, actor: Actor, customer: string) {
  requireRead(actor,'payments');requireRead(actor,'invoices')
  insist(/^[\w-]{1,100}$/.test(customer),'invalid_customer')
  return (await all(env,`SELECT l.* FROM nc_card_lifecycle l JOIN nc_customers c ON c.id=l.customer_id
    JOIN nc_stripe_customer_bindings b ON b.id=l.binding_id AND b.customer_id=c.id AND b.account_ref=l.account_ref AND b.stripe_customer_ref=l.stripe_customer_ref
    WHERE c.id=? AND c.erased_at IS NULL AND c.status='active'
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(l.id,c.id,b.id)) ORDER BY l.account_ref,l.payment_method_ref`,customer)).map(lifecycleView)
}

/** Internal only: call after identity-matched refusal and complete no-success
 * charge evidence. This function never accepts a caller-supplied provider error. */
export async function recordUnusableMethod(env: Bindings, identity: PaymentIdentity, declineCode: string) {
  if(!HARD_CARD_DECLINES.has(declineCode))return false
  const refs=tuple(identity.accountRef,identity.customerRef,identity.paymentMethodRef),request=providerReference(identity.requestId)
  const binding=await one(env,`SELECT b.* FROM nc_stripe_customer_bindings b JOIN nc_customers c ON c.id=b.customer_id
    WHERE b.account_ref=? AND b.stripe_customer_ref=? AND c.erased_at IS NULL AND c.status='active'
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(b.id,c.id))`,refs[0],refs[1])
  insist(binding,'native_customer_binding_required',409)
  const existing=await one(env,`SELECT id,unusable_at FROM nc_card_lifecycle WHERE ${methodWhere}`,...refs)
  if(existing?.unusable_at!==null && existing?.unusable_at!==undefined)return true
  const id=existing?.id??newId(),at=clockInstant(env)
  await commit(env,[bindingGuard(env,binding),
    stmt(env,`INSERT INTO nc_card_lifecycle(id,customer_id,binding_id,account_ref,stripe_customer_ref,payment_method_ref,unusable_reason,unusable_at,source_request_ref,revision)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_ref,stripe_customer_ref,payment_method_ref) DO UPDATE SET
      unusable_reason=COALESCE(nc_card_lifecycle.unusable_reason,excluded.unusable_reason),
      unusable_at=COALESCE(nc_card_lifecycle.unusable_at,excluded.unusable_at),
      source_request_ref=COALESCE(nc_card_lifecycle.source_request_ref,excluded.source_request_ref),revision=excluded.revision`,
    id,binding.customer_id,binding.id,...refs,declineCode,at,request,newId())],
  {actor:'system:card-lifecycle',action:'card.lifecycle.unusable',subject:binding.customer_id,
    detail:{accountRef:refs[0],customerRef:refs[1],methodRef:refs[2],request,declineCode,noRetry:true}})
  return true
}

/** Owner explicitly imports a genuine provider event by id. Old events fetch
 * current method facts; an event snapshot can never roll expiry back. */
export async function consumeCardLifecycleEvent(env: Bindings, actor: Actor, input: Input) {
  await setupOwner(env,actor)
  input.only(['binding','event_ref','confirm','returnTo'])
  insist(input.flag('confirm'),'card_lifecycle_confirmation_required')
  const bindingId=input.text('binding',{max:100}),eventRef=providerReference(input.text('event_ref',{max:255}))
  const binding=await one(env,`SELECT b.* FROM nc_stripe_customer_bindings b JOIN nc_customers c ON c.id=b.customer_id
    WHERE b.id=? AND c.erased_at IS NULL AND c.status='active' AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(b.id,c.id))`,bindingId)
  insist(binding,'native_customer_binding_required',409)
  const accountRef=providerReference(binding.account_ref),customerRef=providerReference(binding.stripe_customer_ref)
  const replay=async()=>{
    const prior=await one(env,'SELECT customer_id,payment_method_ref FROM nc_card_lifecycle_events WHERE account_ref=? AND event_ref=?',accountRef,eventRef)
    if(!prior)return null
    insist(prior.customer_id===binding.customer_id,'card_lifecycle_event_mismatch',409)
    const row=await one(env,`SELECT * FROM nc_card_lifecycle WHERE customer_id=? AND ${methodWhere}`,binding.customer_id,accountRef,customerRef,prior.payment_method_ref)
    insist(row,'card_lifecycle_state_missing',409)
    return {...lifecycleView(row),replayed:true}
  }
  const prior=await replay();if(prior)return prior
  const {stripe}=await stripeForAccount(env,accountRef).catch(providerUnavailable)
  const event=await stripe(`/events/${encodeURIComponent(eventRef)}`).catch(providerUnavailable),object=event.data?.object
  insist(event.object==='event' && event.id===eventRef && event.type==='payment_method.automatically_updated' && event.livemode===false
    && Number.isSafeInteger(event.created) && event.created>0 && event.created<=253402300799
    && (event.account===undefined || event.account===accountRef) && object?.object==='payment_method','card_lifecycle_event_invalid',409)
  const methodRef=providerReference(object.id)
  cardSummary(object,methodRef,customerRef)
  const existing=await one(env,`SELECT id,revision FROM nc_card_lifecycle WHERE ${methodWhere}`,accountRef,customerRef,methodRef)
  const current=await stripe(`/payment_methods/${encodeURIComponent(methodRef)}`).catch(providerUnavailable)
  const card=cardSummary(current,methodRef,customerRef),at=clockInstant(env),created=event.created*1000,id=existing?.id??newId()
  try{
    await commit(env,[...setupOwnerFence(env,actor),bindingGuard(env,binding),
      existing?guard(env,'card_lifecycle_state_changed','EXISTS(SELECT 1 FROM nc_card_lifecycle WHERE id=? AND revision=?)',existing.id,existing.revision):
        guard(env,'card_lifecycle_state_changed',`NOT EXISTS(SELECT 1 FROM nc_card_lifecycle WHERE ${methodWhere})`,accountRef,customerRef,methodRef),
      stmt(env,'INSERT INTO nc_card_lifecycle_events(id,customer_id,binding_id,account_ref,stripe_customer_ref,event_ref,payment_method_ref,provider_created_at,observed_at) VALUES(?,?,?,?,?,?,?,?,?)',
        newId(),binding.customer_id,binding.id,accountRef,customerRef,eventRef,methodRef,created,at),
      stmt(env,`INSERT INTO nc_card_lifecycle(id,customer_id,binding_id,account_ref,stripe_customer_ref,payment_method_ref,brand,last4,exp_month,exp_year,source_event_ref,source_created_at,observed_at,revision)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_ref,stripe_customer_ref,payment_method_ref) DO UPDATE SET
        brand=excluded.brand,last4=excluded.last4,exp_month=excluded.exp_month,exp_year=excluded.exp_year,
        source_event_ref=CASE WHEN excluded.source_created_at>=COALESCE(nc_card_lifecycle.source_created_at,0) THEN excluded.source_event_ref ELSE nc_card_lifecycle.source_event_ref END,
        source_created_at=MAX(COALESCE(nc_card_lifecycle.source_created_at,0),excluded.source_created_at),observed_at=excluded.observed_at,revision=excluded.revision`,
      id,binding.customer_id,binding.id,accountRef,customerRef,methodRef,card.brand,card.last4,card.expMonth,card.expYear,eventRef,created,at,newId())],
    {actor:actorLabel(actor),action:'card.lifecycle.updated',subject:binding.customer_id,detail:{accountRef,customerRef,methodRef,eventRef,eventType:event.type,providerCreatedAt:created,observationOnly:true}})
  }catch(error){
    if(error instanceof NectarError && ['already_exists','card_lifecycle_state_changed'].includes(error.code)){const winner=await replay();if(winner)return winner}
    throw error
  }
  const result=await replay()
  insist(result,'card_lifecycle_state_missing',409)
  return {...result,replayed:false}
}
