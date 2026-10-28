import { savedCollectionMethod } from './payments/default-method'
import { stripeForAccount } from './payments/stripe'
import { approveWithAuthority, finaliseWithAuthority, prepareScheduleRun } from './billruns'
import { memberCapabilities } from './actor'
// Finite, exact invoice schedules. Consent never covers a future unknown bill.
import type { Bindings } from '../auth.server'
import type { Actor } from './actor'
import { actorLabel } from './actor'
import { clockInstant } from './clock'
import { all, canonical, commit, guard, insist, NectarError, newId, one, stmt, type Row } from './core'
import { addDays, today } from './dates'
import { setupOwner, setupOwnerFence } from './hosted-setup-basis'
import { Input } from './input'
import { automaticAuthority, automaticQuote, automaticView, storedAutomaticCollection } from './automatic-collection-records'
import { prepareAutomaticCollection, automaticDecision } from './automatic-collection'
import { customerSession } from './portal-session'
import { collectibleInvoice } from './cadence-holds'
import { cadenceSourceGuard, cadenceSourceSequence } from './cadence-policy'

export interface CollectionSchedule {
 id:string; subscription:string; entries:{invoice:string;issueDate:string;amountCents:number}[]; unpaidDays:number
}
export function scheduleFence(env:Bindings,id:string,active=true) {
 return guard(env,'collection_schedule_authority_changed',`EXISTS(SELECT 1 FROM nc_collection_schedules p JOIN nc_collection_schedule_authority z ON z.id=p.id
 JOIN nc_members m ON m.id=p.prepared_by AND m.status='active' AND m.role='owner'
 JOIN oa_operators o ON lower(o.email)=m.email AND o.status='active' AND o.role='owner'
 WHERE p.id=? AND p.status ${active?"='active'":"IN ('awaiting_customer','pending_approval','active')"}
 ${active?"AND p.accepted_at IS NOT NULL AND p.approved_at IS NOT NULL AND EXISTS(SELECT 1 FROM nc_members f JOIN oa_operators fo ON lower(fo.email)=f.email WHERE f.id=p.approved_by AND f.status='active' AND f.role IN ('owner','finance') AND fo.status='active' AND ((f.role='owner' AND fo.role='owner') OR (f.role='finance' AND fo.role IN ('owner','member'))))":''})`,id)
}
async function scheduleRow(env:Bindings,id:string) {
 const row=await one(env,`SELECT p.*,EXISTS(SELECT 1 FROM nc_collection_schedule_authority z WHERE z.id=p.id) AS authorized
 FROM nc_collection_schedules p JOIN nc_customers c ON c.id=p.customer_id WHERE p.id=? AND c.status='active' AND c.erased_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(p.id,c.id))`,id)
 insist(row,'collection_schedule_not_found',404);return row
}
async function scheduleItems(env:Bindings,row:Row) {
 const ids=await all(env,'SELECT id FROM nc_automatic_collections WHERE json_extract(basis_json,\'$.schedule.id\')=? ORDER BY json_extract(basis_json,\'$.issueDate\'),id',row.id)
 const rows=await Promise.all(ids.map(({id})=>storedAutomaticCollection(env,id)))
 const saved=JSON.parse(row.scope_json) as CollectionSchedule
 insist(rows.length===saved.entries.length&&rows.every(r=>canonical(automaticQuote(r).schedule)===canonical(saved)),'collection_schedule_incomplete',409)
 return rows
}
export async function prepareCollectionSchedule(env:Bindings,actor:Actor,input:Input) {
 await setupOwner(env,actor)
 input.only(['subscription','invoices','periods','issue_dates','unpaid_days','confirm','returnTo'])
 insist(input.flag('confirm'),'collection_schedule_confirmation_required')
 const subscription=input.text('subscription',{max:100}),invoices=input.list('invoices'),dates=input.list('issue_dates'),periods=input.list('periods')
 insist(!invoices.length||!periods.length,'collection_schedule_invalid')
 insist(!await one(env,"SELECT 1 FROM nc_collection_schedules p JOIN nc_collection_schedule_authority z ON z.id=p.id WHERE p.subscription_id=? AND p.status<>'revoked'",subscription),'collection_schedule_exists',409)
 if(periods.length) {
  insist(periods.length<=12&&periods.length===dates.length&&new Set(periods).size===periods.length,'collection_schedule_invalid')
  for(const period of periods) {
   insist(!await one(env,"SELECT 1 FROM nc_bill_runs WHERE period=? AND kind='recurring' AND status='draft'",period),'collection_schedule_bill_run_exists',409)
   const run=await prepareScheduleRun(env,actor,subscription,period)
   const drafts=await all(env,"SELECT id FROM nc_invoices WHERE bill_run_id=? AND subscription_id=? AND status='draft'",run.id,subscription)
   insist(drafts.length===1,'collection_schedule_single_invoice_required',409);invoices.push(drafts[0].id)
  }
 }
 const unpaidDays=input.integer('unpaid_days',{min:1,max:90})!
 insist(invoices.length>=1&&invoices.length<=12&&dates.length===invoices.length&&new Set(invoices).size===invoices.length,'collection_schedule_invalid')
 const sub=await one(env,"SELECT * FROM nc_subscriptions WHERE id=? AND billing_mode='live'",subscription)
 insist(sub,'subscription_not_found',404)
 const entries:CollectionSchedule['entries']=[]
 for(const [index,id] of invoices.entries()) {
  const invoice=await one(env,"SELECT * FROM nc_invoices WHERE id=? AND subscription_id=? AND customer_id=? AND status IN ('draft','approved')",id,subscription,sub.customer_id)
  insist(invoice,'collection_schedule_draft_required',409)
  const calculation=JSON.parse(invoice.calculation_json)
  insist(!periods.length||calculation.inputs?.billing?.dueDate===dates[index],'collection_schedule_date_mismatch',409)
  // The exact saved bill must remain the bill served. Mixed sources, usage,
  // credits and previously issued service still need their own ordinary doors.
  insist(!calculation.exceptions?.length&&invoice.total_cents>=50&&invoice.currency==='USD','collection_schedule_terms_unsupported',409)
  entries.push({invoice:id,issueDate:dates[index],amountCents:invoice.total_cents})
 }
 insist(entries.every((entry,i)=>!i||entry.issueDate>entries[i-1].issueDate),'collection_schedule_dates_invalid')
 const id=newId(),scope:CollectionSchedule={id,subscription,entries,unpaidDays},at=clockInstant(env),policy=newId()
 await commit(env,[...setupOwnerFence(env,actor),
  stmt(env,"INSERT INTO nc_dunning_policies(id,name,scope,scope_ref,offsets_json,end_day,end_action,invoice_only,created_by,created_at) VALUES(?,?,'default','',?,?,'mark_unpaid',0,?,?)",policy,'Exact scheduled invoice exhaustion',canonical([unpaidDays]),unpaidDays,actor.id,at),
  stmt(env,"INSERT INTO nc_collection_schedules(id,customer_id,subscription_id,status,scope_json,prepared_by,prepared_at,policy_id) VALUES(?,?,?,'preparing',?,?,?,?)",id,sub.customer_id,sub.id,canonical(scope),actor.id,at,policy),
  stmt(env,'INSERT INTO nc_collection_schedule_authority(id,customer_id) VALUES(?,?)',id,sub.customer_id)],
 {actor:actorLabel(actor),action:'collection.schedule.prepare',subject:id,detail:{subscription,entries,unpaidDays}})
 // A preparation interrupted here remains inert, visible and withdrawable.
 for(const entry of entries)await prepareAutomaticCollection(env,actor,Input.of({invoice:entry.invoice,issue_date:entry.issueDate,enable_retries:true}),scope)
 const rows=await scheduleItems(env,await scheduleRow(env,id))
 insist(rows.every(r=>r.customer_id===sub.customer_id),'collection_schedule_customer_mismatch',409)
 insist(rows.every(r=>r.account_ref===rows[0].account_ref&&r.stripe_customer_ref===rows[0].stripe_customer_ref&&r.payment_method_ref===rows[0].payment_method_ref&&canonical(automaticQuote(r).retryPolicy)===canonical(automaticQuote(rows[0]).retryPolicy)),'collection_schedule_method_changed',409)
 const primary=rows[0]
 await commit(env,[...setupOwnerFence(env,actor),
  stmt(env,"UPDATE nc_collection_schedules SET status='awaiting_customer',primary_request=? WHERE id=? AND status='preparing'",primary.id,id)],
 {actor:actorLabel(actor),action:'collection.schedule.ready',subject:id,detail:{requests:rows.map(r=>r.id)}})
 return {...automaticView(primary),schedule:id,requests:rows.map(automaticView)}
}
export async function acceptCollectionSchedule(env:Bindings,request:Request,input:Input,primary:Row) {
 const session=await customerSession(env,request),scope=automaticQuote(primary).schedule!,row=await scheduleRow(env,scope.id),rows=await scheduleItems(env,row)
 insist(request.method==='POST'&&request.headers.get('origin')===session.origin&&session.audience==='hosted','forbidden',403)
 insist(row.customer_id===session.customer&&row.primary_request===primary.id,'automatic_collection_not_found',404)
 insist(input.flag('accept')&&input.text('basis_hash',{max:100})===primary.basis_hash&&row.status==='awaiting_customer'&&rows.every(r=>r.status==='awaiting_customer'),'automatic_collection_acceptance_changed',409)
 const at=clockInstant(env)
 await commit(env,[scheduleFence(env,row.id,false),
  guard(env,'customer_session_changed','EXISTS(SELECT 1 FROM nc_portal_sessions WHERE id=? AND customer_id=? AND revoked_at IS NULL AND expires_at>?)',session.jti,session.customer,at),
  ...rows.flatMap(r=>[automaticAuthority(env,r,false),stmt(env,"UPDATE nc_automatic_collections SET status='pending_approval',customer_session_id=?,accepted_at=?,revision=? WHERE id=?",session.jti,at,newId(),r.id)]),
  stmt(env,"UPDATE nc_collection_schedules SET status='pending_approval',accepted_at=? WHERE id=?",at,row.id)],
 {actor:`customer:${session.customer}`,action:'collection.schedule.accept',subject:row.id,detail:{scope,basis:primary.basis_hash,session:session.jti}})
 return automaticView(await storedAutomaticCollection(env,primary.id))
}
export async function decideCollectionSchedule(env:Bindings,actor:Actor,input:Input,primary:Row) {
 const scope=automaticQuote(primary).schedule!,row=await scheduleRow(env,scope.id),rows=await scheduleItems(env,row)
 insist(row.primary_request===primary.id&&row.status==='pending_approval'&&input.text('basis_hash',{max:100})===primary.basis_hash,'automatic_collection_approval_changed',409)
 const plans=await Promise.all(rows.map(r=>automaticDecision(env,actor,Input.of({request:r.id,basis_hash:r.basis_hash,decision:input.text('decision'),confirm:input.flag('confirm'),confirm_single:input.flag('confirm_single')}),r)))
 const decision=input.text('decision'),at=clockInstant(env)
 await commit(env,[scheduleFence(env,row.id,false),...plans.flatMap(p=>p.statements),
  stmt(env,'UPDATE nc_collection_schedules SET status=?,approved_by=?,approved_at=? WHERE id=?',decision==='approved'?'active':'revoked',actor.id,at,row.id)],
 [...plans.map(p=>p.audit),{actor:actorLabel(actor),action:`collection.schedule.${decision}`,subject:row.id,detail:{scope}}])
 return automaticView(await storedAutomaticCollection(env,primary.id))
}
export async function stopCollectionSchedule(env:Bindings,actor:Actor,input:Input) {
 await setupOwner(env,actor);input.only(['schedule','confirm','returnTo']);insist(input.flag('confirm'),'collection_schedule_confirmation_required')
 const row=await scheduleRow(env,input.text('schedule',{max:100}));return stopSchedule(env,row,setupOwnerFence(env,actor),actorLabel(actor))
}
async function stopSchedule(env:Bindings,row:Row,fences:D1PreparedStatement[],actor:string) {
 await commit(env,[...fences,stmt(env,"UPDATE nc_collection_schedules SET status='revoked' WHERE id=?",row.id),
 stmt(env,'DELETE FROM nc_collection_schedule_authority WHERE id=?',row.id),
 stmt(env,"UPDATE nc_automatic_collections SET status='revoked',revision=? WHERE json_extract(basis_json,'$.schedule.id')=? AND (claimed_at IS NULL OR status IN ('refused','returned'))",newId(),row.id)],
 {actor,action:'collection.schedule.withdraw',subject:row.id,detail:{subscription:row.subscription_id}})
 return {id:row.id,status:'revoked'}
}
export async function withdrawCollectionSchedule(env:Bindings,request:Request,input:Input,primary:Row) {
 const session=await customerSession(env,request),scope=automaticQuote(primary).schedule!,row=await scheduleRow(env,scope.id),at=clockInstant(env)
 insist(request.method==='POST'&&request.headers.get('origin')===session.origin&&session.audience==='hosted','forbidden',403)
 insist(row.customer_id===session.customer&&input.flag('withdraw'),'automatic_collection_not_found',404)
 return stopSchedule(env,row,[guard(env,'customer_session_changed','EXISTS(SELECT 1 FROM nc_portal_sessions WHERE id=? AND customer_id=? AND revoked_at IS NULL AND expires_at>?)',session.jti,session.customer,at)],`customer:${session.customer}`)
}
async function runCollectionScheduleEnd(env:Bindings,item:Row) {
  const collection=await storedAutomaticCollection(env,item.id),scope=JSON.parse(item.scope_json) as CollectionSchedule
  const failure=await one(env,'SELECT * FROM nc_retry_series WHERE collection_id=?',item.id)
  if(!failure||!['exhausted','disabled','blocked'].includes(failure.status))return
  const seq=await cadenceSourceSequence(env),source=await collectibleInvoice(env,collection.invoice_id),day=today(source.business.timezone,clockInstant(env))
  const first=today(source.business.timezone,failure.first_failed_at),due=addDays(first,scope.unpaidDays)
  if(day<due||source.hold||source.disputedCents||source.balance_cents<=0)return
  const id=newId(),at=clockInstant(env)
  await commit(env,[scheduleFence(env,item.schedule_id),automaticAuthority(env,collection),cadenceSourceGuard(env,seq),
   guard(env,'collection_schedule_attempt_pending',"EXISTS(SELECT 1 FROM nc_retry_series WHERE collection_id=? AND revision=? AND status IN ('exhausted','disabled','blocked'))",collection.id,failure.revision),
   stmt(env,"INSERT INTO nc_dunning_series(id,invoice_id,customer_id,policy_id,first_failed_at,first_failed_date,timezone,status,created_by,created_at,ended_at,end_date) VALUES(?,?,?,?,?,?,?,'mark_unpaid',?,?,?,?)",id,collection.invoice_id,collection.customer_id,item.policy_id,failure.first_failed_at,first,source.business.timezone,collection.prepared_by,at,at,day)],
  {actor:'system:collection-schedule',action:'dunning.end.schedule',subject:id,detail:{invoice:collection.invoice_id,schedule:item.schedule_id,date:day,action:'mark_unpaid'}})

}
export async function runCollectionScheduleEnds(env:Bindings) {
 const rows=await all(env,`SELECT a.id,p.id AS schedule_id,p.policy_id,p.scope_json FROM nc_collection_schedules p JOIN nc_collection_schedule_authority z ON z.id=p.id
 JOIN nc_automatic_collections a ON json_extract(a.basis_json,'$.schedule.id')=p.id
 WHERE p.status='active' AND a.status IN ('refused','returned') AND NOT EXISTS(SELECT 1 FROM nc_dunning_series d WHERE d.invoice_id=a.invoice_id) ORDER BY a.id`)
 for(const item of rows) {
  try {await runCollectionScheduleEnd(env,item)}catch(error) {
   if(!(error instanceof NectarError))throw error
   await commit(env,[stmt(env,"UPDATE nc_collection_schedules SET status='blocked' WHERE id=? AND status='active'",item.schedule_id)],
    {actor:'system:collection-schedule',action:'collection.schedule.end_refused',subject:item.schedule_id,detail:{error:error.code}})
  }
 }
}

