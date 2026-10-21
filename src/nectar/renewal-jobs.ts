import { prepareSaveOffer } from './retention-offers'
import { customerText } from './locale'
import type { Bindings } from '../auth.server'
import { operatorMail } from '../mail.server.mjs'
import { business } from './business'
import { all, commit, guard, newId, now, one, stmt, NectarError, type Row } from './core'
import { addDays, addMonths, localDate } from './dates'
import { ratingInputs } from './inputs'
import { rate } from './rating'
import { newCancellationLink } from './renewal-terms'
import { nativeRenewalPreview, nextRenewalEnd, renewalReplacementIds } from './renewal-calendar'
import { RENEWAL_RATING_VERSION } from './renewal-rating'
import { esc } from './ui/html'

export async function renewalPreview(env:Bindings,term:Row) {
  const b=(await business(env))!,sub=(await one(env,'SELECT * FROM nc_subscriptions WHERE id=?',term.subscription_id))!
  const native=await nativeRenewalPreview(env,b,sub,term)
  if(native)return native
  const period={start:term.end_date,end:addMonths(term.end_date,1)},input=await ratingInputs(env,b,term.subscription_id,period)
  input.subscription.endDate=addMonths(term.end_date,term.months)
  input.renewals=[...(input.renewals??[]),{id:`next-${term.id}-${term.cycle}`,effectiveDate:term.end_date,upliftPercent:term.uplift_percent}];input.version=RENEWAL_RATING_VERSION
  const result=rate(input)
  return {renewalDate:term.end_date,nextTermEnd:addMonths(term.end_date,term.months),upliftPercent:term.uplift_percent,period,subtotalCents:result.subtotalCents,taxCents:result.taxCents,totalCents:result.totalCents,lines:result.lines,inputs:input}
}
async function notice(env:Bindings,term:Row,day:string) {
  const sub=await one(env,'SELECT end_date FROM nc_subscriptions WHERE id=?',term.subscription_id)
  if(sub?.end_date!==term.end_date||!term.auto_renew||term.cancelled_at||day<addDays(term.end_date,-term.notice_days)||day>=term.end_date)return
  if(await one(env,'SELECT 1 FROM nc_renewal_notices WHERE term_id=? AND cycle=?',term.id,term.cycle))return
  await prepareSaveOffer(env,term)
  const id=newId(),snapshot=await renewalPreview(env,term),link=await newCancellationLink(env,term),customer=await one(env,'SELECT c.billing_email,c.language FROM nc_customers c JOIN nc_subscriptions s ON s.customer_id=c.id WHERE s.id=?',term.subscription_id)
  try{await commit(env,[guard(env,'stale',"EXISTS(SELECT 1 FROM nc_renewal_terms WHERE id=? AND revision=? AND status='active' AND cancelled_at IS NULL) AND NOT EXISTS(SELECT 1 FROM nc_renewal_notices WHERE term_id=? AND cycle=?)",term.id,term.revision,term.id,term.cycle),stmt(env,"INSERT INTO nc_renewal_notices(id,term_id,cycle,due_date,renewal_date,recipient,snapshot_json,status,created_at) VALUES(?,?,?,?,?,?,?,'unconfirmed',?)",id,term.id,term.cycle,addDays(term.end_date,-term.notice_days),term.end_date,customer!.billing_email,JSON.stringify(snapshot),now()),stmt(env,'UPDATE nc_renewal_terms SET token_hash=? WHERE id=?',link.hash,term.id)],{actor:'system:renewals',action:'renewal.notice.reserve',subject:id,detail:{term:term.id,cycle:term.cycle,scheduledDate:addDays(term.end_date,-term.notice_days),actualDate:day}})}catch(e){if(e instanceof NectarError&&e.status===409)return;throw e}
  let status='not_configured',provider:string|null=null
  const mail=operatorMail(env)
  const eligible=await one(env,"SELECT 1 FROM nc_renewal_terms WHERE id=? AND revision=? AND token_hash=? AND status='active' AND auto_renew=1 AND cancelled_at IS NULL",term.id,term.revision,link.hash)
  if(!eligible)status='suppressed'
  if(eligible&&mail&&env.MAIL_FROM&&customer!.billing_email){
    const L=customerText(customer!.language),prices='invoices' in snapshot ? snapshot.invoices.map(invoice=>`${L.day(invoice.dueDate)} (${L.day(invoice.period.start)} – ${L.day(addDays(invoice.period.end,-1))}):\n${invoice.lines.filter(line=>line.priceId).map(line=>`${line.description}: ${L.money(line.amountCents)}`).join('\n')}`).join('\n') : snapshot.lines.filter(l=>l.priceId).map(l=>`${l.description}: ${L.money(l.amountCents)}`).join('\n')
    const text=[L.t('renewal.notice.renews',{date:L.day(term.end_date),end:L.day(snapshot.nextTermEnd),percent:L.percent(term.uplift_percent)}),L.t('renewal.notice.charges'),prices,L.t('renewal.notice.totals',{subtotal:L.money(snapshot.subtotalCents),tax:L.money(snapshot.taxCents),total:L.money(snapshot.totalCents)}),...('usageExplanation' in snapshot && snapshot.usageExplanation?[snapshot.usageExplanation]:[]),L.t('renewal.notice.cancel',{link:link.url})].join('\n')
    status='unconfirmed'
    try{const result=await mail.send({deliveryId:`renewal-${id}`,from:env.MAIL_FROM,to:[customer!.billing_email],subject:L.t('renewal.notice.subject',{date:L.day(term.end_date)}),text,html:`<p>${esc(text).replaceAll('\n','<br>')}</p>`,headers:{'Auto-Submitted':'auto-generated'}});status=result.status==='development'?'not_configured':result.status;provider=result.providerMessageId??null}catch{status='unconfirmed'}
  }
  await commit(env,[stmt(env,'UPDATE nc_renewal_notices SET status=?,provider_ref=? WHERE id=?',status,provider,id)],{actor:'system:renewals',action:'renewal.notice.outcome',subject:id,detail:{status,provider}})
}
export async function runRenewals(env:Bindings,instant=Date.now()) {
  const b=await business(env);if(!b)return
  const day=localDate(instant,b.timezone)
  for(const initial of await all(env,"SELECT * FROM nc_renewal_terms WHERE status='active' ORDER BY end_date,id")) {
    let term=initial
    while(term.end_date<=day) {
      const sub=await one(env,'SELECT * FROM nc_subscriptions WHERE id=?',term.subscription_id)
      const renew=!!term.auto_renew&&!term.cancelled_at&&sub?.end_date===term.end_date,kind=renew?'renew':'end',end=renew?nextRenewalEnd(sub!,term):term.end_date,id=newId()
      const replaced = renew && sub?.billing_anchor_date ? [...await renewalReplacementIds(env, term.subscription_id, term.end_date)] : []
      try{await commit(env,[guard(env,'stale',"EXISTS(SELECT 1 FROM nc_renewal_terms WHERE id=? AND revision=? AND status='active')",term.id,term.revision),...(renew?[guard(env,'stale','EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND revision=? AND end_date=?)',term.subscription_id,sub!.revision,term.end_date)]:[]),stmt(env,'INSERT INTO nc_renewal_events(id,term_id,subscription_id,cycle,effective_date,end_date,kind,uplift_percent,created_at) VALUES(?,?,?,?,?,?,?,?,?)',id,term.id,term.subscription_id,term.cycle,term.end_date,end,kind,renew?term.uplift_percent:'0.00',now()),stmt(env,'UPDATE nc_subscriptions SET end_date=?,contract_end_date=CASE WHEN billing_anchor_date IS NOT NULL THEN ? ELSE contract_end_date END,revision=?,updated_at=? WHERE id=? AND (end_date IS NULL OR end_date>=?)',end,end,newId(),now(),term.subscription_id,term.end_date),...(renew&&sub?.billing_anchor_date?[stmt(env,`UPDATE nc_items SET effective_to=? WHERE subscription_id=? AND effective_to=?${replaced.length ? ` AND id NOT IN (${replaced.map(()=>'?').join(',')})` : ''}`,end,term.subscription_id,term.end_date,...replaced)]:[]),stmt(env,'UPDATE nc_renewal_terms SET start_date=?,end_date=?,cycle=cycle+1,revision=?,token_hash=NULL,status=? WHERE id=?',term.end_date,end,newId(),renew?'active':'ended',term.id)],{actor:'system:renewals',action:`subscription.term.${kind}`,subject:term.subscription_id,detail:{term:term.id,cycle:term.cycle,date:term.end_date,end,upliftPercent:renew?term.uplift_percent:'0.00'}})}catch(e){if(e instanceof NectarError&&e.status===409)break;throw e}
      if(!renew)break
      term=(await one(env,'SELECT * FROM nc_renewal_terms WHERE id=?',term.id))!
    }
    if(term.status==='active')await notice(env,term,day)
  }
}
