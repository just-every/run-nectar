import { lifecycleHistory,lifecycleIntervals } from './lifecycle-records'
import type { Bindings } from '../auth.server'
import { requireCapability, type Actor } from './actor'
import { all, commit, guard, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import { business } from './business'
import { addDays, localDate } from './dates'
import { clockInstant } from './clock'
import { retentionPolicy, retentionPolicyHistory } from './retention-policy'
import { retentionTerms } from './retention-terms'
import { retentionIssuedCondition } from './retention-interval'
export async function prepareSaveOffer(env:Bindings,term:Row) {
  const policy=await retentionPolicy(env);if(!policy.enabled||!policy.id||!term.auto_renew||term.cancelled_at)return
  let terms:Row
  try{terms=await retentionTerms(env,term.subscription_id,'save')}catch(error){if(error instanceof Error&&['discount_already_applies','downgrade_price_unavailable','downgrade_not_compatible','downgrade_must_not_increase_charges','retention_price_required_for_mixed_intervals','retention_price_not_on_subscription','retention_duration_exceeds_service','retention_periods_must_be_contiguous'].includes(error.message))return;throw error}
  if(await one(env,"SELECT 1 FROM nc_retention_offers WHERE subscription_id=? AND kind='save' AND source_revision=?",term.subscription_id,terms.basis))return
  const b=(await business(env))!,expires=addDays(localDate(clockInstant(env),b.timezone),30),id=newId()
  await commit(env,[stmt(env,"INSERT INTO nc_retention_offers(id,subscription_id,kind,policy_id,source_revision,terms_json,from_date,to_date,created_at) VALUES(?,?,'save',?,?,?,?,?,?)",id,term.subscription_id,policy.id,terms.basis,JSON.stringify(terms),terms.from,expires,now())],{actor:'system:retention',action:'retention.save.offer',subject:id,detail:{subscription:term.subscription_id,policy:policy.id}})
}
export const savedOffer=(env:Bindings,term:Row)=>one(env,"SELECT * FROM nc_retention_offers WHERE subscription_id=? AND kind='save' AND status='offered' AND json_extract(terms_json,'$.termId')=? ORDER BY created_at DESC,id DESC LIMIT 1",term.subscription_id,term.id)
export async function declineSaveStatements(env:Bindings,term:Row,reason:string) {
  const offer=await savedOffer(env,term)
  return offer?[stmt(env,"UPDATE nc_retention_offers SET status='declined',reason=?,decided_at=?,token_hash=NULL WHERE id=? AND status='offered'",reason,now(),offer.id)]:[]
}
export async function acceptSave(env:Bindings,term:Row,offerId:string,reason:string) {
  const offer=await savedOffer(env,term);insist(offer&&offer.id===offerId,'offer_not_found',404)
  const sequence=(await one(env,'SELECT COALESCE(MAX(seq),0) AS n FROM nc_audit'))!.n
  const terms=parseJson<Row>(offer.terms_json,{}),fresh=await retentionTerms(env,term.subscription_id,'save',terms.from),b=(await business(env))!
  insist(localDate(clockInstant(env),b.timezone)<=offer.to_date,'offer_expired',409)
  insist(fresh.basis===offer.source_revision,'offer_stale',409)
  const issued=retentionIssuedCondition(terms.priceId??null,terms.kind)
  const author=(await one(env,'SELECT * FROM nc_retention_policies WHERE id=?',offer.policy_id))!,statements=[
    guard(env,'offer_stale',"(SELECT COALESCE(MAX(seq),0) FROM nc_audit)=? AND (SELECT id FROM nc_retention_policies WHERE status='approved' ORDER BY decided_at DESC,id DESC LIMIT 1)=?",sequence,offer.policy_id),
    guard(env,'offer_stale',"EXISTS(SELECT 1 FROM nc_retention_offers WHERE id=? AND status='offered') AND EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND revision=?) AND EXISTS(SELECT 1 FROM nc_renewal_terms WHERE id=? AND revision=? AND token_hash=? AND cancelled_at IS NULL AND status='active')",offer.id,term.subscription_id,terms.sourceRevision,term.id,term.revision,term.token_hash),guard(env,'period_already_invoiced',issued.sql,...(issued.scoped?[term.subscription_id,terms.priceId,terms.from]:[term.subscription_id,terms.from]))]
  if(terms.kind==='discount'&&terms.percent>0)statements.push(stmt(env,"INSERT INTO nc_amendments(id,subscription_id,kind,value,price_id,effective_from,effective_to,note,clause,status,origin,created_by,created_at,decided_by,decided_at,prepared_by_id) VALUES(?,?,'discount_percent',?,?,?,?,'Accepted retention save',?,'approved','native','customer:save-offer',?,?,?,?)",newId(),term.subscription_id,String(terms.percent),terms.priceId??null,terms.from,terms.to,`Policy ${offer.policy_id}`,now(),`policy:${offer.policy_id}`,author.decided_at,author.prepared_by_id))
  if(terms.kind==='pause') {
    const intervals=lifecycleIntervals(await lifecycleHistory(env,term.subscription_id))
    insist(!intervals.some(i=>i.from<terms.to&&(i.to??'9999')>terms.from),'lifecycle_overlap',409)
    statements.push(stmt(env,"INSERT INTO nc_subscription_lifecycle(id,subscription_id,kind,effective_date,until_date,access,reason,author_id,author,created_at) VALUES(?,?,'pause',?,?,'suspend','Customer accepted pause save',?,'customer:save-offer',?)",newId(),term.subscription_id,terms.from,terms.to,author.decided_by_id,now()))
  }
  if(terms.kind==='downgrade'){
    statements.push(guard(env,'offer_stale',"EXISTS(SELECT 1 FROM nc_prices WHERE id=? AND revision=? AND status='active')",terms.target,terms.targetRevision))
    for(const item of terms.selectedItems){
      if(item.from===terms.from)statements.push(stmt(env,'UPDATE nc_items SET price_id=? WHERE id=?',terms.target,item.id))
      else statements.push(stmt(env,'UPDATE nc_items SET effective_to=? WHERE id=?',terms.from,item.id),stmt(env,"INSERT INTO nc_items(id,subscription_id,price_id,quantity,effective_from,effective_to,origin,created_at) VALUES(?,?,?,?,?,?,'native',?)",newId(),term.subscription_id,terms.target,item.quantity,terms.from,item.to,now()))
    }
  }
  statements.push(stmt(env,'UPDATE nc_subscriptions SET revision=?,updated_at=? WHERE id=?',newId(),now(),term.subscription_id),stmt(env,"UPDATE nc_retention_offers SET status='accepted',reason=?,decided_at=? WHERE id=?",reason,now(),offer.id),stmt(env,'UPDATE nc_renewal_terms SET token_hash=NULL,revision=? WHERE id=?',newId(),term.id))
  await commit(env,statements,{actor:'customer:save-offer',action:'retention.save.accept',subject:offer.id,detail:{subscription:term.subscription_id,policy:offer.policy_id,terms,reason}})
  return terms
}
export async function retentionReport(env:Bindings,actor:Actor) {
  requireCapability(actor,'read')
  return {policy:await retentionPolicy(env),history:await retentionPolicyHistory(env,actor),offers:await all(env,'SELECT o.id,o.subscription_id,o.kind,o.policy_id,o.terms_json,o.status,o.reason,o.from_date,o.to_date,o.created_at,o.decided_at,o.mail_status,c.name AS customer_name FROM nc_retention_offers o JOIN nc_subscriptions s ON s.id=o.subscription_id JOIN nc_customers c ON c.id=s.customer_id ORDER BY o.created_at DESC,o.id DESC')}
}
