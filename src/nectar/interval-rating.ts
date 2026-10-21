import { canonical, insist } from './core'
import { addDays, isDate, zonedStart } from './dates'
import { dueBillingWindows, INTERVAL_RATING_VERSION, MONTHLY_ARREARS, type BillingWindow } from './billing-calendar'
import { billingServiceWindows, composeBillingWindows } from './billing-composition'
import { commitmentLines } from './commitment-rating'
import { invoiceTotals } from './invoice-tax'
import { usageCreditApplicationLines } from './usage-correction-records'
import type { Exception, Line, Rating, RatingInput } from './rating'

function validatedServiceWindows(input: RatingInput) {
  const window = input.billing!
  insist(input.version === INTERVAL_RATING_VERSION, 'unsupported_rating_version')
  const windows = dueBillingWindows(input, window.dueDate, addDays(window.dueDate, 1))
  const parts = billingServiceWindows(window)
  for (const part of parts) {
    const expected = windows.find(candidate => candidate.key === part.key)
    insist(expected && part.dueDate === window.dueDate && part.components.length > 0 && new Set(part.components.map(c => c.key)).size === part.components.length && part.components.every(component => expected.components.some(candidate => canonical(candidate) === canonical(component))), 'billing_window_changed', 409)
    const start = part.components.map(c => c.from).sort()[0], end = part.components.map(c => c.to).sort().at(-1)!
    insist(canonical(part.terms) === canonical(expected.terms) && part.nominalStart === expected.nominalStart && part.nominalEnd === expected.nominalEnd && part.period.start === start && part.period.end === end, 'billing_window_changed', 409)
  }
  const composed = composeBillingWindows(parts)
  insist(composed.length === 1 && canonical(composed[0]) === canonical(window) && canonical(input.period) === canonical(window.period), 'billing_window_changed', 409)
  return parts
}

/** The saved input retains the complete source and selected window. The core
 * rates selected immutable timelines against their nominal interval, keeping
 * first/last stubs and pauses as exact calendar-day prorations. */
export function expandBillingWindow(input: RatingInput): RatingInput {
  const parts = validatedServiceWindows(input)
  insist(parts.length === 1, 'composed_billing_service_inputs_required', 409)
  return expandServiceWindow(input, parts[0])
}

/** Index-aligned with billingServiceWindows(input.billing). Service end limits
 * prevent a long advance component from pulling later usage into arrears. */
export function expandBillingWindows(input: RatingInput): RatingInput[] {
  return validatedServiceWindows(input).map(window => expandServiceWindow(input, window))
}

function servicePricingInput(input: RatingInput, window: BillingWindow): RatingInput {
  const change = input.pricingCounterfactual
  if (!change) return input
  const source = input.prices[change.sourcePriceId], target = input.prices[change.targetPriceId]
  insist(source && target && source.id !== target.id && isDate(change.from) && isDate(change.to) && change.from < change.to, 'invalid_pricing_counterfactual', 409)
  insist(canonical(source.billing ?? MONTHLY_ARREARS) === canonical(target.billing ?? MONTHLY_ARREARS), 'pricing_cadence_change_requires_separate_terms', 409)
  insist(change.quantity === undefined || target.kind === 'seat', 'quantity_only_for_seat_target')
  // A boundary invoice can contain last-term arrears and next-term advance.
  // The latter keeps its saved original price, even for the very same item id.
  if (window.period.start < change.from || window.period.end > change.to) return input
  const selected = new Set(window.components.map(component => component.itemId))
  return { ...input, items: input.items.map(item => {
    if (!selected.has(item.id) || item.priceId !== source.id) return item
    const quantity = target.kind === 'seat' ? change.quantity ?? (source.kind === 'seat' ? item.quantity : undefined) : 1
    insist(typeof quantity === 'number' && Number.isSafeInteger(quantity) && quantity >= (target.pricing ? 0 : 1) && quantity <= (target.pricing ? 1_000_000_000 : 1_000_000), 'invalid_quantity')
    return { ...item, priceId: target.id, quantity }
  }) }
}

