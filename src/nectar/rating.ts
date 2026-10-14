// Flow 7: deterministic rating. A pure function from one subscription's
// recorded inputs for one period to invoice lines. Same inputs, same lines:
// no clock, no database, no floating point. Rules (RATING_VERSION):
// - fixed and per-seat charges are billed for the days of the period the item
//   is in effect, outside any trial: unit × quantity × days / period days;
// - per-unit usage sums the exact event quantities per price, then multiplies;
// - each line rounds once to cents, half away from zero;
// - a contract discount applies to the fixed and seat lines it covers, rounded
//   per covered line; a one-time credit applies in the period of its start;
// - usage that occurred in an earlier period and was not yet billed is billed
//   as late usage at the price in effect when it occurred;
// - tax is the declared flat rate on the taxable total, rounded once.
import { addDays, daysBetween, formatDate, localDate, periodContaining } from './dates'
import { decimalText, lineCents, micros, percentOf, quantityText } from './decimal'

export const RATING_VERSION = 'nectar-rating-1'

export interface PriceIn { id: string; kind: 'flat' | 'seat' | 'unit'; unitAmount: string; meterId: string | null; taxable: boolean; label: string; unitLabel: string }
export interface ItemIn { id: string; priceId: string; quantity: number; from: string; to: string | null }
export interface AmendmentIn { id: string; kind: 'discount_percent' | 'fixed_credit' | 'price_override'; value: string; priceId: string | null; from: string; to: string | null; note: string }
export interface EventIn { eventId: string; meterId: string; quantity: string; occurredAt: number }
export interface RatingInput {
  version: string
  timezone: string
  tax: { mode: 'undeclared' | 'no_tax' | 'flat_rate'; rate: string; jurisdiction: string; exempt: boolean; exemptRef: string }
  subscription: { id: string; anchorDay: number; startDate: string; trialEnd: string | null; endDate: string | null; billFrom: string | null }
  period: { start: string; end: string }
  items: ItemIn[]
  prices: Record<string, PriceIn>
  amendments: AmendmentIn[]
  events: EventIn[]
}

export interface Line { kind: string; description: string; quantity: string; unitAmount: string; amountCents: number; taxable: boolean; priceId: string | null; meterId: string | null; periodStart: string; periodEnd: string; evidence: Record<string, unknown> }
export interface Exception { code: string; message: string; detail?: unknown }
export interface Rating { lines: Line[]; subtotalCents: number; taxCents: number; totalCents: number; exceptions: Exception[]; tax: Record<string, unknown>; consumedEvents: string[] }

const max = (a: string, b: string) => (a > b ? a : b)
const min = (a: string, b: string) => (a < b ? a : b)
const FAR = '9999-12-31'

/** Splits [from, to) at every boundary that falls strictly inside it. */
function split(from: string, to: string, boundaries: (string | null)[]): [string, string][] {
  const cuts = [...new Set(boundaries.filter((b): b is string => !!b && b > from && b < to))].sort()
  const points = [from, ...cuts, to]
  return points.slice(0, -1).map((start, index) => [start, points[index + 1]])
}

const covers = (a: AmendmentIn, from: string, to: string) => a.from <= from && (a.to ?? FAR) >= to
const unitFor = (input: RatingInput, price: PriceIn, from: string, to: string) => {
  const override = input.amendments.find(a => a.kind === 'price_override' && a.priceId === price.id && covers(a, from, to))
  return { unit: override ? override.value : price.unitAmount, override }
}

