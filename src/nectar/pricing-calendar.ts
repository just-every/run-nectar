// Pricing changes use the same service calendars as ordinary billing. A price
// migration changes money/packaging, never silently changes the signed cadence.
import type { Bindings } from '../auth.server'
import type { Business } from './business'
import { all, canonical, fingerprint, insist, one, type Row } from './core'
import { addDays, addMonths, addMonthsClamped, periodContaining } from './dates'
import { billingAnchor, billingPeriodContaining, dueBillingWindows, intervalBoundary, INTERVAL_RATING_VERSION,
  MONTHLY_ARREARS, nonMonthlyArrears, type BillingWindow } from './billing-calendar'
import { ratingInputs } from './inputs'
import { rate, type ItemIn, type PriceIn, type Rating, type RatingInput } from './rating'
import { RENEWAL_RATING_VERSION } from './renewal-rating'

export const intervalPricing = (input: RatingInput) => !!input.billing || !!input.subscription.billingAnchorDate || Object.values(input.prices).some(price => nonMonthlyArrears(price.billing ?? MONTHLY_ARREARS))
export function compatiblePricingCadence(source: PriceIn, target: PriceIn) {
  insist(canonical(source.billing ?? MONTHLY_ARREARS) === canonical(target.billing ?? MONTHLY_ARREARS), 'pricing_cadence_change_requires_separate_terms', 409)
}
export async function pricingTerm(env: Bindings, subscription: string) {
  return one(env, "SELECT * FROM nc_renewal_terms WHERE subscription_id=? AND status='active' ORDER BY created_at DESC,id LIMIT 1", subscription)
}
export function pricingRenewalDate(sub: Row, term: Row | null, reference: string, timing: string, sources: PriceIn[]) {
  let date = reference
  if (timing === 'renewal') {
    if (term) {
      insist(reference <= term.end_date && term.auto_renew && !term.cancelled_at, 'term_not_renewing', 409)
      date = term.end_date
    } else {
      const boundaries = sources.map(price => {
        const terms = price.billing ?? MONTHLY_ARREARS
        const anchor = sub.billing_anchor_date ?? periodContaining(sub.anchor_day, sub.start_date).start
        const period = billingPeriodContaining(anchor, terms, reference)
        return period.start === reference ? reference : period.end
      })
      insist(boundaries.length && boundaries.every(boundary => boundary === boundaries[0]), 'mixed_interval_migration_requires_source_price', 409)
      date = boundaries[0]
    }
  }
  const signedEnd = term?.end_date ?? sub.contract_end_date
  insist(!signedEnd || date >= signedEnd, 'signed_term_grandfathered', 409)
  insist(!sub.end_date || sub.end_date > date || term?.auto_renew && !term.cancelled_at && date === term.end_date, 'subscription_ended', 409)
  return date
}

function upcomingRenewal(input: RatingInput, term: Row | null, date: string) {
  if (!term || !term.auto_renew || term.cancelled_at || date !== term.end_date) return input
  const end = addMonthsClamped(date, term.months)
  return { ...input, version: intervalPricing(input) ? INTERVAL_RATING_VERSION : RENEWAL_RATING_VERSION,
    subscription: { ...input.subscription, endDate: end, contractEndDate: end },
    renewals: [...input.renewals ?? [], { id: `term-${term.id}`, effectiveDate: date, upliftPercent: term.uplift_percent }] }
}
type Prior = { input: RatingInput; rating: Rating }
function remainingInput(input: RatingInput, prior: Prior[]): RatingInput {
  const consumed = new Set(prior.flatMap(entry => entry.rating.consumedEvents))
  const charged = new Set(prior.flatMap(entry => (entry.input.charges ?? []).map(charge => charge.id)))
  const credits = new Set(prior.flatMap(entry => entry.rating.lines.filter(line => line.kind === 'credit').map(line => line.evidence.amendment)))
  return { ...input, events: input.events.filter(event => !consumed.has(event.eventId)),
    amendments: input.amendments.filter(amendment => amendment.kind !== 'fixed_credit' || !credits.has(amendment.id)),
    ...(input.charges ? { charges: input.charges.filter(charge => !charged.has(charge.id)) } : {}),
    ...(input.contracts ? { contracts: { ...input.contracts, invoices: [...input.contracts.invoices, ...prior.map((entry, index) => ({
      id: `projected-${input.subscription.id}-${index}`, number: 'Projected invoice', from: entry.input.period.start, to: entry.input.period.end, lines: entry.rating.lines }))] } } : {}) }
}

