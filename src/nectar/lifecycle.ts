// SUB-003 public lifecycle commands. Dates are business-local, [from, until).
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, type Actor } from './actor'
import { commit, guard, insist, newId, now, one, stmt } from './core'
import { requireDate } from './dates'
import type { Input } from './input'
import { lifecycleHistory, lifecycleIntervals } from './lifecycle-records'
import { requireSubscription, notIssuedGuard, startsInIssuedPeriod } from './subscriptions'

export async function pauseSubscription(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const sub = await requireSubscription(env, input.text('subscription', { max: 100 }))
  const revision = input.text('revision', { max: 100 })
  insist(revision === sub.revision, 'stale', 409)
  const from = requireDate(input.text('effective_date', { max: 10 }), 'effective_date')
  const until = requireDate(input.text('resume_date', { max: 10 }), 'resume_date')
  const access = input.text('access', { max: 10 })
  insist(access === 'retain' || access === 'suspend', 'invalid_access')
  const term=await one(env,"SELECT 1 FROM nc_renewal_terms WHERE subscription_id=? AND status='active' AND auto_renew=1 AND cancelled_at IS NULL",sub.id)
  insist(from >= sub.start_date && until > from && (!sub.end_date || until <= sub.end_date || term), 'invalid_pause_dates')
  const reason = input.text('reason', { max: 500 })
  const intervals = lifecycleIntervals(await lifecycleHistory(env, sub.id))
  insist(!intervals.some(i => i.from < until && (i.to ?? '9999-12-31') > from), 'lifecycle_overlap', 409)
  insist(!await startsInIssuedPeriod(env, sub.id, from), 'period_already_invoiced', 409)
  const id = newId(), at = now()
  await commit(env, [
    guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND revision=?)', sub.id, revision),
    notIssuedGuard(env, sub.id, from),
    stmt(env, 'INSERT INTO nc_subscription_lifecycle (id,subscription_id,kind,effective_date,until_date,access,reason,author_id,author,created_at) VALUES (?,?,\'pause\',?,?,?,?,?,?,?)', id, sub.id, from, until, access, reason, actor.id, actorLabel(actor), at),
    stmt(env, 'UPDATE nc_subscriptions SET revision=?,updated_at=? WHERE id=?', newId(), at, sub.id),
  ], { actor: actorLabel(actor), action: 'subscription.pause', subject: sub.id, detail: { id, from, until, access, reason } })
  return { id: sub.id, transition: id }
}

export async function resumeSubscription(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const sub = await requireSubscription(env, input.text('subscription', { max: 100 }))
  const revision = input.text('revision', { max: 100 })
  insist(revision === sub.revision, 'stale', 409)
  const history = await lifecycleHistory(env, sub.id)
  const pause = history.find(e => e.id === input.text('pause', { max: 100 }) && e.kind === 'pause')
  insist(pause, 'pause_not_found', 404)
  insist(!history.some(e => e.related_id === pause.id), 'already_resumed', 409)
  const date = requireDate(input.text('effective_date', { max: 10 }), 'effective_date')
  insist(date > pause.effective_date && date < pause.until_date, 'invalid_resume_date')
  insist(!await startsInIssuedPeriod(env, sub.id, date), 'period_already_invoiced', 409)
  const reason = input.text('reason', { max: 500 }), id = newId(), at = now()
  await commit(env, [
    guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND revision=?)', sub.id, revision),
    notIssuedGuard(env, sub.id, date),
    stmt(env, 'INSERT INTO nc_subscription_lifecycle (id,subscription_id,kind,effective_date,access,related_id,reason,author_id,author,created_at) VALUES (?,?,\'resume\',?,\'retain\',?,?,?,?,?)', id, sub.id, date, pause.id, reason, actor.id, actorLabel(actor), at),
    stmt(env, 'UPDATE nc_subscriptions SET revision=?,updated_at=? WHERE id=?', newId(), at, sub.id),
  ], { actor: actorLabel(actor), action: 'subscription.resume', subject: sub.id, detail: { id, pause: pause.id, date, reason } })
  return { id: sub.id, transition: id }
}
