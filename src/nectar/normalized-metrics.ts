// Contract run rates are independent of invoice proration, usage and cash.
import { fingerprint, insist } from './core'
import { addDays, addMonths, isDate } from './dates'
import { micros, roundHalfAway } from './decimal'
import { blockedAt } from './lifecycle-math'
import { addRational, multiplyRational, rational, type Rational } from './metric-plan'
import type { RatingInput } from './rating'
import { renewalOperands } from './renewal-rating'

export const NORMALIZED_POLICY = 'nectar-normalized-1'
export const NORMALIZED_DEFINITION = 'Month-end USD simple fixed and seat subscription run rate, using retained dated contract operands, not billed revenue. Month intervals divide by their month count; weeks multiply by 52 then divide by 12 and the week count; days multiply by 365 then divide by 12 and the day count. Annual fees divide by 12. Active percentage discounts reduce each original fixed or seat fee additively within their subscription, product or item scope, capped at zero, with dated price overrides and renewal uplifts applied first. One-time fixed credits, amount coupons, metered usage, minimum commitments, prepaid balances, tax, proration, credit notes and refunds do not change this run rate. Trials contribute zero until their end; cancellation or native pause contributes zero from its effective date; future period-end cancellation contributes until that date. Source active and past-due snapshots contribute; other source statuses contribute zero. Source pause_collection retains an active contract rate. Each item retains exact rational cents; displayed MRR rounds each item once, half away from zero. ARR multiplies each exact item MRR by 12 before its own cent rounding. Contributions sum those displayed item cents. Native corrections affect native months only; retained pre-adoption months remain read-only, and correction previews use the same captured source snapshots as reports. Only complete captured subscription snapshots supply pre-adoption rates; invoices never stand in for missing contract history. Non-USD and nonsimple fixed or seat instruments are unsupported. Stripe analytics settings and its report are not imported: this published fixed definition, calendar month-end, 52-week and 365-day convention, additive discounts and per-item rounding can differ from that account’s analytics. Actual source-report comparison remains unqualified.'

export interface ExactCents { numerator: string; denominator: string }
export interface NormalizedComponent {
  itemId: string; priceId: string; quantity: number; unitAmount: string
  interval: { unit: string; count: number }; discounts: { id: string; percent: string }[]
  overrideId: string | null; exactMrrCents: ExactCents; mrrCents: number; arrCents: number
}
export interface NormalizedSnapshot {
  policyVersion: string; asOf: string; subscriptionId: string; fingerprint: string
  supported: boolean; exclusions: string[]; active: boolean
  mrrCents: number; arrCents: number; exactMrrCents: ExactCents; components: NormalizedComponent[]
}
export interface NormalizedEffect {
  source?: { provider: string; reference: string; href: string; eventCreated?: number; status?: string }
  policyVersion: string; before: NormalizedSnapshot; after: NormalizedSnapshot
  deltaMrrCents: number; deltaArrCents: number
}
export interface NormalizedCorrection { policyVersion: string; periods: NormalizedEffect[] }
export const exactCents = (value: Rational): ExactCents => ({ numerator: String(value.n), denominator: String(value.d) })
const safe = (value: bigint) => { const n = Number(value); insist(Number.isSafeInteger(n), 'normalized_amount_out_of_range', 409); return n }
const rounded = (value: Rational) => safe(roundHalfAway(value.n, value.d))
const covers = (from: string, to: string | null | undefined, day: string) => from <= day && (!to || day < to)

