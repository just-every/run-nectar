import type { Bindings } from '../auth.server'
import { operatorMail } from '../mail.server.mjs'
import { business } from './business'
import { all, commit, guard, newId, now, one, stmt } from './core'
import { addMonths, localDate } from './dates'
import { report, reportInvoice, type Report } from './reports'
import { reportsCsv } from './report-csv'
import { ROLE_CAPABILITIES, type Actor, type Role } from './actor'
import { plainMoney } from './decimal'
import { esc } from './ui/html'

/** One frozen current-record snapshot of the previous month per opted-in member.
 * Reserving before reading makes overlapping cron invocations and restarts safe.
 * A claimed send is never automatically repeated: its outcome may be unknown. */
export async function sendScheduledReports(env: Bindings, instant=Date.now()) {
  const b=await business(env)
  if(!b)return
  const day=localDate(instant,b.timezone),period=addMonths(`${day.slice(0,7)}-01`,-1).slice(0,7)
  const rows=await all(env,`SELECT m.id,m.email,m.name,m.role,s.revision FROM nc_members m
    JOIN nc_report_schedules s ON s.member_id=m.id
    WHERE m.status='active' AND m.role IN ('owner','finance','accountant') AND s.enabled=1 AND s.day<=?`,Number(day.slice(8)))
  for(const member of rows){
    const id=newId()
    const claimed=await env.DB.prepare(`INSERT OR IGNORE INTO nc_report_deliveries(id,member_id,period,status,generated_at)
      VALUES (?,?,?,'preparing',?) RETURNING id`).bind(id,member.id,period,now()).first()
    if(!claimed)continue
    let status='failed',provider:string|null=null
    try {
      const actor:Actor={id:member.id,email:member.email,name:member.name,role:member.role as Role,kind:'member',sessionId:null,
        capabilities:new Set(ROLE_CAPABILITIES[member.role as Role])}
      const seq=(await one(env,'SELECT COALESCE(MAX(seq),0) AS seq FROM nc_audit'))!.seq
      const reports:Report[]=[]
      for(const metric of ['billings','collections','ar','credits','tax','unbilled'])reports.push(await report(env,actor,metric,new URL(`https://report.invalid/?period=${period}`)))
      const sourceEvidence=[]
      for(const r of reports)for(const entry of r.entries){
        const sourceUrl=new URL(entry.href,env.AUTH_ORIGIN)
        const detail=await reportInvoice(env,actor,r.metric,entry.invoiceId,sourceUrl)
        sourceEvidence.push({metric:r.metric,sourceId:entry.invoiceId,sourcePath:entry.href,detail})
        entry.sourcePath=entry.href
        entry.href=`/app/report-deliveries/${id}#source-${r.metric}-${entry.invoiceId}`
      }
      const csv=reportsCsv(reports)
      await commit(env,[guard(env,'report_source_changed','(SELECT COALESCE(MAX(seq),0) FROM nc_audit)=?',seq),
        stmt(env,"UPDATE nc_report_deliveries SET reports_json=?,sources_json=?,csv=?,status='sending' WHERE id=? AND status='preparing'",JSON.stringify(reports),JSON.stringify(sourceEvidence),csv,id)],
        {actor:'system:reports',action:'report.snapshot',subject:id,detail:{period}})
      const eligible=await one(env,`SELECT m.id FROM nc_members m JOIN nc_report_schedules s ON s.member_id=m.id
        WHERE m.id=? AND m.email=? AND m.status='active' AND m.role IN ('owner','finance','accountant') AND s.enabled=1 AND s.revision=?`,member.id,member.email,member.revision)
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
    }catch{status='failed'}
    await commit(env,[stmt(env,'UPDATE nc_report_deliveries SET status=?,provider_ref=? WHERE id=?',status,provider,id)],
      {actor:'system:reports',action:'report.delivery',subject:id,detail:{period,status,provider}})
  }
}
