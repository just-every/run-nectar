// One merchant-initiated off-session POST per claimed crossing. Recovery reads
// exact Stripe evidence only, even after authorization/card revocation.
import type { Bindings } from '../auth.server'
import { actorLabel, type Actor } from './actor'
import type { Input } from './input'
import { clockInstant } from './clock'
import { canonical, commit, guard, insist, newId, one, stmt, type Row } from './core'
import { prepaidFundingStatements } from './prepaid-funding'
import { prepaidRevisionGuard } from './prepaid-records'
import { collectedPaymentStatements } from './receivables'
import { nativeCollectionSource, nativeSourceGuard } from './payments/source'
import { NativeStripeError, capturedPayment, readIntent, refusedPayment, stripeForAccount, verifyIntent, type PaymentIdentity, type StripeClient } from './payments/stripe'
import { currentTopupAuthorization, storedTopupAuthorization, topupAuthorizationGuard, topupBalance, topupQuote, topupRuntimeOwner } from './prepaid-topup-records'
const terminal=(row:Row)=>['collected','declined','customer_action_required','stopped'].includes(row.status)
const claimGuard=(env:Bindings,row:Row)=>guard(env,'topup_claim_changed',"EXISTS(SELECT 1 FROM nc_prepaid_topup_claims WHERE id=? AND revision=? AND status IN ('claimed','uncertain'))",row.id,row.revision)
async function stored(env:Bindings,id:string){const row=await one(env,'SELECT * FROM nc_prepaid_topup_claims WHERE id=?',id);insist(row,'topup_claim_not_found',404);return row}
function identity(row:Row,q:ReturnType<typeof topupQuote>):PaymentIdentity{return {accountRef:q.accountRef,customerRef:q.customerRef,paymentMethodRef:q.paymentMethodRef,livemode:q.livemode,invoiceId:row.invoice_id,requestId:row.id,key:row.intent_key,amountCents:row.amount_cents}}
async function outcome(env:Bindings,actor:Actor,row:Row,values:Row){
  const entries=Object.entries({...values,revision:newId(),observed_at:clockInstant(env)})
  await commit(env,[topupRuntimeOwner(env,actor),claimGuard(env,row),stmt(env,`UPDATE nc_prepaid_topup_claims SET ${entries.map(([key])=>`${key}=?`).join(',')} WHERE id=?`,...entries.map(([,value])=>value),row.id)],{actor:actorLabel(actor),action:'prepaid.topup.outcome',subject:row.id,detail:{status:values.status??row.status,error:values.error_code??null}})
  return stored(env,row.id)
}
async function recordIntent(env:Bindings,actor:Actor,row:Row,stripe:StripeClient,intent:Row){
  const auth=await storedTopupAuthorization(env,row.authorization_id),q=topupQuote(auth),who=identity(row,q),intentRef=verifyIntent(intent,who)
  row=await outcome(env,actor,row,{payment_intent_ref:intentRef,status:'uncertain'})
  const refused=await refusedPayment(stripe,intent,who)
  if(refused)return outcome(env,actor,row,{status:refused.status,error_code:refused.errorCode,proof_json:canonical(refused)})
  const proof=await capturedPayment(stripe,intent,who,q.timezone)
  row=await outcome(env,actor,row,{status:'uncertain',charge_ref:proof.chargeRef,proof_json:canonical(proof),error_code:'topup_payment_record_pending'})
  const source=await nativeCollectionSource(env,row.invoice_id)
  insist(source.row.customer_id===q.customer&&source.row.balance_cents===q.amountCents,'topup_purchase_changed',409)
  const financial=await collectedPaymentStatements(env,actor,{customerId:q.customer,invoiceId:row.invoice_id,amountCents:q.amountCents,receivedOn:proof.receivedOn,reference:`stripe:${proof.accountRef}:${proof.paymentIntentRef}`,evidence:canonical(proof)})
  const funding=await prepaidFundingStatements(env,row.funding_id,{paymentId:financial.paymentId,invoiceId:row.invoice_id,amountCents:q.amountCents,providerRef:proof.paymentIntentRef})
  const wallet=await topupBalance(env,q)
  await commit(env,[topupRuntimeOwner(env,actor),claimGuard(env,row),nativeSourceGuard(env,source),prepaidRevisionGuard(env,q.subscription,wallet.basis.revision),...financial.statements,...funding,
    stmt(env,"UPDATE nc_prepaid_topup_claims SET status='collected',payment_id=?,allocation_id=?,error_code=NULL,observed_at=?,revision=? WHERE id=?",financial.paymentId,financial.allocationId,clockInstant(env),newId(),row.id),
    stmt(env,'UPDATE nc_prepaid_topup_states SET armed=?,revision=revision+1 WHERE authorization_id=?',wallet.balance+q.terms.amountN>q.thresholdN?1:0,row.authorization_id)], [...financial.audits,{actor:actorLabel(actor),action:'prepaid.topup.collected',subject:row.id,detail:{authorization:auth.id,invoice:row.invoice_id,payment:financial.paymentId,amountCents:q.amountCents,paymentIntent:proof.paymentIntentRef,charge:proof.chargeRef}}])
  return stored(env,row.id)
}
export async function chargePrepaidTopup(env:Bindings,actor:Actor,id:string){
  topupRuntimeOwner(env,actor)
  let row=await stored(env,id)
  if(terminal(row)||['claimed','uncertain'].includes(row.status))return {id:row.id,status:row.status,noRetry:true}
  insist(row.status==='issued'&&row.invoice_id,'topup_purchase_not_issued',409)
  const {row:auth,q,selected,basis,balance}=await currentTopupAuthorization(env,row.authorization_id)
  const source=await nativeCollectionSource(env,row.invoice_id)
  insist(source.row.customer_id===q.customer&&source.row.balance_cents===q.amountCents&&source.row.total_cents===q.amountCents&&source.row.tax_cents===0&&(source.accountRef===null||source.accountRef===q.accountRef),'topup_purchase_changed',409)
  const purchase=await one(env,"SELECT 1 FROM nc_prepaid_funding_intents f JOIN nc_invoice_lines l ON l.invoice_id=f.invoice_id WHERE f.id=? AND f.invoice_id=? AND f.status='pending' AND f.amount_cents=? AND l.kind='prepaid_purchase' AND l.amount_cents=f.amount_cents AND json_extract(l.evidence_json,'$.prepaidPurchase')=f.id AND NOT EXISTS(SELECT 1 FROM nc_credit_notes WHERE invoice_id=f.invoice_id)",row.funding_id,row.invoice_id,q.amountCents)
  insist(purchase&&balance<=q.thresholdN,'topup_balance_or_purchase_changed',409)
  const revision=newId()
  await commit(env,[topupRuntimeOwner(env,actor),topupAuthorizationGuard(env,auth),prepaidRevisionGuard(env,q.subscription,basis.revision),nativeSourceGuard(env,source),
    guard(env,'topup_claim_changed',"EXISTS(SELECT 1 FROM nc_prepaid_topup_claims WHERE id=? AND status='issued' AND revision=?) AND NOT EXISTS(SELECT 1 FROM nc_native_collection_claims WHERE invoice_id=?)",row.id,row.revision,row.invoice_id),
    stmt(env,"UPDATE nc_prepaid_topup_claims SET status='claimed',revision=? WHERE id=?",revision,row.id)],{actor:actorLabel(actor),action:'prepaid.topup.charge.claim',subject:row.id,detail:{authorization:auth.id,basis:auth.basis_hash,amountCents:q.amountCents,merchantInitiated:true}})
  row={...row,status:'claimed',revision}
  let attempted=false
  try{
    // Final customer/card/owner/source read after the durable attempt claim.
    const final=await currentTopupAuthorization(env,auth.id),finalSource=await nativeCollectionSource(env,row.invoice_id)
    insist(final.balance<=q.thresholdN&&finalSource.sourceHash===source.sourceHash,'topup_balance_or_purchase_changed',409)
    await commit(env,[topupRuntimeOwner(env,actor),topupAuthorizationGuard(env,final.row),prepaidRevisionGuard(env,q.subscription,final.basis.revision),nativeSourceGuard(env,finalSource),claimGuard(env,row)],{actor:actorLabel(actor),action:'prepaid.topup.charge.preflight',subject:row.id,detail:{basis:auth.basis_hash}})
    attempted=true
    const who=identity(row,q),intent=await selected.stripe('/payment_intents',new URLSearchParams({amount:String(q.amountCents),currency:'usd',customer:q.customerRef,payment_method:q.paymentMethodRef,'payment_method_types[0]':'card',confirm:'true',off_session:'true',error_on_requires_action:'true',
      'metadata[nectar_native_collection_key]':who.key,'metadata[nectar_native_collection_request]':row.id,'metadata[nectar_native_invoice]':row.invoice_id,'metadata[nectar_prepaid_topup_authorization]':auth.id}),`nectar-topup-${who.key}`)
    return await recordIntent(env,actor,row,selected.stripe,intent)
  }catch(error){
    row=await stored(env,id);if(terminal(row))return row
    if(!attempted)return outcome(env,actor,row,{status:'stopped',error_code:'topup_preflight_changed'})
    if(error instanceof NativeStripeError&&error.intentRef){try{return await recordIntent(env,actor,row,selected.stripe,await readIntent(selected.stripe,identity(row,q),error.intentRef,row.claimed_at,clockInstant(env)))}catch{row=await stored(env,id)}}
    return outcome(env,actor,row,{status:'uncertain',error_code:row.charge_ref?'topup_payment_record_pending':'topup_payment_unconfirmed'})
  }
}
export async function reconcilePrepaidTopup(env:Bindings,actor:Actor,input:Input){
  topupRuntimeOwner(env,actor)
  let row=await stored(env,input.text('claim',{max:100}));if(terminal(row))return row
  insist(['claimed','uncertain'].includes(row.status),'topup_not_reconcilable',409)
  const q=topupQuote(await storedTopupAuthorization(env,row.authorization_id))
  try{const selected=await stripeForAccount(env,q.accountRef),intent=await readIntent(selected.stripe,identity(row,q),row.payment_intent_ref,row.claimed_at,clockInstant(env));return await recordIntent(env,actor,row,selected.stripe,intent)}
  catch{row=await stored(env,row.id);if(terminal(row))return row;return outcome(env,actor,row,{status:'uncertain',error_code:row.charge_ref?'topup_payment_record_pending':'topup_payment_unconfirmed'})}
}
