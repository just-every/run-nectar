import type { Bindings } from '../auth.server'
import { actorLabel, requireRead, type Actor } from './actor'
import { clockInstant } from './clock'
import { all, canonical, commit, guard, insist, newId, one, parseJson, stmt, type Row } from './core'
import { cents } from './decimal'
import type { Input } from './input'
import { providerReference, stripeForAccount, type StripeClient } from './payments/stripe'
import { completeList, ref } from './processor-source'
import { cashReturnActorGuard, cashReturnAuthority, cashReturnObservation, cashReturnSource, cashReturnSourceGuards, cashReturnView, storedCashReturn } from './processor-cash-return-source'

const fields=['customer','account_ref','amount','currency','basis','confirm','returnTo']
const state=(env:Bindings,r:Row)=>guard(env,'processor_cash_return_state_changed','EXISTS(SELECT 1 FROM nc_processor_cash_returns WHERE id=? AND revision=? AND status=?)',r.id,r.revision,r.status)
function sourceInput(input:Input) {
 const currency=input.text('currency',{max:3}).toLowerCase();insist(/^[a-z]{3}$/.test(currency),'invalid_currency')
 return [input.text('customer',{max:100}),providerReference(input.text('account_ref',{max:255})),currency,cents(input.text('amount',{max:20}))] as const
}
const publicQuote=(source:Awaited<ReturnType<typeof cashReturnSource>>)=>({basis:source.basis,customer:source.quote.customer,accountRef:source.quote.accountRef,customerRef:source.quote.customerRef,currency:source.quote.currency,
 amountCents:source.quote.amountCents,availableCents:source.quote.availableCents,needsSecondApprover:source.quote.thresholdCents!==null&&source.quote.amountCents>source.quote.thresholdCents,providerOutcome:'not-attempted'})