export async function runCollectionScheduleInvoices(env:Bindings) {
 const rows=await all(env,`SELECT a.id,p.id AS schedule_id,p.approved_by FROM nc_collection_schedules p JOIN nc_collection_schedule_authority z ON z.id=p.id
 JOIN nc_automatic_collections a ON json_extract(a.basis_json,'$.schedule.id')=p.id JOIN nc_invoices i ON i.id=a.invoice_id
 WHERE p.status='active' AND a.status='active' AND i.status IN ('draft','approved') ORDER BY json_extract(a.basis_json,'$.issueDate'),a.id`)
 for(const item of rows) {
  const collection=await storedAutomaticCollection(env,item.id),q=automaticQuote(collection)
  const source=await one(env,'SELECT timezone FROM nc_business WHERE singleton=1')
  if(!source||today(source.timezone,clockInstant(env))!==q.issueDate)continue
  const actor:Actor={id:item.approved_by,kind:'member',role:'owner',name:'Exact invoice scheduler',email:'system:collection-schedule',sessionId:null,capabilities:memberCapabilities('owner',null)}
  const authority=()=>scheduleFence(env,item.schedule_id)
  try {
   const {stripe}=await stripeForAccount(env,q.accountRef)
   insist(canonical(await savedCollectionMethod(stripe,q.method.customerRef,q.method.mandateRef??undefined))===canonical(q.method),'automatic_collection_method_changed',409)
   const invoice=await one(env,'SELECT status FROM nc_invoices WHERE id=?',collection.invoice_id)
   if(invoice?.status==='draft')await approveWithAuthority(env,actor,Input.of({invoice:collection.invoice_id}),authority)
   await finaliseWithAuthority(env,actor,Input.of({invoice:collection.invoice_id,issue_date:q.issueDate}),authority)
  }catch(error) {
   if(!(error instanceof NectarError))throw error
   // Changed sources stay in review and acquire no replacement debit authority.
   await commit(env,[stmt(env,"UPDATE nc_automatic_collections SET status='invalidated',error_code=?,revision=? WHERE id=? AND status='active' AND claimed_at IS NULL",error.code,newId(),collection.id)],
    {actor:'system:collection-schedule',action:'collection.schedule.refused',subject:collection.id,detail:{invoice:collection.invoice_id,error:error.code}})
  }
 }
}
