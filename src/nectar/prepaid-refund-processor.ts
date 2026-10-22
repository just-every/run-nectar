// One fixed-account Stripe Refund create per durable claim. Unknown results
// retain the reservation; recovery reads the same charge's refund history.
import type { Bindings } from '../auth.server'
import { actorLabel, type Actor } from './actor'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, canonical, commit, guard, insist, newId, one, stmt, type Row } from './core'
import { localDate } from './dates'
import { documentNumberAllocation } from './invoice-numbering'
import { prepaidRevisionGuard } from './prepaid-records'
import { providerReference, stripeForAccount, type StripeClient } from './payments/stripe'
import { revenueCreditStatements } from './revenue-records'
import { prepaidRefundSource, prepaidRefundView, refundActorGuard, refundApprovalGuard, refundQuote, storedPrepaidRefund, type PrepaidRefundQuote } from './prepaid-refund-records'
const ref=(value:unknown)=>typeof value==='string'?value:value&&typeof value==='object'?(value as Row).id:''
export async function inspectRefundCharge(env:Bindings,q:Pick<PrepaidRefundQuote,'accountRef'|'customerRef'|'paymentMethodRef'|'paymentIntentRef'|'chargeRef'|'originalAmountCents'|'amountCents'|'livemode'>){
  const selected=await stripeForAccount(env,q.accountRef),[intent,charge]=await Promise.all([selected.stripe(`/payment_intents/${encodeURIComponent(q.paymentIntentRef)}`),selected.stripe(`/charges/${encodeURIComponent(q.chargeRef)}`)])
  insist(intent.object==='payment_intent'&&intent.id===q.paymentIntentRef&&intent.status==='succeeded'&&ref(intent.customer)===q.customerRef&&ref(intent.payment_method)===q.paymentMethodRef&&ref(intent.latest_charge)===q.chargeRef&&intent.currency==='usd'&&intent.amount===q.originalAmountCents&&intent.amount_received===q.originalAmountCents&&intent.livemode===q.livemode,'prepaid_refund_capture_changed',409)
  insist(charge.object==='charge'&&charge.id===q.chargeRef&&charge.status==='succeeded'&&charge.paid===true&&charge.captured===true&&charge.disputed===false&&charge.currency==='usd'&&charge.amount===q.originalAmountCents&&charge.amount_captured===q.originalAmountCents&&ref(charge.customer)===q.customerRef&&ref(charge.payment_intent)===q.paymentIntentRef&&ref(charge.payment_method)===q.paymentMethodRef&&charge.livemode===q.livemode&&Number.isSafeInteger(charge.amount_refunded)&&charge.amount_refunded>=0&&charge.amount_refunded+q.amountCents<=q.originalAmountCents,'prepaid_refund_capture_changed',409)
  return {...selected,charge}
}
const stateGuard=(env:Bindings,row:Row)=>guard(env,'prepaid_refund_state_changed',"EXISTS(SELECT 1 FROM nc_prepaid_refunds WHERE id=? AND revision=? AND status IN ('approved','claimed','uncertain'))",row.id,row.revision)
async function outcome(env:Bindings,actor:Actor,row:Row,values:Row){
  const entries=Object.entries({...values,revision:newId()}),released=['failed','stopped'].includes(values.status)
  await commit(env,[refundActorGuard(env,actor),stateGuard(env,row),stmt(env,`UPDATE nc_prepaid_refunds SET ${entries.map(([key])=>`${key}=?`).join(',')} WHERE id=?`,...entries.map(([,value])=>value),row.id),...(released?[stmt(env,'UPDATE nc_prepaid_accounts SET revision=revision+1 WHERE subscription_id=?',row.subscription_id)]:[])],{actor:actorLabel(actor),action:'prepaid.refund.outcome',subject:row.id,detail:{status:values.status??row.status,error:values.error_code??null}})
  return storedPrepaidRefund(env,row.id)
}
function verifyRefund(refund:Row,row:Row,q:PrepaidRefundQuote){
  insist(refund.object==='refund'&&ref(refund.charge)===q.chargeRef&&ref(refund.payment_intent)===q.paymentIntentRef&&refund.amount===q.amountCents&&refund.currency==='usd'&&refund.metadata?.nectar_prepaid_refund_request===row.id&&refund.metadata?.nectar_prepaid_refund_key===row.intent_key,'prepaid_refund_receipt_mismatch',409)
  return providerReference(refund.id)
}
async function refundHistory(stripe:StripeClient,row:Row,q:PrepaidRefundQuote){
  const matches=new Map<string,Row>();let cursor=''
  if(row.refund_ref){const direct=await stripe(`/refunds/${encodeURIComponent(row.refund_ref)}`);matches.set(verifyRefund(direct,row,q),direct)}
  for(let page=0;;page++){
    insist(page<20,'prepaid_refund_history_incomplete',409)
    const result=await stripe(`/refunds?${new URLSearchParams({charge:q.chargeRef,limit:'100',...(cursor?{starting_after:cursor}:{})})}`)
    insist(result.object==='list'&&Array.isArray(result.data)&&typeof result.has_more==='boolean','prepaid_refund_history_incomplete',409)
    for(const refund of result.data)if(refund.metadata?.nectar_prepaid_refund_request===row.id&&refund.metadata?.nectar_prepaid_refund_key===row.intent_key)matches.set(verifyRefund(refund,row,q),refund)
    if(!result.has_more)break
    const last=result.data.at(-1);insist(last&&ref(last.id)!==cursor,'prepaid_refund_history_incomplete',409);cursor=providerReference(last.id)
  }
  insist(matches.size===1,'prepaid_refund_unconfirmed',409);return [...matches.values()][0]
}
async function recordRefund(env:Bindings,actor:Actor,row:Row,stripe:StripeClient,refund:Row){
  const q=refundQuote(row),refundRef=verifyRefund(refund,row,q)
  row=await outcome(env,actor,row,{status:'uncertain',refund_ref:refundRef})
  if(['failed','canceled'].includes(refund.status))return outcome(env,actor,row,{status:'failed',error_code:refund.status==='canceled'?'processor_canceled':'processor_failed',proof_json:canonical({refundRef,status:refund.status,amountCents:q.amountCents,chargeRef:q.chargeRef})})
  insist(refund.status==='succeeded'&&Number.isSafeInteger(refund.created)&&refund.created>0,'prepaid_refund_unconfirmed',409)
  const transactionRef=providerReference(refund.balance_transaction),transaction=await stripe(`/balance_transactions/${encodeURIComponent(transactionRef)}`)
  const charge=await stripe(`/charges/${encodeURIComponent(q.chargeRef)}`)
  insist(transaction.object==='balance_transaction'&&transaction.id===transactionRef&&transaction.type==='refund'&&transaction.amount===-q.amountCents&&transaction.currency==='usd'&&ref(transaction.source)===refundRef&&['pending','available'].includes(transaction.status),'prepaid_refund_balance_proof_required',409)
  insist(charge.object==='charge'&&charge.id===q.chargeRef&&ref(charge.payment_intent)===q.paymentIntentRef&&ref(charge.customer)===q.customerRef&&charge.amount_refunded>=q.refundedBeforeCents+q.amountCents,'prepaid_refund_balance_proof_required',409)
  const date=localDate(refund.created*1000,q.timezone),proof={proof:'succeeded-refund-and-balance-debit',refundRef,chargeRef:q.chargeRef,paymentIntentRef:q.paymentIntentRef,accountRef:q.accountRef,paymentMethodRef:q.paymentMethodRef,amountCents:q.amountCents,cashAmountCents:-q.amountCents,currency:'usd',refundedOn:date,balanceTransactionRef:transactionRef}
  row=await outcome(env,actor,row,{status:'uncertain',proof_json:canonical(proof),error_code:'prepaid_refund_record_pending'})
  const business=await requireBusiness(env),customer=await one(env,'SELECT * FROM nc_customers WHERE id=? AND erased_at IS NULL',q.customer)
  insist(customer,'customer_not_found',404)
  const allocation=await documentNumberAllocation(env,business,customer,'credit-note'),credit=newId(),issuedAt=refund.created*1000
  insist(allocation.entityId===q.entityId&&canonical(JSON.parse(allocation.routeJson))===canonical(JSON.parse(q.routeJson)),'prepaid_refund_entity_changed',409)
  const ledger=`${row.id}-refund`
  await commit(env,[refundActorGuard(env,actor),stateGuard(env,row),...allocation.statements,
    guard(env,'prepaid_refund_balance_changed','(SELECT COALESCE(SUM(amount_n),0) FROM nc_prepaid_ledger WHERE grant_id=?)=? AND (SELECT COALESCE(SUM(liability_cents),0) FROM nc_prepaid_ledger WHERE grant_id=?)=?',q.grant,q.amountN,q.grant,q.amountCents),
    guard(env,'prepaid_refund_source_changed',"EXISTS(SELECT 1 FROM nc_invoices i JOIN nc_payments p ON p.id=? JOIN nc_prepaid_funding_intents f ON f.id=? WHERE i.id=? AND i.status='issued' AND i.source_fingerprint=? AND f.invoice_id=i.id AND f.payment_id=p.id AND p.customer_id=? AND p.amount_cents=? AND p.method='card_external')",q.payment,q.funding,q.invoice,q.sourceFingerprint,q.customer,q.originalAmountCents),
    stmt(env,'INSERT INTO nc_credit_notes(id,number,invoice_id,customer_id,amount_cents,reason,issued_by,issued_at,applied_cents,subtotal_cents,tax_cents,billing_entity_id,billing_route_json) VALUES(?,?,?,?,?,?,?,?,0,?,0,?,?)',credit,allocation.number,q.invoice,q.customer,q.amountCents,row.reason,actorLabel(actor),issuedAt,q.amountCents,allocation.entityId,allocation.routeJson),
    stmt(env,'INSERT INTO nc_prepaid_refund_credits(credit_id,refund_id,customer_id,purchase_invoice_id,purpose) VALUES(?,?,?,?,\'paid-liability-cash-refund\')',credit,row.id,q.customer,q.invoice),
    stmt(env,"INSERT INTO nc_prepaid_ledger(id,grant_id,customer_id,subscription_id,kind,amount_n,liability_cents,recognition_cents,service_date,purchase_invoice_id,purchase_line_id,created_at) VALUES(?,?,?,?,'refund',?,?,0,?,?,?,?)",ledger,q.grant,q.customer,q.subscription,-q.amountN,-q.amountCents,date,q.invoice,q.purchaseLine,clockInstant(env)),
    ...await revenueCreditStatements(env,{id:credit,invoice:q.invoice,customer:q.customer,amountCents:q.amountCents,issuedAt}),
    stmt(env,"UPDATE nc_prepaid_refunds SET status='refunded',credit_id=?,ledger_id=?,refunded_on=?,error_code=NULL,revision=? WHERE id=?",credit,ledger,date,newId(),row.id),
    stmt(env,'UPDATE nc_prepaid_accounts SET revision=revision+1 WHERE subscription_id=?',q.subscription)],{actor:actorLabel(actor),action:'prepaid.refund.complete',subject:row.id,detail:{credit,number:allocation.number,ledger,amountN:q.amountN,cashAmountCents:-q.amountCents,recognitionCents:0,payment:q.payment,refundRef,accountRef:q.accountRef}})
  return storedPrepaidRefund(env,row.id)
}
export async function executePrepaidRefund(env:Bindings,actor:Actor,id:string){
  refundActorGuard(env,actor)
  let row=await storedPrepaidRefund(env,id);if(row.status!=='approved')return prepaidRefundView(row)
  const q=refundQuote(row)
  let source:Awaited<ReturnType<typeof prepaidRefundSource>>,selected:Awaited<ReturnType<typeof inspectRefundCharge>>
  try{source=await prepaidRefundSource(env,q.grant,row.id);insist(source.sourceHash===q.sourceHash,'prepaid_refund_stale',409);selected=await inspectRefundCharge(env,q)}
  catch{return prepaidRefundView(await outcome(env,actor,row,{status:'stopped',error_code:'prepaid_refund_preflight_changed'}))}
  const revision=newId()
  await commit(env,[refundActorGuard(env,actor),refundApprovalGuard(env,row),prepaidRevisionGuard(env,q.subscription,source.basis.revision),stateGuard(env,row),stmt(env,"UPDATE nc_prepaid_refunds SET status='claimed',claimed_at=?,revision=? WHERE id=? AND status='approved'",clockInstant(env),revision,row.id)],{actor:actorLabel(actor),action:'prepaid.refund.claim',subject:row.id,detail:{basis:row.basis_hash,amountCents:q.amountCents,chargeRef:q.chargeRef}})
  row={...row,status:'claimed',revision}
  let attempted=false
  try{
    await inspectRefundCharge(env,q)
    await commit(env,[refundActorGuard(env,actor),refundApprovalGuard(env,row),stateGuard(env,row)],{actor:actorLabel(actor),action:'prepaid.refund.preflight',subject:row.id,detail:{basis:row.basis_hash}})
    attempted=true
    const refund=await selected.stripe('/refunds',new URLSearchParams({charge:q.chargeRef,amount:String(q.amountCents),'metadata[nectar_prepaid_refund_request]':row.id,'metadata[nectar_prepaid_refund_key]':row.intent_key}),`nectar-prepaid-refund-${row.intent_key}`)
    return prepaidRefundView(await recordRefund(env,actor,row,selected.stripe,refund))
  }catch{
    row=await storedPrepaidRefund(env,row.id);if(['refunded','failed'].includes(row.status))return prepaidRefundView(row)
    return prepaidRefundView(await outcome(env,actor,row,{status:attempted?'uncertain':'stopped',error_code:attempted?'prepaid_refund_unconfirmed':'prepaid_refund_preflight_changed'}))
  }
}
export async function reconcileRefund(env:Bindings,actor:Actor,id:string){
  refundActorGuard(env,actor);let row=await storedPrepaidRefund(env,id)
  if(['refunded','failed','stopped','rejected'].includes(row.status))return prepaidRefundView(row)
  insist(['claimed','uncertain'].includes(row.status),'prepaid_refund_not_reconcilable',409)
  try{const q=refundQuote(row),selected=await stripeForAccount(env,q.accountRef),refund=await refundHistory(selected.stripe,row,q);return prepaidRefundView(await recordRefund(env,actor,row,selected.stripe,refund))}
  catch{row=await storedPrepaidRefund(env,row.id);if(['refunded','failed'].includes(row.status))return prepaidRefundView(row);return prepaidRefundView(await outcome(env,actor,row,{status:'uncertain',error_code:row.proof_json?'prepaid_refund_record_pending':'prepaid_refund_unconfirmed'}))}
}
