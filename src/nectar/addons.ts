// A named approver attaches an immutable catalogue price. The existing rating
// engine prorates the new item from its effective date on the recurring bill.
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, type Actor } from './actor'
import { requirePrice } from './catalog'
import { commit, guard, insist, newId, now, one, stmt } from './core'
import { requireDate } from './dates'
import type { Input } from './input'
import { requireSubscription } from './subscriptions'

const ISSUED = `SELECT 1 FROM nc_invoices WHERE subscription_id = ?
  AND invoice_kind = 'recurring' AND status = 'issued' AND period_end > ?`
const ACTIVE_ITEMS = `SELECT COUNT(*) AS count FROM nc_items WHERE subscription_id = ?
  AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?)`
const DUPLICATE_PRICE = `SELECT 1 FROM nc_items WHERE subscription_id = ? AND price_id = ?
  AND (effective_to IS NULL OR effective_to > ?) AND effective_from < ?`

// The new item lasts until its subscription ends. Compare the full future
// interval, including this subscription's own scheduled items and subscriptions
// that have ended today but overlapped the requested historical effective date.
const METER_CLASH = `SELECT 1 FROM nc_items i
  JOIN nc_prices p ON p.id = i.price_id LEFT JOIN nc_meters m ON m.id=p.meter_id JOIN nc_subscriptions s ON s.id = i.subscription_id
  WHERE s.customer_id = ? AND COALESCE(m.source_meter_id,p.meter_id) = ?
    AND MAX(s.start_date, i.effective_from, ?) <
      MIN(COALESCE(s.end_date, '9999-12-31'), COALESCE(i.effective_to, '9999-12-31'), ?) AND (s.id<>? OR (p.meter_id=? AND p.dimensions_json=?))`

export async function attachAddon(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const sub = await requireSubscription(env, input.text('subscription', { max: 100 }))
  insist(sub.billing_mode === 'live', 'subscription_not_live', 409)
  const price = await requirePrice(env, input.text('price', { max: 100 }))
  insist(price.status === 'active', 'price_not_found', 404)
  const date = requireDate(input.text('effective_date', { max: 10 }), 'effective_date')
  insist(date >= sub.start_date && (!sub.end_date || date < sub.end_date), 'invalid_effective_date')
  insist(!sub.cutover_start || date >= sub.cutover_start, 'before_cutover', 409)
  const quantity = price.kind === 'seat'
    ? input.integer('quantity', { min: price.pricing_model === 'simple' ? 1 : 0, max: price.pricing_model === 'simple' ? 1_000_000 : 1_000_000_000 })!
    : 1
  const meterParams = [sub.customer_id, price.source_meter_id??price.meter_id, date, sub.end_date ?? '9999-12-31',sub.id,price.meter_id,price.dimensions_json??'{}']
  const [issued, count, duplicate, clash] = await Promise.all([
    one(env, ISSUED, sub.id, date),
    one<{ count: number }>(env, ACTIVE_ITEMS, sub.id, date, date),
    one(env, DUPLICATE_PRICE, sub.id, price.id, date, sub.end_date ?? '9999-12-31'),
    price.meter_id ? one(env, METER_CLASH, ...meterParams) : Promise.resolve(null),
  ])
  insist(!issued, 'period_already_invoiced', 409)
  insist(count && count.count < 20, 'too_many_items', 409)
  insist(!duplicate, 'price_already_attached', 409)
  insist(!clash, 'meter_already_billed', 409)

  const item = newId(), at = now()
  await commit(env, [
    guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_subscriptions WHERE id = ? AND revision = ?)', sub.id, sub.revision),
    guard(env, 'price_not_found', "EXISTS(SELECT 1 FROM nc_prices WHERE id = ? AND status = 'active')", price.id),
    guard(env, 'period_already_invoiced', `NOT EXISTS(${ISSUED})`, sub.id, date),
    guard(env, 'too_many_items', `(${ACTIVE_ITEMS}) < 20`, sub.id, date, date),
    guard(env, 'price_already_attached', `NOT EXISTS(${DUPLICATE_PRICE})`, sub.id, price.id, date, sub.end_date ?? '9999-12-31'),
    ...(price.meter_id ? [guard(env, 'meter_already_billed', `NOT EXISTS(${METER_CLASH})`, ...meterParams)] : []),
    stmt(env, "INSERT INTO nc_items (id, subscription_id, price_id, quantity, effective_from, origin, created_at) VALUES (?, ?, ?, ?, ?, 'native', ?)", item, sub.id, price.id, quantity, date, at),
    stmt(env, 'UPDATE nc_subscriptions SET revision = ?, updated_at = ? WHERE id = ?', newId(), at, sub.id),
  ], { actor: actorLabel(actor), action: 'subscription.addon', subject: sub.id, detail: { item, price: price.id, quantity, date } })
  return { id: sub.id, item }
}
