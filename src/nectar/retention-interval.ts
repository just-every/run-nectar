import type { Bindings } from '../auth.server'
import { insist, type Row } from './core'
import { addDays, addMonths, periodContaining } from './dates'
import { billingAnchor, billingPeriodContaining, dueBillingWindows, intervalBoundary, MONTHLY_ARREARS, type BillingTerms, type BillingWindow, type CalendarBasis } from './billing-calendar'
import { subscriptionCalendar } from './billing-plan'

export interface RetentionDuration {
  from: string; to: string; priceId: string | null; billing: BillingTerms | null
  windows: BillingWindow[]; calendar: CalendarBasis | null
}

/** A quoted duration counts actual selected-price invoice windows, never the
 * unrelated usage cadence of a mixed subscription. Ambiguous selection refuses. */
export async function retentionDuration(env: Bindings, sub: Row, day: string, count: number, priceId = '', fromDate?: string, reactivating = false): Promise<RetentionDuration> {
  const { basis, enabled } = await subscriptionCalendar(env, sub)
  if (!enabled) {
    const from = fromDate ?? periodContaining(sub.anchor_day, day).start
    return { from, to: addMonths(from, count), priceId: priceId || null, billing: null, windows: [], calendar: null }
  }
  const eligible = Object.entries(basis.prices).filter(([id, price]) => price.kind !== 'unit' && (!priceId || id === priceId) && basis.items.some(item => item.priceId === id && (reactivating || (item.to ?? '9999') > day)))
  insist(eligible.length, 'retention_price_not_on_subscription', 409)
  const cadences = new Set(eligible.map(([, price]) => JSON.stringify(price.billing ?? MONTHLY_ARREARS)))
  insist(cadences.size === 1 && (priceId || eligible.length === 1), 'retention_price_required_for_mixed_intervals', 409)
  const selected = priceId || eligible[0][0], terms = basis.prices[selected].billing ?? MONTHLY_ARREARS
  const calendar: CalendarBasis = { ...basis, items: basis.items.filter(item => item.priceId === selected) }
  if (reactivating) calendar.subscription = { ...calendar.subscription, endDate: null, contractEndDate: null }
  const anchor = billingAnchor(calendar), containing = billingPeriodContaining(anchor, terms, fromDate ?? day)
  const through = intervalBoundary(anchor, terms, containing.index + count + 1)
  const windows = dueBillingWindows(calendar, containing.start, addDays(through, 1))
    .filter(window => window.period.end > (fromDate ?? day))
    .sort((a, b) => a.period.start.localeCompare(b.period.start) || a.key.localeCompare(b.key)).slice(0, count)
  insist(windows.length === count, 'retention_duration_exceeds_service', 409)
  const from = fromDate ?? windows[0].period.start, to = windows.at(-1)!.period.end
  insist(windows[0].period.start === from && windows.every((window, i) => !i || windows[i - 1].period.end === window.period.start), 'retention_periods_must_be_contiguous', 409)
  return { from, to, priceId: selected, billing: terms, windows, calendar }
}
