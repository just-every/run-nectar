import { cadenceSourceGuard, cadenceSourceSequence } from './cadence-policy'
import type { Bindings } from '../auth.server'
import { actorLabel, type Actor } from './actor'
import { all, canonical, commit, guard, insist, newId, one, stmt, type Row } from './core'
import { clockInstant } from './clock'
import { setupOwner, setupOwnerFence } from './hosted-setup-basis'
import type { Input } from './input'
import { addDays, today } from './dates'
import { collectibleInvoice } from './cadence-holds'

export async function createDunningPolicy(env: Bindings, actor: Actor, input: Input) {
 await setupOwner(env,actor)
 input.only(['name','scope','scope_ref','offsets','end_day','end_action','invoice_only','confirm','returnTo'])
 insist(input.flag('confirm'),'dunning_confirmation_required')
 const name=input.text('name',{max:80}),scope=input.text('scope'),ref=input.text('scope_ref',{max:100,optional:true})
 const tokens=input.text('offsets',{max:200}).split(',').map(v=>v.trim())
 insist(tokens.every(v=>/^\d+$/.test(v)),'invalid_dunning_offsets')
 const offsets=tokens.map(Number),endDay=input.integer('end_day',{min:1,max:90})!
 insist(['default','plan','segment'].includes(scope)&&(scope==='default'?!ref:!!ref),'invalid_dunning_scope')
 insist(offsets.length>0&&offsets.length<=12&&offsets.every((n,i)=>Number.isSafeInteger(n)&&n>=0&&n<=endDay&&(i===0||n>offsets[i-1])),'invalid_dunning_offsets')
 const action=input.text('end_action'),invoiceOnly=input.flag('invoice_only')
 insist(['keep_active','mark_unpaid','restrict','cancel'].includes(action)&&(!invoiceOnly||action==='keep_active'),'invalid_dunning_end_action')
 if(scope==='plan')insist(await one(env,'SELECT 1 FROM nc_prices WHERE id=?',ref),'price_not_found',404)
 const id=newId(),at=clockInstant(env)
 await commit(env,[...setupOwnerFence(env,actor),stmt(env,'INSERT INTO nc_dunning_policies(id,name,scope,scope_ref,offsets_json,end_day,end_action,invoice_only,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',id,name,scope,ref,canonical(offsets),endDay,action,invoiceOnly?1:0,actor.id,at)],{actor:actorLabel(actor),action:'dunning.policy.create',subject:id,detail:{name,scope,ref,offsets,endDay,action,invoiceOnly,confirmation:'owner-confirmed-each-step'}})
 return {id,name,scope,scopeRef:ref,offsets,endDay,endAction:action,invoiceOnly}
}

