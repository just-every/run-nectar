// Pure calendar arithmetic. Intervals and invoice service periods are [from, to).
import { insist } from './core'
import { requireDate } from './dates'

export interface LifecycleInterval {
  id: string
  from: string
  to: string | null
  access: 'retain' | 'suspend'
  kind: 'pause' | 'cancellation'
  creditUnused?: boolean
}

function checkInterval(interval: LifecycleInterval): void {
  requireDate(interval.from, 'interval_from')
  if (interval.to !== null) {
    requireDate(interval.to, 'interval_to')
    insist(interval.to >= interval.from, 'invalid_interval_order')
  }
}

/** All intervals covering day, regardless of their access policy. */
export function blockedAt(day: string, intervals: readonly LifecycleInterval[]): LifecycleInterval[] {
  requireDate(day, 'day')
  intervals.forEach(checkInterval)
  return intervals.filter(interval => interval.from <= day && (interval.to === null || day < interval.to))
}

/** Subtract the union of all intervals, without modifying the caller's list. */
export function activeSegments(from: string, to: string, intervals: readonly LifecycleInterval[]): [string, string][] {
  requireDate(from, 'from')
  requireDate(to, 'to')
  insist(from <= to, 'invalid_interval_order')
  intervals.forEach(checkInterval)
  const segments: [string, string][] = []
  let cursor = from
  for (const interval of [...intervals].sort((a, b) => a.from.localeCompare(b.from))) {
    const end = interval.to === null || interval.to > to ? to : interval.to
    if (end <= cursor || interval.from >= to || interval.from === interval.to) continue
    if (interval.from > cursor) segments.push([cursor, interval.from])
    cursor = end
    if (cursor >= to) break
  }
  if (cursor < to) segments.push([cursor, to])
  return segments
}
