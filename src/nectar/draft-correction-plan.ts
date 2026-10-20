// Read-only engine simulations for existing draft-correction proposal kinds.
import type { Bindings } from '../auth.server'
import type { Business } from './business'
import { all, fingerprint, insist, one, type Row } from './core'
import { canonicalDecimal, micros } from './decimal'
import { isDate, localDate, periodContaining, periodStartingIn, zonedStart } from './dates'
import { ratingInputs } from './inputs'
import { requirePrice } from './catalog'
import { rate, type AmendmentIn, type RatingInput } from './rating'
import { screen, type RawEvent } from './usage'
import { startsInIssuedPeriod } from './subscriptions'
import { recognitionForRating, REVENUE_POLICY_VERSION, type RevenueSchedule } from './revenue-allocation'

export interface RevenuePreview {
  policyVersion: string
  schedules: RevenueSchedule[]
  periods: { period: string; amountCents: number }[]
  fingerprint: string
}
export interface RevenuePeriodDelta { period: string; beforeCents: number; afterCents: number; deltaCents: number }

/** These are the same source schedules later persisted on invoice issue; a
 * draft correction never changes an issued schedule or books a preview. */
export async function revenuePreview(schedules: RevenueSchedule[]): Promise<RevenuePreview> {
  const totals = new Map<string, bigint>()
  for (const schedule of schedules) {
    insist(schedule.entries.reduce((sum, entry) => sum + BigInt(entry.amountCents), 0n) === BigInt(schedule.amountCents), 'correction_revenue_does_not_reconcile', 409)
    for (const entry of schedule.entries) totals.set(entry.period, (totals.get(entry.period) ?? 0n) + BigInt(entry.amountCents))
  }
  const periods = [...totals].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([period, value]) => {
    const amountCents = Number(value)
    insist(Number.isSafeInteger(amountCents), 'correction_revenue_amount_out_of_range', 409)
    return { period, amountCents }
  })
  const basis = { policyVersion: REVENUE_POLICY_VERSION, schedules, periods }
  return { ...basis, fingerprint: await fingerprint(basis) }
}

export function revenuePeriodDeltas(before: RevenuePreview, after: RevenuePreview): RevenuePeriodDelta[] {
  insist(before.policyVersion === REVENUE_POLICY_VERSION && after.policyVersion === REVENUE_POLICY_VERSION, 'correction_revenue_policy_changed', 409)
  const months = [...new Set([...before.periods, ...after.periods].map(row => row.period))].sort()
  return months.map(period => {
    const beforeCents = before.periods.find(row => row.period === period)?.amountCents ?? 0
    const afterCents = after.periods.find(row => row.period === period)?.amountCents ?? 0
    const deltaCents = afterCents - beforeCents
    insist([beforeCents, afterCents, deltaCents].every(Number.isSafeInteger), 'correction_revenue_amount_out_of_range', 409)
    return { period, beforeCents, afterCents, deltaCents }
  })
}

const total = async (input: RatingInput) => {
  const r = rate(input), revenue = await revenuePreview(recognitionForRating(input, r))
  return { fingerprint: await fingerprint(input), subtotalCents: r.subtotalCents, taxCents: r.taxCents, totalCents: r.totalCents,
    lines: r.lines.map(line => ({ description: line.description, amountCents: line.amountCents })), revenue }
}

export async function amendmentPlan(env: Bindings, business: Business, payload: Row) {
  const sub = await one(env, 'SELECT * FROM nc_subscriptions WHERE id = ?', String(payload.subscription ?? ''))
  insist(sub, 'subscription_not_found', 404)
  const kind = String(payload.kind ?? '')
  insist(['discount_percent', 'fixed_credit', 'price_override'].includes(kind), 'invalid_amendment_kind')
  const value = canonicalDecimal(String(payload.value ?? ''), 'amendment_value')
  if (kind === 'discount_percent') insist(micros(value) > 0n && micros(value) <= 100_000_000n, 'invalid_amendment_value')
  insist(micros(value) > 0n, 'invalid_amendment_value')
  insist(isDate(payload.effective_from), 'effective_from_required')
  insist(!payload.effective_to || (isDate(payload.effective_to) && payload.effective_to > payload.effective_from), 'invalid_effective_to')
  const priceId = kind === 'price_override' ? String(payload.price ?? '') : null
  if (priceId) insist((await requirePrice(env, priceId)).pricing_model === 'simple', 'override_price_model')
  if (priceId) insist(await one(env, 'SELECT 1 FROM nc_items WHERE subscription_id = ? AND price_id = ?', sub.id, priceId), 'override_price_not_on_subscription')
  insist(!await startsInIssuedPeriod(env, sub.id, payload.effective_from), 'period_already_invoiced', 409)
  const amendment: AmendmentIn = { id: 'proposed', kind: kind as AmendmentIn['kind'], value, priceId, from: payload.effective_from, to: payload.effective_to || null, note: String(payload.note ?? '').slice(0, 200) }
  const impact = []
  const first = periodContaining(sub.anchor_day, amendment.from)
  for (const period of [first, periodContaining(sub.anchor_day, first.end)]) {
    const inputs = await ratingInputs(env, business, sub.id, period)
    const [before, after] = await Promise.all([total(inputs), total({ ...inputs, amendments: [...inputs.amendments, amendment] })])
    impact.push({ period, before, after, revenueDeltas: revenuePeriodDeltas(before.revenue, after.revenue) })
  }
  return { normalized: { ...payload, subscription: sub.id, kind, value, price: priceId, effective_to: payload.effective_to || null }, impact, basis: { subscription: [sub.id, sub.revision], revenuePolicy: REVENUE_POLICY_VERSION } }
}

