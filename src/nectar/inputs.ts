// Gathers the recorded inputs that rate one subscription for one period, and
// fingerprints them. An approval names this fingerprint: if any input changes
// (a usage event, an amendment, a price, the tax declaration), the approval no
// longer matches and the invoice cannot be finalised until it is prepared again.
import type { Bindings } from '../auth.server'
import type { Business } from './business'
import { all, fingerprint, insist, one, type Row } from './core'
import { zonedStart } from './dates'
import { RATING_VERSION, rate, type ItemIn, type PriceIn, type RatingInput } from './rating'
import { PRICE_MODEL_RATING_VERSION, storedQuantityPrice } from './price-model'

export const priceLabel = (row: Row) => `${row.product_name}${row.nickname ? ` — ${row.nickname}` : ''} (v${row.version})`

export async function pricesById(env: Bindings, ids: string[]): Promise<Record<string, PriceIn>> {
  if (!ids.length) return {}
  const rows = await all(env, `SELECT p.*, pr.name AS product_name, m.unit_label FROM nc_prices p JOIN nc_products pr ON pr.id = p.product_id LEFT JOIN nc_meters m ON m.id = p.meter_id WHERE p.id IN (${ids.map(() => '?').join(',')})`, ...ids)
  return Object.fromEntries(rows.map(row => [row.id, { id: row.id, kind: row.kind, unitAmount: row.unit_amount, meterId: row.meter_id, taxable: !!row.taxable, label: priceLabel(row), unitLabel: row.unit_label ?? '', ...(row.pricing_model === 'simple' ? {} : { pricing: storedQuantityPrice(row as any) }) }]))
}

export async function ratingInputs(env: Bindings, business: Business, subscriptionId: string, period: { start: string; end: string }, replaceItems?: ItemIn[]): Promise<RatingInput> {
  const sub = await one(env, 'SELECT s.*, c.tax_exempt, c.tax_exempt_ref FROM nc_subscriptions s JOIN nc_customers c ON c.id = s.customer_id WHERE s.id = ?', subscriptionId)
  insist(sub, 'subscription_not_found', 404)
  const items: ItemIn[] = replaceItems ?? (await all(env, 'SELECT id, price_id, quantity, effective_from, effective_to FROM nc_items WHERE subscription_id = ? ORDER BY effective_from, id', sub.id))
    .map(row => ({ id: row.id, priceId: row.price_id, quantity: row.quantity, from: row.effective_from, to: row.effective_to }))
  const amendments = (await all(env, "SELECT * FROM nc_amendments WHERE subscription_id = ? AND status = 'approved' ORDER BY effective_from, id", sub.id))
    .map(row => ({ id: row.id, kind: row.kind, value: row.value, priceId: row.price_id, from: row.effective_from, to: row.effective_to, note: row.note }))
  const prices = await pricesById(env, [...new Set([...items.map(item => item.priceId), ...amendments.flatMap(a => a.priceId ? [a.priceId] : [])])])
  const meters = [...new Set(Object.values(prices).flatMap(price => price.meterId ? [price.meterId] : []))]
  const events = meters.length ? (await all(env, `SELECT event_id, meter_id, quantity, occurred_at FROM nc_usage_events WHERE customer_id = ? AND status = 'active' AND invoice_id IS NULL AND occurred_at < ? AND meter_id IN (${meters.map(() => '?').join(',')}) ORDER BY occurred_at, event_id`,
    sub.customer_id, zonedStart(period.end, business.timezone), ...meters)).map(row => ({ eventId: row.event_id, meterId: row.meter_id, quantity: row.quantity, occurredAt: row.occurred_at })) : []
  return {
    version: Object.values(prices).some(price => price.pricing) ? PRICE_MODEL_RATING_VERSION : RATING_VERSION,
    timezone: business.timezone,
    tax: { mode: business.tax_mode, rate: business.tax_rate, jurisdiction: business.tax_jurisdiction, exempt: !!sub.tax_exempt, exemptRef: sub.tax_exempt_ref },
    subscription: { id: sub.id, anchorDay: sub.anchor_day, startDate: sub.start_date, trialEnd: sub.trial_end, endDate: sub.end_date, billFrom: sub.cutover_start },
    period, items, prices, amendments, events,
  }
}

export async function rated(env: Bindings, business: Business, subscriptionId: string, period: { start: string; end: string }, replaceItems?: ItemIn[]) {
  const input = await ratingInputs(env, business, subscriptionId, period, replaceItems)
  return { input, rating: rate(input), fingerprint: await fingerprint(input) }
}