export async function previewProcessorCashReturn(env:Bindings,actor:Actor,input:Input) {
 await cashReturnAuthority(env,actor,true);input.only(fields)
 return publicQuote(await cashReturnSource(env,...sourceInput(input)))
}
export async function prepareProcessorCashReturn(env:Bindings,actor:Actor,input:Input) {
 await cashReturnAuthority(env,actor,true);input.only(fields);insist(input.flag('confirm'),'confirmation_required')
 const source=await cashReturnSource(env,...sourceInput(input)),q=source.quote
 insist(input.text('basis',{max:100})===source.basis,'processor_cash_return_stale',409)
 const previous=await one(env,"SELECT * FROM nc_processor_cash_returns WHERE account_ref=? AND stripe_customer_ref=? AND status IN('prepared','claimed','uncertain','requires_action','pending')",q.accountRef,q.customerRef)
 if(previous?.status==='prepared'&&previous.basis_hash===source.basis)return cashReturnView(previous)
 insist(!previous||previous.status==='prepared','processor_cash_return_unresolved',409)
 const id=newId(),at=clockInstant(env),needsSecond=publicQuote(source).needsSecondApprover
 await commit(env,[cashReturnActorGuard(env,actor,true),...cashReturnSourceGuards(env,q),
  ...(previous?[state(env,previous),stmt(env,"UPDATE nc_processor_cash_returns SET status='superseded',revision=? WHERE id=?",newId(),previous.id)]:[]),
  guard(env,'processor_cash_return_unresolved',"NOT EXISTS(SELECT 1 FROM nc_processor_cash_returns WHERE account_ref=? AND stripe_customer_ref=? AND status IN('prepared','claimed','uncertain','requires_action','pending'))",q.accountRef,q.customerRef),
  stmt(env,"INSERT INTO nc_processor_cash_returns(id,customer_id,account_ref,stripe_customer_ref,amount_cents,currency,basis_hash,source_hash,quote_json,policy_revision,needs_second,prepared_by_id,prepared_at,intent_key,revision,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared')",
   id,q.customer,q.accountRef,q.customerRef,q.amountCents,q.currency,source.basis,q.sourceHash,canonical(q),q.policyRevision,needsSecond?1:0,actor.id,at,newId(),newId())],
  {actor:actorLabel(actor),action:'processor.cash.return.prepare',subject:id,detail:{customer:q.customer,basis:source.basis,amountCents:q.amountCents,currency:q.currency,needsSecondApprover:needsSecond,policyRevision:q.policyRevision,superseded:previous?.id??null}})
 return cashReturnView(await storedCashReturn(env,id))
}
async function outcome(env:Bindings,actor:Actor,r:Row,values:Row) {
 const entries=Object.entries({...values,revision:newId(),observed_at:clockInstant(env)})
 await commit(env,[cashReturnActorGuard(env,actor),state(env,r),stmt(env,`UPDATE nc_processor_cash_returns SET ${entries.map(([key])=>`${key}=?`).join(',')} WHERE id=?`,...entries.map(([,value])=>value),r.id)],
  {actor:actorLabel(actor),action:'processor.cash.return.outcome',subject:r.id,detail:{status:values.status,error:values.error_code??null,refundRef:values.refund_ref??r.refund_ref,preparedBy:r.prepared_by_id,approvedBy:r.approved_by_id}})
 return storedCashReturn(env,r.id)
}
function verifyRefund(refund:Row,r:Row) {
 insist(refund.object==='refund'&&refund.livemode!==true&&ref(refund.customer)===r.stripe_customer_ref&&!ref(refund.charge)&&!ref(refund.payment_intent)
  &&refund.amount===r.amount_cents&&refund.currency===r.currency&&refund.metadata?.nectar_cash_return===r.id&&refund.metadata?.nectar_cash_return_key===r.intent_key
  &&['requires_action','pending','succeeded','failed','canceled'].includes(refund.status)&&Number.isSafeInteger(refund.created)&&refund.created>0,'processor_cash_return_receipt_mismatch',409)
 const id=providerReference(refund.id);insist(!r.refund_ref||r.refund_ref===id,'processor_cash_return_receipt_mismatch',409);return id
}
async function record(env:Bindings,actor:Actor,r:Row,stripe:StripeClient,refund:Row) {
 const id=verifyRefund(refund,r)
 // Save the known reference before subsequent reads; uncertainty recovers this
 // exact refund instead of issuing another request.
 if(!r.refund_ref)r=await outcome(env,actor,r,{status:'uncertain',refund_ref:id,error_code:'processor_cash_return_confirmation_pending'})
 const observed=await observeCashReturnEvent(env,stripe,r.account_ref,refund,null)
 await commit(env,[cashReturnActorGuard(env,actor),...observed.statements],
  {actor:actorLabel(actor),action:'processor.cash.return.observe',subject:r.id,detail:{customer:r.customer_id,amountCents:r.amount_cents,currency:r.currency,status:observed.status,refundRef:id,availableCents:observed.availableCents,preparedBy:r.prepared_by_id,approvedBy:r.approved_by_id}})
 return cashReturnView(await storedCashReturn(env,r.id))
}
/** Verified processor intake observes an already approved request; it grants no
 * authority to create or repeat a return. */
