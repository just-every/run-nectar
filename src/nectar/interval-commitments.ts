// v9 minimum settlement follows actual saved service windows and component
// custody, rather than assuming an invoice for each calendar month.
import { billingAnchor, billingPeriodContaining, dueBillingWindows, MONTHLY_ARREARS, type BillingWindow } from './billing-calendar'
import { addDays, daysBetween, isDate, localDate, zonedStart } from './dates'
import { canonical, insist } from './core'
import { lineCents, micros, percentOf, roundHalfAway } from './decimal'
import { addRational, compareRational, divideRational, multiplyRational, rational, type MetricPlan } from './metric-plan'
import { aggregateMetric } from './metric-aggregate'
import type { Commitment, CommitmentAllocationInput, PriorInvoice } from './commitment-rating'
import type { Exception, Line, RatingInput } from './rating'

const eligible = new Set(['flat','seat','usage','late_usage','overage','metric_usage','discount','cancellation_credit'])
const usage = new Set(['usage','late_usage','overage','metric_usage'])
const safe = (value: bigint) => { insist(value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER), 'commitment_amount_out_of_range', 409); return Number(value) }

function serviceShare(line: Line, from: string, to: string, sourceLines: Line[]) {
  const evidence = line.evidence, originalDays = daysBetween(line.periodStart, line.periodEnd)
  const cents = (end: string): bigint => {
    const elapsed = BigInt(daysBetween(line.periodStart, end))
    if (line.kind === 'discount') {
      insist(typeof evidence.percent === 'string' && Array.isArray(evidence.parts), 'commitment_service_evidence_required', 409)
      return evidence.parts.reduce((sum: bigint, part: { line: string; cents: number }) => {
        const source = sourceLines.find(source => ['flat','seat'].includes(source.kind) && source.description === part.line && source.periodStart >= line.periodStart && source.periodEnd <= line.periodEnd)
        insist(source, 'commitment_service_evidence_required', 409)
        const stop = end < source.periodEnd ? end : source.periodEnd
        const earned = stop <= source.periodStart ? 0n : serviceShare(source, source.periodStart, stop, sourceLines)
        return sum - percentOf(earned, micros(evidence.percent as string))
      }, 0n)
    }
    insist(typeof evidence.periodDays === 'number' && Number.isSafeInteger(evidence.periodDays) && evidence.periodDays > 0 && evidence.days === originalDays, 'commitment_service_evidence_required', 409)
    if (typeof evidence.roundingNumerator === 'string' && typeof evidence.roundingDenominator === 'string') {
      return roundHalfAway(BigInt(evidence.roundingNumerator) * elapsed, BigInt(evidence.roundingDenominator) * BigInt(originalDays))
    }
    insist(line.unitAmount !== '' && line.quantity !== '', 'commitment_service_evidence_required', 409)
    return lineCents(micros(line.unitAmount), micros(line.quantity), elapsed, BigInt(evidence.periodDays))
  }
  insist(cents(line.periodEnd) === BigInt(line.amountCents), 'commitment_service_amount_mismatch', 409)
  return cents(to) - cents(from)
}

/** Whole saved lines are used unchanged. Partial recurring service conserves
 * its exact cents by cumulative allocation. Partial metered service requires
 * its original events; it never substitutes present prices or service days. */
