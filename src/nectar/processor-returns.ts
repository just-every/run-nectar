import type { Bindings } from '../auth.server'
import { insist, stmt, type Row } from './core'
import { integer, objectStatement, ref } from './processor-source'

const rawReturnCode=(value:unknown):string|null=>typeof value==='string'&&/^R\d{2}$/.test(value)?value:null

/** Normalized insufficient_funds cannot distinguish R01 from R09. */
export function bankNetworkReturnCode(charge:Row,intent?:Row|null):string|null {
 if(charge.payment_method_details?.type!=='us_bank_account'||charge.status!=='failed')return null
 const chargeCode=rawReturnCode(charge.outcome?.network_decline_code)
 const intentCode=intent&&ref(intent.latest_charge)===charge.id?rawReturnCode(intent.last_payment_error?.network_decline_code):null
 insist(!chargeCode||!intentCode||chargeCode===intentCode,'processor_return_code_mismatch',409)
 return chargeCode??intentCode
}

/** Preserve the real Charge reference and the distinct normalized intent error. */
export function processorReturnStatements(env:Bindings,account:string,charge:Row,intent:Row|null,customer:string,invoice:string|null,at:number) {
 if(charge.payment_method_details?.type!=='us_bank_account'||charge.status!=='failed')return []
 const code=bankNetworkReturnCode(charge,intent)
 const statements=[stmt(env,`INSERT INTO nc_processor_objects(account_ref,object_ref,kind,customer_id,invoice_id,status,amount_cents,currency,code,observed_at)
 VALUES(?,?,'ach_return',?,?,?,?,?,?,?) ON CONFLICT(account_ref,object_ref) DO UPDATE SET kind='ach_return',status=excluded.status,code=excluded.code,observed_at=excluded.observed_at`,
 account,charge.id,customer,invoice,charge.status,integer(charge.amount),charge.currency,code,at)]
 if(intent&&ref(intent.latest_charge)===charge.id){
  const normalized=intent.last_payment_error?.decline_code??intent.last_payment_error?.code??charge.failure_code
  statements.push(objectStatement(env,account,intent,'payment_intent',customer,invoice,intent.status,
   typeof normalized==='string'&&/^[a-z][a-z0-9_]{0,99}$/.test(normalized)?normalized:null,at))
 }
 return statements
}
