// v9 minimum settlement follows actual saved service windows and component
// custody, rather than assuming an invoice for each calendar month.
import { billingAnchor, billingPeriodContaining, dueBillingWindows, MONTHLY_ARREARS, type BillingWindow } from './billing-calendar'
import { addDays, addMonthsClamped, daysBetween, isDate, localDate } from './dates'
import { insist } from './core'
import { micros, roundHalfAway } from './decimal'
import { addRational, divideRational, multiplyRational, rational } from './metric-plan'
import type { Commitment, CommitmentAllocationInput, PriorInvoice } from './commitment-rating'
import type { Exception, Line, RatingInput } from './rating'

const eligible = new Set(['flat','seat','usage','late_usage','overage','metric_usage','discount','cancellation_credit'])
const usage = new Set(['usage','late_usage','overage','metric_usage'])
const safe = (value: bigint) => { insist(value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER), 'commitment_amount_out_of_range', 409); return Number(value) }

function serviceShare(line: Line, from: string, to: string, input?: CommitmentAllocationInput) {
  const supplied = line.evidence.calendar as { terms?: { unit: string }; nominalStart?: string } | undefined
  const inferred = input?.version === 'nectar-rating-9' && Object.values(input.prices ?? {}).some(price => price.billing?.unit === 'month')
  const monthly = supplied ? supplied.terms?.unit === 'month' : inferred
  const anchor = supplied?.nominalStart ?? input?.period.start ?? line.periodStart
  const until = (end: string) => {
    if (!monthly) return rational(BigInt(Math.max(0, daysBetween(line.periodStart, end))))
    insist(isDate(anchor) && anchor <= line.periodStart, 'commitment_service_evidence_required', 409)
    let weight = rational(0n)
    for (let index = 0, start = anchor; start < end; index++) {
      const boundary = addMonthsClamped(anchor, index + 1), begin = start > line.periodStart ? start : line.periodStart, stop = boundary < end ? boundary : end
      if (begin < stop) weight = addRational(weight, rational(BigInt(daysBetween(begin, stop)), BigInt(daysBetween(start, boundary))))
      start = boundary
    }
    return weight
  }
  const total = until(line.periodEnd)
  const cents = (end: string) => { const share = multiplyRational(rational(BigInt(line.amountCents)), divideRational(until(end), total)); return roundHalfAway(share.n, share.d) }
  return cents(to) - cents(from)
}

/** Whole saved lines are used unchanged. Partial recurring service conserves
 * its exact cents by cumulative allocation. Partial metered service requires
 * its original events; it never substitutes present prices or service days. */
export function intervalLineContribution(line: Line, from: string, to: string, input?: CommitmentAllocationInput): bigint {
  if (!eligible.has(line.kind) || line.periodStart >= to || line.periodEnd <= from) return 0n
  insist(Number.isSafeInteger(line.amountCents) && isDate(line.periodStart) && isDate(line.periodEnd) && line.periodStart < line.periodEnd, 'commitment_service_evidence_required', 409)
  const start = line.periodStart > from ? line.periodStart : from, end = line.periodEnd < to ? line.periodEnd : to
  if (start === line.periodStart && end === line.periodEnd) return BigInt(line.amountCents)
  if (line.kind === 'cancellation_credit') {
    const earned = line.evidence.earned, gross = line.evidence.gross
    insist(Array.isArray(earned) && Array.isArray(gross), 'commitment_service_evidence_required', 409)
    return earned.reduce((sum: bigint, entry: Line) => sum + intervalLineContribution(entry, start, end, input), 0n)
      - gross.reduce((sum: bigint, entry: Line) => sum + intervalLineContribution(entry, start, end, input), 0n)
  }
  if (!usage.has(line.kind)) return serviceShare(line, start, end, input)
  insist(line.kind !== 'metric_usage' && input && Array.isArray(line.evidence.eventIds), 'commitment_usage_allocation_required', 409)
  const ids = new Set(line.evidence.eventIds as string[]), events = input.events.filter(event => ids.has(event.eventId))
  insist(events.length === ids.size, 'commitment_usage_allocation_required', 409)
  const quantity = (until: string) => events.filter(event => localDate(event.occurredAt, input.timezone) < until).reduce((sum, event) => sum + micros(event.quantity), 0n)
  const total = quantity(line.periodEnd)
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
  const basis = input.commitmentCalendar
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
  const contributions = prior.map(invoice => ({ id: invoice.id, number: invoice.number,
    earnedCents: safe(invoice.lines.reduce((sum, line) => sum + intervalLineContribution(line, window.from, end, invoice.allocationInput), 0n)) }))
    .filter(invoice => invoice.earnedCents !== 0 || prior.find(source => source.id === invoice.id)!.lines.some(line => line.kind === 'commitment_trueup' && line.evidence.contract === window.contract && line.periodStart === window.from))
  const amount = contributions.reduce((sum, invoice) => sum + BigInt(invoice.earnedCents), 0n) + lines.reduce((sum, line) => sum + intervalLineContribution(line, window.from, end, input), 0n)
  const settled = prior.flatMap(invoice => invoice.lines).filter(line => line.kind === 'commitment_trueup' && line.evidence.contract === window.contract && line.periodStart === window.from).reduce((sum, line) => sum + BigInt(line.amountCents), 0n)
  return { earnedCents: Math.max(0, safe(amount)), previouslySettledCents: safe(settled), priorInvoices: contributions,
    components: windows.flatMap(candidate => candidate.components.map(component => component.key)),
    exceptions: missing.length ? [{ code: 'commitment_prior_periods', message: 'Issue each actual earlier service component before settling its signed minimum.', detail: { contract: window.contract, missing } }] : [] }
}
