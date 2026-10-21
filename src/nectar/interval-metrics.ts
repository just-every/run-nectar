// Preserve the metric engine's exact aggregation, predecessor and allowance
// semantics while selecting actual interval windows rather than monthly ones.
import { billingAnchor, billingPeriodContaining, MONTHLY_ARREARS } from './billing-calendar'
import { localDate, zonedStart } from './dates'
import { metricUsage } from './metric-rating'
import { canonical } from './core'
import type { Exception, Line, RatingInput } from './rating'

export function intervalMetricUsage(input: RatingInput) {
  const lines: Line[] = [], exceptions: Exception[] = [], consumed = new Set<string>()
  for (const [index, item] of input.items.entries()) {
    const price = input.prices[item.priceId]
    if (!price?.metric) continue
    const duplicate = input.items.slice(0, index).find(other => {
      const previous = input.prices[other.priceId]
      return previous?.meterId === price.meterId && canonical(previous.metric?.dimensions) === canonical(price.metric!.dimensions) && item.from < (other.to ?? '9999') && other.from < (item.to ?? '9999')
    })
    if (duplicate) exceptions.push({ code: 'metric_duplicate_selection', message: 'The same metric version and dimensions overlap on this subscription.', detail: { items: [duplicate.id, item.id] } })
  }
  for (const item of input.items) {
    const price = input.prices[item.priceId], metric = price?.metric
    if (!metric) continue
    const windows = new Map([[input.period.start, input.period]])
    for (const event of input.events) if (!event.invoiceId && event.meterId === metric.sourceId && localDate(event.occurredAt, input.timezone) < input.period.start && localDate(event.occurredAt, input.timezone) >= input.subscription.startDate) {
      const window = billingPeriodContaining(billingAnchor(input), price.billing ?? MONTHLY_ARREARS, localDate(event.occurredAt, input.timezone))
      windows.set(window.start, window)
    }
    for (const window of [...windows.values()].sort((a, b) => a.start.localeCompare(b.start))) {
      const from = zonedStart(window.start, input.timezone), to = zonedStart(window.end, input.timezone)
      // Outside-window events remain real predecessor context. Eligibility is
      // explicit so the existing engine cannot create monthly late windows.
      const events = input.events.map(event => event.occurredAt < from || event.occurredAt >= to
        ? { ...event, invoiceId: event.invoiceId ?? 'interval-predecessor-context' } : event)
      const result = metricUsage({ ...input, period: window, items: [item], prices: { [price.id]: price }, events })
      lines.push(...result.lines); exceptions.push(...result.exceptions)
      result.consumed.forEach(id => consumed.add(id))
    }
  }
  return { lines, exceptions, consumed: [...consumed] }
}
