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
export async function processorBinding(env:Bindings,account:string,customer:string) {
 const row=await one(env,`SELECT b.*,c.currency FROM nc_stripe_customer_bindings b JOIN nc_customers c ON c.id=b.customer_id
 WHERE b.account_ref=? AND b.stripe_customer_ref=? AND c.status='active' AND c.erased_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(b.id,c.id))`,account,customer)
 insist(row,'processor_customer_binding_required',409);return row
}
export async function processorInvoice(env:Bindings,binding:Row,object:Row,intent?:Row|null) {
 const id=object.metadata?.nectar_native_invoice??intent?.metadata?.nectar_native_invoice
 if(!id)return null
 const row=await one(env,"SELECT * FROM nc_invoices WHERE id=? AND customer_id=? AND status='issued'",id,binding.customer_id)
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
export async function transactionStatement(env:Bindings,account:string,transaction:Row,context:{customer?:string|null;invoice?:string|null;payment?:string|null;payout?:string|null}={}) {
 insist(transaction.object==='balance_transaction'&&['pending','available'].includes(transaction.status)&&/^[a-z]{3}$/.test(transaction.currency),'processor_transaction_invalid',409)
 const amount=integer(transaction.amount),fee=integer(transaction.fee),net=integer(transaction.net)
 insist(net===amount-fee,'processor_transaction_net_mismatch',409)
 const id=await fingerprint({account,transaction:providerReference(transaction.id)})
 const prior=await one(env,'SELECT * FROM nc_processor_transactions WHERE id=?',id)
 if(prior)insist(prior.amount_cents===amount&&prior.fee_cents===fee&&prior.net_cents===net&&prior.currency===transaction.currency&&prior.source_ref===ref(transaction.source),'processor_transaction_changed',409)
 return stmt(env,`INSERT INTO nc_processor_transactions(id,account_ref,transaction_ref,type,source_ref,customer_id,invoice_id,payment_id,amount_cents,fee_cents,net_cents,currency,status,occurred_at,available_at,payout_ref)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,available_at=excluded.available_at,
 customer_id=COALESCE(nc_processor_transactions.customer_id,excluded.customer_id),invoice_id=COALESCE(nc_processor_transactions.invoice_id,excluded.invoice_id),payment_id=COALESCE(nc_processor_transactions.payment_id,excluded.payment_id),payout_ref=COALESCE(nc_processor_transactions.payout_ref,excluded.payout_ref)`,
 id,account,transaction.id,providerReference(transaction.type),providerReference(ref(transaction.source)),context.customer??null,context.invoice??null,context.payment??null,amount,fee,net,transaction.currency,transaction.status,instant(transaction.created),instant(transaction.available_on),context.payout??null)
}
export function objectStatement(env:Bindings,account:string,object:Row,kind:string,customer:string|null,invoice:string|null,status:string,code:string|null,at:number) {
 return stmt(env,`INSERT INTO nc_processor_objects(account_ref,object_ref,kind,customer_id,invoice_id,status,amount_cents,currency,code,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?)
 ON CONFLICT(account_ref,object_ref) DO UPDATE SET status=excluded.status,code=excluded.code,observed_at=excluded.observed_at`,account,providerReference(object.id),kind,customer,invoice,status,integer(object.amount??0),object.currency??'usd',code,at)
}
