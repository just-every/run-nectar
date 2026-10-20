// Allocation of an already-rated usage line; this never re-prices consumption.
import { canonical, insist, type Row } from './core'
import { addMonths, isDate, localDate, validTimeZone, zonedStart } from './dates'
import { aggregateMetric } from './metric-aggregate'
import { addRational, compareRational, divideRational, multiplyRational, parseRational, rational, type MetricPlan, type Rational } from './metric-plan'
import type { Line, RatingInput } from './rating'

export interface RevenueInput {
  timezone: string
  events?: RatingInput['events']
  period?: RatingInput['period']
}
export interface RevenueMonthEntry { period: string; amountCents: number; basis: Row }
export interface UsageMonthWeight {
  period: string
  id: string
  exact: { numerator: string; denominator: string }
  eventIds: string[]
  contextEventIds: string[]
}
const saved = (value: Rational) => ({ numerator: String(value.n), denominator: String(value.d) })
const exact = (value: unknown): Rational => {
  insist(value && typeof value === 'object', 'revenue_exact_quantity_required', 409)
  const row = value as Row
  insist(typeof row.numerator === 'string' && /^-?\d+$/.test(row.numerator) && typeof row.denominator === 'string' && /^[1-9]\d*$/.test(row.denominator), 'revenue_invalid_exact_quantity', 409)
  return rational(BigInt(row.numerator), BigInt(row.denominator))
}
const ids = (value: unknown): string[] => {
  insist(Array.isArray(value) && value.every(id => typeof id === 'string') && new Set(value).size === value.length, 'revenue_event_evidence_required', 409)
  return value as string[]
}
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

export function revenueMonths(start: string, end: string): string[] {
  insist(isDate(start) && isDate(end) && start < end, 'revenue_invalid_service_period', 409)
  const result: string[] = []
  for (let date = `${start.slice(0, 7)}-01`; date < end; date = addMonths(date, 1)) result.push(date.slice(0, 7))
  return result
}

function eventsFor(input: RevenueInput) {
  insist(validTimeZone(input.timezone) && Array.isArray(input.events), 'revenue_usage_inputs_required', 409)
  const events = input.events
  insist(events.every(event => typeof event.eventId === 'string' && typeof event.meterId === 'string' && Number.isSafeInteger(event.occurredAt) && typeof event.quantity === 'string') && new Set(events.map(e => e.eventId)).size === events.length, 'revenue_invalid_usage_inputs', 409)
  return events
}

function plainWeights(input: RevenueInput, line: Line): UsageMonthWeight[] {
  const events = eventsFor(input), wanted = ids(line.evidence.eventIds)
  const selected = wanted.map(id => {
    const event = events.find(event => event.eventId === id)
    insist(event && event.meterId === line.meterId, 'revenue_usage_source_missing', 409, { eventId: id })
    const day = localDate(event.occurredAt, input.timezone)
    insist(day >= line.periodStart && day < line.periodEnd, 'revenue_usage_source_outside_period', 409)
    return event
  })
  const total = selected.reduce((sum, event) => addRational(sum, parseRational(event.quantity)), rational(0n))
  const expected = line.evidence.rawQuantity === undefined ? line.quantity : line.evidence.rawQuantity
  insist(typeof expected === 'string' && compareRational(total, parseRational(expected)) === 0, 'revenue_usage_quantity_mismatch', 409)
  const months = new Map<string, { quantity: Rational; events: string[] }>()
  for (const event of selected) {
    const quantity = parseRational(event.quantity)
    insist(quantity.n >= 0n, 'revenue_negative_consumption_weight', 409)
    const month = localDate(event.occurredAt, input.timezone).slice(0, 7)
    const bucket = months.get(month) ?? { quantity: rational(0n), events: [] }
    bucket.quantity = addRational(bucket.quantity, quantity); bucket.events.push(event.eventId); months.set(month, bucket)
  }
  return [...months].sort(([a], [b]) => order(a, b)).map(([period, bucket]) => {
    bucket.events.sort(order)
    return { period, id: bucket.events[0], exact: saved(bucket.quantity), eventIds: bucket.events, contextEventIds: [] }
  })
}

