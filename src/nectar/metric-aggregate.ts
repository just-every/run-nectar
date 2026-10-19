// Exact event aggregation. The six-place quantity is presentation only; prices
// multiply the saved rational and round once at the invoice line.
import { insist } from './core'
import { roundHalfAway, SCALE } from './decimal'
import {
  addRational, compareRational, divideRational, matches, multiplyRational,
  numericValue, propertyIdentity, propertyValue, rational,
} from './metric-plan'
import type { MetricEvent, MetricPlan, Rational } from './metric-plan'

type Scalar = MetricEvent['properties'][string]
export interface MetricExact { numerator: string; denominator: string }
export interface MetricAggregate {
  dimensions: Record<string, Scalar>
  quantity: string
  exact: MetricExact
  eventIds: string[]
  contextEventIds: string[]
}
export interface MetricPeriod {
  from: number
  to: number
  active?: { from: number; to: number }[]
}
interface Interval { from: number; to: number }
interface Bucket {
  dimensions: Record<string, Scalar>
  value: Rational
  observed: boolean
  unique: Set<string>
  events: Set<string>
  context: Set<string>
}

/** Presentation rounding, half away from zero to six fractional places. */
export function displayQuantity(value: Rational): string {
  const rounded = roundHalfAway(value.n * SCALE, value.d)
  const absolute = rounded < 0n ? -rounded : rounded
  const fraction = (absolute % SCALE).toString().padStart(6, '0').replace(/0+$/, '')
  return `${rounded < 0n ? '-' : ''}${absolute / SCALE}${fraction ? `.${fraction}` : ''}`
}

/** Exact quantity × millionths of a dollar, optionally prorated, to cents. */
export function metricLineCents(unitMicros: bigint, quantity: Rational | MetricExact, num = 1n, den = 1n): bigint {
  const value = 'n' in quantity ? quantity : rational(BigInt(quantity.numerator), BigInt(quantity.denominator))
  insist(den > 0n, 'invalid_denominator')
  return roundHalfAway(unitMicros * value.n * num * 100n, SCALE * value.d * den)
}

const compareEvents = (a: MetricEvent, b: MetricEvent) => a.occurredAt - b.occurredAt || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0)

// Merge overlapping active intervals: a timestamp/duration is never billed twice.
function activeIntervals(period: MetricPeriod): Interval[] {
  insist(Number.isSafeInteger(period.from) && Number.isSafeInteger(period.to) && period.to > period.from, 'invalid_metric_period')
  const intervals = (period.active ?? [period]).map(interval => {
    insist(Number.isSafeInteger(interval.from) && Number.isSafeInteger(interval.to) && interval.to >= interval.from, 'invalid_metric_active_period')
    return { from: Math.max(period.from, interval.from), to: Math.min(period.to, interval.to) }
  }).filter(interval => interval.to > interval.from).sort((a, b) => a.from - b.from || a.to - b.to)
  const merged: Interval[] = []
  for (const interval of intervals) {
    const previous = merged.at(-1)
    if (previous && interval.from <= previous.to) previous.to = Math.max(previous.to, interval.to)
    else merged.push({ ...interval })
  }
  return merged
}

const isActive = (at: number, intervals: Interval[]) => intervals.some(interval => at >= interval.from && at < interval.to)
const duration = (from: number, to: number, intervals: Interval[]): bigint => intervals.reduce((total, interval) => {
  const start = Math.max(from, interval.from), end = Math.min(to, interval.to)
  return total + (end > start ? BigInt(end) - BigInt(start) : 0n)
}, 0n)

/**
 * Events are raw history, not prefiltered snapshots. Missing grouping properties
 * share the null group. Unique counts exclude missing/null and distinguish types.
 * A nonmatching time-weighted snapshot resets that entity to zero, preventing a
 * formerly matching state from leaking past a property/filter change.
 */
