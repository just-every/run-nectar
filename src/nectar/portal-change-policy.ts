import type { Bindings } from '../auth.server'
import { requireOwner, requireRead, type Actor } from './actor'
import { all, insist, one, parseJson, type Row } from './core'
import type { Input } from './input'
import { preparePolicyChange } from './policy-changes'

export async function portalChangePolicy(env: Bindings) {
  const row = await one(env, 'SELECT * FROM nc_portal_change_policy WHERE singleton=1')
  return { revision: row?.revision ?? 0, prices: parseJson<string[]>(row?.prices_json, []), minimumSeats: row?.minimum_seats ?? 1, pauseAllowed: !!row?.pause_allowed }
}

export async function preparePortalChangePolicy(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  const prices = [...new Set(input.list('prices'))].sort()
  insist(prices.length <= 100, 'too_many_prices')
  for (const id of prices) {
    insist(await one(env, `SELECT p.id FROM nc_prices p LEFT JOIN nc_price_intervals b ON b.price_id=p.id
      WHERE p.id=? AND p.status='active' AND p.kind IN ('flat','seat') AND p.pricing_model='simple'
      AND COALESCE(b.interval_unit,'month')='month' AND COALESCE(b.interval_count,1)=1 AND COALESCE(b.billing_timing,'arrears')='arrears'`, id), 'unsupported_portal_price')
  }
  return preparePolicyChange(env, actor, 'portal_change', { prices, minimumSeats: input.integer('minimum_seats', { min: 1, max: 1_000_000 }), pauseAllowed: input.flag('pause_allowed') })
}

export async function portalChangeSettings(env: Bindings, actor: Actor): Promise<Row> {
  requireRead(actor, 'subscriptions')
  requireRead(actor, 'customers')
  return { policy: await portalChangePolicy(env), requests: await all(env, `SELECT r.id,r.customer_id,r.subscription_id,r.item_id,r.target_price_id,r.quantity,r.status,r.requested_on,r.below_minimum,c.name AS customer_name
    FROM nc_portal_change_requests r JOIN nc_customers c ON c.id=r.customer_id WHERE c.erased_at IS NULL ORDER BY r.requested_at DESC,r.id LIMIT 200`) }
}