/**
 * A usage correction voids recorded events and adds new ones. Additions pass the
 * same checks as any usage import, and every one must be accepted. The effect is
 * each affected subscription's period rated before and after the correction:
 * the draft run's period, or the period of the latest corrected event.
 */
export async function correctionPlan(env: Bindings, business: Business, payload: Row) {
  const voids = Array.isArray(payload.void) ? payload.void : [], adds: RawEvent[] = Array.isArray(payload.add) ? payload.add : []
  insist(voids.length + adds.length > 0 && voids.length + adds.length <= 500, 'correction_required')
  const basis: Record<string, unknown> = {}, rows: Row[] = [], touched: { customerId: string; meterId: string; occurredAt: number }[] = []
  for (const entry of voids) {
    const event = await one(env, 'SELECT event_id, customer_id, meter_id, quantity, occurred_at, occurred_text, status, invoice_id FROM nc_usage_events WHERE event_id = ?', String(entry?.event_id ?? ''))
    insist(event, 'event_not_found', 404, { event: entry?.event_id })
    insist(event.status === 'active' && !event.invoice_id, 'already_billed', 409, { event: event.event_id })
    insist(String(entry.reason ?? '').trim(), 'void_reason_required')
    basis[`event:${event.event_id}`] = [event.status, event.invoice_id]
    rows.push({ action: 'void', event: event.event_id, quantity: event.quantity, occurredAt: event.occurred_text, reason: String(entry.reason).slice(0, 300) })
    touched.push({ customerId: event.customer_id, meterId: event.meter_id, occurredAt: event.occurred_at })
  }
  const screened = adds.length ? await screen(env, adds) : null
  if (screened) {
    insist(screened.counts.accepted === adds.length, 'correction_rows_rejected', 400, screened.report)
    for (const event of screened.accepted) {
      basis[`add:${event.eventId}`] = null
      rows.push({ action: 'add', event: event.eventId, quantity: event.quantity, occurredAt: event.occurredText, reason: '' })
      touched.push(event as typeof touched[number])
    }
  }
  const run = payload.run ? await one(env, "SELECT id, period FROM nc_bill_runs WHERE id = ? AND status = 'draft'", String(payload.run)) : null
  if (payload.run) insist(run, 'bill_run_not_found', 404)
  const voided = new Set(rows.filter(row => row.action === 'void').map(row => row.event))
  const invoices: Row[] = []
  for (const sub of await all(env, `SELECT DISTINCT s.id, s.anchor_day, s.customer_id, c.name AS customer_name FROM nc_subscriptions s JOIN nc_customers c ON c.id = s.customer_id JOIN nc_items i ON i.subscription_id = s.id JOIN nc_prices p ON p.id = i.price_id
    WHERE p.meter_id IS NOT NULL ORDER BY c.name, s.id`)) {
    const mine = touched.filter(event => event.customerId === sub.customer_id)
    if (!mine.length) continue
    const latest = localDate(Math.max(...mine.map(event => event.occurredAt)), business.timezone)
    const period = run ? periodStartingIn(sub.anchor_day, run.period) : periodContaining(sub.anchor_day, latest)
    const inputs = await ratingInputs(env, business, sub.id, period)
    const meters = new Set(Object.values(inputs.prices).flatMap(price => price.metric ? [price.metric.sourceId] : price.meterId ? [price.meterId] : []))
    if (!mine.some(event => meters.has(event.meterId))) continue
    const end = zonedStart(period.end, business.timezone)
    const added = (screened?.accepted ?? []).filter(event => event.customerId === sub.customer_id && meters.has(event.meterId) && event.occurredAt < end)
      .map(event => ({ eventId: event.eventId, meterId: event.meterId, quantity: event.quantity, occurredAt: event.occurredAt, ...(event.properties?{properties:event.properties}:{}) }))
    const [before, after] = await Promise.all([total(inputs), total({ ...inputs, events: [...inputs.events.filter(event => !voided.has(event.eventId)), ...added] })])
    invoices.push({ subscription: sub.id, customer: sub.customer_name, period, before, after, revenueDeltas: revenuePeriodDeltas(before.revenue, after.revenue) })
  }
  return { normalized: { void: voids.map((entry: Row) => ({ event_id: String(entry.event_id), reason: String(entry.reason).slice(0, 300) })), add: adds, run: run?.id ?? null, period: run?.period ?? null }, impact: { rows, invoices }, basis: { ...basis, revenuePolicy: REVENUE_POLICY_VERSION } }
}

