import { recordRetryFailure,recordRetrySuccess } from './retry-records'
import { unusableMethodGuard } from './card-lifecycle'
import { refusedPaymentWithLifecycle } from './payments/refusal'
// Invoice issuance claims once; explicit retry consent governs later confirmations.
import type { Bindings } from '../auth.server'
import { actorLabel, type Actor } from './actor'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, canonical, commit, guard, insist, NectarError, newId, one, stmt, type Row } from './core'
import { prepaidFundingStatements } from './prepaid-funding'
import { prepaidFundingForInvoice } from './prepaid-records'
import { localDate } from './dates'
import { collectedPaymentStatements, issuedInvoice } from './receivables'
import { automaticAuthority, automaticQuote, automaticView, storedAutomaticCollection, validateAutomaticBasis } from './automatic-collection-records'
import { savedCollectionMethod } from './payments/default-method'
import { nativeCollectionSource, nativeSourceGuard } from './payments/source'
import { capturedPayment, NativeStripeError, providerReference, readIntent, stripeForAccount, verifyIntent, type PaymentIdentity, type StripeClient } from './payments/stripe'

const system = (id:string):Actor => ({id:`automatic-collection:${id}`,kind:'agent',name:`automatic-collection:${id}`,email:'',role:null,sessionId:null,capabilities:new Set(['receivables'])})
async function outcome(env:Bindings,row:Row,status:string,values:Row={}){
 const fields={status,...values,revision:newId()}
 await commit(env,[guard(env,'automatic_collection_state_changed','EXISTS(SELECT 1 FROM nc_automatic_collections a JOIN nc_customers c ON c.id=a.customer_id WHERE a.id=? AND a.revision=? AND c.erased_at IS NULL)',row.id,row.revision),
 stmt(env,`UPDATE nc_automatic_collections SET ${Object.keys(fields).map(key=>`${key}=?`).join(',')} WHERE id=?`,...Object.values(fields),row.id)],
 {actor:actorLabel(system(row.id)),action:`automatic.collection.${status}`,subject:row.id,detail:{invoice:row.invoice_id,errorCode:values.error_code??null,paymentIntentRef:values.payment_intent_ref??row.payment_intent_ref}})
 return storedAutomaticCollection(env,row.id)
}
export async function settleAutomaticIntent(env:Bindings,row:Row,stripe:StripeClient,intent:Row,identity:PaymentIdentity){
 const intentRef=verifyIntent(intent,identity)
 if(!row.payment_intent_ref)row=await outcome(env,row,'uncertain',{payment_intent_ref:intentRef})
 if(intent.status==='processing')return automaticView(await outcome(env,row,'pending_settlement',{error_code:null}))
 if(row.method_kind==='us_bank_account'&&intent.status==='requires_payment_method'&&intent.amount_received===0&&intent.last_payment_error){
  const providerCode=intent.last_payment_error.code
  const code: string=({insufficient_funds:'R01',bank_account_closed:'R02',bank_account_invalid_details:'R03',debit_not_authorized:'R10'} as Record<string,string>)[providerCode]??providerCode
  insist(typeof code==='string'&&/^[A-Za-z0-9_]{1,100}$/.test(code),'automatic_collection_return_unconfirmed',409)
  const history=await stripe(`/charges?${new URLSearchParams({payment_intent:intentRef,limit:'100'})}`)
  insist(history.object==='list'&&history.has_more===false&&Array.isArray(history.data)&&history.data.length>0&&history.data.every((charge:Row)=>
   charge.object==='charge'&&providerReference(charge.payment_intent)===intentRef&&providerReference(charge.customer)===identity.customerRef&&charge.status==='failed'&&charge.paid===false),'automatic_collection_return_unconfirmed',409)
  const failed=await outcome(env,row,'returned',{error_code:code});await recordRetryFailure(env,failed,code);return automaticView(failed)
 }
 const refusal=await refusedPaymentWithLifecycle(env,stripe,intent,identity)
 if(refusal){const failed=await outcome(env,row,'refused',{error_code:refusal.retryProhibited?'do_not_try_again':refusal.declineCode??refusal.errorCode});await recordRetryFailure(env,failed,refusal.retryProhibited?'do_not_try_again':refusal.declineCode??refusal.errorCode);return automaticView(failed)}
 if(intent.status!=='succeeded')return automaticView(await outcome(env,row,'uncertain',{error_code:'processor_outcome_unconfirmed'}))
 if(['refused','returned'].includes(row.status))row=await outcome(env,row,'uncertain',{error_code:null})
 const q=automaticQuote(row),business=await requireBusiness(env),proof=await capturedPayment(stripe,intent,identity,business.timezone)
 let settledAt=clockInstant(env)
 if(row.method_kind==='us_bank_account'){
  const charge=await stripe(`/charges/${encodeURIComponent(proof.chargeRef)}`),transactionRef=providerReference(charge.balance_transaction)
  const transaction=await stripe(`/balance_transactions/${encodeURIComponent(transactionRef)}`)
  insist(transaction.object==='balance_transaction'&&transaction.id===transactionRef&&transaction.type==='payment'&&providerReference(transaction.source)===proof.chargeRef
    &&transaction.amount===row.amount_cents&&transaction.currency==='usd'&&Number.isSafeInteger(transaction.available_on),'automatic_collection_settlement_unconfirmed',409)
  if(transaction.status!=='available'||transaction.available_on*1000>clockInstant(env))return automaticView(await outcome(env,row,'pending_settlement',{error_code:null}))
  settledAt=transaction.available_on*1000
 }
 const invoice=await issuedInvoice(env,row.invoice_id)
 const financial=await collectedPaymentStatements(env,system(row.id),{customerId:row.customer_id,invoiceId:row.invoice_id,amountCents:row.amount_cents,balanceCents:invoice.balance_cents,
 currency:q.currency,receivedOn:localDate(settledAt,business.timezone),method:row.method_kind==='card'?'card_external':'bank_transfer',reference:`stripe:${q.accountRef}:${intentRef}`,
 evidence:canonical({...proof,settledAt,method:row.method_kind})})
 const funding=await prepaidFundingForInvoice(env,row.invoice_id)
 const funded=funding?await prepaidFundingStatements(env,funding.id,{paymentId:financial.paymentId,invoiceId:row.invoice_id,amountCents:row.amount_cents,providerRef:intentRef}):[]
 await commit(env,[guard(env,'automatic_collection_state_changed',"EXISTS(SELECT 1 FROM nc_automatic_collections WHERE id=? AND revision=? AND status IN ('claimed','uncertain','pending_settlement') AND payment_id IS NULL)",row.id,row.revision),
 ...financial.statements,...funded,stmt(env,"UPDATE nc_automatic_collections SET status='collected',charge_ref=?,payment_id=?,allocation_id=?,settled_at=?,error_code=NULL,revision=? WHERE id=?",proof.chargeRef,financial.paymentId,financial.allocationId,settledAt,newId(),row.id)],
 [...financial.audits,{actor:actorLabel(system(row.id)),action:'automatic.collection.collected',subject:row.id,detail:{invoice:row.invoice_id,payment:financial.paymentId,amountCents:row.amount_cents,paymentIntentRef:intentRef,settledAt}}])
 const collected=await storedAutomaticCollection(env,row.id);await recordRetrySuccess(env,collected);return automaticView(collected)
}
export async function identityFor(row:Row):Promise<PaymentIdentity>{
 const q=await validateAutomaticBasis(row)
 return {invoiceId:row.invoice_id,requestId:row.id,accountRef:q.accountRef,customerRef:q.method.customerRef,paymentMethodRef:q.method.paymentMethodRef,
 livemode:false,key:await import('./core').then(m=>m.fingerprint(['nectar-automatic-collection-1',q.accountRef,row.invoice_id])),amountCents:q.amountCents,currency:'usd'}
}
export async function reconcileAutomaticCollection(env:Bindings,id:string){
 let row=await storedAutomaticCollection(env,id)
 if(['refused','returned'].includes(row.status)){await recordRetryFailure(env,row,row.error_code);return automaticView(row)}
 if(['collected','revoked','invalidated'].includes(row.status))return automaticView(row)
 insist(row.claimed_at&&['claimed','uncertain','pending_settlement'].includes(row.status),'automatic_collection_not_claimed',409)
 const identity=await identityFor(row),{stripe}=await stripeForAccount(env,row.account_ref)
 try{return await settleAutomaticIntent(env,row,stripe,await readIntent(stripe,identity,row.payment_intent_ref,row.claimed_at,clockInstant(env)),identity)}catch(error){
  const current=await storedAutomaticCollection(env,id)
  if(current.status==='collected')return automaticView(current)
  row=await outcome(env,current,current.status==='pending_settlement'?'pending_settlement':'uncertain',{error_code:error instanceof NectarError?error.code:'processor_outcome_unconfirmed'})
  return automaticView(row)
 }
}
export async function collectAutomaticInvoice(env:Bindings,invoice:string){
 let row=await one(env,"SELECT * FROM nc_automatic_collections WHERE invoice_id=? AND status='active' ORDER BY prepared_at DESC LIMIT 1",invoice)
 if(!row)return
 try{
  insist(!await one(env,'SELECT 1 FROM nc_prepaid_topup_claims WHERE invoice_id=?',invoice),'prepaid_topup_invoice_managed',409)
  const q=await validateAutomaticBasis(row),source=await nativeCollectionSource(env,invoice),{stripe}=await stripeForAccount(env,q.accountRef),at=clockInstant(env)
  const business=await requireBusiness(env)
  insist(source.payerId===row.customer_id&&source.row.issue_date===q.issueDate&&localDate(at,business.timezone)===q.issueDate&&source.collectibleCents===q.amountCents
   &&source.row.source_fingerprint===q.fingerprint&&source.row.calculation_json===q.calculation,'automatic_collection_terms_changed',409)
  insist(canonical(await savedCollectionMethod(stripe,q.method.customerRef,q.method.mandateRef??undefined))===canonical(q.method),'automatic_collection_method_changed',409)
  const identity=await identityFor(row)
  await commit(env,[automaticAuthority(env,row),nativeSourceGuard(env,source),unusableMethodGuard(env,q.accountRef,q.method.customerRef,q.method.paymentMethodRef),
   guard(env,'native_collection_already_claimed','NOT EXISTS(SELECT 1 FROM nc_native_collection_claims WHERE invoice_id=?)',invoice),
   stmt(env,"UPDATE nc_automatic_collections SET status='claimed',claimed_at=?,revision=? WHERE id=?",at,newId(),row.id)],
  {actor:actorLabel(system(row.id)),action:'automatic.collection.claim',subject:row.id,detail:{invoice,basis:row.basis_hash,amountCents:q.amountCents,attempts:1}})
  row=await storedAutomaticCollection(env,row.id)
  const fields=new URLSearchParams({amount:String(q.amountCents),currency:'usd',customer:q.method.customerRef,payment_method:q.method.paymentMethodRef,
   'payment_method_types[0]':q.method.kind,confirm:'true',off_session:'true','metadata[nectar_native_collection_key]':identity.key,
   'metadata[nectar_native_collection_request]':row.id,'metadata[nectar_native_invoice]':invoice})
  if(q.method.kind==='card')fields.set('error_on_requires_action','true')
  else fields.set('mandate',q.method.mandateRef!)
  let intent:Row
  try{intent=await stripe('/payment_intents',fields,`nectar-automatic-${identity.key}`)}catch(error){
   if(!(error instanceof NativeStripeError)||!error.intentRef)throw error
   intent=await readIntent(stripe,identity,error.intentRef,at,clockInstant(env))
  }
  await settleAutomaticIntent(env,row,stripe,intent,identity)
 }catch(error){
  const current=await storedAutomaticCollection(env,row.id)
  if(['collected','refused','returned','invalidated'].includes(current.status))return
  await outcome(env,current,current.claimed_at?'uncertain':'invalidated',{error_code:error instanceof NectarError?error.code:'processor_outcome_unconfirmed'})
 }
}
export async function runAutomaticCollections(env:Bindings){
 for(const row of await all(env,"SELECT a.id,a.invoice_id,a.status FROM nc_automatic_collections a JOIN nc_invoices i ON i.id=a.invoice_id JOIN nc_customers c ON c.id=a.customer_id WHERE c.erased_at IS NULL AND i.status='issued' AND (a.status IN ('active','claimed','uncertain','pending_settlement') OR (a.status IN ('refused','returned') AND NOT EXISTS(SELECT 1 FROM nc_retry_series r WHERE r.collection_id=a.id))) ORDER BY a.prepared_at,a.id")){
  if(row.status==='active')await collectAutomaticInvoice(env,row.invoice_id)
  else await reconcileAutomaticCollection(env,row.id)
 }
}
