// Claim once before the provider request; an uncertain result is never retried.
import type { Bindings } from '../auth.server'
import { operatorMail } from '../mail.server.mjs'
import { all, commit, guard, NectarError, one, stmt } from './core'
import { clockInstant } from './clock'
import { esc } from './ui/html'

export async function deliverThresholdMail(env: Bindings, customers?: string[]) {
  if(customers&&!customers.length)return
  const rows=await all(env,`SELECT x.* FROM nc_usage_crossings x WHERE x.email_status='pending'${customers?` AND x.customer_id IN (${customers.map(()=>'?').join(',')})`:''} ORDER BY x.created_at,x.id LIMIT 100`,...(customers??[]))
  for(const row of rows){
    const eligible=await one(env,`SELECT 1 FROM nc_contacts contact JOIN nc_customers c ON c.id=contact.customer_id JOIN nc_usage_thresholds t ON t.id=? WHERE contact.id=? AND contact.customer_id=? AND contact.email=? AND contact.role='billing' AND c.erased_at IS NULL AND t.enabled=1`,row.threshold_id,row.contact_id,row.customer_id,row.recipient)
    if(!eligible){await commit(env,[stmt(env,"UPDATE nc_usage_crossings SET email_status='suppressed' WHERE id=? AND email_status='pending'",row.id)],{actor:'system:usage-threshold',action:'usage.threshold.mail.suppress',subject:row.id});continue}
    try{
      await commit(env,[guard(env,'stale',"EXISTS(SELECT 1 FROM nc_usage_crossings x JOIN nc_customers c ON c.id=x.customer_id JOIN nc_contacts contact ON contact.id=x.contact_id JOIN nc_usage_thresholds t ON t.id=x.threshold_id WHERE x.id=? AND x.email_status='pending' AND c.erased_at IS NULL AND contact.role='billing' AND contact.email=x.recipient AND t.enabled=1)",row.id),stmt(env,"UPDATE nc_usage_crossings SET email_status='sending' WHERE id=?",row.id)],{actor:'system:usage-threshold',action:'usage.threshold.mail.claim',subject:row.id})
    }catch(error){if(error instanceof NectarError&&error.code==='stale')continue;throw error}
    let status='failed',provider:string|null=null
    try{
      const mail=operatorMail(env)
      if(mail&&env.MAIL_FROM){
        status='uncertain'
        const text=`${row.name}\n${row.kind}: ${row.value}; threshold: ${row.threshold}\nWindow: ${row.period_start} to ${row.period_end}\nCrossing reference: ${row.id}`
        const result=await mail.send({deliveryId:`usage-threshold-${row.id}`,from:env.MAIL_FROM,to:[row.recipient],subject:`Usage alert: ${row.name}`,text,html:`<pre>${esc(text)}</pre>`,headers:{'Auto-Submitted':'auto-generated'}})
        status=result.status==='accepted'?'accepted':result.status==='development'?'suppressed':['failed','rejected','rate_limited'].includes(result.status)?'failed':'uncertain'
        provider=result.providerMessageId??null
      }
    }catch{/* A lost transport response cannot prove non-acceptance. */}
    await commit(env,[stmt(env,"UPDATE nc_usage_crossings SET email_status=?,provider_ref=? WHERE id=? AND email_status='sending'",status,provider,row.id)],{actor:'system:usage-threshold',action:'usage.threshold.mail.outcome',subject:row.id,detail:{status,provider}})
  }
}
