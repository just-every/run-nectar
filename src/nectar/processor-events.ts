import type { Bindings } from '../auth.server'
import { requireMember, requireRead, type Actor } from './actor'
import { requireFreshFactor } from './mfa'
import { clockInstant } from './clock'
import { all, commit, fingerprint, guard, insist, NectarError, one, stmt, type Row } from './core'
import type { Input } from './input'
import { alertStatements } from './notifications'
import { deliverAlerts } from './notification-mail'
import { providerReference, stripeForAccount } from './payments/stripe'
import { chargeFacts, disputeFacts, failureFacts, payoutFacts, refundFacts } from './processor-facts'
import { instant, processorBinding, ref } from './processor-source'
import { reconcileProcessorCash } from './processor-cash'
import { processorCashObservation, unmatchedProcessorCash } from './processor-cash-queue'
import { readProcessorCashReturns, observeCashReturnEvent } from './processor-cash-return'

export const PROCESSOR_TYPES=['payment_intent.succeeded','payment_intent.processing','payment_intent.payment_failed','charge.succeeded','charge.failed','charge.refunded','refund.created','refund.updated','charge.dispute.created','charge.dispute.updated','charge.dispute.closed','cash_balance.funds_available','payout.created','payout.updated','payout.paid','payout.failed']
export async function consumeProcessorEvent(env:Bindings,actor:Actor,input:Input) {
 requireMember(actor,'approve');requireRead(actor,'payments');requireRead(actor,'invoices');await requireFreshFactor(env,actor)
 input.only(['account_ref','event_ref','returnTo'])
 return applyProcessorEvent(env,providerReference(input.text('account_ref',{max:255})),providerReference(input.text('event_ref',{max:255})),[guard(env,'authority',"EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','finance'))",actor.id)])
}
export async function applyProcessorEvent(env:Bindings,account:string|null,eventRef:string,authority:D1PreparedStatement[]=[]) {
 const selected=await stripeForAccount(env,account),stripe=selected.stripe;account=selected.account
 const id=await fingerprint({account,event:eventRef})
 const prior=await one(env,'SELECT status,event_type FROM nc_processor_events WHERE id=?',id)
 if(prior?.status==='applied'&&prior.event_type!=='cash_balance.funds_available')return {id,replayed:true}
 const event=await stripe(`/events/${encodeURIComponent(eventRef)}`),object=event.data?.object
 insist(event.object==='event'&&event.id===eventRef&&event.livemode===false&&PROCESSOR_TYPES.includes(event.type)&&object&&typeof object==='object'
  &&(event.account===undefined||event.account===account),'processor_event_invalid',409)
 const occurred=instant(event.created),objectRef=providerReference(object.id??object.customer)
 let customer:string|null=null,invoice:string|null=null
 try {
  let result:{statements:D1PreparedStatement[];customer:string|null;invoice:string|null}
  if(event.type==='payment_intent.payment_failed')result=await failureFacts(env,stripe,account,event)
  else if(event.type.startsWith('payment_intent.')) {
   const intent=await stripe(`/payment_intents/${encodeURIComponent(objectRef)}`)
   insist(intent.object==='payment_intent'&&intent.id===objectRef&&intent.livemode===false,'processor_intent_mismatch',409)
   if(ref(intent.latest_charge))result=await chargeFacts(env,stripe,account,providerReference(ref(intent.latest_charge)),event)
   else {const binding=await processorBinding(env,account,providerReference(ref(intent.customer)));result={statements:[],customer:binding.customer_id,invoice:null}}
  }
  else if(event.type.startsWith('charge.dispute.'))result=await disputeFacts(env,stripe,account,objectRef,event)
  else if(event.type==='charge.refunded') {
   const base=await chargeFacts(env,stripe,account,objectRef,event)
   result=base
   const {completeList}=await import('./processor-source')
   for(const refund of await completeList(stripe,'/refunds',{charge:objectRef})) {
    const facts=await refundFacts(env,stripe,account,refund.id,event,base)
    result.statements.push(...facts.statements)
   }
  }
  else if(event.type.startsWith('charge.'))result=await chargeFacts(env,stripe,account,objectRef,event)
  else if(event.type.startsWith('refund.')){
   const refund=await stripe(`/refunds/${encodeURIComponent(objectRef)}`)
   result=refund.origin==='customer_balance'||!ref(refund.charge)&&ref(refund.customer)
    ?await observeCashReturnEvent(env,stripe,account,refund,event):await refundFacts(env,stripe,account,objectRef,event)
  }
  else if(event.type.startsWith('payout.'))result=await payoutFacts(env,stripe,account,objectRef)
  else {
   const binding=await processorBinding(env,account,providerReference(ref(object.customer)))
   const cash=await reconcileProcessorCash(env,stripe,account,binding,prior?.status!=='applied')
   const statements=await processorCashObservation(env,account,binding.customer_id,cash)
   if(prior?.status==='applied'){
    await commit(env,[...authority,...statements],{actor:'system:processor',action:'processor.cash.observe',subject:id,detail:{customer:binding.customer_id}})
    return {id,replayed:true}
   }
   result={statements,customer:binding.customer_id,invoice:null}
  }
  customer=result.customer;invoice=result.invoice
  await commit(env,[...authority,
   guard(env,'processor_event_applied','NOT EXISTS(SELECT 1 FROM nc_processor_events WHERE id=? AND status=\'applied\')',id),
   ...result.statements,
   stmt(env,`INSERT INTO nc_processor_events(id,account_ref,event_ref,event_type,object_ref,customer_id,invoice_id,status,occurred_at,received_at,error_code) VALUES(?,?,?,?,?,?,?,'applied',?,?,NULL)
    ON CONFLICT(id) DO UPDATE SET status='applied',customer_id=excluded.customer_id,invoice_id=excluded.invoice_id,error_code=NULL`,id,account,eventRef,event.type,objectRef,customer,invoice,occurred,clockInstant(env))],
   {actor:'system:processor',action:'processor.event.apply',subject:id,detail:{accountRef:account,eventRef,type:event.type,customer,invoice}})
  return {id,replayed:false}
 }catch(error) {
  if((await one(env,'SELECT status FROM nc_processor_events WHERE id=?',id))?.status==='applied')return {id,replayed:true}
  const code=error instanceof NectarError?error.code:'processor_provider_or_storage_failure'
  await commit(env,[stmt(env,`INSERT INTO nc_processor_events(id,account_ref,event_ref,event_type,object_ref,customer_id,invoice_id,status,occurred_at,received_at,error_code) VALUES(?,?,?,?,?,?,?,'failed',?,?,?)
   ON CONFLICT(id) DO NOTHING`,id,account,eventRef,event.type,objectRef,customer,invoice,occurred,clockInstant(env),code),
   ...await alertStatements(env,'webhook_failure',id,`/app/processor-events#${id}`,'processor')],{actor:'system:processor',action:'processor.event.failure',subject:id,detail:{eventRef,code}})
  await deliverAlerts(env,'webhook_failure',id,'system:processor')
  throw error
 }
}
export async function processorEvents(env:Bindings,actor:Actor,customer?:string) {
 requireRead(actor,'payments');requireRead(actor,'invoices')
 const active=`AND (customer_id IS NULL OR EXISTS(SELECT 1 FROM nc_customers c WHERE c.id=customer_id AND c.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM nc_erased_records e WHERE e.record_id=c.id)))`
 return {bankPayoutMatches:actor.kind==='member'&&actor.role==='owner'?await all(env,`SELECT m.* FROM nc_bank_payout_matches m WHERE 1=1 ${customer?'AND EXISTS(SELECT 1 FROM nc_processor_transactions t JOIN nc_customers c ON c.id=t.customer_id WHERE t.account_ref=m.processor_account AND t.payout_ref=m.payout_ref AND t.customer_id=? AND c.erased_at IS NULL)':''} ORDER BY m.matched_at,m.id`,...(customer?[customer]:[])):[],cashReturns:await readProcessorCashReturns(env,actor,customer),unmatched:await unmatchedProcessorCash(env,actor,customer),cashBalances:await all(env,`SELECT * FROM nc_processor_cash_balances WHERE 1=1 ${active} ${customer?'AND customer_id=?':''}`, ...(customer?[customer]:[])),
  cashTransactions:await all(env,`SELECT * FROM nc_processor_cash_transactions WHERE 1=1 ${active} ${customer?'AND customer_id=?':''} ORDER BY occurred_at,transaction_ref`,...(customer?[customer]:[])),
  cashApplications:await all(env,`SELECT id,customer_id,invoice_id,transfer_ref,amount_cents,currency,status,payment_intent_ref,payment_id,allocation_id FROM nc_processor_cash_applications WHERE 1=1 ${active} ${customer?'AND customer_id=?':''} ORDER BY claimed_at,id`,...(customer?[customer]:[])),
  importedCashApplications:await all(env,`SELECT * FROM nc_processor_cash_imported_applications WHERE 1=1 ${active} ${customer?'AND customer_id=?':''} ORDER BY claimed_at,id`,...(customer?[customer]:[])),
  importedCashTakeovers:await all(env,`SELECT id,customer_id,invoice_id,account_ref,status,basis_hash,amount_cents,prepared_by FROM nc_processor_cash_imported_takeovers WHERE 1=1 ${active} ${customer?'AND customer_id=?':''} ORDER BY prepared_at,id`,...(customer?[customer]:[])),
  events:await all(env,`SELECT * FROM nc_processor_events WHERE 1=1 ${active} ${customer?'AND customer_id=?':''} ORDER BY occurred_at,event_ref`,...(customer?[customer]:[])),
  transactions:await all(env,`SELECT * FROM nc_processor_transactions WHERE 1=1 ${active} ${customer?'AND customer_id=?':''} ORDER BY occurred_at,transaction_ref`,...(customer?[customer]:[])),
  objects:await all(env,`SELECT * FROM nc_processor_objects WHERE 1=1 ${active} ${customer?'AND customer_id=?':''} ORDER BY observed_at,object_ref`,...(customer?[customer]:[])),
  reversals:await all(env,`SELECT * FROM nc_processor_reversals WHERE 1=1 ${active} ${customer?'AND customer_id=?':''} ORDER BY occurred_at,id`,...(customer?[customer]:[]))}
}
