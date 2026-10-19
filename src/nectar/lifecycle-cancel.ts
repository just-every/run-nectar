import { serviceEndSql } from './renewal-sql'
// SUB-003 cancellation/reactivation for the current in-arrears catalogue.
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, type Actor } from './actor'
import { requireBusiness } from './business'
import { all, commit, guard, insist, newId, now, one, parseJson, stmt } from './core'
import { addDays, periodContaining, requireDate, today } from './dates'
import type { Input } from './input'
import { lifecyclePolicy } from './lifecycle-policy'
import { lifecycleHistory } from './lifecycle-records'
import { requireSubscription, startsInIssuedPeriod, notIssuedGuard } from './subscriptions'

export async function cancelSubscription(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const sub = await requireSubscription(env, input.text('subscription',{max:100}))
  const revision = input.text('revision',{max:100})
  insist(revision === sub.revision, 'stale',409)
  const term=await one(env,"SELECT * FROM nc_renewal_terms WHERE subscription_id=? AND status='active' AND cancelled_at IS NULL",sub.id)
  insist(!sub.end_date||term, 'already_ended',409)
  const mode = input.text('mode',{max:20})
  insist(mode === 'immediate' || mode === 'term_end', 'invalid_cancel_mode')
  const business = await requireBusiness(env)
  const requested = requireDate(input.text('effective_date',{max:10,optional:true}) || today(business.timezone),'effective_date')
  const date = mode === 'term_end' ? term?.end_date??periodContaining(sub.anchor_day,requested).end : requested
  insist(!term||date<=term.end_date,'invalid_end_date')
  insist(date > sub.start_date, 'invalid_end_date')
  insist(!await startsInIssuedPeriod(env,sub.id,date),'period_already_invoiced',409)
  const reason = input.text('reason',{max:500}), policy = await lifecyclePolicy(env)
  const id = newId(), at = now()
  await commit(env,[
    guard(env,'stale','EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND revision=?)',sub.id,revision),
    guard(env,'policy_changed','COALESCE((SELECT revision FROM nc_lifecycle_policy WHERE singleton=1),0)=?',policy.revision),
    notIssuedGuard(env,sub.id,date),
    stmt(env,"INSERT INTO nc_subscription_lifecycle (id,subscription_id,kind,effective_date,access,reason,author_id,author,created_at,policy_json) VALUES (?,?,'cancel',?,'suspend',?,?,?,?,?)",id,sub.id,date,reason,actor.id,actorLabel(actor),at,JSON.stringify({...policy,mode,requested})),
    stmt(env,'UPDATE nc_subscriptions SET end_date=?,revision=?,updated_at=? WHERE id=?',date,newId(),at,sub.id),
    ...(term?[stmt(env,'UPDATE nc_renewal_terms SET auto_renew=0,cancelled_at=?,token_hash=NULL,revision=? WHERE id=?',at,newId(),term.id)]:[]),
  ],{actor:actorLabel(actor),action:'subscription.cancel',subject:sub.id,detail:{id,date,mode,reason,policy}})
  return {id:sub.id,transition:id,endDate:date,policy}
}

export async function reactivateSubscription(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor,'approve')
  const sub = await requireSubscription(env,input.text('subscription',{max:100}))
  const revision = input.text('revision',{max:100})
  insist(revision === sub.revision,'stale',409)
  insist(sub.end_date,'not_canceled',409)
  const history = await lifecycleHistory(env,sub.id)
  const canceled = history.findLast(e=>e.kind === 'cancel' && !history.some(c=>c.related_id===e.id))
  insist(canceled,'cancellation_history_required',409)
  const date = requireDate(input.text('effective_date',{max:10}),'effective_date')
  const policy = parseJson<{reactivationDays:number}>(canceled.policy_json,{reactivationDays:30})
  insist(date >= canceled.effective_date && date <= addDays(canceled.effective_date,policy.reactivationDays),'reactivation_window_closed',409)
  insist(!await startsInIssuedPeriod(env,sub.id,date),'period_already_invoiced',409)
  // A canceled subscription releases its meter; claiming it again must be atomic.
  const meters = (await all(env,'SELECT DISTINCT COALESCE(m.source_meter_id,p.meter_id) AS meter_id FROM nc_items i JOIN nc_prices p ON p.id=i.price_id LEFT JOIN nc_meters m ON m.id=p.meter_id WHERE i.subscription_id=? AND p.meter_id IS NOT NULL AND (i.effective_to IS NULL OR i.effective_to>?)',sub.id,date)).map(r=>r.meter_id)
  const clash = `NOT EXISTS(SELECT 1 FROM nc_items i JOIN nc_prices p ON p.id=i.price_id LEFT JOIN nc_meters m ON m.id=p.meter_id JOIN nc_subscriptions s ON s.id=i.subscription_id WHERE s.customer_id=? AND s.id<>? AND (${serviceEndSql()}>?) AND (i.effective_to IS NULL OR i.effective_to>?) AND COALESCE(m.source_meter_id,p.meter_id) IN (${meters.map(()=>'?').join(',')}))`
  const reason=input.text('reason',{max:500}),id=newId(),at=now()
  await commit(env,[guard(env,'stale','EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND revision=?)',sub.id,revision),
    notIssuedGuard(env,sub.id,date),
    ...(meters.length ? [guard(env,'meter_already_billed',clash,sub.customer_id,sub.id,date,date,...meters)] : []),
    stmt(env,"INSERT INTO nc_subscription_lifecycle (id,subscription_id,kind,effective_date,access,related_id,reason,author_id,author,created_at) VALUES (?,?,'reactivate',?,'retain',?,?,?,?,?)",id,sub.id,date,canceled.id,reason,actor.id,actorLabel(actor),at),
    stmt(env,'UPDATE nc_subscriptions SET end_date=NULL,revision=?,updated_at=? WHERE id=?',newId(),at,sub.id),
    stmt(env,"UPDATE nc_renewal_terms SET status='superseded',token_hash=NULL,revision=? WHERE subscription_id=? AND status='active' AND cancelled_at IS NOT NULL",newId(),sub.id),
  ],{actor:actorLabel(actor),action:'subscription.reactivate',subject:sub.id,detail:{id,date,canceled:canceled.id,reason}})
  return {id:sub.id,transition:id}
}
