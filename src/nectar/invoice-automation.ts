// A saved, explicitly confirmed policy can issue clean invoices. It never
// authorizes a processor charge or an invoice email.
import type { Bindings } from '../auth.server'
import { actorLabel, memberCapabilities, requireMember, requireOwner, type Actor } from './actor'
import { approveWithAuthority, finaliseWithAuthority, prepareRunWithCheckpoint } from './billruns'
import { business } from './business'
import { clockInstant } from './clock'
import { all, commit, guard, insist, NectarError, newId, one, parseJson, stmt, type Row } from './core'
import { addMonths, localDate } from './dates'
import { Input } from './input'
import { requireFreshFactor } from './mfa'
import { setupOwner, setupOwnerFence } from './hosted-setup-basis'

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

// A saved day's work may be continued only after explicit current-owner review.
// Normal ticks never take over an interrupted reservation.
export const INVOICE_AUTOMATION_LEASE_MS = 30 * 60_000

function executionGuard(env: Bindings, id: string, revision: string) {
  return guard(env,'invoice_automation_execution_changed',`EXISTS(SELECT 1 FROM nc_invoice_automation_runs r
    JOIN nc_invoice_automation_authority a ON a.automation_id=r.id AND a.revision=r.execution_revision
    WHERE r.id=? AND r.execution_revision=? AND r.status='running')`,id,revision)
}

export async function invoiceAutomationRuns(env: Bindings, actor: Actor) {
  requireOwner(actor)
  const policy=await invoiceAutomation(env),b=await business(env),at=clockInstant(env)
  const runs=await all(env,`SELECT r.*,EXISTS(SELECT 1 FROM nc_invoice_automation_authority a WHERE a.automation_id=r.id AND a.revision=r.execution_revision) AS local_authority
    FROM nc_invoice_automation_runs r ORDER BY business_day DESC LIMIT 30`)
  const periods=await all(env,'SELECT automation_id,period,bill_run_id FROM nc_invoice_automation_periods ORDER BY period')
  return {policy,runs:runs.map(({result_json,local_authority,...row})=>({...row,result:parseJson(result_json,{}),
    periods:periods.filter(p=>p.automation_id===row.id).map(({automation_id:_id,...p})=>p),
    resumable:!!(local_authority&&policy.enabled&&row.policy_revision===policy.revision&&b&&row.business_day===localDate(at,b.timezone)
      &&(row.status==='failed'||row.status==='running'&&row.heartbeat_at<=at-INVOICE_AUTOMATION_LEASE_MS))}))}
}

async function executeInvoiceAutomation(env: Bindings, policy: Row, row: Row) {
  const id=row.id,revision=row.execution_revision,day=row.business_day
  const authority=()=>executionGuard(env,id,revision)
  const actor:Actor={id:policy.approved_by,kind:'member',role:'owner',name:'Invoice scheduler',email:`system:invoice-automation:${id}`,sessionId:null,capabilities:memberCapabilities('owner',null)}
  const heartbeat=async()=>{
    await env.DB.batch([authority(),stmt(env,"UPDATE nc_invoice_automation_runs SET heartbeat_at=? WHERE id=?",clockInstant(env),id),stmt(env,'DELETE FROM nc_guard')])
  }
  const result:Row={issued:[],review:[],runs:[]}
  let pending=Promise.resolve()
  const timer=setInterval(()=>{pending=pending.then(heartbeat).catch(()=>{})},60_000)
  try {
    const months=[addMonths(`${day.slice(0,7)}-01`,-1).slice(0,7),day.slice(0,7)]
    for(const period of months){
      await heartbeat()
      let saved=await one(env,'SELECT bill_run_id FROM nc_invoice_automation_periods WHERE automation_id=? AND period=?',id,period)
      if(!saved){
        const run=await prepareRunWithCheckpoint(env,actor,Input.of({period}),billRun=>[authority(),invoiceAutomationGuard(env,policy),
          stmt(env,'INSERT INTO nc_invoice_automation_periods(automation_id,period,bill_run_id) VALUES(?,?,?)',id,period,billRun)])
        saved={bill_run_id:run.id}
      }
      result.runs.push(saved.bill_run_id)
      const invoices=await all(env,'SELECT * FROM nc_invoices WHERE bill_run_id=? ORDER BY id',saved.bill_run_id)
      for(const invoice of invoices){
        await heartbeat()
        if(invoice.status==='issued'){result.issued.push(invoice.number);continue}
        if(invoice.status==='shadow')continue
        if(!['draft','approved'].includes(invoice.status)||parseJson<Row[]>(invoice.exceptions_json,[]).length){result.review.push(invoice.id);continue}
        try {
          // Fence approval and issue separately, including a stale Worker that
          // wakes after its expired execution was explicitly replaced.
          if(invoice.status==='draft')await approveWithAuthority(env,actor,Input.of({invoice:invoice.id}),()=>combinedAuthority(env,policy,id,revision))
          // Each transaction also rechecks the exact approved policy.
          const issued=await finaliseWithAuthority(env,actor,Input.of({invoice:invoice.id}),()=>combinedAuthority(env,policy,id,revision))
          result.issued.push(...issued.issued)
        }catch(error){if(!(error instanceof NectarError))throw error;result.review.push(invoice.id)}
      }
    }
    await commit(env,[authority(),stmt(env,"UPDATE nc_invoice_automation_runs SET status='completed',result_json=?,heartbeat_at=? WHERE id=?",JSON.stringify(result),clockInstant(env),id)],
      {actor:'system:invoices',action:'invoice.automation.complete',subject:id,detail:result})
    return {id,status:'completed',...result}
  }catch(error){
    // The old invocation cannot overwrite the outcome of a newer continuation.
    await commit(env,[stmt(env,"UPDATE nc_invoice_automation_runs SET status='failed',result_json=?,heartbeat_at=? WHERE id=? AND execution_revision=? AND status='running'",JSON.stringify(result),clockInstant(env),id,revision)],
      {actor:'system:invoices',action:'invoice.automation.failed',subject:id})
    throw error
  }finally{clearInterval(timer);await pending}
}

