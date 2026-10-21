// Plan-change previews summarize all documents covering the affected actual
// service interval, including separate advance stubs; ordinary billing uses
// these exact item timelines and the same calendar/rating engine.
import type { Bindings } from '../auth.server'
import type { Business } from './business'
import { subscriptionCalendar } from './billing-plan'
import { billingAnchor, billingPeriodContaining, dueBillingWindows, MONTHLY_ARREARS, type CalendarBasis } from './billing-calendar'
import { addDays } from './dates'
import { canonical, insist, type Row } from './core'
import { pricesById, rated } from './inputs'
import type { ItemIn, Line } from './rating'

const recurring = (lines: Line[]) => lines.filter(line => ['flat','seat','discount'].includes(line.kind))

export async function intervalChangePreview(env: Bindings, business: Business, sub: Row, original: ItemIn[], changed: ItemIn[], oldPrice: string, newPrice: string, date: string) {
  const { basis, enabled } = await subscriptionCalendar(env, sub)
  if (!enabled) return null
  const prices = await pricesById(env, [...new Set([...original, ...changed].map(item => item.priceId))])
  const terms = prices[oldPrice].billing ?? MONTHLY_ARREARS
  insist(canonical(terms) === canonical(prices[newPrice].billing ?? MONTHLY_ARREARS), 'change_billing_interval_separately')
  const period = billingPeriodContaining(billingAnchor(basis), terms, date), next = billingPeriodContaining(billingAnchor(basis), terms, period.end)
  const calculate = async (items: ItemIn[], span: { start: string; end: string }) => {
    const input: CalendarBasis = { ...basis, prices, items }
    const windows = dueBillingWindows(input, span.start, addDays(span.end, 1)).filter(window => window.nominalStart === span.start && window.nominalEnd === span.end && canonical(window.terms) === canonical(terms))
    const calculations = []
    for (const window of windows) {
      const result = await rated(env, business, sub.id, window.period, items, window)
      calculations.push({ window, fingerprint: result.fingerprint, lines: recurring(result.rating.lines) })
    }
    const lines = calculations.flatMap(result => result.lines)
    return { lines, cents: lines.reduce((sum, line) => sum + line.amountCents, 0), windows: calculations }
  }
  return { period: { start: period.start, end: period.end }, effectiveDate: date,
    before: await calculate(original, period), after: await calculate(changed, period),
    nextPeriod: { period: { start: next.start, end: next.end }, ...await calculate(changed, next) } }
}