function expandServiceWindow(input: RatingInput, window: BillingWindow): RatingInput {
  const original = input
  // Original calendars were validated before semantic price bindings change.
  // Rebind before source selection so flat-to-metered simulations retain their
  // actual target meter events, rather than losing them to the old flat price.
  input = servicePricingInput(input, window)
  const components = new Map(window.components.map(component => [component.itemId, component]))
  const selected = input.items.filter(item => components.has(item.id))
  const meters = new Set(selected.map(item => input.prices[item.priceId]).filter(price => price.kind === 'unit').map(price => price.meterId))
  const items = input.items.filter(item => components.has(item.id) || (input.prices[item.priceId]?.kind === 'unit' && meters.has(input.prices[item.priceId].meterId)))
    .map(item => input.prices[item.priceId].kind === 'unit' ? item : { ...item, from: components.get(item.id)!.from, to: components.get(item.id)!.to })
  const usedPrices = new Set(items.map(item => item.priceId))
  const prices = Object.fromEntries(Object.entries(input.prices).filter(([id]) => usedPrices.has(id)))
  const sources = new Set(Object.values(prices).flatMap(price => price.metric ? [price.metric.sourceId] : price.meterId ? [price.meterId] : []))
  const expanded: RatingInput = { ...input, billing: undefined, pricingCounterfactual: undefined, billingDueDate: window.dueDate, items, prices,
    commitmentCalendar: { subscription: original.subscription, items: original.items, prices: original.prices },
    events: input.events.filter(event => sources.has(event.meterId) && event.occurredAt < zonedStart(window.period.end, input.timezone)), period: { start: window.nominalStart, end: window.nominalEnd } }
  if (expanded.charges) expanded.charges = expanded.charges.filter(charge => charge.date < window.period.end)
  // Metered usage and historical usage corrections are arrears operands.
  if (window.terms.timing === 'advance') {
    expanded.events = []
    expanded.charges = []
    expanded.usageAdjustments = []
    if (expanded.contracts) expanded.contracts = { ...expanded.contracts, commitments: [] }
  }
  // A simultaneous invoice receives a contract credit once, on the first
  // deterministic due window. Issued applications are excluded by input reads.
  const first = dueBillingWindows(original, window.dueDate, addDays(window.dueDate, 1))[0]
  if (first?.key !== window.key) expanded.amendments = expanded.amendments.filter(amendment => amendment.kind !== 'fixed_credit')
  return expanded
}

function withCalendar(line: Line, window: BillingWindow): Line {
  // Historical corrections already carry their own immutable source calendar.
  if (line.evidence.calendar) return line
  return { ...line, evidence: { ...line.evidence,
    calendar: { version: INTERVAL_RATING_VERSION, terms: window.terms, nominalStart: window.nominalStart, nominalEnd: window.nominalEnd,
      dueDate: window.dueDate, windowKey: window.key, componentKeys: window.components.map(component => component.key) } } }
}

export function rateBillingWindow(input: RatingInput, core: (input: RatingInput) => Rating): Rating {
  const parts = validatedServiceWindows(input)
  if (parts.length === 1) {
    const result = core(expandServiceWindow(input, parts[0]))
    return { ...result, lines: result.lines.map(line => withCalendar(line, parts[0])) }
  }
  const representative = parts.filter(part => part.terms.timing === 'arrears').at(-1) ?? parts.at(-1)!
  const serviceInputs = parts.map(part => expandServiceWindow(input, part))
  const results = serviceInputs.map((expanded, index) => {
    const owner = parts[index].key === representative.key
    const current: RatingInput = { ...expanded, usageCredits: [],
      charges: owner ? expanded.charges : [], usageAdjustments: owner ? expanded.usageAdjustments : [],
      contracts: expanded.contracts ? { ...expanded.contracts, commitments: [] } : undefined }
    return core(current)
  })
  const serviceLines = results.flatMap((result, index) => result.lines.map(line => withCalendar(line, parts[index])))
  const selected = new Set(input.billing!.components.map(component => component.itemId))
  const context: RatingInput = { ...serviceInputs[parts.indexOf(representative)],
    items: input.items.filter(item => selected.has(item.id)), prices: input.prices, events: input.events, contracts: input.contracts }
  const committed = commitmentLines(context, serviceLines)
  const lines = committed.lines.map((line, index) => index < serviceLines.length ? line : withCalendar(line, representative))
  // Tax is rounded once on the complete taxable consideration, never summed
  // from independently rounded service-window subtotals.
  const totals = invoiceTotals(input.tax, lines)
  const adjustments = representative.terms.timing === 'arrears' ? input.usageAdjustments ?? [] : []
  const correctionTax = adjustments.reduce((sum, adjustment) => sum + adjustment.taxCents, 0)
  totals.taxCents += correctionTax; totals.totalCents += correctionTax
  if (adjustments.length) totals.tax.historicalCorrectionTaxCents = correctionTax
  insist([totals.subtotalCents, totals.taxCents, totals.totalCents].every(Number.isSafeInteger), 'correction_amount_out_of_range')
  const taxCodes = new Set(['negative_total', 'tax_undeclared', ...(input.tax.exception ? [input.tax.exception.code] : [])])
  const exceptions = new Map<string, Exception>()
  for (const exception of [...results.flatMap(result => result.exceptions).filter(exception => !taxCodes.has(exception.code)), ...committed.exceptions, ...totals.exceptions]) exceptions.set(canonical(exception), exception)
  return { ...totals, lines: [...lines, ...usageCreditApplicationLines(input.usageCredits ?? [], totals.totalCents, input.period)],
    exceptions: [...exceptions.values()], consumedEvents: [...new Set(results.flatMap(result => result.consumedEvents))] }
}