export function intervalLineContribution(line: Line, from: string, to: string, input?: CommitmentAllocationInput, boundaries: string[] = [], sourceLines: Line[] = []): bigint {
  if (!eligible.has(line.kind) || line.periodStart >= to || line.periodEnd <= from) return 0n
  insist(Number.isSafeInteger(line.amountCents) && isDate(line.periodStart) && isDate(line.periodEnd) && line.periodStart < line.periodEnd, 'commitment_service_evidence_required', 409)
  const start = line.periodStart > from ? line.periodStart : from, end = line.periodEnd < to ? line.periodEnd : to
  if (start === line.periodStart && end === line.periodEnd) return BigInt(line.amountCents)
  if (line.kind === 'cancellation_credit') {
    const earned = line.evidence.earned, gross = line.evidence.gross
    insist(Array.isArray(earned) && Array.isArray(gross), 'commitment_service_evidence_required', 409)
    return (earned as Line[]).reduce<bigint>((sum, entry) => sum + intervalLineContribution(entry, start, end, input, boundaries, earned), 0n)
      - (gross as Line[]).reduce<bigint>((sum, entry) => sum + intervalLineContribution(entry, start, end, input, boundaries, gross), 0n)
  }
  if (!usage.has(line.kind)) return serviceShare(line, start, end, sourceLines)
  insist(input && Array.isArray(line.evidence.eventIds), 'commitment_usage_allocation_required', 409)
  if (line.kind === 'metric_usage') {
    const evidence = line.evidence
    insist(evidence.metricPlan && typeof evidence.sourceMeter === 'string' && Array.isArray(evidence.activeIntervals), 'commitment_usage_allocation_required', 409)
    const points = [...new Set([line.periodStart, line.periodEnd, start, end, ...boundaries.filter(date => date > line.periodStart && date < line.periodEnd)])].sort()
    const events = input.events.filter(event => event.meterId === evidence.sourceMeter).map(event => ({ ...event, properties: event.properties ?? {} }))
    const captured = new Set(events.map(event => event.eventId)), references = [...evidence.eventIds as string[], ...((evidence.contextEventIds as string[] | undefined) ?? [])]
    insist(references.every(id => captured.has(id)), 'commitment_usage_allocation_required', 409)
    const shares = points.slice(0, -1).map((from, index) => {
      const to = points[index + 1], a = zonedStart(from, input.timezone), b = zonedStart(to, input.timezone)
      const active = (evidence.activeIntervals as { from: number; to: number }[]).flatMap(span => Math.max(span.from, a) < Math.min(span.to, b) ? [{ from: Math.max(span.from, a), to: Math.min(span.to, b) }] : [])
      const results = aggregateMetric(evidence.metricPlan as MetricPlan, events, { from: a, to: b, active })
      const result = results.find(result => canonical(result.dimensions) === canonical(evidence.dimensions))
      const weight = result ? rational(BigInt(result.exact.numerator), BigInt(result.exact.denominator)) : rational(0n)
      insist(weight.n >= 0n, 'commitment_usage_allocation_required', 409)
      return { from, to, weight, cents: 0n, remainder: rational(0n) }
    })
    const total = shares.reduce((sum, share) => addRational(sum, share.weight), rational(0n)), absolute = BigInt(Math.abs(line.amountCents))
    if (total.n === 0n) { insist(absolute === 0n, 'commitment_usage_allocation_required', 409); return 0n }
    for (const share of shares) {
      const value = multiplyRational(rational(absolute), divideRational(share.weight, total))
      share.cents = value.n / value.d; share.remainder = rational(value.n % value.d, value.d)
    }
    let remainder = absolute - shares.reduce((sum, share) => sum + share.cents, 0n)
    for (const share of [...shares].sort((a, b) => -compareRational(a.remainder, b.remainder) || a.from.localeCompare(b.from))) if (remainder > 0n) { share.cents++; remainder-- }
    insist(remainder === 0n, 'commitment_usage_allocation_required', 409)
    return shares.filter(share => share.from >= start && share.to <= end).reduce((sum, share) => sum + share.cents, 0n) * (line.amountCents < 0 ? -1n : 1n)
  }
  const ids = new Set(line.evidence.eventIds as string[]), events = input.events.filter(event => ids.has(event.eventId))
  insist(events.length === ids.size, 'commitment_usage_allocation_required', 409)
  const quantity = (until: string) => events.filter(event => localDate(event.occurredAt, input.timezone) < until).reduce((sum, event) => sum + micros(event.quantity), 0n)
  const total = quantity(line.periodEnd)
  const expectedQuantity = line.evidence.rawQuantity ?? line.quantity
  insist(typeof expectedQuantity === 'string' && total === micros(expectedQuantity), 'commitment_usage_allocation_required', 409)
  if (total === 0n) { insist(line.amountCents === 0, 'commitment_usage_allocation_required', 409); return 0n }
  return roundHalfAway(BigInt(line.amountCents) * quantity(end), total) - roundHalfAway(BigInt(line.amountCents) * quantity(start), total)
}

