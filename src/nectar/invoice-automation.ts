// A saved, explicitly confirmed policy can issue clean invoices. It never
// authorizes a processor charge or an invoice email.
import type { Bindings } from '../auth.server'
import { actorLabel, memberCapabilities, requireMember, requireOwner, type Actor } from './actor'
import { approveWithAuthority, finaliseWithAuthority, prepareRun } from './billruns'
import { business } from './business'
import { clockInstant } from './clock'
import { all, commit, guard, insist, NectarError, newId, one, parseJson, stmt, type Row } from './core'
import { addMonths, localDate } from './dates'
import { Input } from './input'
import { requireFreshFactor } from './mfa'

const REVISION='COALESCE((SELECT revision FROM nc_invoice_automation WHERE singleton=1),0)'
const OTHER="SELECT 1 FROM nc_members WHERE status='active' AND role IN ('owner','finance') AND id<>?"
export async function invoiceAutomation(env: Bindings) {
  return await one(env,'SELECT * FROM nc_invoice_automation WHERE singleton=1')??{enabled:0,hour:6,revision:0}
}
export async function prepareInvoiceAutomation(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor);await requireFreshFactor(env,actor)
  const enabled=input.flag('enabled'),hour=input.integer('hour',{max:23})!,policy=await invoiceAutomation(env),id=newId()
  await commit(env,[guard(env,'policy_changed',`${REVISION}=?`,policy.revision),
    stmt(env,'INSERT INTO nc_invoice_automation_requests(id,enabled,hour,base_revision,prepared_by,prepared_at) VALUES(?,?,?,?,?,?)',id,enabled?1:0,hour,policy.revision,actor.id,clockInstant(env))],
    {actor:actorLabel(actor),action:'invoice.automation.prepare',subject:id,detail:{enabled,hour,baseRevision:policy.revision}})
  return {request:id,status:'pending'}
}
export async function decideInvoiceAutomation(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor,'approve');await requireFreshFactor(env,actor)
  const row=await one(env,'SELECT * FROM nc_invoice_automation_requests WHERE id=?',input.text('request',{max:100}))
  insist(row,'policy_request_not_found',404);insist(row.status==='pending','policy_already_decided',409)
  const decision=input.text('decision',{max:10});insist(['approved','rejected'].includes(decision),'invalid_decision')
  const statements=[guard(env,'policy_already_decided',"EXISTS(SELECT 1 FROM nc_invoice_automation_requests WHERE id=? AND status='pending')",row.id),
    guard(env,'forbidden',"EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','finance'))",actor.id)]
  if(decision==='rejected'){
    await commit(env,[...statements,stmt(env,"UPDATE nc_invoice_automation_requests SET status='rejected',approved_by=? WHERE id=?",actor.id,row.id)],{actor:actorLabel(actor),action:'invoice.automation.reject',subject:row.id})
    return {request:row.id,status:'rejected'}
  }
  const single=actor.id===row.prepared_by
  if(single){requireOwner(actor);insist(input.flag('confirm_single'),'single_confirmation_required',409);insist(!await one(env,OTHER,actor.id),'second_approver_required',409);statements.push(guard(env,'second_approver_required',`NOT EXISTS(${OTHER})`,actor.id))}
  const mode=single?'single-approver':'two-person'
  await commit(env,[...statements,guard(env,'policy_changed',`${REVISION}=?`,row.base_revision),
    guard(env,'policy_preparer_inactive',"EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role='owner')",row.prepared_by),
    stmt(env,`INSERT INTO nc_invoice_automation(singleton,enabled,hour,revision,prepared_by,approved_by,request_id) VALUES(1,?,?,1,?,?,?)
      ON CONFLICT(singleton) DO UPDATE SET enabled=excluded.enabled,hour=excluded.hour,revision=revision+1,prepared_by=excluded.prepared_by,approved_by=excluded.approved_by,request_id=excluded.request_id`,row.enabled,row.hour,row.prepared_by,actor.id,row.id),
    stmt(env,"UPDATE nc_invoice_automation_requests SET status='applied',approved_by=?,approval_mode=? WHERE id=?",actor.id,mode,row.id)],
    {actor:actorLabel(actor),action:'invoice.automation.apply',subject:row.id,detail:{enabled:!!row.enabled,hour:row.hour,preparedBy:row.prepared_by,approvedBy:actor.id,mode}})
  return {request:row.id,status:'applied',mode}
}
export const invoiceAutomationGuard=(env: Bindings, policy: Row)=>guard(env,'invoice_automation_changed',`EXISTS(SELECT 1 FROM nc_invoice_automation p
  JOIN nc_members maker ON maker.id=p.prepared_by AND maker.status='active' AND maker.role='owner'
  JOIN nc_members approver ON approver.id=p.approved_by AND approver.status='active' AND approver.role IN ('owner','finance')
  WHERE p.singleton=1 AND p.enabled=1 AND p.revision=?)`,policy.revision)

