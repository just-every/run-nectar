// Source totals are assertions about a customer's meter on a billing-zone day.
// An acknowledgement binds the exact source and ingested totals, not a date alone.
import type { Bindings } from '../auth.server'
import { actorLabel, companyAgentDetail, requireCapability, requireMember, type Actor } from './actor'
import { requireBusiness } from './business'
import { all, commit, fingerprint, guard, insist, newId, one, stmt, type Row } from './core'
import { canonicalDecimal, decimalText, micros } from './decimal'
import { addDays, localDate, requireDate, zonedStart } from './dates'
import type { Input } from './input'

async function compared(env: Bindings, row: Row, zone: string) {
  const events = await all(env, "SELECT event_id, quantity FROM nc_usage_events WHERE customer_id = ? AND meter_id = ? AND status = 'active' AND occurred_at >= ? AND occurred_at < ? ORDER BY event_id", row.customer_id, row.meter_id, zonedStart(row.day, zone), zonedStart(addDays(row.day, 1), zone))
  const quantity = events.reduce((sum, event) => sum + micros(event.quantity, 'quantity'), 0n)
  const basis = await fingerprint({ revision: row.revision, events })
  return { id: row.id, customer: row.customer_id, meter: row.meter_code, customerName: row.customer_name, customerExternalId: row.external_id, day: row.day,
    expectedCount: row.expected_count, actualCount: events.length, countDifference: events.length - row.expected_count,
    expectedQuantity: row.expected_quantity, actualQuantity: decimalText(quantity), quantityDifference: decimalText(quantity - micros(row.expected_quantity)),
    mismatch: events.length !== row.expected_count || quantity !== micros(row.expected_quantity),
    acknowledged: row.acknowledged_basis === basis, acknowledgedBy: row.acknowledged_basis === basis ? row.acknowledged_by : null,
    reason: row.acknowledged_basis === basis ? row.acknowledged_reason : null, basis }
}

export async function controlTotals(env: Bindings, actor: Actor, month: string) {
  requireCapability(actor, 'read')
  const business = await requireBusiness(env)
  const rows = await all(env, 'SELECT c.*, m.code AS meter_code, cu.name AS customer_name, cu.external_id FROM nc_usage_controls c JOIN nc_meters m ON m.id = c.meter_id JOIN nc_customers cu ON cu.id = c.customer_id WHERE substr(c.day, 1, 7) = ? ORDER BY c.day, m.code', month)
  return await Promise.all(rows.map(row => compared(env, row, business.timezone)))
}

export async function reconciliationFor(env: Bindings, subscription: string, period: { start: string; end: string }, zone: string, events: { meterId: string; occurredAt: number }[] = [], selectedMeters?: Set<string>) {
  const lateDays = new Set(events.filter(event => localDate(event.occurredAt, zone) < period.start).map(event => `${event.meterId}|${localDate(event.occurredAt, zone)}`))
  const rows = await all(env, `SELECT DISTINCT c.*, m.code AS meter_code FROM nc_usage_controls c JOIN nc_meters m ON m.id = c.meter_id JOIN nc_subscriptions s ON s.customer_id = c.customer_id
    JOIN nc_items i ON i.subscription_id = s.id JOIN nc_prices p ON p.id = i.price_id JOIN nc_meters pm ON pm.id=p.meter_id AND COALESCE(pm.source_meter_id,p.meter_id) = c.meter_id
    WHERE s.id = ? AND c.day < ? AND c.day >= s.start_date AND (s.end_date IS NULL OR c.day < s.end_date)
    AND i.effective_from <= c.day AND (i.effective_to IS NULL OR c.day < i.effective_to) ORDER BY c.day, m.code`, subscription, period.end)
  return await Promise.all(rows.filter(row => (!selectedMeters || selectedMeters.has(row.meter_id)) && (row.day >= period.start || lateDays.has(`${row.meter_id}|${row.day}`))).map(row => compared(env, row, zone)))
}

export async function recordControl(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'usage')
  const customerKey = input.text('customer', { max: 100 }), meterKey = input.text('meter', { max: 100 })
  const customer = await one(env, 'SELECT id FROM nc_customers WHERE id = ? OR external_id = ?', customerKey, customerKey)
  const meter = await one(env, 'SELECT id FROM nc_meters WHERE id = ? OR code = ?', meterKey, meterKey)
  insist(customer, 'customer_not_found', 404); insist(meter, 'meter_not_found', 404)
  const day = requireDate(input.text('day', { max: 10 }), 'day')
  const count = input.integer('expected_count', { max: Number.MAX_SAFE_INTEGER })!
  const quantity = canonicalDecimal(input.text('expected_quantity', { max: 24 }), 'expected_quantity')
  const prior = await one(env, 'SELECT * FROM nc_usage_controls WHERE customer_id = ? AND meter_id = ? AND day = ?', customer.id, meter.id, day)
  if (prior && prior.expected_count === count && prior.expected_quantity === quantity) return { id: prior.id }
  const id = prior?.id ?? newId(), revision = newId()
  await commit(env, [
    ...(prior ? [guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_usage_controls WHERE id = ? AND revision = ?)', id, prior.revision)] : []),
    prior ? stmt(env, 'UPDATE nc_usage_controls SET expected_count = ?, expected_quantity = ?, revision = ?, acknowledged_basis = NULL, acknowledged_by = NULL, acknowledged_reason = NULL WHERE id = ?', count, quantity, revision, id)
      : stmt(env, 'INSERT INTO nc_usage_controls (id, customer_id, meter_id, day, expected_count, expected_quantity, revision) VALUES (?, ?, ?, ?, ?, ?, ?)', id, customer.id, meter.id, day, count, quantity, revision),
  ], { actor: actorLabel(actor), action: 'usage.control', subject: id, detail: { customer: customer.id, meter: meter.id, day, expectedCount: count, expectedQuantity: quantity, ...companyAgentDetail(actor) } })
  return { id }
}

export async function acknowledgeControl(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const row = await one(env, 'SELECT c.*, m.code AS meter_code FROM nc_usage_controls c JOIN nc_meters m ON m.id = c.meter_id WHERE c.id = ?', input.text('control', { max: 100 }))
  insist(row, 'control_not_found', 404)
  const view = await compared(env, row, (await requireBusiness(env)).timezone)
  insist(view.basis === input.text('basis', { max: 100 }), 'source_changed', 409)
  const reason = input.text('reason', { max: 1000 })
  await commit(env, [guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_usage_controls WHERE id = ? AND revision = ?)', row.id, row.revision),
    stmt(env, 'UPDATE nc_usage_controls SET acknowledged_basis = ?, acknowledged_by = ?, acknowledged_reason = ? WHERE id = ?', view.basis, actorLabel(actor), reason, row.id)],
  { actor: actorLabel(actor), action: 'usage.acknowledge', subject: row.id, detail: { basis: view.basis, reason } })
  return { id: row.id }
}
