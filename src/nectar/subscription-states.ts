// Observe native lifecycle facts on scheduled ticks. No read grants authority,
// issues an invoice, changes a collection policy or calls a payment provider.
import type { Bindings } from '../auth.server'
import { all, canonical, commit, guard, NectarError, newId, one, parseJson, stmt, type Row } from './core'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { today } from './dates'
import { entitlementState } from './entitlement-state'

export async function subscriptionState(env: Bindings, sub: Row, day: string) {
  const input = await entitlementState(env, sub, day)
  const state = input.lifecycle === 'active' && ['past_due','unpaid'].includes(input.payment.status)
    ? input.payment.status : input.lifecycle
  return { state, input }
}
export async function subscriptionStateHistory(env: Bindings, subscription: string): Promise<Row[]> {
  return (await all(env, 'SELECT * FROM nc_subscription_states WHERE subscription_id=? ORDER BY seq', subscription))
    .map(({ cause_json, ...row }) => ({ ...row, cause: parseJson<Row>(cause_json, {}) }))
}
export async function observeSubscriptionStates(env: Bindings) {
  const business = await requireBusiness(env).catch(() => null)
  if (!business) return
  const at = clockInstant(env), day = today(business.timezone, at)
  const cursor = (await one(env, 'SELECT subscription_id FROM nc_subscription_state_cursor WHERE singleton=1'))!.subscription_id
  const rows = await all(env, `SELECT s.* FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id
    WHERE s.billing_mode='live' AND c.status='active' AND c.erased_at IS NULL AND s.id>? ORDER BY s.id LIMIT 25`, cursor)
  for (const sub of rows) {
    const generation = (await one(env, 'SELECT value FROM nc_privacy_generation WHERE id=1'))!.value
    const audit = (await one(env, 'SELECT COALESCE(MAX(seq),0) seq FROM nc_audit'))!.seq
    const old = await one(env, 'SELECT * FROM nc_subscription_states WHERE subscription_id=? ORDER BY seq DESC LIMIT 1', sub.id)
    const { state, input } = await subscriptionState(env, sub, day)
    if (old?.state === state || old && old.observed_at > at) continue
    const lifecycle = await all(env, `SELECT id,kind,effective_date,until_date,related_id FROM nc_subscription_lifecycle WHERE subscription_id=? AND effective_date<=? ORDER BY seq`, sub.id, day)
    const dunning = await all(env, `SELECT d.id,d.policy_id,d.status,d.end_date,d.invoice_id FROM nc_dunning_series d JOIN nc_invoices i ON i.id=d.invoice_id WHERE i.subscription_id=? AND d.end_date<=? ORDER BY d.id`, sub.id, day)
    const allocations = old && ['past_due','unpaid'].includes(old.state) && state === 'active'
      ? await all(env, `SELECT a.id,a.invoice_id,a.payment_id,a.amount_cents FROM nc_allocations a JOIN nc_invoices i ON i.id=a.invoice_id WHERE i.subscription_id=? ORDER BY a.id`, sub.id) : []
    const cause = { day, timezone: business.timezone, startDate: sub.start_date, trialEnd: sub.trial_end,
      endDate: sub.end_date, lifecycle, payment: input.payment, dunning, allocations }
    const id = newId(), data = { subscription_id: sub.id, customer_id: sub.customer_id, transition_id: id,
      previous_state: old?.state ?? null, state, cause, observed_at: at }
    try {
      await commit(env, [
        guard(env, 'subscription_state_changed', '(SELECT value FROM nc_privacy_generation WHERE id=1)=? AND (SELECT COALESCE(MAX(seq),0) FROM nc_audit)=?', generation, audit),
        guard(env, 'subscription_state_changed', '(SELECT id FROM nc_subscription_states WHERE subscription_id=? ORDER BY seq DESC LIMIT 1) IS ?', sub.id, old?.id ?? null),
        stmt(env, 'INSERT INTO nc_subscription_states(id,subscription_id,customer_id,previous_id,previous_state,state,cause_json,observed_at) VALUES(?,?,?,?,?,?,?,?)', id, sub.id, sub.customer_id, old?.id ?? null, old?.state ?? null, state, canonical(cause), at),
        stmt(env, 'INSERT INTO nc_webhook_events(id,type,customer_id,subject,payload_json,created_at) VALUES(?,?,?,?,?,?)', id, 'subscription.state_changed', sub.customer_id, sub.id, canonical({type:'subscription.state_changed',data}), at),
      ], { actor:'system:lifecycle', action:'subscription.state.observe', subject:sub.id, detail:data })
    } catch (error) {
      if (!(error instanceof NectarError && error.code === 'subscription_state_changed')) throw error
      // Keep the page pending so a source race is retried on the next tick.
      return
    }
  }
  await env.DB.prepare('UPDATE nc_subscription_state_cursor SET subscription_id=? WHERE singleton=1 AND subscription_id=?')
    .bind(rows.length === 25 ? rows.at(-1)!.id : '', cursor).run()
}
