import type { Bindings } from '../auth.server'
import { customerText } from './locale'
import { operatorMail } from '../mail.server.mjs'
import { all, commit, guard, insist, newId, now, one, parseJson, sha256Hex, stmt, type Row } from './core'
import { business } from './business'
import { addDays, localDate } from './dates'
import { clockInstant } from './clock'
import { retentionScopeStatements } from './retention-amendments'
import { retentionDuration } from './retention-interval'
import { retentionPreview } from './retention-preview'
import { retentionTerms } from './retention-terms'
import { retentionPolicy } from './retention-policy'
import { serviceEndSql } from './renewal-sql'
import { notIssuedGuard } from './subscriptions'
import { esc } from './ui/html'

export async function runWinbacks(env:Bindings,instant=clockInstant(env)) {
  const b=await business(env);if(!b)return
  const day=localDate(instant,b.timezone),policy=await retentionPolicy(env)
  if(await one(env,"SELECT 1 FROM nc_retention_offers WHERE status='offered' AND to_date<?",day))await commit(env,[stmt(env,"UPDATE nc_retention_offers SET status='expired',token_hash=NULL,decided_at=? WHERE status='offered' AND to_date<?",now(),day)],{actor:'system:retention',action:'retention.expiry.tick',subject:day})
  if(!policy.enabled||!policy.winback_enabled||!policy.id)return
  const rows=await all(env,`SELECT s.*,c.billing_email,c.language FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id WHERE c.erased_at IS NULL AND s.end_date<=? AND s.end_date>=? AND s.billing_mode='live' AND NOT EXISTS(SELECT 1 FROM nc_retention_offers o WHERE o.subscription_id=s.id AND o.kind='winback') AND NOT EXISTS(SELECT 1 FROM nc_renewal_terms t WHERE t.subscription_id=s.id AND t.status='active' AND t.auto_renew=1 AND t.cancelled_at IS NULL)`,day,addDays(day,-policy.winback_days))
  for(const sub of rows) {
    const id=newId(),token=Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join(''),expires=addDays(sub.end_date,policy.winback_days),hash=await sha256Hex(token)
    let proposed:Row
    try { proposed=await retentionTerms(env,sub.id,'winback') } catch(error) { if(error instanceof Error&&['discount_already_applies','retention_price_required_for_mixed_intervals','retention_price_not_on_subscription','retention_duration_exceeds_service','retention_periods_must_be_contiguous','reactivation_requires_approved_term'].includes(error.message)) continue; throw error }
    const terms:Row={...proposed,percent:policy.winback_percent,months:policy.winback_months,cancelledDate:sub.end_date,sourceRevision:sub.revision,policyId:policy.id}
    try{await commit(env,[guard(env,'stale',"NOT EXISTS(SELECT 1 FROM nc_retention_offers WHERE subscription_id=? AND kind='winback')",sub.id),stmt(env,"INSERT INTO nc_retention_offers(id,subscription_id,kind,policy_id,source_revision,terms_json,from_date,to_date,token_hash,created_at,mail_status) VALUES(?,?,'winback',?,?,?,?,?,?,?,'unconfirmed')",id,sub.id,policy.id,sub.revision,JSON.stringify(terms),day,expires,hash,now())],{actor:'system:retention',action:'retention.winback.reserve',subject:id,detail:{subscription:sub.id,policy:policy.id,day,expires}})}catch(e){if(e instanceof Error&&['already_exists','precondition_failed','stale'].includes(e.message))continue;throw e}
    const mail=operatorMail(env);let status='not_configured',provider:string|null=null
    if(mail&&env.MAIL_FROM&&sub.billing_email){
      const L=customerText(sub.language),link=new URL(`/return/${token}`,env.AUTH_ORIGIN).href,text=L.t(terms.billing?'winback.body_periods':'winback.body',{percent:L.percent(terms.percent),months:terms.months,date:L.day(expires),zone:b.timezone,link})
      status='unconfirmed'
      try{const result=await mail.send({deliveryId:`winback-${id}`,from:env.MAIL_FROM,to:[sub.billing_email],subject:L.t('winback.subject'),text,html:`<p>${esc(text)}</p>`,headers:{'Auto-Submitted':'auto-generated'}});status=result.status==='development'?'not_configured':result.status;provider=result.providerMessageId??null}catch{status='unconfirmed'}
    }
    await commit(env,[stmt(env,'UPDATE nc_retention_offers SET mail_status=?,provider_ref=? WHERE id=?',status,provider,id)],{actor:'system:retention',action:'retention.winback.outcome',subject:id,detail:{status,provider}})
  }
}
export async function winbackForToken(env:Bindings,token:string) {
  if(!/^[a-f0-9]{64}$/.test(token))return null
  const row=await one(env,"SELECT * FROM nc_retention_offers WHERE token_hash=? AND kind='winback' AND status='offered'",await sha256Hex(token)),b=await business(env)
  if(!row||!b||localDate(clockInstant(env),b.timezone)>row.to_date)return null
  const policy=await retentionPolicy(env)
  return policy.enabled&&policy.winback_enabled&&policy.id===row.policy_id?row:null
}
export async function acceptWinback(env:Bindings,offer:Row) {
  const terms=parseJson<Row>(offer.terms_json,{}),sub=(await one(env,'SELECT * FROM nc_subscriptions WHERE id=?',offer.subscription_id))!,b=(await business(env))!
  const day=localDate(clockInstant(env),b.timezone)
  const duration=await retentionDuration(env,sub,day,terms.months,terms.priceId??'',undefined,true),from=duration.from,to=duration.to
  const preview=await retentionPreview(env,b,sub,duration,{kind:'discount',months:terms.months,percent:terms.percent},true)
  insist(sub.end_date===terms.cancelledDate&&sub.revision===terms.sourceRevision,'offer_stale',409)
  insist(day>=sub.end_date&&day<=offer.to_date,'offer_expired',409)
  insist(!await one(env,"SELECT 1 FROM nc_amendments WHERE subscription_id=? AND kind='discount_percent' AND status='approved' AND effective_from<? AND COALESCE(effective_to,'9999')>?",sub.id,to,from),'discount_already_applies',409)
  const author=(await one(env,'SELECT * FROM nc_retention_policies WHERE id=?',offer.policy_id))!
  const meters=(await all(env,'SELECT DISTINCT COALESCE(m.source_meter_id,p.meter_id) AS meter FROM nc_items i JOIN nc_prices p ON p.id=i.price_id LEFT JOIN nc_meters m ON m.id=p.meter_id WHERE i.subscription_id=? AND p.meter_id IS NOT NULL AND (i.effective_to IS NULL OR i.effective_to>?)',sub.id,day)).map(r=>r.meter)
  const clash=`SELECT 1 FROM nc_items i JOIN nc_prices p ON p.id=i.price_id LEFT JOIN nc_meters m ON m.id=p.meter_id JOIN nc_subscriptions s ON s.id=i.subscription_id WHERE s.customer_id=? AND s.id<>? AND ${serviceEndSql()}>? AND COALESCE(i.effective_to,'9999')>? AND COALESCE(m.source_meter_id,p.meter_id) IN (${meters.map(()=>'?').join(',')})`
  const statements=[guard(env,'offer_stale',"EXISTS(SELECT 1 FROM nc_retention_offers WHERE id=? AND status='offered') AND EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND revision=? AND end_date=?) AND (SELECT id FROM nc_retention_policies WHERE status='approved' ORDER BY decided_at DESC,id DESC LIMIT 1)=?",offer.id,sub.id,sub.revision,sub.end_date,offer.policy_id),notIssuedGuard(env,sub.id,day),...(meters.length?[guard(env,'meter_already_billed',`NOT EXISTS(${clash})`,sub.customer_id,sub.id,day,day,...meters)]:[])]
  let cancel=await one(env,"SELECT c.id FROM nc_subscription_lifecycle c WHERE c.subscription_id=? AND c.kind='cancel' AND NOT EXISTS(SELECT 1 FROM nc_subscription_lifecycle r WHERE r.related_id=c.id) ORDER BY c.seq DESC LIMIT 1",sub.id)
  if(!cancel){cancel={id:newId()};statements.push(stmt(env,"INSERT INTO nc_subscription_lifecycle(id,subscription_id,kind,effective_date,access,reason,author_id,author,created_at,policy_json) VALUES(?,?,'cancel',?,'suspend','Term ended before win-back',?,'system:retention',?,?)",cancel.id,sub.id,sub.end_date,author.decided_by_id,now(),JSON.stringify({creditUnused:false,reactivationDays:terms.months*31})))}
  statements.push(stmt(env,"INSERT INTO nc_subscription_lifecycle(id,subscription_id,kind,effective_date,access,related_id,reason,author_id,author,created_at) VALUES(?,?,'reactivate',?,'retain',?,'Accepted win-back',?,'customer:winback-offer',?)",newId(),sub.id,day,cancel.id,author.decided_by_id,now()),stmt(env,"UPDATE nc_renewal_terms SET status='superseded',token_hash=NULL WHERE subscription_id=? AND status IN ('active','ended')",sub.id),stmt(env,'UPDATE nc_subscriptions SET end_date=NULL,revision=?,updated_at=? WHERE id=?',newId(),now(),sub.id))
  if(terms.percent>0) {
    const amendment=newId()
    statements.push(stmt(env,"INSERT INTO nc_amendments(id,subscription_id,kind,value,price_id,effective_from,effective_to,note,clause,status,origin,created_by,created_at,decided_by,decided_at,prepared_by_id) VALUES(?,?,'discount_percent',?,?,?,?,'Accepted win-back',?,'approved','native','customer:winback-offer',?,?,?,?)",amendment,sub.id,String(terms.percent),null,from,to,`Policy ${offer.policy_id}`,now(),`policy:${offer.policy_id}`,author.decided_at,author.prepared_by_id),...retentionScopeStatements(env,amendment,sub.id,duration.priceId))
  }
  statements.push(stmt(env,"UPDATE nc_retention_offers SET status='accepted',decided_at=?,token_hash=NULL,terms_json=? WHERE id=?",now(),JSON.stringify({...terms,from,to,preview}),offer.id))
  await commit(env,statements,{actor:'customer:winback-offer',action:'retention.winback.accept',subject:offer.id,detail:{subscription:sub.id,policy:offer.policy_id,from,to,reactivationDate:day}})
  return {from,to,day,percent:terms.percent}
}
