import type { Bindings } from '../auth.server'
import { all, fingerprint, insist, one, stmt, type Row } from './core'
import { providerReference, type StripeClient } from './payments/stripe'

export const ref=(value:unknown):string=>typeof value==='string'?value:value&&typeof value==='object'?String((value as Row).id??''):''
export const integer=(value:unknown):number=>{insist(Number.isSafeInteger(value),'processor_amount_invalid',409);return value as number}
export const instant=(value:unknown):number=>{const n=integer(value);insist(n>0&&n<=253402300799,'processor_time_invalid',409);return n*1000}
export async function completeList(stripe:StripeClient,path:string,fields:Record<string,string>={}) {
 const rows:Row[]=[],seen=new Set<string>();let cursor=''
 for(let page=0;page<100;page++) {
  const result=await stripe(`${path}?${new URLSearchParams({...fields,limit:'100',...(cursor?{starting_after:cursor}:{})})}`)
  insist(result.object==='list'&&Array.isArray(result.data)&&typeof result.has_more==='boolean','processor_list_incomplete',409)
  for(const row of result.data){const id=providerReference(row.id);insist(!seen.has(id),'processor_list_duplicate',409);seen.add(id);rows.push(row)}
  if(!result.has_more)return rows
  insist(result.data.length>0,'processor_list_incomplete',409);cursor=providerReference(result.data.at(-1).id)
 }
 throw new Error('processor_list_limit')
}
async function findProcessorBinding(env:Bindings,account:string,customer:string) {
 return one(env,`SELECT b.*,c.currency FROM nc_stripe_customer_bindings b JOIN nc_customers c ON c.id=b.customer_id
 WHERE b.account_ref=? AND b.stripe_customer_ref=? AND c.status='active' AND c.erased_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(b.id,c.id))`,account,customer)
}
export async function processorBinding(env:Bindings,account:string,customer:string) {
 const row=await findProcessorBinding(env,account,customer)
 insist(row,'processor_customer_binding_required',409);return row
}
export async function processorInvoice(env:Bindings,binding:Row,object:Row,intent?:Row|null) {
 const chargeRef=object.object==='charge'?object.id:'',intentRef=object.object==='payment_intent'?object.id:intent?.id??''
 const native=await all(env,`SELECT invoice_id FROM nc_native_collections WHERE account_ref=? AND stripe_customer_ref=? AND (charge_ref=? OR payment_intent_ref=?)
 UNION SELECT invoice_id FROM nc_automatic_collections WHERE account_ref=? AND stripe_customer_ref=? AND (charge_ref=? OR payment_intent_ref=?)
 UNION SELECT invoice_id FROM nc_ach_payment_evidence WHERE account_ref=? AND stripe_customer_ref=? AND (charge_ref=? OR payment_intent_ref=?)
 UNION SELECT invoice_id FROM nc_processor_cash_applications WHERE account_ref=? AND stripe_customer_ref=? AND (charge_ref=? OR payment_intent_ref=?)`,
 binding.account_ref,binding.stripe_customer_ref,chargeRef||null,intentRef||null,binding.account_ref,binding.stripe_customer_ref,chargeRef||null,intentRef||null,
 binding.account_ref,binding.stripe_customer_ref,chargeRef||null,intentRef||null,binding.account_ref,binding.stripe_customer_ref,chargeRef||null,intentRef||null)
 const ids=new Set([object.metadata?.nectar_native_invoice,intent?.metadata?.nectar_native_invoice,...native.map(row=>row.invoice_id)].filter(Boolean))
 insist(ids.size<=1,'processor_invoice_mismatch',409)
 const id=[...ids][0]
 if(!id)return null
 const row=await one(env,"SELECT * FROM nc_invoices WHERE id=? AND customer_id=? AND status='issued' AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=nc_invoices.id)",id,binding.customer_id)
 insist(row&&row.currency.toLowerCase()===object.currency,'processor_invoice_mismatch',409)
 return row
}
export async function knownPayment(env:Bindings,account:string,charge:Row,intent:Row|null) {
 const matches=await all(env,`SELECT payment_id FROM nc_native_collections WHERE account_ref=? AND (charge_ref=? OR payment_intent_ref=?) AND payment_id IS NOT NULL
 UNION SELECT payment_id FROM nc_automatic_collections WHERE account_ref=? AND (charge_ref=? OR payment_intent_ref=?) AND payment_id IS NOT NULL
 UNION SELECT payment_id FROM nc_ach_payment_evidence WHERE account_ref=? AND charge_ref=?
 UNION SELECT payment_id FROM nc_processor_cash_applications WHERE account_ref=? AND charge_ref=? AND payment_id IS NOT NULL
 UNION SELECT payment_id FROM nc_processor_transactions WHERE account_ref=? AND source_ref=? AND payment_id IS NOT NULL`,
 account,charge.id,intent?.id??'',account,charge.id,intent?.id??'',account,charge.id,account,charge.id,account,charge.id)
 insist(matches.length<=1,'processor_payment_ambiguous',409)
 if(matches.length)return one(env,'SELECT * FROM nc_payments WHERE id=?',matches[0].payment_id)
 return one(env,'SELECT * FROM nc_payments WHERE reference=?',`stripe:${account}:${intent?.id??charge.id}`)
}
export async function processorImportedCash(env:Bindings,stripe:StripeClient,binding:Row,charge:Row,intent:Row|null,requireKnown=true) {
 const {observeImportedCashPayment}=await import('./processor-cash-imported')
 return observeImportedCashPayment(env,stripe,binding,charge,intent,requireKnown)
}
/** Attribution observes existing native records; a payout never creates cash or invoices. */
export async function payoutAttribution(env:Bindings,stripe:StripeClient,account:string,transaction:Row) {
 const expanded=transaction.source
 if(!expanded||typeof expanded!=='object'||!['charge','payment_intent','refund','dispute'].includes(expanded.object))return {}
 const paths:Record<string,string>={charge:'charges',payment_intent:'payment_intents',refund:'refunds',dispute:'disputes'},path=paths[expanded.object]
 const source=await stripe(`/${path}/${encodeURIComponent(providerReference(expanded.id))}`)
 insist(source.object===expanded.object&&source.id===expanded.id&&(source.object==='refund'?source.livemode!==true:source.livemode===false),'processor_payout_source_mismatch',409)
 const chargeRef=source.object==='charge'?source.id:source.object==='payment_intent'?ref(source.latest_charge):ref(source.charge)
 if(!chargeRef)return {}
 const charge=source.object==='charge'?source:await stripe(`/charges/${encodeURIComponent(providerReference(chargeRef))}`)
 insist(charge.object==='charge'&&charge.id===chargeRef&&charge.livemode===false&&charge.currency===transaction.currency,'processor_payout_source_mismatch',409)
 const linked=source.object==='refund'?ref(source.balance_transaction)===transaction.id&&transaction.amount===-integer(source.amount)
  :source.object==='dispute'?(source.balance_transactions??[]).some((row:unknown)=>ref(row)===transaction.id)
  :ref(charge.balance_transaction)===transaction.id&&transaction.amount===integer(charge.amount)
   ||ref(charge.failure_balance_transaction)===transaction.id&&transaction.amount===-integer(charge.amount)
 insist(linked&&source.currency===transaction.currency,'processor_payout_source_mismatch',409)
 const binding=await findProcessorBinding(env,account,ref(charge.customer))
 if(!binding)return {}
 const intent=ref(charge.payment_intent)?await stripe(`/payment_intents/${encodeURIComponent(providerReference(ref(charge.payment_intent)))}`):null
 if(intent)insist(intent.object==='payment_intent'&&intent.id===ref(charge.payment_intent)&&ref(intent.customer)===binding.stripe_customer_ref&&intent.currency===charge.currency&&intent.livemode===false,'processor_intent_mismatch',409)
 if(await processorImportedCash(env,stripe,binding,charge,intent,false))return {customer:binding.customer_id}
 const payment=await knownPayment(env,account,charge,intent)
 if(payment)insist(payment.customer_id===binding.customer_id&&payment.amount_cents===charge.amount&&payment.currency.toLowerCase()===charge.currency,'processor_payment_mismatch',409)
 if(!payment&&!(charge.status==='succeeded'&&charge.paid===true&&charge.captured===true&&charge.amount_captured===charge.amount))return {}
 let invoice=await processorInvoice(env,binding,charge,intent)
 if(!invoice&&payment){
  const allocations=await all(env,'SELECT DISTINCT invoice_id FROM nc_allocations WHERE payment_id=?',payment.id)
  if(allocations.length===1)invoice=await one(env,"SELECT * FROM nc_invoices WHERE id=? AND customer_id=? AND status='issued'",allocations[0].invoice_id,binding.customer_id)
 }
 if(!invoice)return {}
 return {customer:binding.customer_id,invoice:invoice.id,payment:payment?.id}
}
export async function transactionStatement(env:Bindings,account:string,transaction:Row,context:{customer?:string|null;invoice?:string|null;payment?:string|null;payout?:string|null}={}) {
 insist(transaction.object==='balance_transaction'&&['pending','available'].includes(transaction.status)&&/^[a-z]{3}$/.test(transaction.currency),'processor_transaction_invalid',409)
 const amount=integer(transaction.amount),fee=integer(transaction.fee),net=integer(transaction.net)
 const source=transaction.source==null?'':providerReference(ref(transaction.source))
 insist(net===amount-fee,'processor_transaction_net_mismatch',409)
 const id=await fingerprint({account,transaction:providerReference(transaction.id)})
 const prior=await one(env,'SELECT * FROM nc_processor_transactions WHERE id=?',id)
 if(prior)insist(prior.amount_cents===amount&&prior.fee_cents===fee&&prior.net_cents===net&&prior.currency===transaction.currency&&prior.source_ref===ref(transaction.source),'processor_transaction_changed',409)
 return stmt(env,`INSERT INTO nc_processor_transactions(id,account_ref,transaction_ref,type,source_ref,customer_id,invoice_id,payment_id,amount_cents,fee_cents,net_cents,currency,status,occurred_at,available_at,payout_ref)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,available_at=excluded.available_at,
 customer_id=COALESCE(nc_processor_transactions.customer_id,excluded.customer_id),invoice_id=COALESCE(nc_processor_transactions.invoice_id,excluded.invoice_id),payment_id=COALESCE(nc_processor_transactions.payment_id,excluded.payment_id),payout_ref=COALESCE(nc_processor_transactions.payout_ref,excluded.payout_ref)`,
 id,account,transaction.id,providerReference(transaction.type),source,context.customer??null,context.invoice??null,context.payment??null,amount,fee,net,transaction.currency,transaction.status,instant(transaction.created),instant(transaction.available_on),context.payout??null)
}
export function objectStatement(env:Bindings,account:string,object:Row,kind:string,customer:string|null,invoice:string|null,status:string,code:string|null,at:number) {
 return stmt(env,`INSERT INTO nc_processor_objects(account_ref,object_ref,kind,customer_id,invoice_id,status,amount_cents,currency,code,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?)
 ON CONFLICT(account_ref,object_ref) DO UPDATE SET status=excluded.status,code=excluded.code,observed_at=excluded.observed_at`,account,providerReference(object.id),kind,customer,invoice,status,integer(object.amount??0),object.currency??'usd',code,at)
}