export async function observeCashReturnEvent(env:Bindings,stripe:StripeClient,account:string,refund:Row,event:Row|null) {
 const current=await stripe(`/refunds/${encodeURIComponent(providerReference(refund.id))}`)
 insist(current.id===refund.id,'processor_cash_return_receipt_mismatch',409)
 const r=await storedCashReturn(env,providerReference(current.metadata?.nectar_cash_return))
 insist(r.account_ref===account&&r.claimed_at&&r.approved_by_id&&!['prepared','superseded','stopped'].includes(r.status),'processor_cash_return_unapproved',409)
 const id=verifyRefund(current,r),q=parseJson<Row>(r.quote_json,{}),observed=await cashReturnObservation(env,q,stripe),at=clockInstant(env)
 const completed=current.status==='succeeded'?(r.completed_at??(event?.data?.object?.status==='succeeded'&&Number.isSafeInteger(event.created)&&event.created>0?event.created*1000:at)):r.completed_at
 return {customer:r.customer_id,invoice:null,status:current.status,availableCents:observed.availableCents,statements:[state(env,r),...observed.statements,
  stmt(env,'UPDATE nc_processor_cash_returns SET status=?,refund_ref=?,error_code=NULL,observed_at=?,provider_created_at=?,completed_at=?,revision=? WHERE id=?',current.status,id,at,current.created*1000,completed??null,newId(),r.id)]}
}
export async function executeProcessorCashReturn(env:Bindings,actor:Actor,input:Input) {
 await cashReturnAuthority(env,actor);input.only(['request','basis','confirm','returnTo']);insist(input.flag('confirm'),'confirmation_required')
 let r=await storedCashReturn(env,input.text('request',{max:100}))
 insist(input.text('basis',{max:100})===r.basis_hash,'processor_cash_return_stale',409)
 insist(!['superseded','stopped'].includes(r.status),'processor_cash_return_not_prepared',409)
 if(r.status!=='prepared')return cashReturnView(r)
 insist(!r.needs_second||actor.id!==r.prepared_by_id,'second_approver_required',409)
 const source=await cashReturnSource(env,r.customer_id,r.account_ref,r.currency,r.amount_cents),q=parseJson<Row>(r.quote_json,{})
 insist(source.basis===r.basis_hash,'processor_cash_return_stale',409)
 const revision=newId(),at=clockInstant(env)
 const preparer=()=>guard(env,'processor_cash_return_authority_changed',"EXISTS(SELECT 1 FROM nc_members m JOIN oa_operators o ON o.email=m.email WHERE m.id=? AND m.role='owner' AND m.status='active' AND o.role='owner' AND o.status='active')",r.prepared_by_id)
 await commit(env,[cashReturnActorGuard(env,actor),preparer(),state(env,r),...cashReturnSourceGuards(env,q),
  stmt(env,"UPDATE nc_processor_cash_returns SET status='claimed',approved_by_id=?,approved_at=?,claimed_at=?,revision=? WHERE id=?",actor.id,at,at,revision,r.id)],
  {actor:actorLabel(actor),action:'processor.cash.return.claim',subject:r.id,detail:{customer:r.customer_id,amountCents:r.amount_cents,currency:r.currency,basis:r.basis_hash,preparedBy:r.prepared_by_id,approvedBy:actor.id,policyRevision:q.policyRevision}})
 r={...r,status:'claimed',approved_by_id:actor.id,approved_at:at,claimed_at:at,revision}
 let attempted=false
 try{
  const current=await cashReturnSource(env,r.customer_id,r.account_ref,r.currency,r.amount_cents)
  insist(current.basis===r.basis_hash,'processor_cash_return_stale',409)
  await commit(env,[cashReturnActorGuard(env,actor),preparer(),state(env,r),...cashReturnSourceGuards(env,q)],{actor:actorLabel(actor),action:'processor.cash.return.preflight',subject:r.id,detail:{basis:r.basis_hash,preparedBy:r.prepared_by_id,approvedBy:actor.id}})
  attempted=true
  const refund=await source.stripe('/refunds',new URLSearchParams({origin:'customer_balance',customer:r.stripe_customer_ref,amount:String(r.amount_cents),currency:r.currency,'metadata[nectar_cash_return]':r.id,'metadata[nectar_cash_return_key]':r.intent_key}),`nectar-cash-return-${r.intent_key}`)
  return await record(env,actor,r,source.stripe,refund)
 }catch{
  r=await storedCashReturn(env,r.id)
  if(!['claimed','uncertain'].includes(r.status))return cashReturnView(r)
  return cashReturnView(await outcome(env,actor,r,{status:attempted?'uncertain':'stopped',error_code:attempted?'processor_cash_return_unconfirmed':'processor_cash_return_preflight_changed'}))
 }
}
export async function reconcileProcessorCashReturn(env:Bindings,actor:Actor,input:Input) {
 await cashReturnAuthority(env,actor);input.only(['request','returnTo'])
 const r=await storedCashReturn(env,input.text('request',{max:100}))
 insist(!['prepared','superseded','stopped'].includes(r.status),'processor_cash_return_not_reconcilable',409)
 const {stripe}=await stripeForAccount(env,r.account_ref)
 let refund:Row
 if(r.refund_ref)refund=await stripe(`/refunds/${encodeURIComponent(providerReference(r.refund_ref))}`)
 else{
  const matches=(await completeList(stripe,'/refunds')).filter(row=>row.metadata?.nectar_cash_return===r.id&&row.metadata?.nectar_cash_return_key===r.intent_key)
  insist(matches.length===1,'processor_cash_return_unconfirmed',409);refund=matches[0]
 }
 return record(env,actor,r,stripe,refund)
}
export async function readProcessorCashReturns(env:Bindings,actor:Actor,customer?:string) {
 requireRead(actor,'payments')
 return (await all(env,`SELECT r.* FROM nc_processor_cash_returns r JOIN nc_customers c ON c.id=r.customer_id WHERE c.status='active' AND c.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(r.id,c.id)) ${customer?'AND r.customer_id=?':''} ORDER BY r.prepared_at,r.id`,...(customer?[customer]:[]))).map(cashReturnView)
}
