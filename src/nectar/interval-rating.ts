import { canonical, insist } from './core'
import { addDays } from './dates'
import { dueBillingWindows, INTERVAL_RATING_VERSION } from './billing-calendar'
import type { Rating, RatingInput } from './rating'

/** The saved input retains the complete source and selected window. The core
 * rates selected immutable timelines against their nominal interval, keeping
 * first/last stubs and pauses as exact calendar-day prorations. */
export function expandBillingWindow(input: RatingInput): RatingInput {
  const window = input.billing!
  insist(input.version === INTERVAL_RATING_VERSION, 'unsupported_rating_version')
  const expected = dueBillingWindows(input, window.dueDate, addDays(window.dueDate, 1)).find(candidate => candidate.key === window.key)
  insist(expected && window.components.length > 0 && new Set(window.components.map(c => c.key)).size === window.components.length && window.components.every(component => expected.components.some(candidate => canonical(candidate) === canonical(component))), 'billing_window_changed', 409)
  const start = window.components.map(c => c.from).sort()[0], end = window.components.map(c => c.to).sort().at(-1)!
  insist(canonical(window.terms) === canonical(expected.terms) && window.nominalStart === expected.nominalStart && window.nominalEnd === expected.nominalEnd && window.period.start === start && window.period.end === end && input.period.start === start && input.period.end === end, 'billing_window_changed', 409)
  const components = new Map(window.components.map(component => [component.itemId, component]))
  const selected = input.items.filter(item => components.has(item.id))
  const meters = new Set(selected.map(item => input.prices[item.priceId]).filter(price => price.kind === 'unit').map(price => price.meterId))
  const items = input.items.filter(item => components.has(item.id) || (input.prices[item.priceId]?.kind === 'unit' && meters.has(input.prices[item.priceId].meterId)))
    .map(item => input.prices[item.priceId].kind === 'unit' ? item : { ...item, from: components.get(item.id)!.from, to: components.get(item.id)!.to })
  const usedPrices = new Set(items.map(item => item.priceId))
  const prices = Object.fromEntries(Object.entries(input.prices).filter(([id]) => usedPrices.has(id)))
  const sources = new Set(Object.values(prices).flatMap(price => price.metric ? [price.metric.sourceId] : price.meterId ? [price.meterId] : []))
  const expanded: RatingInput = { ...input, billing: undefined, billingDueDate: window.dueDate, items, prices,
    events: input.events.filter(event => sources.has(event.meterId)), period: { start: window.nominalStart, end: window.nominalEnd } }
  // Metered usage and historical usage corrections are arrears operands.
  if (window.terms.timing === 'advance') {
    expanded.events = []
    expanded.charges = []
    expanded.usageAdjustments = []
    if (expanded.contracts) expanded.contracts = { ...expanded.contracts, commitments: [] }
  }
  // A simultaneous invoice receives a contract credit once, on the first
  // deterministic due window. Issued applications are excluded by input reads.
  const first = dueBillingWindows(input, window.dueDate, addDays(window.dueDate, 1))[0]
  if (first?.key !== window.key) expanded.amendments = expanded.amendments.filter(amendment => amendment.kind !== 'fixed_credit')
  return expanded
}

export function rateBillingWindow(input: RatingInput, core: (input: RatingInput) => Rating): Rating {
  const window = input.billing!, expanded = expandBillingWindow(input)
  const result = core(expanded)
  return { ...result, lines: result.lines.map(line => ({ ...line, evidence: { ...line.evidence,
    calendar: { version: INTERVAL_RATING_VERSION, terms: window.terms, nominalStart: window.nominalStart, nominalEnd: window.nominalEnd,
      dueDate: window.dueDate, windowKey: window.key, componentKeys: window.components.map(component => component.key) } } })) }
}
