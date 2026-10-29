// Current provider reads, never event payload snapshots, determine financial facts.
import { payoutComparison, PayoutComparisonError } from './close-payouts'
import type { Bindings } from '../auth.server'
import { ROLE_CAPABILITIES, type Actor } from './actor'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, canonical, fingerprint, guard, insist, newId, one, stmt, type Row } from './core'
import { localDate } from './dates'
import { providerReference, type StripeClient } from './payments/stripe'
import { allocationFactStatements, issuedInvoice, paymentFactStatement } from './receivables'
import { bankNetworkReturnCode, processorReturnStatements } from './processor-returns'
import { completeList, instant, integer, knownPayment, objectStatement, payoutAttribution, processorBinding, processorImportedCash, processorInvoice, ref, transactionStatement } from './processor-source'
export const processorActor:Actor={id:'system:processor',kind:'member',name:'Verified processor',email:'',role:'owner',sessionId:null,capabilities:new Set(ROLE_CAPABILITIES.owner)}

export async function chargeFacts(env:Bindings,stripe:StripeClient,account:string,chargeRef:string,event:Row) {
 const charge=await stripe(`/charges/${encodeURIComponent(providerReference(chargeRef))}`)
 insist(charge.object==='charge'&&charge.id===chargeRef&&charge.livemode===false,'processor_charge_invalid',409)
 const binding=await processorBinding(env,account,providerReference(ref(charge.customer)))
 const intent=ref(charge.payment_intent)?await stripe(`/payment_intents/${encodeURIComponent(providerReference(ref(charge.payment_intent)))}`):null
 if(intent)insist(intent.object==='payment_intent'&&ref(intent.customer)===binding.stripe_customer_ref&&intent.livemode===false,'processor_intent_mismatch',409)
 let invoice=await processorInvoice(env,binding,charge,intent)
 let payment=await knownPayment(env,account,charge,intent)
 if(payment){
  insist(payment.customer_id===binding.customer_id&&payment.amount_cents===charge.amount&&payment.currency.toLowerCase()===charge.currency,'processor_payment_mismatch',409)
  const allocations=await all(env,'SELECT DISTINCT invoice_id FROM nc_allocations WHERE payment_id=?',payment.id)
  if(!invoice&&allocations.length===1)invoice=await one(env,'SELECT * FROM nc_invoices WHERE id=?',allocations[0].invoice_id)
 }
 const statements:D1PreparedStatement[]=[]
 const at=clockInstant(env),amount=integer(charge.amount)
 const captured=charge.status==='succeeded'&&charge.paid===true&&charge.captured===true&&charge.amount_captured===amount
 const imported=await processorImportedCash(env,stripe,binding,charge,intent)
 if(imported){
  insist(!invoice&&!payment,'processor_cash_imported_evidence_invalid',409)
  if(imported.status==='uncertain'){
   const {importedCashSettlementStatements}=await import('./processor-cash-imported')
   statements.push(...await importedCashSettlementStatements(env,stripe,binding,imported,intent!,charge))
  }
 }
 if(captured&&!payment&&!imported){
  insist(invoice,'processor_invoice_required',409)
  const owed=await issuedInvoice(env,invoice.id)
  insist(owed.balance_cents>=amount&&amount>0,'processor_allocation_exceeds_balance',409)
  const id=newId(),reference=`stripe:${account}:${intent?.id??charge.id}`
  payment={id,customer_id:binding.customer_id,amount_cents:amount,currency:charge.currency}
  statements.push(guard(env,'processor_payment_exists','NOT EXISTS(SELECT 1 FROM nc_payments WHERE customer_id=? AND reference=?)',binding.customer_id,reference),
   paymentFactStatement(env,processorActor,{paymentId:id,customerId:binding.customer_id,amountCents:amount,currency:charge.currency,receivedOn:localDate(instant(charge.created),(await requireBusiness(env)).timezone),
    method:charge.payment_method_details?.type==='us_bank_account'?'bank_transfer':'card_external',reference,evidence:canonical({kind:'verified_processor_capture',accountRef:account,chargeRef:charge.id,paymentIntentRef:intent?.id??null})}),
   ...allocationFactStatements(env,processorActor,id,invoice,amount,newId()))
 }
 if(ref(charge.balance_transaction)) {
  const transaction=await stripe(`/balance_transactions/${encodeURIComponent(providerReference(ref(charge.balance_transaction)))}`)
  insist(ref(transaction.source)===charge.id&&transaction.amount===amount&&transaction.currency===charge.currency,'processor_charge_transaction_mismatch',409)
  statements.push(await transactionStatement(env,account,transaction,{customer:binding.customer_id,invoice:invoice?.id,payment:payment?.id}))
 }
 if(ref(charge.failure_balance_transaction)) {
  const transaction=await stripe(`/balance_transactions/${encodeURIComponent(providerReference(ref(charge.failure_balance_transaction)))}`)
  insist(ref(transaction.source)===charge.id&&transaction.amount===-amount&&transaction.currency===charge.currency,'processor_return_transaction_mismatch',409)
  statements.push(await transactionStatement(env,account,transaction,{customer:binding.customer_id,invoice:invoice?.id,payment:payment?.id}))
 }
 // A late bank failure reverses the allocation with an append-only fact. Gross
 // receipts remain historical cash evidence; the issued invoice becomes owed.
 if(charge.status==='failed'&&payment&&charge.payment_method_details?.type==='us_bank_account'){
  const allocations=await all(env,'SELECT * FROM nc_allocations WHERE payment_id=?',payment.id)
  for(const allocation of allocations) {
   const id=await fingerprint({account,charge:charge.id,allocation:allocation.id})
   statements.push(stmt(env,`INSERT OR IGNORE INTO nc_processor_reversals(id,account_ref,source_ref,allocation_id,invoice_id,customer_id,amount_cents,occurred_at) VALUES(?,?,?,?,?,?,?,?)`,
    id,account,charge.id,allocation.id,allocation.invoice_id,binding.customer_id,allocation.amount_cents,instant(event.created)))
  }
 }
 const code=typeof charge.failure_code==='string'?charge.failure_code:null
 const returned=processorReturnStatements(env,account,charge,intent,binding.customer_id,invoice?.id??null,at)
 statements.push(...(returned.length?returned:[objectStatement(env,account,charge,'charge',binding.customer_id,invoice?.id??null,charge.status,code,at)]))
 return {statements,customer:binding.customer_id,invoice:invoice?.id??null,charge,intent,binding,payment}
}

