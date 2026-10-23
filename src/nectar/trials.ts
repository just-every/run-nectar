// CAT-005 trials. A trial records whether a payment method is on file. An
// operator can extend a running trial; the first charge moves with its end date
// because rating bills fixed and seat lines from the trial end. At the end date
// a trial with a payment method on file converts, and one without ends unpaid
// with no charge, once, audited.
import type { Bindings } from '../auth.server'
import { actorLabel, requireCapability, requireMember, type Actor } from './actor'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, commit, guard, insist, newId, now, one, stmt, type Row } from './core'
import { addDays, today } from './dates'
import type { Input } from './input'
import { runTrialCollections } from './trial-collection-jobs'

const running = async (env: Bindings, id: string) => {
  const sub = await one(env, "SELECT * FROM nc_subscriptions WHERE id=? AND billing_mode='live'", id)
  insist(sub, 'subscription_not_found', 404)
  return sub
}

export async function extendTrial(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'records')
  insist(actor.kind === 'member', 'person_required', 403)
  const sub = await running(env, input.text('subscription', { max: 100 }))
  const days = input.integer('days', { min: 1, max: 90 })!
  const business = await requireBusiness(env), day = today(business.timezone, clockInstant(env))
  insist(sub.trial_end && sub.trial_end > day && !sub.trial_outcome && (!sub.end_date || sub.end_date > sub.trial_end), 'trial_not_running', 409)
  insist(!await one(env, "SELECT 1 FROM nc_invoices WHERE subscription_id=? AND status IN ('issued','approved') AND period_end>?", sub.id, sub.trial_end), 'trial_already_billed', 409)
  insist(!sub.contract_end_date || addDays(sub.trial_end, days) < sub.contract_end_date, 'trial_exceeds_contract', 409)
  const next = addDays(sub.trial_end, days), id = newId(), at = clockInstant(env)
  await commit(env, [
    guard(env, 'stale', "EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND trial_end=? AND trial_outcome IS NULL)", sub.id, sub.trial_end),
    stmt(env, 'INSERT INTO nc_trial_extensions(id,subscription_id,customer_id,previous_end,new_end,days,extended_by,extended_at) VALUES(?,?,?,?,?,?,?,?)', id, sub.id, sub.customer_id, sub.trial_end, next, days, actorLabel(actor), at),
    stmt(env, 'UPDATE nc_subscriptions SET trial_end=?,revision=?,updated_at=? WHERE id=?', next, newId(), now(), sub.id),
    stmt(env, "UPDATE nc_trial_collections SET status='invalidated',error_code='trial_end_changed',ended_at=?,revision=? WHERE subscription_id=? AND status IN ('pending_owner','pending_approval','active')", at, newId(), sub.id),
  ], { actor: actorLabel(actor), action: 'trial.extend', subject: sub.id, detail: { previousEnd: sub.trial_end, newEnd: next, days } })
  return { id: sub.id, trialEnd: next }
}

/** The outcome at the trial end date, for one subscription; idempotent. */
export async function resolveTrialRow(env: Bindings, actor: Actor, sub: Row) {
  const outcome = sub.trial_payment === 'card' ? 'converted' : 'ended_unpaid'
  const at = clockInstant(env)
  await commit(env, [
    guard(env, 'stale', "EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND trial_end=? AND trial_outcome IS NULL)", sub.id, sub.trial_end),
    stmt(env, `UPDATE nc_subscriptions SET trial_outcome=?,trial_resolved_at=?${outcome === 'ended_unpaid' ? ',end_date=?' : ''},revision=?,updated_at=? WHERE id=?`, outcome, at, ...(outcome === 'ended_unpaid' ? [sub.trial_end] : []), newId(), now(), sub.id),
  ], { actor: actorLabel(actor), action: `trial.${outcome}`, subject: sub.id, detail: { trialEnd: sub.trial_end, paymentMethod: sub.trial_payment } })
  return { id: sub.id, outcome }
}

export async function resolveTrial(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const sub = await running(env, input.text('subscription', { max: 100 }))
  const business = await requireBusiness(env)
  insist(sub.trial_end && !sub.trial_outcome, 'trial_not_running', 409)
  insist(sub.trial_end <= today(business.timezone, clockInstant(env)), 'trial_not_ended', 409)
  insist(sub.trial_payment, 'trial_payment_unknown', 409)
  return await resolveTrialRow(env, actor, sub)
}

/** The daily job: every trial whose end date has arrived and that declared its payment method. */
export async function runTrials(env: Bindings, scheduledTime = clockInstant(env)) {
  const business = await requireBusiness(env).catch(() => null)
  if (!business) return
  await runTrialCollections(env)
  const system: Actor = { id: 'system', kind: 'agent', name: 'trial-scheduler', email: '', role: null, sessionId: null, capabilities: new Set() }
  for (const sub of await all(env, "SELECT * FROM nc_subscriptions WHERE billing_mode='live' AND trial_end IS NOT NULL AND trial_outcome IS NULL AND trial_payment IS NOT NULL AND trial_end<=? ORDER BY trial_end,id", today(business.timezone, scheduledTime)))
    await resolveTrialRow(env, system, sub).catch(() => undefined)
}