export async function runInvoiceAutomation(env: Bindings, instant=clockInstant(env)) {
  const b=await business(env),policy=await invoiceAutomation(env)
  if(!b||!policy.enabled)return {status:'disabled'}
  const day=localDate(instant,b.timezone),hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:b.timezone,hour:'numeric',hourCycle:'h23'}).format(new Date(instant)))
  if(hour<policy.hour)return {status:'before_schedule'}
  const id=newId(),result:Row={issued:[],review:[],runs:[]}
  try {
    await commit(env,[invoiceAutomationGuard(env,policy),stmt(env,"INSERT INTO nc_invoice_automation_runs(id,business_day,policy_revision,status,created_at) VALUES(?,?,?,'running',?)",id,day,policy.revision,instant)],{actor:'system:invoices',action:'invoice.automation.reserve',subject:id,detail:{day,policyRevision:policy.revision}})
  }catch(error){if(error instanceof NectarError&&['already_exists','invoice_automation_changed'].includes(error.code))return {status:error.code};throw error}
  // The actor label identifies the scheduler, while the saved policy and live
  // member guards authorize each approval and issue transaction separately.
  const actor:Actor={id:policy.approved_by,kind:'member',role:'owner',name:'Invoice scheduler',email:`system:invoice-automation:${id}`,sessionId:null,capabilities:memberCapabilities('owner',null)}
  try {
    const months=[addMonths(`${day.slice(0,7)}-01`,-1).slice(0,7),day.slice(0,7)]
    for(const period of months){
      const run=await prepareRun(env,actor,Input.of({period}));result.runs.push(run.id)
      const drafts=await all(env,"SELECT * FROM nc_invoices WHERE bill_run_id=? AND status='draft' ORDER BY id",run.id)
      for(const invoice of drafts){
        if(parseJson<Row[]>(invoice.exceptions_json,[]).length){result.review.push(invoice.id);continue}
        try {
          await approveWithAuthority(env,actor,Input.of({invoice:invoice.id}),()=>invoiceAutomationGuard(env,policy))
          const issued=await finaliseWithAuthority(env,actor,Input.of({invoice:invoice.id}),()=>invoiceAutomationGuard(env,policy))
          result.issued.push(...issued.issued)
        }catch(error){if(!(error instanceof NectarError))throw error;result.review.push(invoice.id)}
      }
    }
    await commit(env,[stmt(env,"UPDATE nc_invoice_automation_runs SET status='completed',result_json=? WHERE id=?",JSON.stringify(result),id)],{actor:'system:invoices',action:'invoice.automation.complete',subject:id,detail:result})
    return {id,status:'completed',...result}
  }catch(error){
    await commit(env,[stmt(env,"UPDATE nc_invoice_automation_runs SET status='failed',result_json=? WHERE id=?",JSON.stringify(result),id)],{actor:'system:invoices',action:'invoice.automation.failed',subject:id})
    throw error
  }
}
export async function runInvoiceAutomationDoor(env: Bindings, actor: Actor) {
  requireOwner(actor);return runInvoiceAutomation(env)
}
