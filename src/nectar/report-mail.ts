import type { Bindings } from '../auth.server'
import { operatorMail } from '../mail.server.mjs'
import { business } from './business'
import { clockInstant } from './clock'
import { NectarError, all, commit, guard, newId, now, one, stmt } from './core'
import { addMonths, localDate } from './dates'
import { report, reportInvoice, type Report } from './reports'
import { reportsCsv } from './report-csv'
import { memberCapabilities, type Actor, type Role } from './actor'
import { plainMoney } from './decimal'
import { esc } from './ui/html'

/** GOV-001: scheduled reports reach only members who can read reports and export. */
type ScheduledReportMember={id:string;email:string;name:string;role:Role;custom:string|null;revision:string}
const reportReader=(role:Role,custom:string|null)=>{const held=memberCapabilities(role,custom);return held.has('export')&&(held.has('read')||held.has('read.reports'))}

// Preparation may resume only before its durable mail claim. These local
// leases are excluded from portability; history alone cannot authorize a send.
const PREPARATION_LEASE_MS=30*60_000
async function reserveReport(env: Bindings, member: {id:string;revision:string}, period: string) {
  const existing=await one(env,'SELECT id,status FROM nc_report_deliveries WHERE member_id=? AND period=?',member.id,period)
  const revision=newId(),at=clockInstant(env)
  if(!existing){
    const id=newId()
    try {
      await commit(env,[guard(env,'stale','NOT EXISTS(SELECT 1 FROM nc_report_deliveries WHERE member_id=? AND period=?)',member.id,period),
        stmt(env,"INSERT INTO nc_report_deliveries(id,member_id,period,status,generated_at) VALUES (?,?,?,'preparing',?)",id,member.id,period,now()),
        stmt(env,'INSERT INTO nc_report_preparations(delivery_id,revision,schedule_revision,heartbeat_at) VALUES(?,?,?,?)',id,revision,member.revision,at)],
        {actor:'system:reports',action:'report.reserve',subject:id,detail:{period,member:member.id,scheduleRevision:member.revision}})
      return {id,revision}
    }catch(error){if(error instanceof NectarError&&error.code==='stale')return null;throw error}
  }
  const preparation=await one(env,'SELECT * FROM nc_report_preparations WHERE delivery_id=?',existing.id)
  if(!preparation||preparation.claimed_at!==null||preparation.schedule_revision!==member.revision
    ||!(existing.status==='failed'||existing.status==='preparing'&&preparation.heartbeat_at<=at-PREPARATION_LEASE_MS))return null
  try {
    await commit(env,[guard(env,'stale',`EXISTS(SELECT 1 FROM nc_report_deliveries d JOIN nc_report_preparations p ON p.delivery_id=d.id
      WHERE d.id=? AND p.revision=? AND p.claimed_at IS NULL AND (d.status='failed' OR d.status='preparing' AND p.heartbeat_at<=?))`,existing.id,preparation.revision,at-PREPARATION_LEASE_MS),
      stmt(env,"UPDATE nc_report_deliveries SET status='preparing' WHERE id=?",existing.id),
      stmt(env,'UPDATE nc_report_preparations SET revision=?,heartbeat_at=? WHERE delivery_id=?',revision,at,existing.id)],
      {actor:'system:reports',action:'report.preparation.resume',subject:existing.id,detail:{period,member:member.id,scheduleRevision:member.revision}})
    return {id:existing.id,revision}
  }catch(error){if(error instanceof NectarError&&error.code==='stale')return null;throw error}
}
const preparationGuard=(env: Bindings,id:string,revision:string)=>guard(env,'stale',
  'EXISTS(SELECT 1 FROM nc_report_preparations WHERE delivery_id=? AND revision=?)',id,revision)

/** One frozen current-record snapshot of the previous month per opted-in member.
 * Reserving before reading makes overlapping cron invocations and restarts safe.
 * A claimed send is never automatically repeated: its outcome may be unknown. */
