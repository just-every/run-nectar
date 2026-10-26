// The customer initiates one on-session confirmation; later requests only read.
import type { Bindings } from '../auth.server'
import { storedAutomaticCollection } from './automatic-collection-records'
import { identityFor, settleAutomaticIntent } from './automatic-collection-jobs'
import { clockInstant } from './clock'
import { canonical, commit, guard, insist, newId, one, stmt } from './core'
import type { Input } from './input'
import { nativeCollectionSource, nativeSourceGuard } from './payments/source'
import { savedCollectionMethod } from './payments/default-method'
import { NativeStripeError, readIntent, refusedPayment, stripeForAccount, verifyIntent } from './payments/stripe'
import { customerSession } from './portal-session'
import { checkedQuote, claimRetryMethodRecovery, portalFence, retryMethodRecovery } from './retry-method-recovery'

export async function authenticateRetryRecovery(env:Bindings,request:Request,input:Input){
 const session=await customerSession(env,request)
 input.only(['recovery','quote_hash','authenticate','check'])
 insist(request.method==='POST'&&request.headers.get('origin')===session.origin&&session.audience==='hosted'&&session.parent==='','forbidden',403)
 const proposal=await retryMethodRecovery(env,input.text('recovery',{max:100}))
 insist(proposal.customer_id===session.customer,'retry_recovery_not_found',404)
 let row=await storedAutomaticCollection(env,proposal.collection_id)
 const quote=await checkedQuote(row,proposal)
 insist(quote.wordingVersion==='exact-invoice-authentication-1'&&input.text('quote_hash',{max:100})===proposal.quote_hash
  &&proposal.customer_session_id===session.jti,'retry_authentication_not_authorized',409)
 const {stripe}=await stripeForAccount(env,quote.accountRef)
 const returnUrl=`${env.AUTH_ORIGIN}/portal/retry-method-recoveries/${proposal.id}/return`
 if(proposal.status==='active'){
  insist(input.flag('authenticate')&&!input.flag('check'),'retry_authentication_confirmation_required',409)
  const identity=await identityFor(env,row),at=clockInstant(env)
  const observed=await readIntent(stripe,identity,row.payment_intent_ref,row.claimed_at,at),refusal=await refusedPayment(stripe,observed,identity)
  insist(refusal&&!refusal.retryProhibited&&row.retry_advice_code!=='do_not_try_again'&&(refusal.declineCode??refusal.errorCode)==='authentication_required','retry_authentication_not_eligible',409)
  insist(canonical(await savedCollectionMethod(stripe,quote.method.customerRef))===canonical(quote.method),'retry_method_changed',409)
  const source=await nativeCollectionSource(env,row.invoice_id),series=await one(env,'SELECT * FROM nc_retry_series WHERE collection_id=?',row.id)
  insist(series&&series.status==='blocked'&&at<=series.deadline,'retry_authentication_not_eligible',409)
  const attempt=series.attempts+1
  await commit(env,[...await claimRetryMethodRecovery(env,row,quote,`customer:${session.customer}`),portalFence(env,session),nativeSourceGuard(env,source),
   guard(env,'retry_disputed','NOT EXISTS(SELECT 1 FROM nc_cadence_disputes WHERE invoice_id=? AND resolved_at IS NULL)',row.invoice_id),
   guard(env,'retry_state_changed',"EXISTS(SELECT 1 FROM nc_retry_series WHERE collection_id=? AND revision=? AND status='blocked' AND deadline>=?)",row.id,series.revision,clockInstant(env)),
   stmt(env,"UPDATE nc_retry_series SET attempts=?,next_at=NULL,status='uncertain',revision=? WHERE collection_id=?",attempt,newId(),row.id),
   stmt(env,"INSERT INTO nc_retry_attempts(collection_id,invoice_id,customer_id,attempt,attempted_at,outcome,amount_cents) VALUES(?,?,?,?,?,'claimed',?)",row.id,row.invoice_id,row.customer_id,attempt,at,row.amount_cents),
   stmt(env,"UPDATE nc_automatic_collections SET status='claimed',revision=? WHERE id=?",newId(),row.id)],
   {actor:`customer:${session.customer}`,action:'retry.authentication.claim',subject:proposal.id,detail:{invoice:row.invoice_id,attempt,quoteHash:proposal.quote_hash}})
  row=await storedAutomaticCollection(env,row.id)
  try{
   const intent=await stripe(`/payment_intents/${encodeURIComponent(row.payment_intent_ref)}/confirm`,new URLSearchParams({payment_method:quote.method.paymentMethodRef,
    off_session:'false',use_stripe_sdk:'false',return_url:returnUrl}),`nectar-authentication-${proposal.id}`)
   verifyIntent(intent,await identityFor(env,row))
  }catch(error){
   // A lost response never permits another confirmation, even on customer replay.
   if(!(error instanceof NativeStripeError))throw error
  }
 }else insist(proposal.status==='consumed'&&(input.flag('authenticate')||input.flag('check')),'retry_authentication_not_authorized',409)
 row=await storedAutomaticCollection(env,row.id)
 if(row.status==='collected')return {status:'collected',redirect:null}
 insist(['claimed','uncertain','pending_settlement','refused'].includes(row.status),'retry_authentication_not_authorized',409)
 const identity=await identityFor(env,row)
 let intent
 try{
  // The intent is already fixed by a durable claim. Read its current object;
  // eventually consistent search snapshots cannot order an authentication result.
  intent=await stripe(`/payment_intents/${encodeURIComponent(row.payment_intent_ref)}`)
  insist(verifyIntent(intent,identity)===row.payment_intent_ref,'stripe_native_intent_mismatch',409)
 }catch(error){
  if(error instanceof NativeStripeError)return {status:'uncertain',redirect:null}
  throw error
 }
 if(intent.status==='requires_action'){
  const action=intent.next_action
  insist(action?.type==='redirect_to_url'&&action.redirect_to_url?.return_url===returnUrl,'retry_authentication_action_unavailable',409)
  let destination:URL
  try{destination=new URL(action.redirect_to_url.url)}catch{insist(false,'retry_authentication_action_unavailable',409)}
  insist(destination!.protocol==='https:'&&destination!.hostname==='hooks.stripe.com'&&!destination!.port&&!destination!.username&&!destination!.password&&!destination!.hash,'retry_authentication_action_unavailable',409)
  return {status:'requires_action',redirect:destination!.href}
 }
 try{
  const result=await settleAutomaticIntent(env,row,stripe,intent,identity)
  return {status:result.status,redirect:null}
 }catch(error){
  if((await storedAutomaticCollection(env,row.id)).status==='collected')return {status:'collected',redirect:null}
  throw error
 }
}
