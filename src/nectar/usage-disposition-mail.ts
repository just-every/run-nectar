import { jobNeedsAttention } from './job-outcome'
// One durable reservation and claim; a lost response is never automatically retried.
import type { Bindings } from '../auth.server'
import { operatorMail } from '../mail.server.mjs'
import { all, commit, guard, now, one, stmt, NectarError } from './core'
import { esc } from './ui/html'
export async function deliverUsageCorrectionMail(env: Bindings, id: string) {
  const row=await one(env,"SELECT * FROM nc_usage_correction_mail WHERE correction_id=? AND status='pending'",id)
  if(!row)return
  try{await commit(env,[guard(env,'stale',"EXISTS(SELECT 1 FROM nc_usage_correction_mail m JOIN nc_usage_corrections c ON c.id=m.correction_id WHERE c.id=? AND c.status='approved' AND m.status='pending')",id),
    stmt(env,"UPDATE nc_usage_correction_mail SET status='sending',updated_at=? WHERE correction_id=?",now(),id)],{actor:'system:usage-correction',action:'usage.correction.mail.claim',subject:id})}
  catch(error){if(error instanceof NectarError&&error.code==='stale')return;throw error}
  let status='failed',provider:string|null=null
  try{const mail=operatorMail(env);if(mail&&env.MAIL_FROM){status='uncertain';const result=await mail.send({deliveryId:`usage-correction-${id}`,from:env.MAIL_FROM,to:[row.recipient],subject:row.subject,text:row.body,html:`<pre>${esc(row.body)}</pre>`,headers:{'Auto-Submitted':'auto-generated'}});
    status=result.status==='accepted'?'accepted':result.status==='development'?'suppressed':['failed','rejected','rate_limited'].includes(result.status)?'failed':'uncertain';provider=result.providerMessageId??null}}
  catch{/* A thrown transport cannot prove non-acceptance. */}
  await commit(env,[stmt(env,"UPDATE nc_usage_correction_mail SET status=?,provider_ref=?,updated_at=? WHERE correction_id=? AND status='sending'",status,provider,now(),id)],{actor:'system:usage-correction',action:'usage.correction.mail.outcome',subject:id,detail:{status,provider}})
  return {status}
}

export async function deliverPendingUsageCorrectionMail(env: Bindings) {
  let failed = false
  for(const row of await all(env,"SELECT correction_id FROM nc_usage_correction_mail WHERE status='pending' ORDER BY updated_at,correction_id LIMIT 100")) {
    const result = await deliverUsageCorrectionMail(env,row.correction_id)
    failed ||= jobNeedsAttention(result?.status)
  }
  return { status: failed ? 'failed' : 'completed' }
}