function combinedAuthority(env: Bindings, policy: Row, id: string, revision: string) {
  return guard(env,'invoice_automation_changed',`EXISTS(SELECT 1 FROM nc_invoice_automation p
    JOIN nc_members maker ON maker.id=p.prepared_by AND maker.status='active' AND maker.role='owner'
    JOIN nc_members approver ON approver.id=p.approved_by AND approver.status='active' AND approver.role IN ('owner','finance')
    JOIN nc_invoice_automation_runs r ON r.id=? AND r.status='running' AND r.execution_revision=?
    JOIN nc_invoice_automation_authority a ON a.automation_id=r.id AND a.revision=r.execution_revision
    WHERE p.singleton=1 AND p.enabled=1 AND p.revision=?)`,id,revision,policy.revision)
}

export async function runInvoiceAutomation(env: Bindings, instant=clockInstant(env)) {
  const b=await business(env),policy=await invoiceAutomation(env)
  if(!b||!policy.enabled)return {status:'disabled'}
  const day=localDate(instant,b.timezone),hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:b.timezone,hour:'numeric',hourCycle:'h23'}).format(new Date(instant)))
  if(hour<policy.hour)return {status:'before_schedule'}
  const id=newId(),revision=newId()
  try {
    await commit(env,[invoiceAutomationGuard(env,policy),stmt(env,"INSERT INTO nc_invoice_automation_runs(id,business_day,policy_revision,status,created_at,heartbeat_at,execution_revision) VALUES(?,?,?,'running',?,?,?)",id,day,policy.revision,instant,clockInstant(env),revision),
      stmt(env,'INSERT INTO nc_invoice_automation_authority(automation_id,revision) VALUES(?,?)',id,revision)],
      {actor:'system:invoices',action:'invoice.automation.reserve',subject:id,detail:{day,policyRevision:policy.revision}})
  }catch(error){if(error instanceof NectarError&&['already_exists','invoice_automation_changed'].includes(error.code))return {status:error.code};throw error}
  return executeInvoiceAutomation(env,policy,{id,business_day:day,execution_revision:revision})
}

export async function resumeInvoiceAutomation(env: Bindings, actor: Actor, input: Input) {
  await setupOwner(env,actor)
  input.only(['run','revision','confirm'])
  insist(input.flag('confirm'),'confirmation_required')
  const row=await one(env,'SELECT * FROM nc_invoice_automation_runs WHERE id=?',input.text('run',{max:100}))
  insist(row,'invoice_automation_run_not_found',404)
  const policy=await invoiceAutomation(env),b=await business(env),at=clockInstant(env),revision=newId()
  insist(b&&row.business_day===localDate(at,b.timezone),'invoice_automation_day_expired',409)
  insist(row.execution_revision===input.text('revision',{max:100}),'invoice_automation_execution_changed',409)
  insist(row.status==='failed'||row.status==='running'&&row.heartbeat_at<=at-INVOICE_AUTOMATION_LEASE_MS,'invoice_automation_not_interrupted',409)
  insist(row.policy_revision===policy.revision,'invoice_automation_changed',409)
  await commit(env,[...setupOwnerFence(env,actor),invoiceAutomationGuard(env,policy),
    guard(env,'invoice_automation_execution_changed',`EXISTS(SELECT 1 FROM nc_invoice_automation_runs r JOIN nc_invoice_automation_authority a ON a.automation_id=r.id AND a.revision=r.execution_revision
      WHERE r.id=? AND r.execution_revision=? AND (r.status='failed' OR r.status='running' AND r.heartbeat_at<=?))`,row.id,row.execution_revision,at-INVOICE_AUTOMATION_LEASE_MS),
    stmt(env,"UPDATE nc_invoice_automation_runs SET status='running',execution_revision=?,heartbeat_at=?,resumption_count=resumption_count+1 WHERE id=?",revision,at,row.id),
    stmt(env,'UPDATE nc_invoice_automation_authority SET revision=? WHERE automation_id=?',revision,row.id)],
    {actor:actorLabel(actor),action:'invoice.automation.resume',subject:row.id,detail:{day:row.business_day,policyRevision:policy.revision,previousExecution:row.execution_revision}})
  return executeInvoiceAutomation(env,policy,{...row,execution_revision:revision})
}
export async function runInvoiceAutomationDoor(env: Bindings, actor: Actor) {
  requireOwner(actor);return runInvoiceAutomation(env)
}
