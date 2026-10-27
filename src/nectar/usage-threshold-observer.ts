// The crossing, immutable webhook and pending email share one transaction.
import type { Bindings } from '../auth.server'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, commit, fingerprint, guard, NectarError, newId, one, stmt, type Row } from './core'
import { localDate, periodContaining, zonedStart } from './dates'
import { decimalText, micros, roundHalfAway } from './decimal'
import { ratingInputs } from './inputs'
import { rate } from './rating'
import { earnedCents } from './commitment-rating'
import { contractBasis } from './contract-terms'
import { deliverThresholdMail } from './usage-threshold-mail'

async function measure(env: Bindings, definition: Row) {
  const b=await requireBusiness(env), at=clockInstant(env)
  const sub=await one(env,'SELECT * FROM nc_subscriptions WHERE id=?',definition.subscription_id)
  if(!sub)return null
  const period=periodContaining(sub.anchor_day,localDate(at,b.timezone))
  if(sub.start_date>=period.end||sub.end_date&&sub.end_date<=period.start||sub.cutover_start&&sub.cutover_start>=period.end)return null
  const input=await ratingInputs(env,b,sub.id,period)
  input.events=input.events.filter(e=>e.occurredAt<=at)
  const rating=rate(input)
  if(definition.kind==='usage'){
    const price=Object.values(input.prices).find(p=>p.meterId===definition.meter_id)
    const value=price?.metric?rating.lines.filter(l=>l.meterId===definition.meter_id&&l.periodStart===period.start&&l.kind==='metric_usage').reduce((n,l)=>n+micros(l.quantity),0n)
      :(await all(env,`SELECT quantity FROM nc_usage_events e WHERE customer_id=? AND meter_id=? AND status='active' AND occurred_at>=? AND occurred_at<? AND occurred_at<=? AND NOT EXISTS(SELECT 1 FROM nc_usage_voids v WHERE v.event_id=e.event_id)`,sub.customer_id,definition.meter_id,zonedStart(period.start,b.timezone),zonedStart(period.end,b.timezone),at)).reduce((n,e)=>n+micros(e.quantity),0n)
    return {period,value:decimalText(value),reached:value>=micros(definition.threshold),basis:await fingerprint(input)}
  }
  const metered=rating.lines.filter(l=>['usage','overage','metric_usage'].includes(l.kind)&&l.periodStart===period.start&&(!definition.meter_id||l.meterId===definition.meter_id)).reduce((n,l)=>n+l.amountCents,0)
  if(definition.kind==='spend')return {period,value:decimalText(BigInt(metered)*10000n),reached:BigInt(metered)*10000n>=micros(definition.threshold),basis:await fingerprint(input)}
  const basis=await contractBasis(env,sub.id),window=basis.commitments.find(w=>w.contract===definition.contract_id&&w.from<=period.start&&w.to>=period.end)
  if(!window)return null
  const previous=basis.invoices.filter(i=>i.from>=window.from&&i.to<=period.start).reduce((n,i)=>n+earnedCents(i.lines),0)
  const earned=previous+metered, value=roundHalfAway(BigInt(earned)*100_000_000n,BigInt(window.minimumCents))
  return {period:{start:window.from,end:window.to},value:decimalText(value),reached:BigInt(earned)*100_000_000n>=micros(definition.threshold)*BigInt(window.minimumCents),basis:await fingerprint(input)}
}
export async function observeUsageThresholds(env: Bindings, customers?: string[]) {
  if(customers&&!customers.length)return
  const definitions=await all(env,`SELECT t.* FROM nc_usage_thresholds t JOIN nc_customers c ON c.id=t.customer_id JOIN nc_contacts contact ON contact.id=t.contact_id AND contact.customer_id=t.customer_id AND contact.role='billing' AND contact.email=t.recipient
    WHERE t.enabled=1 AND c.erased_at IS NULL${customers?` AND t.customer_id IN (${customers.map(()=>'?').join(',')})`:''} ORDER BY t.id`,...(customers??[]))
  for(const d of definitions){
    const generation=(await one(env,'SELECT value FROM nc_privacy_generation WHERE id=1'))!.value
    const measured=await measure(env,d)
    if(!measured?.reached)continue
    if(await one(env,'SELECT 1 FROM nc_usage_crossings WHERE threshold_id=? AND period_start=?',d.id,measured.period.start))continue
    const id=newId(),at=clockInstant(env),event=newId()
    const data={threshold_id:d.id,crossing_id:id,customer_id:d.customer_id,subscription_id:d.subscription_id,kind:d.kind,meter_id:d.meter_id,contract_id:d.contract_id,value:measured.value,threshold:d.threshold,period:measured.period,basis:measured.basis}
    try{
      await commit(env,[guard(env,'stale','(SELECT value FROM nc_privacy_generation WHERE id=1)=?',generation),guard(env,'stale',`EXISTS(SELECT 1 FROM nc_usage_thresholds t JOIN nc_customers c ON c.id=t.customer_id JOIN nc_contacts contact ON contact.id=t.contact_id WHERE t.id=? AND t.revision=? AND t.enabled=1 AND c.erased_at IS NULL AND contact.role='billing' AND contact.email=t.recipient)`,d.id,d.revision),
        guard(env,'stale','NOT EXISTS(SELECT 1 FROM nc_usage_crossings WHERE threshold_id=? AND period_start=?)',d.id,measured.period.start),
        stmt(env,`INSERT INTO nc_usage_crossings(id,threshold_id,customer_id,subscription_id,period_start,period_end,value,threshold,name,recipient,contact_id,kind,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,d.id,d.customer_id,d.subscription_id,measured.period.start,measured.period.end,measured.value,d.threshold,d.name,d.recipient,d.contact_id,d.kind,at),
        stmt(env,'INSERT INTO nc_webhook_events(id,type,customer_id,subject,payload_json,created_at) VALUES(?,?,?,?,?,?)',event,'usage.threshold_crossed',d.customer_id,id,JSON.stringify({type:'usage.threshold_crossed',data,metadata:[]}),at)],
        {actor:'system:usage-threshold',action:'usage.threshold.crossed',subject:id,detail:{...data,event}})
    }catch(error){if(!(error instanceof NectarError&&['stale','already_exists'].includes(error.code)))throw error}
  }
  await deliverThresholdMail(env,customers)
}
