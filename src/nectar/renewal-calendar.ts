// Native renewals preserve the original calendar anchor and expose each actual
// invoice separately. Future usage is unknown, never a forecast of zero usage.
import type { Bindings } from '../auth.server'
import type { Business } from './business'
import { all, insist, one, parseJson, type Row } from './core'
import { addDays, addMonths, addMonthsClamped } from './dates'
import { composeBillingWindows } from './billing-composition'
import { dueBillingWindows, INTERVAL_RATING_VERSION } from './billing-calendar'
import { ratingInputs } from './inputs'
import { rate, type ItemIn, type Rating, type RatingInput } from './rating'

const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1
export function nextRenewalEnd(sub: Row, term: Row) {
  if (!sub.billing_anchor_date) return addMonths(term.end_date, term.months)
  const anchor = sub.billing_anchor_date
  const offset = monthIndex(term.end_date) - monthIndex(anchor)
  // A term may begin on a different signed day from the billing calendar. It
  // still keeps that signed day; only a matching original anchor is reused.
  if (addMonthsClamped(anchor, offset) === term.end_date) return addMonthsClamped(anchor, offset + term.months)
  const startOffset = monthIndex(term.end_date) - monthIndex(sub.start_date)
  if (addMonthsClamped(sub.start_date, startOffset) === term.end_date) return addMonthsClamped(sub.start_date, startOffset + term.months)
  const originMonth = addMonthsClamped(term.start_date, -Number(term.cycle ?? 0) * term.months)
  const day = String(sub.anchor_day).padStart(2, '0')
  const signedAnchor = `${originMonth.slice(0, 8)}${day}`
  return addMonthsClamped(signedAnchor, (Number(term.cycle ?? 0) + 2) * term.months)
}
/** Closing an item at a renewal boundary can mean a scheduled replacement.
 * Preserve that explicit decision; only co-termed continuing service extends. */
export async function renewalReplacementIds(env: Bindings, subscription: string, date: string) {
  const [changes, proposals, saves] = await Promise.all([
    all(env, "SELECT item_id FROM nc_changes WHERE subscription_id=? AND status='approved' AND effective_date=?", subscription, date),
    all(env, "SELECT kind,payload_json,impact_json FROM nc_proposals WHERE status='approved' AND (kind='price_change' OR json_extract(payload_json,'$.setup')=1)"),
    all(env, "SELECT terms_json FROM nc_retention_offers WHERE subscription_id=? AND kind='save' AND status='accepted' AND json_extract(terms_json,'$.kind')='downgrade' AND json_extract(terms_json,'$.from')=?", subscription, date),
  ])
  const replaced = new Set<string>(changes.map(change => change.item_id))
  for (const proposal of proposals) {
    const payload = parseJson<Row>(proposal.payload_json, {})
    if (proposal.kind === 'price_change') {
      for (const entry of parseJson<Row[]>(proposal.impact_json, [])) if (entry.subscription === subscription && (entry.effective_date ?? payload.effective_date) === date) {
        for (const source of entry.sourceItems ?? [{ id: entry.item }]) if (source.id) replaced.add(source.id)
      }
    } else if (payload.setup === true && payload.plan?.subscription?.id === subscription) {
      for (const closed of payload.plan.itemUpdates ?? []) if (closed.to === date && payload.plan.items.some((item: Row) => item.setupKey === closed.id && item.from === date)) replaced.add(closed.id)
    }
  }
  for (const save of saves) for (const item of parseJson<Row>(save.terms_json, {}).selectedItems ?? []) replaced.add(item.id)
  return replaced
}
export const renewalItems = (items: ItemIn[], sub: Row, term: Row, end: string, replaced = new Set<string>()) => items.map(item =>
  sub.billing_anchor_date && item.to === term.end_date && !replaced.has(item.id) ? { ...item, to: end } : item)

