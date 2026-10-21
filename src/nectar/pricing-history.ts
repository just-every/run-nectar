// Select complete issued evidence using the immutable calendars saved at issue.
import type { Bindings } from '../auth.server'
import type { Business } from './business'
import { all, canonical, insist, one, parseJson, type Row } from './core'
import { addDays, addMonths, addMonthsClamped, periodStartingIn, today } from './dates'
import { billingAnchor, billingPeriodContaining, dueBillingWindows, intervalBoundary, MONTHLY_ARREARS } from './billing-calendar'
import type { PriceIn, RatingInput } from './rating'

const inputOf = (invoice: Row) => parseJson<Row>(invoice.calculation_json, {}).inputs as RatingInput | undefined
export async function pricingHistory(env: Bindings, business: Business, sub: Row, startMonth: string, source: PriceIn) {
  const term = await one(env, "SELECT * FROM nc_renewal_terms WHERE subscription_id=? AND status IN ('active','ended') ORDER BY created_at DESC,id LIMIT 1", sub.id)
  const issued = await all(env, "SELECT * FROM nc_invoices WHERE subscription_id=? AND status='issued' AND invoice_kind='recurring' ORDER BY period_start,id", sub.id)
  const interval = issued.some(invoice => !!inputOf(invoice)?.billing)
  if (!interval) {
    const count = term?.months ?? sub.contract_term_months ?? 6
    const expected = Array.from({ length: count }, (_, index) => periodStartingIn(sub.anchor_day, addMonths(`${startMonth}-01`, index).slice(0, 7)))
    insist(expected[count - 1].end <= today(business.timezone), 'simulation_requires_historical_periods', 409)
    const invoices = issued.filter(invoice => invoice.period_start >= expected[0].start && invoice.period_start < expected[count - 1].end)
    insist(invoices.length === count && expected.every((period, index) => invoices[index].period_start === period.start && invoices[index].period_end === period.end), term || sub.contract_term_months ? 'complete_issued_term_required' : 'six_issued_monthly_invoices_required', 409)
    return { invoices, from: expected[0].start, to: expected[count - 1].end }
  }
  const snapshots = issued.map(invoice => inputOf(invoice)).filter((input): input is RatingInput => !!input?.billing)
  const latest = snapshots.at(-1)!
  const anchor = billingAnchor(latest), terms = source.billing ?? MONTHLY_ARREARS
  let from: string, to: string
  const months = term?.months ?? sub.contract_term_months
  if (months) {
    const origin = term ? addMonthsClamped(term.start_date, -Number(term.cycle ?? 0) * months) : sub.start_date
    from = origin
    while (addMonthsClamped(from, months).slice(0, 7) <= startMonth) from = addMonthsClamped(from, months)
    insist(from.slice(0, 7) === startMonth, 'complete_issued_term_required', 409)
    to = addMonthsClamped(from, months)
  } else {
    const first = billingPeriodContaining(anchor, terms, `${startMonth}-01`)
    const index = first.start.slice(0, 7) === startMonth ? first.index : first.index + 1
    from = intervalBoundary(anchor, terms, index)
    insist(from.slice(0, 7) === startMonth, 'saved_service_interval_required', 409)
    to = intervalBoundary(anchor, terms, index + 6)
  }
  const calendar = { ...latest, subscription: { ...latest.subscription, startDate: [latest.subscription.startDate, from].sort().at(-1)!, endDate: to, contractEndDate: to } }
  const expected = dueBillingWindows(calendar, from, addDays(to, 1)).filter(window => window.period.start >= from && window.period.end <= to)
  insist(expected.length && expected.every(window => window.dueDate <= today(business.timezone)), 'simulation_requires_historical_periods', 409)
  const expectedComponents = new Map(expected.flatMap(window => window.components.map(component => [component.key, { window, component }] as const)))
  const seen = new Set<string>()
  const invoices = issued.filter(invoice => {
    const input = inputOf(invoice)
    return input?.billing && input.billing.period.start >= from && input.billing.period.start < to
  })
  for (const invoice of invoices) {
    const window = inputOf(invoice)!.billing!
    for (const component of window.components) {
      const match = expectedComponents.get(component.key)
      insist(match && match.window.key === window.key && canonical(match.component) === canonical(component) && !seen.has(component.key), 'complete_issued_service_history_required', 409, { invoice: invoice.id })
      seen.add(component.key)
    }
  }
  insist(invoices.length && seen.size === expectedComponents.size, months ? 'complete_issued_term_required' : 'six_issued_service_intervals_required', 409, { subscription: sub.id, from, to })
  invoices.sort((a, b) => inputOf(a)!.billing!.dueDate.localeCompare(inputOf(b)!.billing!.dueDate) || a.period_start.localeCompare(b.period_start) || a.id.localeCompare(b.id))
  return { invoices, from, to }
}
