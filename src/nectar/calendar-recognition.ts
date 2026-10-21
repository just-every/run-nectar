// Versioned recognition of already-rounded native interval consideration.
import { insist, type Row } from './core'
import { addMonthsClamped, daysBetween, isDate } from './dates'
import { roundHalfAway } from './decimal'
import { addRational, divideRational, multiplyRational, rational } from './metric-plan'
import type { Line } from './rating'
import type { RevenueMonthEntry } from './revenue-usage'

export const CALENDAR_REVENUE_POLICY_VERSION = 'nectar-revenue-2'

/** Each full contractual service month has equal weight; partial months follow
 * their actual days. Calendar-month pieces conserve the once-rounded cents.
 * Older lines without this explicit versioned evidence retain policy-v1. */
export function calendarRecognition(line: Line): RevenueMonthEntry[] | null {
  const calendar = line.evidence.calendar as Row | undefined
  if (!calendar || calendar.version !== 'nectar-rating-9' || calendar.terms?.unit !== 'month') return null
  const anchor = calendar.nominalStart, end = calendar.nominalEnd
  insist(isDate(anchor) && isDate(end) && anchor <= line.periodStart && end >= line.periodEnd, 'calendar_revenue_source_required', 409)
  const pieces: { period: string; from: string; to: string; weight: ReturnType<typeof rational> }[] = []
  for (let index = 0, from = anchor; from < line.periodEnd; index++) {
    const boundary = addMonthsClamped(anchor, index + 1)
    const start = from < line.periodStart ? line.periodStart : from, stop = boundary < line.periodEnd ? boundary : line.periodEnd
    for (let point = start; point < stop;) {
      const monthEnd = addMonthsClamped(`${point.slice(0, 7)}-01`, 1), to = monthEnd < stop ? monthEnd : stop
      pieces.push({ period: point.slice(0, 7), from: point, to, weight: rational(BigInt(daysBetween(point, to)), BigInt(daysBetween(from, boundary))) })
      point = to
    }
    from = boundary
  }
  const weight = pieces.reduce((sum, piece) => addRational(sum, piece.weight), rational(0n)), months = new Map<string, RevenueMonthEntry>()
  let elapsed = rational(0n), previous = 0n
  for (const piece of pieces) {
    elapsed = addRational(elapsed, piece.weight)
    const fraction = multiplyRational(rational(BigInt(line.amountCents)), divideRational(elapsed, weight))
    const cumulative = roundHalfAway(fraction.n, fraction.d), amount = Number(cumulative - previous)
    const entry = months.get(piece.period) ?? { period: piece.period, amountCents: 0, basis: { version: CALENDAR_REVENUE_POLICY_VERSION, method: 'equal-contract-service-months', components: [] } }
    entry.amountCents += amount
    entry.basis.components.push({ from: piece.from, to: piece.to, amountCents: amount, numerator: String(piece.weight.n), denominator: String(piece.weight.d) })
    months.set(piece.period, entry); previous = cumulative
  }
  insist(previous === BigInt(line.amountCents) && pieces.length > 0, 'calendar_revenue_amount_mismatch', 409)
  return [...months.values()]
}
