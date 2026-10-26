import type { Bindings } from '../auth.server'
import { clockInstant } from './clock'
import { canonical,commit,guard,newId,one,stmt,type Row } from './core'
import { automaticQuote } from './automatic-collection-records'
import { nextRetry,DAY } from './retry-policy'
import { collectionHold } from './cadence-holds'

export async function retryState(env:Bindings,invoice:string){
 const row=await one(env,`SELECT r.*,a.status AS collection_status,EXISTS(SELECT 1 FROM nc_automatic_collection_authorizations z WHERE z.id=a.id AND z.basis_hash=a.basis_hash) AS authorized FROM nc_retry_series r JOIN nc_automatic_collections a ON a.id=r.collection_id WHERE r.invoice_id=?`,invoice)
 if(!row)return {attempt_count:0,next_payment_attempt:null,retry_status:null}
 const hold=await collectionHold(env,invoice)
 const allowed=row.authorized&&['refused','returned'].includes(row.collection_status)&&row.status==='scheduled'&&!hold.disputedCents&&!hold.hold&&hold.collectibleCents>0
 return {attempt_count:row.attempts,next_payment_attempt:allowed?row.next_at:null,retry_status:row.collection_status==='revoked'?'revoked':!row.authorized?'historical':hold.disputedCents?'disputed':hold.hold??row.status}
}
export async function recordRetryFailure(env:Bindings,row:Row,code:string){
 const q=automaticQuote(row),at=clockInstant(env),prior=await one(env,'SELECT * FROM nc_retry_series WHERE collection_id=?',row.id)
 // A replay observes the same terminal attempt, never advances the schedule.
 if(prior&&!await one(env,"SELECT 1 FROM nc_retry_attempts WHERE collection_id=? AND attempt=? AND outcome='claimed'",row.id,prior.attempts))return
 const attempts=prior?.attempts??1,first=prior?.first_failed_at??at,policy=q.retryPolicy??{version:'disabled',maxAttempts:1,windowDays:14,scope:'default'}
 const deadline=Math.min(first+policy.windowDays*DAY,row.method_kind==='us_bank_account'?row.claimed_at+180*DAY:Infinity)
 const proposed=q.retryPolicy?nextRetry(code,row.method_kind,attempts,at,first,policy):null
 const next=proposed!==null&&proposed<=deadline?proposed:null
 const status=next===null?(q.retryPolicy?'blocked':'disabled'):'scheduled',revision=newId(),event=newId()
 const hold=await collectionHold(env,row.invoice_id)
 const data={invoice:row.invoice_id,amount_cents:row.amount_cents,decline_code:code,attempt_count:attempts,next_payment_attempt:hold.disputedCents||hold.hold?null:next,retry_table:policy.version}
 await commit(env,[guard(env,'retry_state_changed',prior?'EXISTS(SELECT 1 FROM nc_retry_series WHERE collection_id=? AND revision=?)':'NOT EXISTS(SELECT 1 FROM nc_retry_series WHERE collection_id=?)',row.id,...(prior?[prior.revision]:[])),
 stmt(env,`INSERT INTO nc_retry_series(collection_id,invoice_id,customer_id,first_failed_at,next_at,deadline,attempts,decline_code,status,policy_json,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(collection_id) DO UPDATE SET next_at=excluded.next_at,decline_code=excluded.decline_code,status=excluded.status,revision=excluded.revision`,row.id,row.invoice_id,row.customer_id,first,next,deadline,attempts,code,status,canonical(policy),revision),
 stmt(env,`INSERT INTO nc_retry_attempts(collection_id,invoice_id,customer_id,attempt,attempted_at,outcome,decline_code,amount_cents) VALUES(?,?,?,?,?,'failed',?,?) ON CONFLICT(collection_id,attempt) DO UPDATE SET outcome='failed',decline_code=excluded.decline_code`,row.id,row.invoice_id,row.customer_id,attempts,at,code,row.amount_cents),
 stmt(env,'INSERT INTO nc_webhook_events(id,type,customer_id,subject,payload_json,created_at) VALUES(?,?,?,?,?,?)',event,'invoice.payment_failed',row.customer_id,row.invoice_id,canonical({type:'invoice.payment_failed',data}),at)],
 {actor:'system:retries',action:'retry.failure',subject:row.invoice_id,detail:data})
}
export async function recordRetrySuccess(env:Bindings,row:Row){
 const series=await one(env,'SELECT * FROM nc_retry_series WHERE collection_id=?',row.id);if(!series||series.status==='collected')return
 await commit(env,[stmt(env,"UPDATE nc_retry_series SET status='collected',next_at=NULL,revision=? WHERE collection_id=?",newId(),row.id),stmt(env,"UPDATE nc_retry_attempts SET outcome='collected',payment_id=? WHERE collection_id=? AND attempt=?",row.payment_id,row.id,series.attempts)],{actor:'system:retries',action:'retry.collected',subject:row.invoice_id,detail:{payment:row.payment_id,attempt:series.attempts}})
}