export function aggregateMetric(plan: MetricPlan, events: MetricEvent[], period: MetricPeriod): MetricAggregate[] {
  const intervals = activeIntervals(period)
  const ordered = [...events].sort(compareEvents)
  const buckets = new Map<string, Bucket>()
  const bucketFor = (event?: MetricEvent): Bucket => {
    const dimensions = Object.fromEntries(plan.groupBy.map(name => [name, event ? propertyValue(event, name) ?? null : null])) as Record<string, Scalar>
    const key = JSON.stringify(plan.groupBy.map(name => propertyIdentity(dimensions[name])))
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { dimensions, value: rational(0n), observed: false, unique: new Set(), events: new Set(), context: new Set() }
      buckets.set(key, bucket)
    }
    return bucket
  }
  if (!plan.groupBy.length) bucketFor()

  if (plan.aggregation === 'time_weighted') {
    timeWeighted(plan, ordered, period, intervals, bucketFor)
  } else {
    for (const event of ordered) {
      if (!isActive(event.occurredAt, intervals) || !matches(plan.where, event)) continue
      const bucket = bucketFor(event)
      bucket.events.add(event.eventId)
      if (plan.aggregation === 'count') bucket.value = addRational(bucket.value, rational(1n))
      else if (plan.aggregation === 'unique') {
        insist(!!plan.uniqueProperty, 'invalid_metric_unique_property')
        const value = propertyValue(event, plan.uniqueProperty)
        if (value !== null && value !== undefined) bucket.unique.add(propertyIdentity(value))
        bucket.value = rational(BigInt(bucket.unique.size))
      } else {
        const value = numericValue(plan.value, event)
        if (plan.aggregation === 'sum') bucket.value = addRational(bucket.value, value)
        else if (plan.aggregation === 'latest' || !bucket.observed || compareRational(value, bucket.value) > 0) bucket.value = value
      }
      bucket.observed = true
    }
  }

  const eventOrder = new Map(ordered.map((event, index) => [event.eventId, index]))
  const ids = (values: Set<string>) => [...values].sort((a, b) => eventOrder.get(a)! - eventOrder.get(b)!)
  return [...buckets].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, bucket]) => ({
    dimensions: bucket.dimensions, quantity: displayQuantity(bucket.value),
    exact: { numerator: bucket.value.n.toString(), denominator: bucket.value.d.toString() },
    eventIds: ids(bucket.events), contextEventIds: ids(bucket.context),
  }))
}

function timeWeighted(plan: MetricPlan, events: MetricEvent[], period: MetricPeriod, intervals: Interval[], bucketFor: (event?: MetricEvent) => Bucket) {
  const entities = new Map<string, MetricEvent[]>()
  for (const event of events) {
    if (event.occurredAt >= period.to) continue
    const entity = plan.entityProperty ? propertyIdentity(propertyValue(event, plan.entityProperty) ?? null) : ''
    const history = entities.get(entity)
    if (history) {
      // Only the final preperiod state is relevant; retain all in-period changes.
      if (event.occurredAt < period.from) history[0] = event
      else history.push(event)
    } else entities.set(entity, [event])
  }
  // Month means the actual elapsed period, including daylight-saving changes.
  const unit = plan.timeUnit === 'month' ? BigInt(period.to) - BigInt(period.from) : 3_600_000n
  for (const history of entities.values()) for (let index = 0; index < history.length; index++) {
    const event = history[index]
    if (!matches(plan.where, event)) continue
    const from = Math.max(period.from, event.occurredAt)
    const to = history[index + 1]?.occurredAt ?? period.to
    const elapsed = duration(from, to, intervals)
    const newlyOccurred = event.occurredAt >= period.from
    if (elapsed === 0n && (!newlyOccurred || !isActive(event.occurredAt, intervals))) continue
    const bucket = bucketFor(event)
    if (newlyOccurred) bucket.events.add(event.eventId)
    else bucket.context.add(event.eventId)
    if (elapsed > 0n) bucket.value = addRational(bucket.value, multiplyRational(numericValue(plan.value, event), divideRational(rational(elapsed), rational(unit))))
  }
}
