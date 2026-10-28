// Native service calendars. Invoice due dates and contractual service spans
// are separate facts; a component always names one immutable item timeline.
import { insist } from './core'
import { addDays, addMonthsClamped, daysBetween, isDate, periodContaining } from './dates'
import type { Input } from './input'

export const INTERVAL_RATING_VERSION = 'nectar-rating-9'
export interface BillingTerms { unit: 'day' | 'week' | 'month'; count: number; timing: 'advance' | 'arrears' }
export const MONTHLY_ARREARS: BillingTerms = { unit: 'month', count: 1, timing: 'arrears' }
export interface BillingComponent { key: string; itemId: string; from: string; to: string; nominalStart: string; nominalEnd: string }
export interface BillingWindow {
  key: string; terms: BillingTerms; dueDate: string
  period: { start: string; end: string }
  nominalStart: string; nominalEnd: string
  components: BillingComponent[]
  // Only composed invoice envelopes have these fields. Each original service
  // window remains authoritative for its own terms and pricing denominator.
  mixed?: true
  serviceWindows?: BillingWindow[]
}
export interface CalendarBasis {
  subscription: { anchorDay: number; startDate: string; trialEnd: string | null; endDate: string | null; billFrom: string | null; billingAnchorDate?: string | null; contractEndDate?: string | null }
  items: { id: string; priceId: string; from: string; to: string | null }[]
  prices: Record<string, { kind: string; billing?: BillingTerms }>
}
export const nonMonthlyArrears = (terms: BillingTerms) => terms.unit !== 'month' || terms.count !== 1 || terms.timing !== 'arrears'
export function validateBillingTerms(terms: BillingTerms): BillingTerms {
  insist(['day', 'week', 'month'].includes(terms.unit) && Number.isSafeInteger(terms.count) && terms.count >= 1 && terms.count <= 1200 && ['advance', 'arrears'].includes(terms.timing), 'invalid_billing_interval')
  return terms
}
export function readBillingTerms(input: Input, kind?: string): BillingTerms {
  const aliases: Record<string, [BillingTerms['unit'], number]> = { day: ['day', 1], daily: ['day', 1], week: ['week', 1], weekly: ['week', 1], month: ['month', 1], monthly: ['month', 1], quarter: ['month', 3], quarterly: ['month', 3], semiannual: ['month', 6], semiannually: ['month', 6], year: ['month', 12], annual: ['month', 12], annually: ['month', 12] }
  const name = input.text(input.has('interval_unit') ? 'interval_unit' : 'billing_interval', { max: 20, optional: true }) || 'month'
  const value = Object.hasOwn(aliases, name) ? aliases[name] : undefined; insist(value, 'invalid_billing_interval')
  const count = (input.integer('interval_count', { min: 1, max: 1200, optional: true }) ?? 1) * value[1]
  const timing = input.text('billing_timing', { max: 10, optional: true }) || 'arrears'
  insist(timing === 'advance' || timing === 'arrears', 'invalid_billing_timing')
  insist(kind !== 'unit' || timing === 'arrears', 'metered_usage_requires_arrears')
  return validateBillingTerms({ unit: value[0], count, timing })
}
export function storedBillingTerms(row: Record<string, any>): BillingTerms | undefined {
  return row.interval_unit ? validateBillingTerms({ unit: row.interval_unit, count: row.interval_count, timing: row.billing_timing }) : undefined
}
export function billingAnchor(input: CalendarBasis) {
  return input.subscription.billingAnchorDate ?? periodContaining(input.subscription.anchorDay, input.subscription.startDate).start
}
export function intervalBoundary(anchor: string, terms: BillingTerms, index: number) {
  validateBillingTerms(terms)
  const date = terms.unit === 'month' ? addMonthsClamped(anchor, terms.count * index) : addDays(anchor, terms.count * (terms.unit === 'week' ? 7 : 1) * index)
  insist(isDate(date) && date >= '0001-01-01', 'billing_calendar_out_of_range')
  return date
}
export function billingPeriodContaining(anchor: string, terms: BillingTerms, date: string) {
  insist(isDate(anchor) && isDate(date), 'invalid_billing_date')
  let index = terms.unit === 'month'
    ? Math.floor(((Number(date.slice(0, 4)) - Number(anchor.slice(0, 4))) * 12 + Number(date.slice(5, 7)) - Number(anchor.slice(5, 7))) / terms.count)
    : Math.floor(daysBetween(anchor, date) / (terms.count * (terms.unit === 'week' ? 7 : 1)))
  if (intervalBoundary(anchor, terms, index) > date) index--
  return { start: intervalBoundary(anchor, terms, index), end: intervalBoundary(anchor, terms, index + 1), index }
}
export function billingWindowKey(terms: BillingTerms, start: string, end: string, dueDate: string) {
  return `${terms.unit}:${terms.count}:${terms.timing}:${start}:${end}:${dueDate}`
}

/** Enumerate only dates potentially due in [from,to). An annual add-on starts
 * inside its existing anniversary window, so its stub is due on its own start
 * in advance and uses that complete interval as its proration denominator. */
export function dueBillingWindows(input: CalendarBasis, from: string, to: string): BillingWindow[] {
  insist(isDate(from) && isDate(to) && from < to, 'invalid_billing_range')
  const groups = new Map<string, BillingWindow>(), anchor = billingAnchor(input), sub = input.subscription
  for (const item of input.items) {
    const price = input.prices[item.priceId]; insist(price, 'price_not_found')
    const terms = validateBillingTerms(price.billing ?? MONTHLY_ARREARS)
    insist(price.kind !== 'unit' || terms.timing === 'arrears', 'metered_usage_requires_arrears')
    const first = billingPeriodContaining(anchor, terms, from), last = billingPeriodContaining(anchor, terms, to)
    for (let index = first.index - (terms.timing === 'arrears' ? 1 : 0); index <= last.index; index++) {
      const nominalStart = intervalBoundary(anchor, terms, index), nominalEnd = intervalBoundary(anchor, terms, index + 1)
      const start = [nominalStart, item.from, sub.startDate, sub.trialEnd ?? nominalStart, sub.billFrom ?? nominalStart].sort().at(-1)!
      const end = [nominalEnd, item.to ?? nominalEnd, sub.endDate ?? nominalEnd, sub.contractEndDate ?? nominalEnd].sort()[0]
      if (start >= end) continue
      const arrearsEnd = [nominalEnd, sub.endDate ?? nominalEnd, sub.contractEndDate ?? nominalEnd].sort()[0]
      const dueDate = terms.timing === 'advance' ? start : arrearsEnd
      if (dueDate < from || dueDate >= to) continue
      const key = billingWindowKey(terms, nominalStart, nominalEnd, dueDate)
      const component = { key: `${item.id}:${nominalStart}:${nominalEnd}`, itemId: item.id, from: start, to: end, nominalStart, nominalEnd }
      const window = groups.get(key) ?? { key, terms, dueDate, nominalStart, nominalEnd, period: { start, end }, components: [] }
      window.components.push(component)
      if (start < window.period.start) window.period.start = start
      if (end > window.period.end) window.period.end = end
      groups.set(key, window)
    }
  }
  return [...groups.values()].map(window => ({ ...window, components: window.components.sort((a, b) => a.key.localeCompare(b.key)) }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.key.localeCompare(b.key))
}
