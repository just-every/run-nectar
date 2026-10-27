// A person attributes an actual ended subscription to its unpaid failed invoice.
// Exhaustion alone never cancels a subscription or manufactures churn.
import type { Bindings } from '../auth.server'
import { type Actor,requireRead,actorLabel } from './actor'
import { clockInstant } from './clock'
import { all,commit,guard,insist,one,stmt } from './core'
import { collectionAuthority,collectionOwner } from './movein/collection-state'
import { requireBusiness } from './business'
import { localDate } from './dates'
import { BALANCE_SQL } from './receivables'
import type { Input } from './input'
import { FAILED_INVOICE_SQL } from './processor-recovery'
export async function retryChurnReport(env:Bindings,actor:Actor){
 requireRead(actor,'reports');requireRead(actor,'invoices');requireRead(actor,'payments')
 const day=localDate(clockInstant(env),(await requireBusiness(env)).timezone)
 const records=await all(env,`SELECT r.subscription_id,r.invoice_id,r.ended_on,r.recorded_at FROM nc_retry_churn r JOIN nc_customers c ON c.id=r.customer_id WHERE c.erased_at IS NULL ORDER BY r.ended_on,r.subscription_id`)
 const candidates=actor.role==='owner'?await all(env,`SELECT DISTINCT s.id AS subscription,s.revision,s.end_date,i.id AS invoice,i.number FROM nc_subscriptions s JOIN nc_invoices i ON i.subscription_id=s.id JOIN nc_customers c ON c.id=i.customer_id WHERE c.erased_at IS NULL AND i.status='issued' AND ${FAILED_INVOICE_SQL} AND s.end_date<=? AND ${BALANCE_SQL}>0 AND NOT EXISTS(SELECT 1 FROM nc_retry_churn x WHERE x.subscription_id=s.id)`,day):[]
 return {available:true,count:records.length,records,candidates,reason:'Only an owner-confirmed attribution of an actually ended subscription to an unpaid failed invoice counts. Retry exhaustion is not churn.'}
}
export async function recordRetryChurn(env:Bindings,actor:Actor,input:Input){
 await collectionOwner(env,actor);input.only(['invoice','subscription_revision','end_date','confirm','returnTo']);insist(input.flag('confirm'),'churn_confirmation_required')
 const invoice=input.text('invoice',{max:100}),revision=input.text('subscription_revision',{max:100}),end=input.text('end_date',{max:10})
 const day=localDate(clockInstant(env),(await requireBusiness(env)).timezone)
 const row=await one(env,`SELECT i.customer_id,i.subscription_id,s.end_date,s.revision,${BALANCE_SQL} AS balance_cents FROM nc_invoices i JOIN nc_subscriptions s ON s.id=i.subscription_id JOIN nc_customers c ON c.id=i.customer_id WHERE i.id=? AND i.status='issued' AND c.erased_at IS NULL AND ${FAILED_INVOICE_SQL}`,invoice)
 insist(row&&row.end_date===end&&end<=day&&row.revision===revision&&row.balance_cents>0,'churn_basis_changed',409)
 await commit(env,[collectionAuthority(env,actor),guard(env,'churn_basis_changed',`EXISTS(SELECT 1 FROM nc_subscriptions s JOIN nc_invoices i ON i.subscription_id=s.id JOIN nc_customers c ON c.id=i.customer_id WHERE i.id=? AND i.status='issued' AND s.revision=? AND s.end_date=? AND c.erased_at IS NULL AND ${FAILED_INVOICE_SQL} AND ${BALANCE_SQL}=? )`,invoice,revision,end,row.balance_cents),
 stmt(env,'INSERT INTO nc_retry_churn(subscription_id,invoice_id,customer_id,ended_on,subscription_revision,recorded_by,recorded_at) VALUES(?,?,?,?,?,?,?)',row.subscription_id,invoice,row.customer_id,end,revision,actor.id,clockInstant(env))],
 {actor:actorLabel(actor),action:'retry.churn.record',subject:invoice,detail:{subscription:row.subscription_id,endedOn:end,revision}})
 return {subscription:row.subscription_id,invoice,endedOn:end}
}