function savedComponent(invoice: PriorInvoice, window: BillingWindow, key: string) {
  if (invoice.billing) return invoice.billing.key === window.key && invoice.billing.components.some(component => component.key === key)
  if (invoice.lines.some(line => { const calendar = line.evidence.calendar as { windowKey?: string; componentKeys?: string[] } | undefined; return calendar?.windowKey === window.key && calendar.componentKeys?.includes(key) })) return true
  // Legacy monthly issued periods predate component identities. Their original
  // once-per-period boundary is authoritative only for that same monthly door.
  return window.terms.unit === 'month' && window.terms.count === 1 && window.terms.timing === 'arrears' && invoice.from === window.period.start && invoice.to === window.period.end
}

export interface IntervalSettlement {
  earnedCents: number
  previouslySettledCents: number
  priorInvoices: { id: string; number: string; earnedCents: number }[]
  exceptions: Exception[]
  components: string[]
}

/** Only the last actual arrears window covering the signed boundary settles.
 * Other due windows can issue first; the settlement blocks until their saved
 * components exist, including zero-value and already-issued annual service. */
export function intervalCommitmentSettlement(input: RatingInput, lines: Line[], window: Commitment, end: string): IntervalSettlement | null {
  const source = input.commitmentCalendar
  const basis = source ? { ...source, subscription: { ...source.subscription, ...input.subscription } } : undefined
  insist(basis && input.billingDueDate, 'commitment_calendar_required', 409)
  const anchor = billingAnchor(basis), bounds = Object.values(basis.prices).map(price => {
    const terms = price.billing ?? MONTHLY_ARREARS
    return { first: billingPeriodContaining(anchor, terms, window.from).start, last: billingPeriodContaining(anchor, terms, addDays(end, -1)).end }
  })
  const from = bounds.map(bound => bound.first).sort()[0] ?? window.from, through = bounds.map(bound => bound.last).sort().at(-1) ?? end
  const windows = dueBillingWindows(basis, from, addDays(through, 1)).filter(candidate => candidate.components.some(component => component.from < end && component.to > window.from))
  const closing = windows.filter(candidate => candidate.terms.timing === 'arrears' && candidate.dueDate >= end)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.key.localeCompare(b.key)).at(-1)
  if (!closing || closing.dueDate !== input.billingDueDate || closing.nominalStart !== input.period.start || closing.nominalEnd !== input.period.end) return null
  const selected = new Set(input.items.map(item => item.id))
  if (!closing.components.every(component => selected.has(component.itemId))) return null
  const prior = input.contracts!.invoices, current = new Set(closing.components.map(component => component.key))
  const missing = windows.flatMap(candidate => candidate.components.filter(component => !current.has(component.key) && !prior.some(invoice => savedComponent(invoice, candidate, component.key))).map(component => ({ key: component.key, dueDate: candidate.dueDate, from: component.from, to: component.to })))
  const boundaries = input.contracts!.commitments.flatMap(window => [window.from, window.to]).concat(input.subscription.endDate ? [input.subscription.endDate] : [])
  const contributions = prior.map(invoice => ({ id: invoice.id, number: invoice.number,
    earnedCents: safe(invoice.lines.reduce((sum, line) => sum + intervalLineContribution(line, window.from, end, invoice.allocationInput, boundaries, invoice.lines), 0n)) }))
    .filter(invoice => invoice.earnedCents !== 0 || prior.find(source => source.id === invoice.id)!.lines.some(line => line.kind === 'commitment_trueup' && line.evidence.contract === window.contract && line.periodStart === window.from))
  const amount = contributions.reduce((sum, invoice) => sum + BigInt(invoice.earnedCents), 0n) + lines.reduce((sum, line) => sum + intervalLineContribution(line, window.from, end, input, boundaries, lines), 0n)
  const settled = prior.flatMap(invoice => invoice.lines).filter(line => line.kind === 'commitment_trueup' && line.evidence.contract === window.contract && line.periodStart === window.from).reduce((sum, line) => sum + BigInt(line.amountCents), 0n)
  return { earnedCents: Math.max(0, safe(amount)), previouslySettledCents: safe(settled), priorInvoices: contributions,
    components: windows.flatMap(candidate => candidate.components.map(component => component.key)),
    exceptions: missing.length ? [{ code: 'commitment_prior_periods', message: 'Issue each actual earlier service component before settling its signed minimum.', detail: { contract: window.contract, missing } }] : [] }
}
