// A refund request's private narrative never becomes a shared credit reason.
// Project by durable source linkage, including rows saved by an older build or
// restored from an archive. No free-text matching or customer-input exception.
import type { Bindings } from '../auth.server'
import { all, type Row } from './core'

export const REFUND_CREDIT_REASON='unused_paid_credit'
export const sharedCreditReasonSql=(alias:string)=>`CASE WHEN EXISTS(SELECT 1 FROM nc_prepaid_refund_credits refund WHERE refund.credit_id=${alias}.id) THEN '${REFUND_CREDIT_REASON}' ELSE ${alias}.reason END`

/** Callers authorize the record family before requesting this shared view. */
export async function sharedCreditNotes(env:Bindings,where:string,...params:unknown[]):Promise<Row[]>{
  const rows=await all(env,`SELECT n.*,${sharedCreditReasonSql('n')} AS shared_reason FROM nc_credit_notes n WHERE ${where} ORDER BY n.issued_at,n.number,n.id`,...params)
  return rows.map(({shared_reason,...note})=>({...note,reason:shared_reason}))
}
