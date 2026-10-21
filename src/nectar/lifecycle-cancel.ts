import { serviceEndSql } from './renewal-sql'
// SUB-003 cancellation/reactivation, including CAT-001 issued advance service.
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, type Actor } from './actor'
import { requireBusiness } from './business'
import { all, commit, guard, insist, newId, now, one, parseJson, stmt } from './core'
import { addDays, periodContaining, requireDate, today } from './dates'
import type { Input } from './input'
import { lifecyclePolicy } from './lifecycle-policy'
import { lifecycleHistory } from './lifecycle-records'
import { requireSubscription } from './subscriptions'
import { cancellationPlan } from './interval-cancel-plan'
import { cancellationIssuedGuard, cancellationTransitionStatements, prepareIntervalCancellation } from './interval-cancel'
import { billingPeriodContaining, MONTHLY_ARREARS, storedBillingTerms } from './billing-calendar'
import { intervalReactivationStatements } from './interval-reactivate'

export async function cancelSubscription(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const sub = await requireSubscription(env, input.text('subscription',{max:100}))
  const revision = input.text('revision',{max:100})
  insist(revision === sub.revision, 'stale',409)
  const term=await one(env,"SELECT * FROM nc_renewal_terms WHERE subscription_id=? AND status='active' AND cancelled_at IS NULL",sub.id)
  const history = await lifecycleHistory(env, sub.id)
  insist(!history.some(event => event.kind === 'cancel' && !history.some(close => close.related_id === event.id)), 'already_ended',409)
  insist(!sub.end_date || term || sub.end_date === sub.contract_end_date, 'already_ended',409)
  const mode = input.text('mode',{max:20})
  insist(mode === 'immediate' || mode === 'term_end', 'invalid_cancel_mode')
  const business = await requireBusiness(env)
  const requested = requireDate(input.text('effective_date',{max:10,optional:true}) || today(business.timezone),'effective_date')
  const cadence = await one(env, 'SELECT c.* FROM nc_items i JOIN nc_price_intervals c ON c.price_id=i.price_id WHERE i.subscription_id=? AND i.effective_from<=? AND (i.effective_to IS NULL OR i.effective_to>?) ORDER BY i.effective_from,i.id LIMIT 1', sub.id, requested, requested)
  const fallbackEnd = cadence ? billingPeriodContaining(sub.billing_anchor_date ?? periodContaining(sub.anchor_day, sub.start_date).start, storedBillingTerms(cadence) ?? MONTHLY_ARREARS, requested).end : periodContaining(sub.anchor_day,requested).end
  const date = mode === 'term_end' ? term?.end_date ?? sub.contract_end_date ?? fallbackEnd : requested
  insist(!term||date<=term.end_date,'invalid_end_date')
  insist(!sub.contract_end_date || term || date <= sub.contract_end_date, 'invalid_end_date')
  insist(date > sub.start_date, 'invalid_end_date')
  const reason = input.text('reason',{max:500}), policy = await lifecyclePolicy(env)
  const id = newId()
  const transition = { id, date, reason, mode, requested, policy }
  const plan = await cancellationPlan(env, sub.id, date, id, policy.creditUnused)
  const prepared = await prepareIntervalCancellation(env, actor, sub, term, transition, plan)
  if (prepared) return prepared
  await commit(env,[
    guard(env, 'cancellation_pending', "NOT EXISTS(SELECT 1 FROM nc_interval_cancellations WHERE subscription_id=? AND status='pending')", sub.id),
    cancellationIssuedGuard(env, sub.id, date, plan.invoices),
    ...cancellationTransitionStatements(env, { id: actor.id, name: actorLabel(actor) }, sub, term, transition),
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
  const reinstated = await intervalReactivationStatements(env, sub, canceled, date)
  // A canceled subscription releases its meter; claiming it again must be atomic.
  const meters = (await all(env,'SELECT DISTINCT COALESCE(m.source_meter_id,p.meter_id) AS meter_id FROM nc_items i JOIN nc_prices p ON p.id=i.price_id LEFT JOIN nc_meters m ON m.id=p.meter_id WHERE i.subscription_id=? AND p.meter_id IS NOT NULL AND (i.effective_to IS NULL OR i.effective_to>?)',sub.id,date)).map(r=>r.meter_id)
  const clash = `NOT EXISTS(SELECT 1 FROM nc_items i JOIN nc_prices p ON p.id=i.price_id LEFT JOIN nc_meters m ON m.id=p.meter_id JOIN nc_subscriptions s ON s.id=i.subscription_id WHERE s.customer_id=? AND s.id<>? AND (${serviceEndSql()}>?) AND (i.effective_to IS NULL OR i.effective_to>?) AND COALESCE(m.source_meter_id,p.meter_id) IN (${meters.map(()=>'?').join(',')}))`
  const reason=input.text('reason',{max:500}),id=newId(),at=now()
  await commit(env,[guard(env,'stale','EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND revision=?)',sub.id,revision),
    ...reinstated.statements,
    ...(meters.length ? [guard(env,'meter_already_billed',clash,sub.customer_id,sub.id,date,date,...meters)] : []),
    stmt(env,"INSERT INTO nc_subscription_lifecycle (id,subscription_id,kind,effective_date,access,related_id,reason,author_id,author,created_at) VALUES (?,?,'reactivate',?,'retain',?,?,?,?,?)",id,sub.id,date,canceled.id,reason,actor.id,actorLabel(actor),at),
    stmt(env,'UPDATE nc_subscriptions SET end_date=?,contract_end_date=?,revision=?,updated_at=? WHERE id=?',reinstated.term ? reinstated.term.end_date : null,reinstated.contractEnd,newId(),at,sub.id),
    stmt(env,"UPDATE nc_renewal_terms SET status='superseded',token_hash=NULL,revision=? WHERE subscription_id=? AND status='active' AND cancelled_at IS NOT NULL",newId(),sub.id),
  ],{actor:actorLabel(actor),action:'subscription.reactivate',subject:sub.id,detail:{id,date,canceled:canceled.id,reason,restoredItems:reinstated.restored,renewal:reinstated.term?.id ?? null}})
  return {id:sub.id,transition:id}
}
