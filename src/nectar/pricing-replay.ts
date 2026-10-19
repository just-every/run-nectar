// Historical simulations use issued evidence, never a reconstruction from
// today's subscription. Nothing in this module writes billing records.
import type { Bindings } from '../auth.server'
import type { Business } from './business'
import { all, fingerprint, insist, one, parseJson, type Row } from './core'
import { addMonths, isDate, isMonth, periodStartingIn, today, zonedStart } from './dates'
import { money } from './decimal'
import { pricesById } from './inputs'
import { metricEvents } from './meter-definitions'
import { METRIC_RATING_VERSION } from './metric-rating'
import { rate, type EventIn, type Line, type PriceIn, type Rating, type RatingInput } from './rating'

export interface PricingReplacement { source_price: string; quantity?: number }
export interface ReplayTotals {
  beforeSubtotalCents: number; afterSubtotalCents: number
  beforeTotalCents: number; afterTotalCents: number
  deltaSubtotalCents: number; deltaTotalCents: number
}
export interface ReplayPeriod {
  period: { start: string; end: string }; invoice: string; invoiceNumber: string
  before: Rating; after: Rating; deltaSubtotalCents: number; deltaTotalCents: number
  sourceEvents: EventIn[]; fingerprint: string
  fingerprints: { original: string; raw: string; target: string }
}

function seatQuantity(target: PriceIn, value: unknown): number {
  insist(typeof value === 'number' && Number.isSafeInteger(value) &&
    value >= (target.pricing ? 0 : 1) && value <= (target.pricing ? 1_000_000_000 : 1_000_000), 'invalid_quantity')
  return value
}

/** Replace the complete source service intervals. Upcoming previews must keep
 * their pre-effective-date item slices separately and merge them afterwards.
 * Raw events must already have the intended replay/preview billing eligibility.
 * Signed terms retain their exact original price bindings, values and dates.
 */
export function applyPricingReplacement(input: RatingInput, target: PriceIn, change: PricingReplacement, events: EventIn[] = input.events): RatingInput {
  const sources = input.items.filter(item => item.priceId === change.source_price)
  insist(sources.length, 'source_price_not_on_subscription', 409, { subscription: input.subscription.id })
  const items = input.items.map(item => item.priceId !== change.source_price ? { ...item } : {
    ...item, priceId: target.id,
    quantity: target.kind === 'seat' ? seatQuantity(target, change.quantity ??
      (input.prices[item.priceId]?.kind === 'seat' ? item.quantity : undefined)) : 1,
  })
  const usedPrices = new Set(items.map(item => item.priceId))
  const prices = Object.fromEntries(Object.entries({ ...input.prices, [target.id]: target }).filter(([id]) => usedPrices.has(id)))
  return {
    ...input, version: METRIC_RATING_VERSION, items, prices, events,
  }
}

const emptyTotals = (): ReplayTotals => ({ beforeSubtotalCents: 0, afterSubtotalCents: 0,
  beforeTotalCents: 0, afterTotalCents: 0, deltaSubtotalCents: 0, deltaTotalCents: 0 })

function sumTotals(values: ReplayTotals[]): ReplayTotals {
  const total = emptyTotals()
  for (const value of values) for (const key of Object.keys(total) as (keyof ReplayTotals)[]) {
    total[key] += value[key]
    insist(Number.isSafeInteger(total[key]), 'simulation_amount_out_of_range')
  }
  return total
}

function periodTotals(period: ReplayPeriod): ReplayTotals {
  return { beforeSubtotalCents: period.before.subtotalCents, afterSubtotalCents: period.after.subtotalCents,
    beforeTotalCents: period.before.totalCents, afterTotalCents: period.after.totalCents,
    deltaSubtotalCents: period.deltaSubtotalCents, deltaTotalCents: period.deltaTotalCents }
}

function invoiceLine(line: Row): Line {
  return { kind: line.kind, description: line.description, quantity: line.quantity, unitAmount: line.unit_amount,
    amountCents: line.amount_cents, taxable: !!line.taxable, priceId: line.price_id, meterId: line.meter_id,
    periodStart: line.period_start, periodEnd: line.period_end, evidence: parseJson(line.evidence_json, {}) }
}

function savedInput(invoice: Row): RatingInput {
  const input = parseJson<Row>(invoice.calculation_json, {}).inputs as RatingInput | undefined
  insist(input && input.subscription?.id === invoice.subscription_id &&
    input.period?.start === invoice.period_start && input.period?.end === invoice.period_end &&
    Array.isArray(input.items) && input.prices && Array.isArray(input.events) && Array.isArray(input.amendments),
  'historical_invoice_inputs_missing', 409, { invoice: invoice.id })
  return input
}