function prospectiveInput(input: RatingInput, term: Row, end: string): RatingInput {
  return { ...input, version: INTERVAL_RATING_VERSION,
    subscription: { ...input.subscription, endDate: end, contractEndDate: end },
    renewals: [...input.renewals ?? [], { id: `next-${term.id}-${term.cycle}`, effectiveDate: term.end_date, upliftPercent: term.uplift_percent }] }
}
export async function nativeRenewalPreview(env: Bindings, business: Business, sub: Row, term: Row) {
  const enabled = !!sub.billing_anchor_date || !!await one(env, "SELECT 1 FROM nc_items i JOIN nc_price_intervals b ON b.price_id=i.price_id WHERE i.subscription_id=? AND (b.interval_unit<>'month' OR b.interval_count<>1 OR b.billing_timing<>'arrears') LIMIT 1", sub.id)
  if (!enabled) return null
  const end = nextRenewalEnd(sub, term)
  const basis = await ratingInputs(env, business, sub.id, { start: term.end_date, end })
  const replaced = await renewalReplacementIds(env, sub.id, term.end_date)
  const items = renewalItems(basis.items, sub, term, end, replaced)
  const calendar = prospectiveInput({ ...basis, items }, term, end)
  const windows = composeBillingWindows(dueBillingWindows(calendar, term.end_date, addDays(end, 1))
    .filter(window => window.period.end > term.end_date && window.period.start < end))
  const invoices: { dueDate: string; period: RatingInput['period']; subtotalCents: number; taxCents: number; totalCents: number; lines: Rating['lines']; inputs: RatingInput; usage: { status: string; meters: string[] } }[] = []
  const consumedCharges = new Set<string>(), consumedCredits = new Set<string>()
  const prior: { id: string; number: string; from: string; to: string; lines: Rating['lines'] }[] = []
  for (const window of windows) {
    let input = prospectiveInput(await ratingInputs(env, business, sub.id, window.period, items, window), term, end)
    const meters = [...new Set(window.components.flatMap(component => {
      const item = items.find(candidate => candidate.id === component.itemId)!, price = input.prices[item.priceId]
      return price.kind === 'unit' && price.meterId ? [price.meterId] : []
    }))]
    // No retained late events, corrections, or unobserved consumption become a
    // next-term prediction. Signed fixed charges and minima remain operands.
    input = { ...input, events: [], usageAdjustments: [], usageCredits: [], unresolvedHistoricalUsage: [], usageCorrectionPending: [],
      amendments: input.amendments.filter(amendment => amendment.kind !== 'fixed_credit' || !consumedCredits.has(amendment.id)),
      ...(input.charges ? { charges: input.charges.filter(charge => charge.date >= term.end_date && !consumedCharges.has(charge.id)) } : {}),
      ...(input.contracts ? { contracts: { ...input.contracts, invoices: [...input.contracts.invoices, ...prior] } } : {}) }
    const result = rate(input)
    for (const line of result.lines) {
      if (line.kind === 'credit' && typeof line.evidence.amendment === 'string') consumedCredits.add(line.evidence.amendment)
      if (typeof line.evidence.charge === 'string') consumedCharges.add(line.evidence.charge)
    }
    for (const charge of input.charges ?? []) if (result.lines.some(line => line.evidence.charge === charge.id)) consumedCharges.add(charge.id)
    prior.push({ id: `renewal-preview-${term.id}-${invoices.length}`, number: 'Renewal preview', from: window.period.start, to: window.period.end, lines: result.lines })
    invoices.push({ dueDate: window.dueDate, period: window.period, subtotalCents: result.subtotalCents, taxCents: result.taxCents, totalCents: result.totalCents, lines: result.lines, inputs: input,
      usage: { status: meters.length ? 'unknown_not_forecast' : 'not_applicable', meters } })
  }
  const totals = invoices.reduce((sum, invoice) => ({ subtotalCents: sum.subtotalCents + invoice.subtotalCents, taxCents: sum.taxCents + invoice.taxCents, totalCents: sum.totalCents + invoice.totalCents }), { subtotalCents: 0, taxCents: 0, totalCents: 0 })
  insist(Object.values(totals).every(Number.isSafeInteger), 'renewal_amount_out_of_range')
  const unknownUsage = invoices.some(invoice => invoice.usage.meters.length)
  return { renewalDate: term.end_date, nextTermEnd: end, upliftPercent: term.uplift_percent,
    period: { start: term.end_date, end }, ...totals, lines: invoices.flatMap(invoice => invoice.lines), inputs: invoices.length === 1 ? invoices[0].inputs : null,
    invoices, amountBasis: unknownUsage ? 'known_scheduled_charges_excluding_unknown_usage' : 'scheduled_next_term_charges',
    unknownUsage, usageExplanation: unknownUsage ? 'Future usage is unknown and is excluded. These are scheduled charges and contractual minimums, not a forecast of the final invoices.' : null }
}
