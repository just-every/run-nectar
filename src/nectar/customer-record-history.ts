// Customer-owned histories retain source identities and underlying family gates.
import type { Bindings } from '../auth.server'
import { canRead,type Actor } from './actor'
import { all,type Row } from './core'
import { subscriptionDetail } from './subscriptions'
import { lifecycleHistory } from './lifecycle-records'

export async function customerSubscriptionHistory(env:Bindings,actor:Actor,customer:string) {
  if(!canRead(actor,'subscriptions'))return null
  const subscriptions=await all(env,'SELECT id FROM nc_subscriptions WHERE customer_id=? ORDER BY created_at,id',customer)
  return Promise.all(subscriptions.map(async ({id})=>({id,source:`/app/subscriptions/${id}`,
    record:await subscriptionDetail(env,actor,id,true),events:await lifecycleHistory(env,id)})))
}
export async function customerWriteOffHistory(env:Bindings,actor:Actor,customer:string) {
  if(!canRead(actor,'invoices'))return null
  const rows=await all(env,`SELECT w.id,w.invoice_id AS invoice,i.number AS invoiceNumber,i.currency,w.status,
    w.amount_cents AS amountCents,w.prepared_at AS preparedAt,w.approved_at AS approvedAt
    FROM nc_write_offs w JOIN nc_invoices i ON i.id=w.invoice_id WHERE w.customer_id=? ORDER BY w.prepared_at,w.id`,customer)
  const recoveries=canRead(actor,'payments')?await all(env,`SELECT r.id,r.write_off_id AS writeOff,r.invoice_id AS invoice,r.payment_id AS payment,
    r.amount_cents AS amountCents,r.recorded_at AS recordedAt,p.reference
    FROM nc_write_off_recoveries r JOIN nc_payments p ON p.id=r.payment_id WHERE r.customer_id=? ORDER BY r.recorded_at,r.id`,customer):null
  return rows.map((row:Row)=>{const own=recoveries?.filter(r=>r.writeOff===row.id)??null
    return {...row,recoveries:own,recoveredCents:own?.reduce((sum,r)=>sum+r.amountCents,0)??null,
      source:`/app/invoices/${row.invoice}`}
  })
}