/** Both reports and governed correction previews use these exact operands. */
export async function normalizedSnapshot(source: RatingInput, asOf: string): Promise<NormalizedSnapshot> {
  insist(isDate(asOf), 'invalid_normalized_date')
  const input = source.renewals?.length ? renewalOperands(source).input : source
  const sub = input.subscription, exclusions: string[] = []
  if ((input.currency ?? 'USD') !== 'USD') exclusions.push('non_usd_currency')
  const active = sub.startDate <= asOf && (!sub.trialEnd || sub.trialEnd <= asOf)
    && (!sub.endDate || asOf < sub.endDate) && (!sub.contractEndDate || asOf < sub.contractEndDate)
    && blockedAt(asOf, input.lifecycle ?? []).length === 0
  const components: NormalizedComponent[] = []
  let exact = rational(0n)
  for (const item of input.items.filter(item => covers(item.from, item.to, asOf))) {
    const price = input.prices[item.priceId]
    insist(price, 'normalized_price_evidence_required', 409)
    if (price.kind === 'unit') continue
    if (price.pricing) { exclusions.push('nonsimple_fixed_or_seat_price'); continue }
    if (!active) continue
    const scope = price.sourcePriceId ?? price.id
    const amendments = input.amendments.filter(a => covers(a.from, a.to, asOf) && (!a.itemId || a.itemId === item.id) && (!a.priceId || a.priceId === price.id || a.priceId === scope))
    const override = amendments.find(a => a.kind === 'price_override')
    const unitAmount = override?.value ?? price.unitAmount
    insist(Number.isSafeInteger(item.quantity) && item.quantity >= 0 && micros(unitAmount) >= 0n, 'normalized_contract_evidence_required', 409)
    const discounts = amendments.filter(a => a.kind === 'discount_percent').map(a => ({ id: a.id, percent: a.value }))
    const percent = discounts.reduce((sum, d) => sum + micros(d.percent), 0n)
    insist(percent >= 0n, 'normalized_discount_evidence_required', 409)
    const terms = price.billing ?? { unit: 'month', count: 1 }
    insist(Number.isSafeInteger(terms.count) && terms.count > 0, 'normalized_interval_evidence_required', 409)
    const factor = terms.unit === 'month' ? rational(1n, BigInt(terms.count))
      : rational(terms.unit === 'week' ? 52n : 365n, 12n * BigInt(terms.count))
    const fee = rational(micros(unitAmount) * BigInt(item.quantity), 10_000n)
    const net = multiplyRational(fee, rational(percent >= 100_000_000n ? 0n : 100_000_000n - percent, 100_000_000n))
    const monthly = multiplyRational(net, factor)
    exact = addRational(exact, monthly)
    components.push({ itemId: item.id, priceId: scope, quantity: item.quantity, unitAmount,
      interval: { unit: terms.unit, count: terms.count }, discounts, overrideId: override?.id ?? null,
      exactMrrCents: exactCents(monthly), mrrCents: rounded(monthly), arrCents: rounded(multiplyRational(monthly, rational(12n))) })
  }
  // Bind the complete contract timeline, including currently inactive terms.
  // Usage, billing-recipient narratives and tax are not normalized operands.
  const basis = { policyVersion: NORMALIZED_POLICY, asOf, currency: input.currency ?? 'USD', subscription: sub,
    items: input.items, prices: input.prices, amendments: input.amendments.map(({ note: _note, ...a }) => a), lifecycle: input.lifecycle ?? [] }
  return { policyVersion: NORMALIZED_POLICY, asOf, subscriptionId: sub.id, fingerprint: await fingerprint(basis),
    supported: exclusions.length === 0, exclusions: [...new Set(exclusions)], active,
    mrrCents: safe(components.reduce((sum, c) => sum + BigInt(c.mrrCents), 0n)),
    arrCents: safe(components.reduce((sum, c) => sum + BigInt(c.arrCents), 0n)), exactMrrCents: exactCents(exact), components }
}

export async function normalizedEffect(before: RatingInput, after: RatingInput, asOf: string): Promise<NormalizedEffect> {
  const [a, b] = await Promise.all([normalizedSnapshot(before, asOf), normalizedSnapshot(after, asOf)])
  return { policyVersion: NORMALIZED_POLICY, before: a, after: b, deltaMrrCents: b.mrrCents - a.mrrCents, deltaArrCents: b.arrCents - a.arrCents }
}

export async function correctionMrr(before: RatingInput, after: RatingInput): Promise<NormalizedCorrection> {
  const periods: NormalizedEffect[] = []
  for (let month = before.period.start.slice(0, 7); `${month}-01` < before.period.end; month = addMonths(`${month}-01`, 1).slice(0, 7)) {
    periods.push(await normalizedEffect(before, after, addDays(addMonths(`${month}-01`, 1), -1)))
  }
  return { policyVersion: NORMALIZED_POLICY, periods }
}