export async function refundFacts(env:Bindings,stripe:StripeClient,account:string,refundRef:string,event:Row,chargeContext?:Awaited<ReturnType<typeof chargeFacts>>) {
 const refund=await stripe(`/refunds/${encodeURIComponent(providerReference(refundRef))}`)
 insist(refund.object==='refund'&&refund.id===refundRef&&refund.livemode!==true,'processor_refund_invalid',409)
 const facts=chargeContext?{...chargeContext,statements:[] as D1PreparedStatement[]}:await chargeFacts(env,stripe,account,providerReference(ref(refund.charge)),event)
 insist(refund.currency===facts.charge.currency&&integer(refund.amount)>0&&refund.amount<=facts.charge.amount,'processor_refund_mismatch',409)
 if(refund.status==='succeeded'&&ref(refund.balance_transaction)) {
  const transaction=await stripe(`/balance_transactions/${encodeURIComponent(providerReference(ref(refund.balance_transaction)))}`)
  insist(ref(transaction.source)===refund.id&&transaction.amount===-refund.amount&&transaction.currency===refund.currency,'processor_refund_transaction_mismatch',409)
  facts.statements.push(await transactionStatement(env,account,transaction,{customer:facts.customer,invoice:facts.invoice,payment:facts.payment?.id}))
 }
 facts.statements.push(objectStatement(env,account,refund,'refund',facts.customer,facts.invoice,refund.status,refund.failure_reason??null,clockInstant(env)))
 return facts
}
export async function disputeFacts(env:Bindings,stripe:StripeClient,account:string,disputeRef:string,event:Row) {
 const dispute=await stripe(`/disputes/${encodeURIComponent(providerReference(disputeRef))}`)
 insist(dispute.object==='dispute'&&dispute.id===disputeRef&&dispute.livemode===false,'processor_dispute_invalid',409)
 const facts=await chargeFacts(env,stripe,account,providerReference(ref(dispute.charge)),event)
 for(const candidate of dispute.balance_transactions??[]) {
  const transaction=await stripe(`/balance_transactions/${encodeURIComponent(providerReference(ref(candidate)))}`)
  insist(ref(transaction.source)===dispute.id&&transaction.currency===dispute.currency,'processor_dispute_transaction_mismatch',409)
  facts.statements.push(await transactionStatement(env,account,transaction,{customer:facts.customer,invoice:facts.invoice,payment:facts.payment?.id}))
 }
 const bank=facts.charge.payment_method_details?.type==='us_bank_account'
 facts.statements.push(objectStatement(env,account,dispute,bank?'ach_return':'dispute',facts.customer,facts.invoice,dispute.status,dispute.reason,clockInstant(env)))
 if(bank&&facts.payment&&['lost','needs_response','warning_needs_response'].includes(dispute.status)) {
  for(const allocation of await all(env,'SELECT * FROM nc_allocations WHERE payment_id=?',facts.payment.id)){
   const id=await fingerprint({account,charge:facts.charge.id,allocation:allocation.id})
   facts.statements.push(stmt(env,'INSERT OR IGNORE INTO nc_processor_reversals(id,account_ref,source_ref,allocation_id,invoice_id,customer_id,amount_cents,occurred_at) VALUES(?,?,?,?,?,?,?,?)',id,account,facts.charge.id,allocation.id,allocation.invoice_id,facts.customer,allocation.amount_cents,instant(event.created)))
  }
 }
 return facts
}
export async function failureFacts(env:Bindings,stripe:StripeClient,account:string,event:Row) {
 const intent=await stripe(`/payment_intents/${encodeURIComponent(providerReference(event.data.object.id))}`)
 insist(intent.object==='payment_intent'&&intent.livemode===false,'processor_intent_mismatch',409)
 const binding=await processorBinding(env,account,providerReference(ref(intent.customer))),invoice=await processorInvoice(env,binding,intent)
 insist(invoice,'processor_invoice_required',409)
 insist(!await one(env,"SELECT 1 FROM nc_invoice_lines WHERE invoice_id=? AND kind='prepaid_purchase' UNION ALL SELECT 1 FROM nc_trial_collections WHERE invoice_id=? UNION ALL SELECT 1 FROM nc_prepaid_topup_claims WHERE invoice_id=?",invoice.id,invoice.id,invoice.id),'processor_recovery_source_excluded',409)
 // Only definitive original failure evidence enters the immutable cohort. A
 // later success cannot erase it; an older failure can arrive after recovery.
 const source=event.data.object,error=source.last_payment_error,code=error?.decline_code??error?.code
 insist(source.object==='payment_intent'&&source.customer===intent.customer&&source.currency===invoice.currency.toLowerCase()
  &&source.metadata?.nectar_native_invoice===invoice.id&&integer(source.amount)>0&&source.amount<=invoice.total_cents&&source.amount_received===0&&source.status==='requires_payment_method'&&typeof code==='string'&&/^[a-zA-Z0-9_]{1,100}$/.test(code),'processor_failure_unconfirmed',409)
 const bank=error?.payment_method?.type==='us_bank_account'||typeof error?.network_decline_code==='string'&&/^R\d{2}$/.test(error.network_decline_code)
 const facts=bank&&ref(intent.latest_charge)?await chargeFacts(env,stripe,account,providerReference(ref(intent.latest_charge)),event):null
 const sameBankCharge=facts?.charge.payment_method_details?.type==='us_bank_account'&&ref(source.latest_charge)===facts.charge.id
 // Current failed-bank observations and automatic attempts share the raw reason.
 // An earlier genuine failure event can arrive after that same charge recovered.
 const raw=sameBankCharge?(bankNetworkReturnCode(facts!.charge,facts!.intent)??(/^R\d{2}$/.test(error?.network_decline_code??'')?error.network_decline_code:null)):null
 const id=await fingerprint({account,event:event.id})
 const statements=[...(facts?.statements??[]),stmt(env,`INSERT OR IGNORE INTO nc_processor_failures(id,account_ref,intent_ref,invoice_id,customer_id,attempted_at,amount_cents,decline_code) VALUES(?,?,?,?,?,?,?,?)`,id,account,intent.id,invoice.id,binding.customer_id,instant(event.created),integer(source.amount),raw??code),
  objectStatement(env,account,intent,'payment_intent',binding.customer_id,invoice.id,intent.status,code,clockInstant(env))]
 return {statements,customer:binding.customer_id,invoice:invoice.id}
}
export async function payoutFacts(env:Bindings,stripe:StripeClient,account:string,payoutRef:string) {
 const payout=await stripe(`/payouts/${encodeURIComponent(providerReference(payoutRef))}`)
 insist(payout.object==='payout'&&payout.id===payoutRef&&payout.livemode===false,'processor_payout_invalid',409)
 const transaction=await stripe(`/balance_transactions/${encodeURIComponent(providerReference(ref(payout.balance_transaction)))}`)
 insist(ref(transaction.source)===payout.id&&transaction.amount===-payout.amount&&transaction.currency===payout.currency,'processor_payout_transaction_mismatch',409)
 const statements=[await transactionStatement(env,account,transaction,{payout:payout.id}),objectStatement(env,account,payout,'payout',null,null,payout.status,payout.automatic===true?null:'manual_payout_constituents_unavailable',clockInstant(env))]
 // Keep validated comparison evidence even when the constituent sum is refused.
 // Rejected observations never enter the financial transaction table.
 const observed: {transaction:Row;context:Row}[]=[]
 if(payout.automatic===true){
  const members=(await completeList(stripe,'/balance_transactions',{payout:payout.id,'expand[]':'data.source'})).filter(row=>row.id!==transaction.id)
  for(const member of members)observed.push({transaction:member,context:await payoutAttribution(env,stripe,account,member)})
 }
 const comparison=await payoutComparison(env,account,payout,transaction,observed)
 if(comparison.error&&payout.automatic===true)throw new PayoutComparisonError(comparison.error,comparison.statements)
 statements.push(...comparison.statements)
 for(const {transaction:member,context} of observed)statements.push(await transactionStatement(env,account,member,{...context,payout:payout.id}))
 return {statements,customer:null,invoice:null}
}