/** Each side carries its real window. With compatible cadences their keys
 * coincide; a dated unissued stub can introduce an additional real window. */
export async function pricingFuture(env: Bindings, business: Business, sub: Row, term: Row | null, date: string,
  moved: ItemIn[], target: PriceIn, fullTerm = false) {
  const initial = upcomingRenewal(await ratingInputs(env, business, sub.id, periodContaining(sub.anchor_day, date)), term, date)
  const afterInitial: RatingInput = { ...initial, items: moved, prices: { ...initial.prices, [target.id]: target } }
  const calendar = intervalPricing(initial) || intervalPricing(afterInitial)
  const windows = (input: RatingInput): (BillingWindow | undefined)[] => {
    if (!calendar) return Array.from({ length: fullTerm ? term?.months ?? 2 : 2 }, () => undefined)
    const active = input.items.filter(item => item.from <= date && (item.to ?? '9999-12-31') > date)
    const anchor = billingAnchor(input)
    const end = term && date === term.end_date ? addMonthsClamped(date, term.months)
      : sub.contract_end_date && date < sub.contract_end_date ? sub.contract_end_date
      : active.map(item => {
        const terms = input.prices[item.priceId].billing ?? MONTHLY_ARREARS
        const period = billingPeriodContaining(anchor, terms, date)
        return intervalBoundary(anchor, terms, period.index + 2)
      }).sort().at(-1)
    insist(end && end > date, 'pricing_preview_service_required', 409)
    const from = active.map(item => billingPeriodContaining(anchor, input.prices[item.priceId].billing ?? MONTHLY_ARREARS, date).start).sort()[0] ?? date
    return dueBillingWindows(input, from, addDays(end, 1)).filter(window => window.period.end > date && window.period.start < end)
  }
  const beforeWindows = windows(initial), afterWindows = windows(afterInitial)
  const first = periodContaining(sub.anchor_day, date)
  const entries = new Map<string, { before?: BillingWindow; after?: BillingWindow; period: { start: string; end: string } }>()
  for (const [side, selected] of [['before', beforeWindows], ['after', afterWindows]] as const) for (const [index, window] of selected.entries()) {
    const period = window?.period ?? { start: addMonths(first.start, index), end: addMonths(first.start, index + 1) }
    const key = window?.key ?? period.start
    const entry = entries.get(key) ?? { period }
    if (window) entry[side] = window
    entries.set(key, entry)
  }
  const priorBefore: Prior[] = [], priorAfter: Prior[] = [], fingerprints: string[] = [], periods = []
  const zero = (): Rating => ({ lines: [], subtotalCents: 0, taxCents: 0, totalCents: 0, exceptions: [], tax: {}, consumedEvents: [] })
  for (const entry of [...entries.values()].sort((a, b) => (a.after?.dueDate ?? a.before?.dueDate ?? a.period.start).localeCompare(b.after?.dueDate ?? b.before?.dueDate ?? b.period.start))) {
    const side = async (after: boolean) => {
      const window = after ? entry.after : entry.before
      if (calendar && !window) return { input: null, rating: zero() }
      const input = upcomingRenewal(await ratingInputs(env, business, sub.id, window?.period ?? entry.period, after ? moved : undefined, window), term, date)
      if (after) input.prices[target.id] = target
      const remaining = remainingInput(input, after ? priorAfter : priorBefore), rating = rate(remaining)
      insist(!rating.exceptions.some(exception => ['metric_duplicate_selection','metric_negative_quantity','metric_late_correction'].includes(exception.code)), 'simulation_blocked', 409, rating.exceptions)
      ;(after ? priorAfter : priorBefore).push({ input: remaining, rating })
      return { input: remaining, rating }
    }
    const before = await side(false), after = await side(true)
    fingerprints.push(await fingerprint({ before: before.input, after: after.input, term: term && { id: term.id, revision: term.revision, date: term.end_date } }))
    periods.push({ period: entry.after?.period ?? entry.before?.period ?? entry.period,
      ...(calendar ? { beforeWindow: entry.before ?? null, afterWindow: entry.after ?? null } : {}), before: before.rating, after: after.rating })
  }
  return { periods, fingerprints }
}