function metricWeights(input: RevenueInput, line: Line): UsageMonthWeight[] {
  const all = eventsFor(input), evidence = line.evidence
  insist(input.period && isDate(input.period.start) && isDate(input.period.end), 'revenue_metric_period_required', 409)
  const plan = evidence.metricPlan as MetricPlan
  insist(plan && ['sum', 'count', 'maximum', 'unique', 'latest', 'time_weighted'].includes(plan.aggregation) && Array.isArray(plan.groupBy), 'revenue_metric_plan_required', 409)
  insist(typeof evidence.sourceMeter === 'string' && evidence.dimensions && typeof evidence.dimensions === 'object' && !Array.isArray(evidence.dimensions), 'revenue_metric_source_required', 409)
  const expectedEvents = ids(evidence.eventIds), expectedContext = ids(evidence.contextEventIds)
  const from = zonedStart(line.periodStart, input.timezone), to = zonedStart(line.periodEnd, input.timezone)
  insist(Array.isArray(evidence.activeIntervals) && evidence.activeIntervals.every(interval => {
    const row = interval as Row
    return row && Number.isSafeInteger(row.from) && Number.isSafeInteger(row.to) && row.from <= row.to
  }), 'revenue_metric_active_intervals_required', 409)
  const active = evidence.activeIntervals as { from: number; to: number }[]
  // Nonmatching/reset snapshots must remain present: filtering to eventIds alone
  // would carry time-weighted state through a filter or dimension change.
  const source = all.filter(event => event.meterId === evidence.sourceMeter && !(line.periodStart < input.period!.start && event.invoiceId))
  const events = source.map(event => ({ ...event, properties: event.properties ?? {} }))
  const dimensionKey = canonical(evidence.dimensions)
  const select = (intervals: { from: number; to: number }[]) => aggregateMetric(plan, events, { from, to, active: intervals }).find(result => canonical(result.dimensions) === dimensionKey)
  const whole = select(active), raw = exact(evidence.rawExactQuantity), billed = exact(evidence.exactQuantity)
  insist(raw.n >= 0n && billed.n >= 0n, 'revenue_negative_consumption_weight', 409)
  if (whole) insist(compareRational(exact(whole.exact), raw) === 0 && canonical(whole.eventIds) === canonical(expectedEvents) && canonical(whole.contextEventIds) === canonical(expectedContext), 'revenue_metric_evidence_mismatch', 409)
  else insist(raw.n === 0n && expectedEvents.length === 0 && expectedContext.length === 0, 'revenue_metric_evidence_mismatch', 409)
  const included = evidence.includedExact === undefined ? rational(0n) : exact(evidence.includedExact)
  insist(included.n >= 0n && compareRational(addRational(billed, included), raw) === 0, 'revenue_metric_allowance_mismatch', 409)
  const weights: UsageMonthWeight[] = []
  for (const period of revenueMonths(line.periodStart, line.periodEnd)) {
    const start = Math.max(from, zonedStart(`${period}-01`, input.timezone))
    const end = Math.min(to, zonedStart(addMonths(`${period}-01`, 1), input.timezone))
    const intervals = active.map(interval => ({ from: Math.max(start, interval.from), to: Math.min(end, interval.to) })).filter(interval => interval.from < interval.to)
    // Keep the original measurement window, especially the timeUnit=month
    // denominator, and intersect only active consumption with this month.
    const result = select(intervals)
    if (!result) continue
    const quantity = exact(result.exact)
    insist(quantity.n >= 0n, 'revenue_negative_consumption_weight', 409)
    const references = [...result.eventIds, ...result.contextEventIds].sort(order)
    weights.push({ period, id: references.length ? references[0] : String(evidence.sourceMeter), exact: saved(quantity), eventIds: result.eventIds, contextEventIds: result.contextEventIds })
  }
  return weights
}

/** Month quantities are allocation weights, not independently re-rated bills.
 * Nonadditive metric month weights are explicitly normalized by their sum. */
export function usageMonthWeights(input: RevenueInput, line: Line): UsageMonthWeight[] {
  insist(['usage', 'late_usage', 'overage', 'metric_usage'].includes(line.kind), 'revenue_unsupported_usage_kind', 409)
  revenueMonths(line.periodStart, line.periodEnd)
  return line.kind === 'metric_usage' ? metricWeights(input, line) : plainWeights(input, line)
}

export function usageRevenueEntries(input: RevenueInput, line: Line, lineId: string): RevenueMonthEntry[] {
  insist(Number.isSafeInteger(line.amountCents), 'revenue_invalid_line_amount', 409)
  const weights = usageMonthWeights(input, line)
  const total = weights.reduce((sum, weight) => addRational(sum, exact(weight.exact)), rational(0n))
  if (total.n === 0n) {
    insist(line.amountCents === 0, 'revenue_consumption_weight_required', 409)
    return revenueMonths(line.periodStart, line.periodEnd).map(period => ({ period, amountCents: 0, basis: { method: 'zero-consumption', lineId, weights: weights.filter(weight => weight.period === period) } }))
  }
  const absolute = BigInt(line.amountCents < 0 ? -line.amountCents : line.amountCents)
  const shares = weights.map(weight => {
    const share = multiplyRational(rational(absolute), divideRational(exact(weight.exact), total))
    return { weight, cents: share.n / share.d, remainder: rational(share.n % share.d, share.d) }
  })
  let remaining = absolute - shares.reduce((sum, share) => sum + share.cents, 0n)
  const ranked = [...shares].sort((a, b) => -compareRational(a.remainder, b.remainder) || order(a.weight.period, b.weight.period) || order(a.weight.id, b.weight.id))
  insist(remaining >= 0n && remaining <= BigInt(ranked.length), 'revenue_allocation_invalid', 409)
  for (const share of ranked) if (remaining > 0n) { share.cents++; remaining-- }
  const sign = line.amountCents < 0 ? -1n : 1n
  return shares.sort((a, b) => order(a.weight.period, b.weight.period) || order(a.weight.id, b.weight.id)).map(share => ({
    period: share.weight.period, amountCents: Number(sign * share.cents),
    basis: { method: 'consumption-quantity-largest-remainder', lineId, weight: share.weight, totalWeight: saved(total),
      weightPolicy: line.kind === 'metric_usage' ? 'exact metric quantity in each consumption month, normalized across months' : 'exact raw consumed quantity in each month',
      tieBreak: ['month', 'source-id'] },
  }))
}