// Keep immutable historical snapshots in preference to current copies of events
// they already contain. Added raw usage includes events billed by any invoice.
function replayEvents(input: RatingInput, target: PriceIn, source: string, raw: EventIn[]): EventIn[] {
  const sourceMeter = target.metric?.sourceId ?? target.meterId
  const replacedSource = input.prices[source]
  const oldMeter = replacedSource?.metric?.sourceId ?? replacedSource?.meterId
  const remaining = input.items.filter(item => item.priceId !== source).map(item => input.prices[item.priceId])
  const oldMeterStillUsed = remaining.some(price => (price?.metric?.sourceId ?? price?.meterId) === oldMeter)
  const events = input.events.filter(event => !oldMeter || oldMeterStillUsed || event.meterId !== oldMeter)
  if (!sourceMeter) return events
  const from = zonedStart(input.period.start, input.timezone), to = zonedStart(input.period.end, input.timezone)
  const merged = new Map(raw.map(event => [event.eventId, event]))
  const savedEvents = new Map(input.events.map(event => [event.eventId, event]))
  for (const event of input.events) if (event.meterId === sourceMeter) merged.set(event.eventId, event)
  const sourceEvents = [...merged.values()].filter(event => event.occurredAt < to &&
    (target.metric || event.occurredAt >= from || savedEvents.has(event.eventId)))
    .map(event => ({ ...event,
      // Earlier states are context, never invented late billable usage. Current
      // window events must be rerated even when a real invoice consumed them.
      invoiceId: event.occurredAt < from ? (savedEvents.has(event.eventId)
        ? savedEvents.get(event.eventId)!.invoiceId : event.invoiceId || 'historical-context') : null,
    }))
  return [...events.filter(event => event.meterId !== sourceMeter), ...sourceEvents]
    .sort((a, b) => a.occurredAt - b.occurredAt || a.eventId.localeCompare(b.eventId))
}

function checkSelections(input: RatingInput, result: Rating): void {
  insist(!result.exceptions.some(exception => exception.code === 'metric_duplicate_selection'), 'meter_already_billed', 409, result.exceptions)
  // The simple unit engine selects the first matching item. Refuse ambiguity
  // instead of presenting an apparently valid total from that first match.
  for (const [index, item] of input.items.entries()) {
    const price = input.prices[item.priceId]
    if (price?.kind !== 'unit' || price.metric) continue
    insist(!input.items.slice(0, index).some(other => {
      const previous = input.prices[other.priceId]
      return previous?.kind === 'unit' && !previous.metric && previous.meterId === price.meterId &&
        item.from < (other.to ?? '9999-12-31') && other.from < (item.to ?? '9999-12-31')
    }), 'meter_already_billed', 409, { subscription: input.subscription.id, item: item.id })
  }
}

/** Six actual, issued monthly service periods starting in start_month.
 * effective_date schedules the future change; it never clips historical items.
 * Repeating this read recomputes basis for proposal stale comparison.
 */