export async function sendScheduledReports(env: Bindings, instant=Date.now()) {
  const b=await business(env)
  if(!b)return
  const day=localDate(instant,b.timezone),period=addMonths(`${day.slice(0,7)}-01`,-1).slice(0,7)
  const rows=(await all<ScheduledReportMember>(env,`SELECT m.id,m.email,m.name,m.role,r.capabilities AS custom,s.revision FROM nc_members m
    JOIN nc_report_schedules s ON s.member_id=m.id LEFT JOIN nc_roles r ON r.id=m.custom_role_id
    WHERE m.status='active' AND s.enabled=1 AND s.day<=?`,Number(day.slice(8)))).filter(member=>reportReader(member.role as Role,member.custom))
  let failed=false
  // A stopped sender has an unknown outcome, never permission to send again.
  for(const interrupted of await all(env,`SELECT d.id,d.period FROM nc_report_deliveries d JOIN nc_report_preparations p ON p.delivery_id=d.id
    WHERE d.status='sending' AND p.claimed_at IS NOT NULL AND p.heartbeat_at<=?`,clockInstant(env)-PREPARATION_LEASE_MS)){
    try {
      await commit(env,[guard(env,'stale',"EXISTS(SELECT 1 FROM nc_report_deliveries WHERE id=? AND status='sending')",interrupted.id),
        stmt(env,"UPDATE nc_report_deliveries SET status='uncertain' WHERE id=? AND status='sending'",interrupted.id)],
        {actor:'system:reports',action:'report.delivery.interrupted',subject:interrupted.id,detail:{period:interrupted.period}})
      failed=true
    }catch(error){if(!(error instanceof NectarError&&error.code==='stale'))throw error}
  }
  for(const member of rows){
    const reservation=await reserveReport(env,member,period)
    if(!reservation)continue
    const {id,revision}=reservation
    let pending=Promise.resolve()
    const timer=setInterval(()=>{pending=pending.then(async()=>{
      await stmt(env,'UPDATE nc_report_preparations SET heartbeat_at=? WHERE delivery_id=? AND revision=? AND claimed_at IS NULL',clockInstant(env),id,revision).run()
    }).catch(()=>{})},60_000)
    let status='failed',provider:string|null=null
    try {
      const actor:Actor={id:member.id,email:member.email,name:member.name,role:member.role as Role,kind:'member',sessionId:null,
        capabilities:memberCapabilities(member.role as Role,member.custom)}
      const seq=(await one(env,'SELECT COALESCE(MAX(seq),0) AS seq FROM nc_audit'))!.seq
      const reports:Report[]=[]
      for(const metric of ['billings','collections','settlements','refunds','ar','credits','tax','unbilled','credit-balances'])reports.push(await report(env,actor,metric,new URL(`https://report.invalid/?period=${period}`)))
      const sourceEvidence=[]
      for(const r of reports)for(const entry of r.entries){
        const sourceUrl=new URL(entry.href,env.AUTH_ORIGIN)
        const detail=await reportInvoice(env,actor,r.metric,entry.invoiceId,sourceUrl)
        sourceEvidence.push({metric:r.metric,sourceId:entry.invoiceId,sourcePath:entry.href,detail})
        entry.sourcePath=entry.href
        entry.href=`/app/report-deliveries/${id}#source-${r.metric}-${entry.invoiceId}`
      }
      const csv=reportsCsv(reports)
      await commit(env,[preparationGuard(env,id,revision),guard(env,'report_source_changed','(SELECT COALESCE(MAX(seq),0) FROM nc_audit)=?',seq),
        stmt(env,'UPDATE nc_report_preparations SET claimed_at=? WHERE delivery_id=? AND revision=? AND claimed_at IS NULL',clockInstant(env),id,revision),
        stmt(env,"UPDATE nc_report_deliveries SET reports_json=?,sources_json=?,csv=?,status='sending' WHERE id=? AND status='preparing'",JSON.stringify(reports),JSON.stringify(sourceEvidence),csv,id)],
        [{actor:'system:reports',action:'report.snapshot',subject:id,detail:{period}},{actor:'system:reports',action:'report.mail.claim',subject:id,detail:{period,member:member.id,scheduleRevision:member.revision}}])
      const current=await one(env,`SELECT m.id,m.role,r.capabilities AS custom FROM nc_members m JOIN nc_report_schedules s ON s.member_id=m.id LEFT JOIN nc_roles r ON r.id=m.custom_role_id
        WHERE m.id=? AND m.email=? AND m.status='active' AND s.enabled=1 AND s.revision=?`,member.id,member.email,member.revision)
      const eligible=current&&reportReader(current.role as Role,current.custom)
      status='suppressed'
      const mail=operatorMail(env)
      if(eligible&&mail&&env.MAIL_FROM){
        const link=new URL(`/app/report-deliveries/${id}`,env.AUTH_ORIGIN).href
        const figures=reports.map(r=>`${r.title}: USD ${plainMoney(r.totalCents)} (${r.period}). ${r.definition}`).join('\n\n')
        status='uncertain'
        try {
          const result=await mail.send({deliveryId:`financial-report-${id}`,from:env.MAIL_FROM,to:[member.email],subject:`Financial reports: ${period}`,
            text:`${figures}\n\nFrozen report and CSV (sign in): ${link}`,html:`<pre>${esc(figures)}</pre><p><a href="${esc(link)}">Sign in for the frozen report and CSV</a></p>`,headers:{'Auto-Submitted':'auto-generated'}})
          status=result.status==='accepted'?'accepted':result.status==='development'?'suppressed':result.status
          provider=result.providerMessageId??null
        }catch{status='uncertain'}
      }
    }catch{status='failed'}finally{clearInterval(timer);await pending}
    // A stale preparer cannot overwrite a newer execution's delivery outcome.
    if(!await one(env,'SELECT 1 FROM nc_report_preparations WHERE delivery_id=? AND revision=?',id,revision))continue
    failed ||= status==='failed'
    await commit(env,[preparationGuard(env,id,revision),stmt(env,'UPDATE nc_report_deliveries SET status=?,provider_ref=? WHERE id=?',status,provider,id)],
      {actor:'system:reports',action:'report.delivery',subject:id,detail:{period,status,provider}})
  }
  return {status:failed?'failed':'completed'}
}