export function rate(input: RatingInput): Rating {
  const { period, subscription: sub } = input
  const periodDays = BigInt(daysBetween(period.start, period.end))
  const lines: Line[] = [], exceptions: Exception[] = [], consumed: string[] = []
  const activeFrom = max(max(period.start, sub.startDate), sub.billFrom ?? period.start)
  const activeTo = min(period.end, sub.endDate ?? FAR)
  const billFrom = sub.trialEnd ? max(activeFrom, sub.trialEnd) : activeFrom
  const trialDays = sub.trialEnd && sub.trialEnd > activeFrom ? daysBetween(activeFrom, min(sub.trialEnd, activeTo)) : 0
  const label = (price: PriceIn) => price.label
  const boundaries = input.amendments.flatMap(a => [a.from, a.to])

  // Fixed and per-seat charges, prorated by days in effect.
  const recurring: { line: Line; from: string; to: string }[] = []
  for (const item of [...input.items].sort((a, b) => a.from.localeCompare(b.from) || a.id.localeCompare(b.id))) {
    const price = input.prices[item.priceId]
    if (!price || price.kind === 'unit') continue
    const from = max(item.from, billFrom), to = min(item.to ?? FAR, activeTo)
    if (from >= to) continue
    for (const [start, end] of split(from, to, boundaries)) {
      const days = BigInt(daysBetween(start, end))
      const { unit, override } = unitFor(input, price, start, end)
      const quantity = BigInt(item.quantity) * 1_000_000n
      const amount = lineCents(micros(unit), quantity, days, periodDays)
      const prorated = days !== periodDays
      const line: Line = {
        kind: price.kind, quantity: String(item.quantity), unitAmount: unit, amountCents: Number(amount), taxable: price.taxable, priceId: price.id, meterId: null, periodStart: start, periodEnd: end,
        description: `${label(price)}${price.kind === 'seat' ? ` × ${item.quantity} seat${item.quantity === 1 ? '' : 's'}` : ''}${prorated ? ` (${days} of ${periodDays} days)` : ''}${override ? ' at contract price' : ''}`,
        evidence: { rule: prorated ? 'unit × quantity × days ÷ period days, rounded half away from zero' : 'unit × quantity', item: item.id, days: Number(days), periodDays: Number(periodDays), unit, quantity: item.quantity, override: override?.id ?? null },
      }
      lines.push(line)
      recurring.push({ line, from: start, to: end })
    }
  }

  // Contract discounts on the fixed and seat lines they cover.
  for (const amendment of input.amendments.filter(a => a.kind === 'discount_percent')) {
    const covered = recurring.filter(entry => covers(amendment, entry.from, entry.to))
    if (!covered.length) continue
    const parts = covered.map(entry => ({ line: entry.line.description, cents: -Number(percentOf(BigInt(entry.line.amountCents), micros(amendment.value))), taxable: entry.line.taxable }))
    for (const taxable of [true, false]) {
      const group = parts.filter(part => part.taxable === taxable)
      if (!group.length) continue
      lines.push({ kind: 'discount', description: `Contract discount ${amendment.value}%${amendment.note ? ` (${amendment.note})` : ''}`, quantity: '1', unitAmount: '', amountCents: group.reduce((sum, part) => sum + part.cents, 0), taxable, priceId: null, meterId: null, periodStart: period.start, periodEnd: period.end, evidence: { rule: 'percent of each covered line, rounded half away from zero per line', amendment: amendment.id, percent: amendment.value, parts: group } })
    }
  }

  // One-time contract credits, in the period where they start.
  for (const amendment of input.amendments.filter(a => a.kind === 'fixed_credit' && a.from >= period.start && a.from < period.end)) {
    const amount = Number(lineCents(micros(amendment.value), 1_000_000n))
    lines.push({ kind: 'credit', description: `Contract credit${amendment.note ? ` (${amendment.note})` : ''}`, quantity: '1', unitAmount: amendment.value, amountCents: -amount, taxable: true, priceId: null, meterId: null, periodStart: period.start, periodEnd: period.end, evidence: { rule: 'one-time credit in the period it starts', amendment: amendment.id } })
  }

  // Usage: group by (original period, price in effect, override), sum exactly, then rate.
  const groups = new Map<string, { late: boolean; start: string; end: string; price: PriceIn; unit: string; override: string | null; trial: boolean; events: EventIn[] }>()
  const unrated: EventIn[] = []
  for (const event of [...input.events].sort((a, b) => a.occurredAt - b.occurredAt || a.eventId.localeCompare(b.eventId))) {
    const date = localDate(event.occurredAt, input.timezone)
    const item = input.items.find(candidate => input.prices[candidate.priceId]?.meterId === event.meterId && candidate.from <= date && (candidate.to ?? FAR) > date)
    const startOk = date >= max(sub.startDate, sub.billFrom ?? sub.startDate) && date < (sub.endDate ?? FAR)
    if (!item || !startOk || date >= period.end) { if (date < period.end) unrated.push(event); continue }
    const price = input.prices[item.priceId]
    const late = date < period.start
    const window = late ? periodContaining(sub.anchorDay, date) : period
    const trial = !!sub.trialEnd && date < sub.trialEnd
    const { unit, override } = unitFor(input, price, date, addDays(date, 1))
    const key = [window.start, price.id, unit, trial].join('|')
    const group = groups.get(key) ?? { late, start: window.start, end: window.end, price, unit, override: override?.id ?? null, trial, events: [] }
    group.events.push(event)
    groups.set(key, group)
  }
  for (const group of [...groups.values()].sort((a, b) => a.start.localeCompare(b.start) || a.price.id.localeCompare(b.price.id))) {
    const total = group.events.reduce((sum, event) => sum + micros(event.quantity, 'quantity'), 0n)
    const amount = group.trial ? 0n : lineCents(micros(group.unit), total)
    consumed.push(...group.events.map(event => event.eventId))
    lines.push({
      kind: group.trial ? 'trial_usage' : group.late ? 'late_usage' : 'usage',
      description: `${group.late ? `Late usage from the period starting ${formatDate(group.start)}: ` : ''}${group.price.label} — ${quantityText(decimalText(total))} ${group.price.unitLabel}${group.trial ? ' during trial (not charged)' : ''}`,
      quantity: decimalText(total), unitAmount: group.unit, amountCents: Number(amount), taxable: group.price.taxable, priceId: group.price.id, meterId: group.price.meterId, periodStart: group.start, periodEnd: group.end,
      evidence: { rule: group.trial ? 'usage during a trial is recorded and not charged' : 'sum of event quantities × unit, rounded half away from zero once', events: group.events.length, eventIds: group.events.map(event => event.eventId), first: new Date(group.events[0].occurredAt).toISOString(), last: new Date(group.events[group.events.length - 1].occurredAt).toISOString(), override: group.override, late: group.late },
    })
  }
  if (unrated.length) exceptions.push({ code: 'unrated_usage', message: `${unrated.length} usage event(s) for this customer have no metered price in effect when they occurred; they are not billed.`, detail: unrated.map(event => event.eventId) })
  if (trialDays > 0) lines.push({ kind: 'trial', description: `Trial: ${trialDays} day(s) not charged`, quantity: String(trialDays), unitAmount: '', amountCents: 0, taxable: false, priceId: null, meterId: null, periodStart: activeFrom, periodEnd: min(sub.trialEnd!, activeTo), evidence: { rule: 'fixed and seat charges start when the trial ends', trialEnd: sub.trialEnd } })

  const subtotal = lines.reduce((sum, line) => sum + line.amountCents, 0)
  const taxableBase = lines.filter(line => line.taxable).reduce((sum, line) => sum + line.amountCents, 0)
  let taxCents = 0
  const tax: Record<string, unknown> = { mode: input.tax.mode, jurisdiction: input.tax.jurisdiction, taxableBaseCents: taxableBase }
  if (input.tax.mode === 'undeclared') exceptions.push({ code: 'tax_undeclared', message: 'The business has not declared its tax policy; this invoice cannot be finalised.' })
  else if (input.tax.exempt) Object.assign(tax, { exempt: true, exemptRef: input.tax.exemptRef, rule: 'customer is tax exempt' })
  else if (input.tax.mode === 'flat_rate' && taxableBase > 0) {
    taxCents = Number(percentOf(BigInt(taxableBase), micros(input.tax.rate)))
    Object.assign(tax, { rate: input.tax.rate, rule: 'declared rate × taxable total, rounded half away from zero once' })
  } else Object.assign(tax, { rule: input.tax.mode === 'no_tax' ? 'declared: no sales tax applies' : 'no taxable charges' })
  if (subtotal < 0) exceptions.push({ code: 'negative_total', message: 'Credits exceed the charges for this period; issue a credit note instead of a negative invoice.' })
  return { lines, subtotalCents: subtotal, taxCents, totalCents: subtotal + taxCents, exceptions, tax, consumedEvents: consumed }
}