export async function dunningSeries(env: Bindings,id: string) {
 const row=await one(env,`SELECT s.*,p.name,p.scope,p.scope_ref,p.offsets_json,p.end_day,p.end_action,p.invoice_only,
 EXISTS(SELECT 1 FROM nc_dunning_authority a WHERE a.id=s.id) AS authorized
 FROM nc_dunning_series s JOIN nc_dunning_policies p ON p.id=s.policy_id JOIN nc_customers c ON c.id=s.customer_id
 WHERE s.id=? AND c.status='active' AND c.erased_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(s.id,s.invoice_id,s.customer_id))`,id)
 insist(row,'dunning_not_found',404);return row
}
export async function dunningSource(env: Bindings,row: Row) {
 const invoice=await collectibleInvoice(env,row.invoice_id),day=today(row.timezone,clockInstant(env))
 insist(await one(env,"SELECT 1 FROM nc_customers WHERE id=? AND status='active' AND erased_at IS NULL",row.customer_id),'dunning_not_found',404)
 return {invoice,day,stopped:!row.authorized||row.status!=='active'||invoice.balance_cents<=0,
  held:!!invoice.hold||invoice.disputedCents>0,
  basis:canonical({series:row.id,policy:row.policy_id,status:row.status,recipient:invoice.billing_email,language:invoice.language,balance:invoice.basis,amount:invoice.collectibleCents,day})}
}
export function dunningFence(env: Bindings,row: Row) {
 return guard(env,'dunning_authority_changed',`EXISTS(SELECT 1 FROM nc_dunning_series s JOIN nc_dunning_authority a ON a.id=s.id JOIN nc_customers c ON c.id=s.customer_id
 WHERE s.id=? AND s.status='active' AND c.status='active' AND c.erased_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(s.id,s.invoice_id,s.customer_id)))`,row.id)
}
export async function enrollDunning(env: Bindings,actor: Actor,input: Input) {
 await setupOwner(env,actor);input.only(['invoice','policy','confirm','returnTo']);insist(input.flag('confirm'),'dunning_confirmation_required')
 const seq=await cadenceSourceSequence(env)
 const invoice=await collectibleInvoice(env,input.text('invoice',{max:100})),policy=await one(env,'SELECT * FROM nc_dunning_policies WHERE id=?',input.text('policy',{max:100}))
 insist(policy,'dunning_policy_not_found',404)
 insist(policy.end_action!=='cancel'||!!invoice.subscription_id,'dunning_subscription_required',409)
 insist(!invoice.hold&&!invoice.disputedCents,'dunning_invoice_held',409)
 const failure=await one(env,`SELECT MIN(attempted_at) AS at FROM (SELECT attempted_at FROM nc_retry_attempts WHERE invoice_id=? AND outcome='failed'
 UNION ALL SELECT reconciled_at FROM nc_native_collections WHERE invoice_id=? AND status IN ('declined','customer_action_required'))`,invoice.id,invoice.id)
 insist(failure?.at!==null&&failure?.at!==undefined,'dunning_failure_required',409)
 const specific=await all(env,`SELECT p.id FROM nc_dunning_policies p WHERE (p.scope='plan' AND EXISTS(SELECT 1 FROM nc_invoice_lines l WHERE l.invoice_id=? AND l.price_id=p.scope_ref)) OR (p.scope='segment' AND EXISTS(SELECT 1 FROM nc_retry_segments s WHERE s.customer_id=? AND s.segment=p.scope_ref))`,invoice.id,invoice.customer_id)
 insist(policy.scope!=='default'||specific.length===0,'dunning_specific_policy_required',409)
 if(policy.scope==='plan')insist(await one(env,'SELECT 1 FROM nc_invoice_lines WHERE invoice_id=? AND price_id=?',invoice.id,policy.scope_ref),'dunning_plan_mismatch',409)
 if(policy.scope==='segment')insist(await one(env,'SELECT 1 FROM nc_retry_segments WHERE customer_id=? AND segment=?',invoice.customer_id,policy.scope_ref),'dunning_segment_mismatch',409)
 const id=newId(),at=clockInstant(env),date=today(invoice.business.timezone,failure.at)
 await commit(env,[...setupOwnerFence(env,actor),cadenceSourceGuard(env,seq),guard(env,'dunning_already_enrolled','NOT EXISTS(SELECT 1 FROM nc_dunning_series WHERE invoice_id=?)',invoice.id),
 stmt(env,"INSERT INTO nc_dunning_series(id,invoice_id,customer_id,policy_id,first_failed_at,first_failed_date,timezone,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,'active',?,?)",id,invoice.id,invoice.customer_id,policy.id,failure.at,date,invoice.business.timezone,actor.id,at),
 stmt(env,'INSERT INTO nc_dunning_authority(id,customer_id) VALUES(?,?)',id,invoice.customer_id)],{actor:actorLabel(actor),action:'dunning.enroll',subject:id,detail:{invoice:invoice.id,policy:policy.id,firstFailedAt:failure.at,date,timezone:invoice.business.timezone}})
 return {id,invoice:invoice.id,policy:policy.id,status:'active'}
}
export function dunningDue(row: Row,step: number) {
 const offsets=JSON.parse(row.offsets_json) as number[]
 insist(Number.isInteger(step)&&step>=1&&step<=offsets.length,'invalid_dunning_step')
 return addDays(row.first_failed_date,offsets[step-1])
}
export async function dunningPolicyList(env: Bindings) { return all(env,'SELECT * FROM nc_dunning_policies ORDER BY created_at,id') }
