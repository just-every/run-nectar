import { insist, type Row } from './core'
import { addDays, addMonthsClamped, periodContaining } from './dates'
import { dueBillingWindows, nonMonthlyArrears, type BillingWindow, type BillingTerms, type CalendarBasis } from './billing-calendar'

/** Setup and ordinary billing enumerate the same immutable service components. */
export function setupCalendar(plan: Row, prices: CalendarBasis['prices']): CalendarBasis {
  const s = plan.subscription
  return { subscription: { anchorDay: s.anchorDay, startDate: s.startDate, trialEnd: s.trialEnd, endDate: s.evergreen ? null : s.endDate, billFrom: s.billFrom, billingAnchorDate: s.billingAnchorDate, contractEndDate: s.evergreen ? null : s.contractEndDate }, items: plan.items, prices }
}

export function setupBillingWindows(plan: Row, prices: CalendarBasis['prices']): BillingWindow[] | null {
  if (!plan.subscription.billingAnchorDate && !Object.values(prices).some(p => p.billing && nonMonthlyArrears(p.billing))) return null
  const basis = setupCalendar(plan, prices), start = plan.subscription.previewStart
  if (!plan.subscription.evergreen) return dueBillingWindows(basis, start, addDays(plan.subscription.previewEnd, 1))
  // Find the complete first 36 invoice windows, even for multi-year intervals.
  // No fabricated monthly windows fill the gaps between actual billing dates.
  let through = addMonthsClamped(start, 36), windows = dueBillingWindows(basis, start, addDays(through, 1))
  while (windows.length < 36 && plan.items.some((item: Row) => !item.to || item.to > through)) {
    const next = addMonthsClamped(through, 36)
    insist(next > through, 'billing_calendar_out_of_range')
    through = next
    windows = dueBillingWindows(basis, start, addDays(through, 1))
  }
  const selected = windows.slice(0, 36)
  plan.subscription.previewEnd = selected.reduce((end, window) => window.period.end > end ? window.period.end : end, start)
  return selected
}

const quotedIntervals = (text: string) => {
  const found: Pick<BillingTerms, 'unit' | 'count'>[] = []
  const patterns: [RegExp, BillingTerms['unit'], number][] = [
    [/\b(?:weekly|per week)\b/gi, 'week', 1],
    [/\b(?:monthly|per month)\b/gi, 'month', 1],
    [/\bquarterly\b/gi, 'month', 3],
    [/\bsemi[- ]annual(?:ly)?\b/gi, 'month', 6],
    [/\b(?:annually|yearly|annual billing|per year)\b/gi, 'month', 12],
  ]
  for (const [pattern, unit, count] of patterns) if (pattern.test(text.replace(/semi[- ]annual(?:ly)?/gi, count === 6 ? 'semi-annually' : ''))) found.push({ unit, count })
  for (const match of text.matchAll(/\bevery (\d+) (day|week|month)s?\b/gi)) found.push({ unit: match[2] as BillingTerms['unit'], count: Number(match[1]) })
  return found
}

/** Keep unsupported or unmapped source terms blocking under the existing
 * source-custody machinery; a human note cannot turn them into executable terms. */
export function setupIntervalAmbiguities(ambiguities: Row[], plan: Row, source: Row, quotes: Row[]) {
  const terms: BillingTerms[] = plan.prices.map((p: Row) => p.billing ?? { unit: 'month', count: 1, timing: 'arrears' })
  const intervals = quotedIntervals(source.text)
  const unsupported = intervals.filter(interval => !terms.some((term) => term.unit === interval.unit && term.count === interval.count))
  const unmappedAdvance = /\b(?:in advance|prepay(?:ment|ments|able)?)\b/i.test(source.text) && !terms.some((term) => term.timing === 'advance')
  const supported = !unsupported.length && !unmappedAdvance && terms.some((term) => nonMonthlyArrears(term))
  const result = supported ? ambiguities.filter(a => a.issue !== 'Nonmonthly or advance billing terms require review; this plan rates monthly in arrears.') : [...ambiguities]
  for (const interval of unsupported) result.push({ issue: `Quoted billing interval ${interval.count} ${interval.unit} is not mapped to an executable catalog price.`, code: 'unmapped_billing_interval' })
  for (const price of plan.prices) {
    const quote = quotes.find(q => q.field === `catalog.${price.key}`)?.quote ?? ''
    const declared = quotedIntervals(quote), term = price.billing ?? { unit: 'month', count: 1, timing: 'arrears' }
    const cadences = [...new Set(declared.map(interval => `${interval.unit}:${interval.count}`))]
    if (cadences.length === 1 && cadences[0] !== `${term.unit}:${term.count}`) result.push({ issue: `Catalog ${price.key} does not implement its quoted billing interval.`, code: 'quoted_billing_interval_mismatch' })
    const advance = /\bin advance\b/i.test(quote), arrears = /\bin arrears\b/i.test(quote)
    if (advance !== arrears && term.timing !== (advance ? 'advance' : 'arrears')) result.push({ issue: `Catalog ${price.key} does not implement its quoted billing timing.`, code: 'quoted_billing_timing_mismatch' })
  }
  return result
}

export function setupAnchor(start: string, day: number, fullAnchor: string | null) {
  return fullAnchor ?? periodContaining(day, start).start
}