export async function pricingReplay(env: Bindings, business: Business, payload: Row) {
  insist(Array.isArray(payload.subscriptions) && payload.subscriptions.length > 0 && payload.subscriptions.length <= 200,
    'subscriptions_required')
  insist(payload.subscriptions.every((id: unknown) => typeof id === 'string' && id.trim() && id.length <= 100), 'invalid_subscription')
  const ids: string[] = payload.subscriptions.map((id: string) => id.trim())
  insist(new Set(ids).size === ids.length, 'duplicate_subscriptions')
  const startMonth = payload.start_month, effectiveDate = payload.effective_date
  insist(isMonth(startMonth) && isDate(`${startMonth}-01`) && isDate(addMonths(`${startMonth}-01`, 6)), 'invalid_start_month')
  insist(isDate(effectiveDate), 'effective_date_required')
  insist(typeof payload.source_price === 'string' && payload.source_price.trim() &&
    typeof payload.target_price === 'string' && payload.target_price.trim(), 'source_and_target_price_required')
  const sourceId = payload.source_price.trim(), targetId = payload.target_price.trim()
  insist(sourceId !== targetId, 'nothing_changes')
  const [sourceRow, targetRow, prices] = await Promise.all([
    one(env, 'SELECT * FROM nc_prices WHERE id=?', sourceId),
    one(env, 'SELECT * FROM nc_prices WHERE id=?', targetId),
    pricesById(env, [sourceId, targetId]),
  ])
  insist(sourceRow && prices[sourceId], 'price_not_found', 404, { price: sourceId })
  insist(targetRow && prices[targetId], 'price_not_found', 404, { price: targetId })
  insist(targetRow.status === 'active', 'price_retired', 409)
  const target = prices[targetId]
  if (payload.quantity !== undefined) {
    insist(target.kind === 'seat', 'quantity_only_for_seat_target')
    seatQuantity(target, payload.quantity)
  }
  if (target.kind === 'seat' && prices[sourceId].kind !== 'seat') seatQuantity(target, payload.quantity)
  if (payload.cost_cents !== undefined) insist(typeof payload.cost_cents === 'number' &&
    Number.isSafeInteger(payload.cost_cents) && payload.cost_cents >= 0, 'invalid_cost_cents')
  const normalized = { simulation: true, subscriptions: ids, start_month: startMonth, effective_date: effectiveDate,
    source_price: sourceId, target_price: targetId,
    ...(payload.quantity !== undefined ? { quantity: payload.quantity as number } : {}),
    ...(payload.cost_cents !== undefined ? { cost_cents: payload.cost_cents as number } : {}),
  }
  const targetFingerprint = await fingerprint({ price: targetRow, definition: target })
  const subscriptions: Record<string, { revision: string; periods: string[] }> = {}
  const customers = []
  for (const id of ids) {
    const sub = await one(env, 'SELECT s.*, c.name AS customer_name FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id WHERE s.id=?', id)
    insist(sub, 'subscription_not_found', 404)
    const expected = Array.from({ length: 6 }, (_, index) => periodStartingIn(sub.anchor_day, addMonths(`${startMonth}-01`, index).slice(0, 7)))
    insist(expected[5].end <= today(business.timezone), 'simulation_requires_historical_periods', 409)
    const invoices = await all(env, "SELECT * FROM nc_invoices WHERE subscription_id=? AND status='issued' AND invoice_kind='recurring' AND period_start>=? AND period_start<? ORDER BY period_start,id",
      id, expected[0].start, expected[5].end)
    insist(invoices.length === 6 && expected.every((period, index) => invoices[index].period_start === period.start && invoices[index].period_end === period.end),
      'six_issued_monthly_invoices_required', 409, { subscription: id, periods: expected, invoices: invoices.map(invoice => invoice.id) })
    const sourceMeter = target.metric?.sourceId ?? target.meterId
    // metricEvents retains the full predecessor history for latest/time-weighted.
    const [lines, raw] = await Promise.all([
      all(env, `SELECT l.* FROM nc_invoice_lines l JOIN nc_invoices i ON i.id=l.invoice_id WHERE i.subscription_id=? AND i.status='issued' AND i.invoice_kind='recurring' AND i.period_start>=? AND i.period_start<? ORDER BY i.period_start,l.seq`,
        id, expected[0].start, expected[5].end),
      sourceMeter ? metricEvents(env, sub.customer_id, sourceMeter, zonedStart(expected[5].end, business.timezone)) : Promise.resolve([]),
    ])
    const periods: ReplayPeriod[] = []
    const rerated = new Map<string, Line[]>()
    for (const invoice of invoices) {
      const input = savedInput(invoice)
      insist(input.items.some(item => item.priceId === sourceId && item.from < input.period.end && (item.to ?? '9999-12-31') > input.period.start),
        'source_price_not_on_subscription', 409, { subscription: id, invoice: invoice.id })
      const calculation = parseJson<Row>(invoice.calculation_json, {})
      const before: Rating = {
        lines: lines.filter(line => line.invoice_id === invoice.id).map(invoiceLine),
        subtotalCents: invoice.subtotal_cents, taxCents: invoice.tax_cents, totalCents: invoice.total_cents,
        tax: calculation.tax ?? {}, consumedEvents: calculation.consumedEvents ?? [],
        exceptions: parseJson(invoice.exceptions_json, []),
      }
      const events = replayEvents(input, target, sourceId, raw)
      const afterInput = applyPricingReplacement(input, target, normalized, events)
      if (afterInput.contracts) afterInput.contracts = { ...afterInput.contracts,
        invoices: afterInput.contracts.invoices.map(previous => ({ ...previous,
          lines: rerated.get(previous.id) ?? previous.lines,
        })) }
      const after = rate(afterInput)
      checkSelections(afterInput, after)
      rerated.set(invoice.id, after.lines)
      const periodRaw = raw.filter(event => event.occurredAt < zonedStart(input.period.end, input.timezone) &&
        (target.metric || event.occurredAt >= zonedStart(input.period.start, input.timezone)))
      const originalFingerprint = await fingerprint({ invoice: invoice.id, input, before })
      const rawFingerprint = await fingerprint(periodRaw)
      const periodFingerprint = await fingerprint({ originalFingerprint, rawFingerprint, targetFingerprint,
        subscriptionRevision: sub.revision, normalized, afterInput })
      periods.push({ period: input.period, invoice: invoice.id, invoiceNumber: invoice.number, before, after,
        deltaSubtotalCents: after.subtotalCents - before.subtotalCents, deltaTotalCents: after.totalCents - before.totalCents,
        sourceEvents: periodRaw, fingerprint: periodFingerprint,
        fingerprints: { original: originalFingerprint, raw: rawFingerprint, target: targetFingerprint } })
    }
    const totals = sumTotals(periods.map(periodTotals))
    const citations = periods.map(period => ({ invoice: period.invoice, number: period.invoiceNumber }))
    const explanation = `${sub.customer_name}: replacing ${prices[sourceId].label} with ${target.label} changes six issued periods' subtotal from ${money(totals.beforeSubtotalCents)} to ${money(totals.afterSubtotalCents)} (${money(totals.deltaSubtotalCents)}); total including saved tax treatment changes by ${money(totals.deltaTotalCents)}. Source invoices: ${citations.map(cite => `${cite.number} [${cite.invoice}]`).join(', ')}.`
    const assumedCost = payload.cost_cents === undefined ? undefined : payload.cost_cents * 6
    insist(assumedCost === undefined || Number.isSafeInteger(assumedCost), 'simulation_amount_out_of_range')
    customers.push({ subscription: id, subscriptionLabel: sub.external_id || id, customerId: sub.customer_id,
      customer: sub.customer_name, periods, totals, explanation, citations,
      ...(assumedCost === undefined ? {} : { estimatedMargins: { label: 'Estimated margins using the same assumed cost per subscription period; not actual costs',
        costPerPeriodCents: payload.cost_cents as number, totalCostCents: assumedCost,
        beforeMarginCents: totals.beforeSubtotalCents - assumedCost, afterMarginCents: totals.afterSubtotalCents - assumedCost } }),
    })
    subscriptions[id] = { revision: sub.revision, periods: periods.map(period => period.fingerprint) }
  }
  const totals = sumTotals(customers.map(customer => customer.totals))
  const highestAffectedCustomers = [...customers].sort((a, b) => Math.abs(b.totals.deltaTotalCents) - Math.abs(a.totals.deltaTotalCents) || a.subscription.localeCompare(b.subscription))
    .slice(0, 10).map(customer => ({ subscription: customer.subscription, customerId: customer.customerId, customer: customer.customer,
      ...customer.totals, invoiceIds: customer.periods.map(period => period.invoice) }))
  const basis = { targetFingerprint, subscriptions, fingerprint: await fingerprint({ targetFingerprint, subscriptions, normalized }) }
  const assumptions = ['Counterfactual catalog packaging applies throughout each saved source service interval.',
    'Saved price-specific amendments and included quantities keep their original price bindings, values and dates; replacing an item can change eligibility.',
    'Saved commitments, discounts, one-time charges, lifecycle and tax declarations remain the rating basis.',
    'Retained target-source usage includes already billed events; metric predecessor events provide context only.']
  const cost = payload.cost_cents === undefined ? undefined : payload.cost_cents * customers.length * 6
  insist(cost === undefined || Number.isSafeInteger(cost), 'simulation_amount_out_of_range')
  return { normalized, impact: { customers, totals, highestAffectedCustomers, assumptions,
    explanation: `${customers.length} subscription(s), ${customers.length * 6} issued invoices: subtotal changes by ${money(totals.deltaSubtotalCents)} and total by ${money(totals.deltaTotalCents)}. ${customers.map(customer => customer.explanation).join(' ')}`,
    ...(cost === undefined ? {} : { costAssumption: { label: 'Estimated margins; assumed costs, not actual costs',
      costPerPeriodCents: payload.cost_cents as number, totalCostCents: cost,
      beforeMarginCents: totals.beforeSubtotalCents - cost, afterMarginCents: totals.afterSubtotalCents - cost } }),
  }, basis }
}
