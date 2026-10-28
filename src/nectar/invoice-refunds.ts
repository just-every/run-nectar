import { reverseInvoiceTax } from './invoice-refund-tax'
import { checkedRefundCorrection, refundProposalGuard, refundCorrectionMailStatements } from './invoice-refund-correction'
import { deliverCorrectionMail } from './credit-correction-mail'
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, requireRead, type Actor } from './actor'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, canonical, commit, guard, insist, newId, one, parseJson, stmt, type Row } from './core'
import { creditPolicy } from './credit-policy'
import { documentNumberAllocation } from './invoice-numbering'
import { previewInvoiceRefund } from './invoice-refund-preview'
import { Input } from './input'
import { requireFreshFactor } from './mfa'
import { providerReference, stripeForAccount, type StripeClient } from './payments/stripe'
import { inspectRefundCharge } from './prepaid-refund-processor'
import { refundActorGuard } from './prepaid-refund-records'
import { revenueCreditStatements } from './revenue-records'

const ref = (v: unknown): string => typeof v === 'string' ? v : v && typeof v === 'object' ? (v as Row).id : ''
const chargeQuote = (proof: Row, originalAmountCents: number, amountCents: number) => ({ accountRef:proof.accountRef,customerRef:proof.customerRef,paymentMethodRef:proof.paymentMethodRef,paymentIntentRef:proof.paymentIntentRef,chargeRef:proof.chargeRef,livemode:proof.livemode,originalAmountCents,amountCents })
const view = (r: Row) => ({ id:r.id,invoice:r.invoice_id,customer:r.customer_id,payment:r.payment_id,amountCents:r.amount_cents,cashAmountCents:r.status==='completed'&&r.destination==='original'?-r.amount_cents:0,destination:r.destination,status:r.status,basis:r.basis_hash,preparedBy:r.prepared_by_id,approvedBy:r.approved_by_id,preparedAt:r.prepared_at,approvedAt:r.approved_at,refundRef:r.refund_ref,credit:r.credit_id,completedAt:r.completed_at,error:r.error_code,taxReversalRef:r.tax_ref??null,cancellationCredit:r.cancellation_credit_id??null,source:`/app/invoices/${r.invoice_id}#recv` })
async function stored(env: Bindings, id: string) {
  const r = await one(env, 'SELECT r.* FROM nc_invoice_refunds r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=? AND c.erased_at IS NULL', id)
  insist(r, 'invoice_refund_not_found', 404); return r
}
async function authority(env: Bindings, actor: Actor) { requireMember(actor,'approve'); await requireFreshFactor(env,actor); refundActorGuard(env,actor) }
async function current(env: Bindings, actor: Actor, input: Input) {
  const generation = Number((await one(env,'SELECT value FROM nc_privacy_generation WHERE id=1'))!.value)
  const preview = await previewInvoiceRefund(env,actor,input)
  // Declared local tax is not a provider transaction. Never invent its reversal.
  insist(preview.executionAvailable, 'invoice_refund_provider_tax_required', 409)
  insist(!await one(env,"SELECT 1 FROM nc_invoice_lines WHERE invoice_id=? AND kind IN ('prepaid_purchase','prepaid_drawdown','prepaid_credit','usage_correction','plan_change')",preview.invoice),'invoice_refund_source_not_supported',409)
  insist(!await one(env,"SELECT 1 FROM nc_cadence_disputes WHERE invoice_id=? AND resolved_at IS NULL",preview.invoice),'invoice_refund_disputed',409)
  const receipt = await one(env,"SELECT proof_json FROM nc_native_collections WHERE payment_id=? AND status='collected'",preview.original.payment)
  const proof = parseJson<Row>(receipt?.proof_json,{})
  const business = await requireBusiness(env), customer = await one(env,'SELECT * FROM nc_customers WHERE id=? AND erased_at IS NULL',preview.customer)
  insist(customer,'customer_not_found',404)
  const invoice = await one(env,'SELECT * FROM nc_invoices WHERE id=?',preview.invoice)
  insist(!await one(env,"SELECT 1 FROM nc_invoice_refunds WHERE invoice_id=? AND status IN ('claimed','uncertain')",preview.invoice),'invoice_refund_unresolved',409)
  insist(generation === Number((await one(env,'SELECT value FROM nc_privacy_generation WHERE id=1'))!.value),'invoice_refund_stale',409)
  return { preview,proof,invoice:invoice!,business,customer,generation }
}
const state = (env: Bindings, r: Row) => guard(env,'invoice_refund_state_changed','EXISTS(SELECT 1 FROM nc_invoice_refunds WHERE id=? AND revision=?)',r.id,r.revision)
async function outcome(env: Bindings, actor: Actor, r: Row, fields: Row) {
  const values = Object.entries({...fields,revision:newId()})
  await commit(env,[refundActorGuard(env,actor),state(env,r),stmt(env,`UPDATE nc_invoice_refunds SET ${values.map(([key])=>`${key}=?`).join(',')} WHERE id=?`,...values.map(([,v])=>v),r.id)],{actor:actorLabel(actor),action:'invoice.refund.outcome',subject:r.id,detail:{status:fields.status,error:fields.error_code??null}})
  return stored(env,r.id)
}
export async function prepareInvoiceRefund(env: Bindings, actor: Actor, input: Input) {
  await authority(env,actor)
  const correction = input.has('proposal') ? await checkedRefundCorrection(env,input.text('proposal',{max:100})) : null
  if(correction) insist(!await one(env,"SELECT 1 FROM nc_invoice_refunds WHERE json_extract(quote_json,'$.correction.proposal.id')=?",correction.proposal.id),'invoice_refund_already_prepared',409)
  if(correction) input=Input.of({...correction.plan.normalized,basis:correction.plan.impact.refund.basis})
  const source = await current(env,actor,input), reason=input.text('reason',{max:500})
  insist(input.text('basis',{max:100})===source.preview.basis,'invoice_refund_stale',409)
  const captured=await inspectRefundCharge(env,chargeQuote(source.proof,source.preview.original.totalCents,source.preview.destination==='original'?source.preview.amountCents:0))
  const knownCash=(await one(env,"SELECT COALESCE(SUM(amount_cents),0) AS amount FROM nc_invoice_refunds WHERE invoice_id=? AND destination='original' AND status='completed'",source.preview.invoice))!.amount
  insist(captured.charge.amount_refunded===knownCash,'invoice_refund_capture_unreconciled',409)
  const policy=await creditPolicy(env), id=newId(), at=clockInstant(env)
  const quote={...source.preview,proof:source.proof,refundedBeforeCents:captured.charge.amount_refunded,preparedName:actorLabel(actor),policyRevision:policy.revision,customerRevision:source.customer.revision,businessRevision:source.business.revision,entityId:source.invoice.billing_entity_id,routeJson:source.invoice.billing_route_json,...(correction?{correction:{proposal:correction.proposal,mail:correction.plan.impact.mail}}:{})}
  await commit(env,[refundActorGuard(env,actor),...(correction?[refundProposalGuard(env,correction.proposal)]:[]),guard(env,'invoice_refund_stale','COALESCE((SELECT revision FROM nc_credit_policy WHERE singleton=1),0)=?',policy.revision),
    guard(env,'invoice_refund_stale','(SELECT value FROM nc_privacy_generation WHERE id=1)=?',source.generation),
    guard(env,'invoice_refund_unresolved',"NOT EXISTS(SELECT 1 FROM nc_invoice_refunds WHERE invoice_id=? AND status IN ('claimed','uncertain'))",quote.invoice),
    stmt(env,"INSERT INTO nc_invoice_refunds(id,invoice_id,customer_id,payment_id,amount_cents,destination,basis_hash,quote_json,reason,prepared_by_id,prepared_at,status,intent_key,revision,cancellation_credit_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)",id,quote.invoice,quote.customer,quote.original.payment,quote.amountCents,quote.destination,quote.basis,canonical(quote),reason,actor.id,at,newId(),newId(),quote.cancellation?.creditId??null),stmt(env,'INSERT INTO nc_invoice_refund_authority(refund_id) VALUES(?)',id)],{actor:actorLabel(actor),action:'invoice.refund.prepare',subject:id,detail:{invoice:quote.invoice,basis:quote.basis,amountCents:quote.amountCents,destination:quote.destination}})
  return view(await stored(env,id))
}
function verify(refund: Row, r: Row, q: Row) {
  insist(refund.object==='refund'&&ref(refund.charge)===q.proof.chargeRef&&ref(refund.payment_intent)===q.proof.paymentIntentRef&&refund.amount===r.amount_cents&&refund.currency==='usd'&&refund.metadata?.nectar_invoice_refund===r.id&&refund.metadata?.nectar_refund_key===r.intent_key,'invoice_refund_receipt_mismatch',409)
  return providerReference(refund.id)
}
async function complete(env: Bindings, actor: Actor, r: Row, stripe?: StripeClient, refund?: Row, taxReference?: string) {
  const q=parseJson<Row>(r.quote_json,{})
  let proof:Row={proof:'paid-invoice-balance-credit',amountCents:r.amount_cents}, at=clockInstant(env)
  if(r.destination==='original') {
    insist(stripe&&refund,'invoice_refund_unconfirmed',409)
    const refundRef=verify(refund,r,q)
    r=await outcome(env,actor,r,{status:'uncertain',refund_ref:refundRef})
    if(['failed','canceled'].includes(refund.status))return view(await outcome(env,actor,r,{status:'failed',error_code:'processor_refund_failed'}))
    insist(refund.status==='succeeded'&&Number.isSafeInteger(refund.created),'invoice_refund_unconfirmed',409)
    const transactionRef=providerReference(refund.balance_transaction),transaction=await stripe(`/balance_transactions/${encodeURIComponent(transactionRef)}`)
    insist(transaction.object==='balance_transaction'&&transaction.id===transactionRef&&transaction.type==='refund'&&transaction.amount===-r.amount_cents&&transaction.currency==='usd'&&ref(transaction.source)===refundRef,'invoice_refund_balance_proof_required',409)
    at=refund.created*1000
    proof={proof:'succeeded-refund-and-balance-debit',refundRef,amountCents:r.amount_cents,balanceTransactionRef:transactionRef,chargeRef:q.proof.chargeRef,accountRef:q.proof.accountRef}
  }
  const reversedTax = await reverseInvoiceTax(env,actor,r,q,taxReference)
  r = reversedTax.refund
  if(reversedTax.proof) proof.taxReversal=reversedTax.proof
  const business=await requireBusiness(env),customer=await one(env,'SELECT * FROM nc_customers WHERE id=? AND erased_at IS NULL',r.customer_id)
  insist(customer,'customer_not_found',404)
  const number=await documentNumberAllocation(env,business,customer,'credit-note'),credit=q.cancellation?.creditId??newId()
  insist(number.entityId===q.entityId&&number.routeJson===q.routeJson,'invoice_refund_source_changed',409)
  await commit(env,[refundActorGuard(env,actor),state(env,r),...(q.cancellation?[]:number.statements),
    ...(q.cancellation?[guard(env,'cancellation_refund_credit_unavailable',"EXISTS(SELECT 1 FROM nc_credit_notes WHERE id=? AND applied_cents=0) AND NOT EXISTS(SELECT 1 FROM nc_usage_credit_applications WHERE credit_id=?)",credit,credit)]:[
    stmt(env,'INSERT INTO nc_credit_notes(id,number,invoice_id,customer_id,amount_cents,reason,issued_by,issued_at,applied_cents,subtotal_cents,tax_cents,billing_entity_id,billing_route_json,invoice_refund_id) VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?,?)',credit,number.number,r.invoice_id,r.customer_id,r.amount_cents,'Invoice refund',actorLabel(actor),at,q.reversing.subtotalCents,q.reversing.taxCents,number.entityId,number.routeJson,r.id),
    ...await revenueCreditStatements(env,{id:credit,invoice:r.invoice_id,customer:r.customer_id,amountCents:r.amount_cents,subtotalCents:q.reversing.subtotalCents,issuedAt:at})]),
    ...(q.correction?refundCorrectionMailStatements(env,q.correction,credit,r.customer_id,at):[]),
    stmt(env,"UPDATE nc_invoice_refunds SET status='completed',credit_id=?,completed_at=?,proof_json=?,error_code=NULL,revision=? WHERE id=?",credit,at,canonical(proof),newId(),r.id)],{actor:actorLabel(actor),action:'invoice.refund.complete',subject:r.id,detail:{invoice:r.invoice_id,credit,amountCents:r.amount_cents,destination:r.destination,preparedBy:q.preparedName,approvedBy:actorLabel(actor),refundRef:r.refund_ref??null}})
  if(q.correction && await one(env,'SELECT 1 FROM nc_invoice_refund_authority WHERE refund_id=?',r.id)) await deliverCorrectionMail(env,q.correction.proposal.id)
  return view(await stored(env,r.id))
}
export async function executeInvoiceRefund(env: Bindings, actor: Actor, input: Input) {
  return executeInvoiceRefundRequest(env,actor,input)
}
export async function executeRefundCorrection(env: Bindings, actor: Actor, input: Input, proposal: Row) {
  return executeInvoiceRefundRequest(env,actor,input,proposal)
}
async function executeInvoiceRefundRequest(env: Bindings, actor: Actor, input: Input, proposal?: Row) {
  await authority(env,actor);insist(input.flag('confirm'),'confirmation_required')
  let r:Row
  if(input.has('refund'))r=await stored(env,input.text('refund',{max:100}))
  else {
    const source=await current(env,actor,input)
    insist(!source.preview.needsSecondApprover,'second_approver_required',409)
    r=await stored(env,(await prepareInvoiceRefund(env,actor,input)).id)
  }
  insist(r.status==='pending','invoice_refund_not_pending',409)
  insist(await one(env,'SELECT 1 FROM nc_invoice_refund_authority WHERE refund_id=?',r.id),'invoice_refund_authority_inactive',409)
  const q=parseJson<Row>(r.quote_json,{})
  insist(!q.correction || proposal?.id===q.correction.proposal.id,'invoice_refund_proposal_required',409)
  if(proposal) {
    const checked=await checkedRefundCorrection(env,proposal.id)
    insist(q.correction && checked.plan.impact.refund.basis===r.basis_hash,'proposal_stale',409)
  }
  const source=await current(env,actor,Input.of({invoice:r.invoice_id,amount:String(r.amount_cents/100),destination:r.destination,...(q.cancellation?{cancellation:q.cancellation.id}:{})}))
  insist(input.text('basis',{max:100})===r.basis_hash&&source.preview.basis===r.basis_hash&&source.customer.revision===q.customerRevision&&source.business.revision===q.businessRevision,'invoice_refund_stale',409)
  insist(!source.preview.needsSecondApprover||actor.id!==r.prepared_by_id,'second_approver_required',409)
  const live=await inspectRefundCharge(env,chargeQuote(q.proof,q.original.totalCents,r.destination==='original'?r.amount_cents:0))
  insist(live.charge.amount_refunded===q.refundedBeforeCents,'invoice_refund_capture_changed',409)
  const actors=()=>guard(env,'invoice_refund_authority_changed',"EXISTS(SELECT 1 FROM nc_members m JOIN oa_operators o ON o.email=m.email WHERE m.id=? AND m.role IN ('owner','finance') AND m.status='active' AND o.status='active' AND (m.role<>'owner' OR o.role='owner'))",r.prepared_by_id)
  const revision=newId(),at=clockInstant(env)
  await commit(env,[refundActorGuard(env,actor),actors(),state(env,r),...(proposal?[refundProposalGuard(env,proposal)]:[]),guard(env,'invoice_refund_stale','COALESCE((SELECT revision FROM nc_credit_policy WHERE singleton=1),0)=?',q.policyRevision),
    guard(env,'invoice_refund_stale','(SELECT value FROM nc_privacy_generation WHERE id=1)=?',source.generation),
    ...(proposal?[stmt(env,"UPDATE nc_proposals SET status='approved',decided_by=?,decided_at=?,decision_note=?,result_json=? WHERE id=?",actorLabel(actor),at,proposal.decision_note??'',canonical({refund:r.id,invoice:r.invoice_id}),proposal.id)]:[]),
    stmt(env,"UPDATE nc_invoice_refunds SET status='claimed',approved_by_id=?,approved_at=?,claimed_at=?,revision=? WHERE id=?",actor.id,at,at,revision,r.id)],[{actor:actorLabel(actor),action:'invoice.refund.claim',subject:r.id,detail:{invoice:r.invoice_id,basis:r.basis_hash,amountCents:r.amount_cents,preparedBy:r.prepared_by_id,approvedBy:actor.id}},...(proposal?[{actor:actorLabel(actor),action:'proposal.approve',subject:proposal.id,detail:{refund:r.id,note:proposal.decision_note??''}}]:[])])
  r={...r,status:'claimed',approved_by_id:actor.id,revision}
  try {
    if(r.destination==='balance')return await complete(env,actor,r)
    await commit(env,[refundActorGuard(env,actor),actors(),state(env,r)],{actor:actorLabel(actor),action:'invoice.refund.preflight',subject:r.id,detail:{basis:r.basis_hash}})
    const refund=await live.stripe('/refunds',new URLSearchParams({charge:q.proof.chargeRef,amount:String(r.amount_cents),'metadata[nectar_invoice_refund]':r.id,'metadata[nectar_refund_key]':r.intent_key}),`nectar-invoice-refund-${r.intent_key}`)
    return await complete(env,actor,r,live.stripe,refund)
  } catch {
    r=await stored(env,r.id)
    if(['completed','failed'].includes(r.status))return view(r)
    return view(await outcome(env,actor,r,{status:'uncertain',error_code:'invoice_refund_unconfirmed'}))
  }
}
export async function reconcileInvoiceRefund(env: Bindings, actor: Actor, input: Input) {
  await authority(env,actor)
  const r=await stored(env,input.text('refund',{max:100}))
  if(['completed','failed','stopped'].includes(r.status))return view(r)
  insist(['claimed','uncertain'].includes(r.status),'invoice_refund_not_reconcilable',409)
  if(r.destination==='balance')return complete(env,actor,r,undefined,undefined,input.text('tax_reversal',{max:255,optional:true})||undefined)
  const q=parseJson<Row>(r.quote_json,{}),{stripe}=await stripeForAccount(env,q.proof.accountRef)
  let cursor='';const matches=new Map<string,Row>()
  for(let page=0;;page++) {
    insist(page<20,'invoice_refund_history_incomplete',409)
    const result=await stripe(`/refunds?${new URLSearchParams({charge:q.proof.chargeRef,limit:'100',...(cursor?{starting_after:cursor}:{})})}`)
    insist(result.object==='list'&&Array.isArray(result.data)&&typeof result.has_more==='boolean','invoice_refund_history_incomplete',409)
    for(const refund of result.data)if(refund.metadata?.nectar_invoice_refund===r.id&&refund.metadata?.nectar_refund_key===r.intent_key)matches.set(verify(refund,r,q),refund)
    if(!result.has_more)break
    cursor=providerReference(result.data.at(-1)?.id)
  }
  insist(matches.size===1,'invoice_refund_unconfirmed',409)
  return complete(env,actor,r,stripe,[...matches.values()][0],input.text('tax_reversal',{max:255,optional:true})||undefined)
}
export async function invoiceRefunds(env: Bindings, actor: Actor, invoice: string) {
  requireRead(actor,'invoices');requireRead(actor,'payments')
  return (await all(env,'SELECT * FROM nc_invoice_refunds WHERE invoice_id=? ORDER BY prepared_at,id',invoice)).map(view)
}

/** Releasing an unclaimed request cannot repeat or reverse a provider action. */
export async function stopInvoiceRefund(env: Bindings, actor: Actor, input: Input) {
  await authority(env,actor);insist(input.flag('confirm'),'confirmation_required')
  const r=await stored(env,input.text('refund',{max:100}))
  insist(r.status==='pending','invoice_refund_already_claimed',409)
  await commit(env,[refundActorGuard(env,actor),state(env,r),stmt(env,"UPDATE nc_invoice_refunds SET status='stopped',revision=? WHERE id=?",newId(),r.id)],{actor:actorLabel(actor),action:'invoice.refund.stop',subject:r.id,detail:{invoice:r.invoice_id,cancellationCredit:r.cancellation_credit_id??null}})
  return view(await stored(env,r.id))
}
