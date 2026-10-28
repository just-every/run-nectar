// Subscription events, rather than paid invoice amounts, retain source run rates.
import type { Row } from '../core'
import { insist, parseJson } from '../core'
import { localDate, zonedStart } from '../dates'
import { decimalText } from '../decimal'
import type { RatingInput, PriceIn, AmendmentIn } from '../rating'
import { historicalHref } from './history-reports'

const ref = (value: any): string => typeof value === 'string' ? value : value?.id
const day = (value: unknown, zone: string): string | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? localDate(value * 1000, zone) : null

export function capturedNormalizedInput(sub: Row, events: Row[], through: string, zone: string) {
  const snapshots = events.filter(row => row.customer_id === sub.customer_id && row.subscription_ref === sub.provider_ref)
    .map(row => ({ row, event: parseJson<Row>(row.payload_json, {}) }))
    .filter(({ event }) => Number.isSafeInteger(event.created) && event.created * 1000 < zonedStart(through, zone))
    .sort((a, b) => a.event.created - b.event.created || a.row.id.localeCompare(b.row.id))
  // A creation snapshot establishes the first state. Missing history is refused,
  // rather than silently backfilling today's catalogue over an earlier month.
  insist(snapshots.some(({ event }) => event.type === 'customer.subscription.created'), 'normalized_history_evidence_required', 409)
  const { row, event } = snapshots.at(-1)!, source = event.data?.object
  insist(source?.id === sub.provider_ref && Array.isArray(source.items?.data) && source.items.has_more !== true, 'normalized_history_evidence_required', 409)
  const prices: Record<string, PriceIn> = {}, items: RatingInput['items'] = [], amendments: AmendmentIn[] = []
  const asOf = localDate(zonedStart(through, zone) - 1, zone)
  const start = day(source.start_date, zone)
  insist(start, 'normalized_history_evidence_required', 409)
  for (const item of source.items.data) {
    const price = item.price
    insist(price && typeof price === 'object' && price.currency === 'usd' && price.recurring, 'normalized_source_price_unsupported', 409)
    if (price.recurring.usage_type === 'metered') continue
    insist(price.billing_scheme !== 'tiered', 'normalized_source_price_unsupported', 409)
    const id = ref(price), unit = price.recurring.interval, count = price.recurring.interval_count ?? 1
    insist(typeof id === 'string' && ['day', 'week', 'month', 'year'].includes(unit) && Number.isSafeInteger(count) && count > 0, 'normalized_history_evidence_required', 409)
    const amount = price.unit_amount_decimal ?? price.unit_amount
    insist(typeof amount === 'number' && Number.isSafeInteger(amount) || typeof amount === 'string' && /^\d+(?:\.\d{1,4})?$/.test(amount), 'normalized_history_evidence_required', 409)
    // Stripe unit_amount_decimal is cents, while native unitAmount is dollars.
    const [whole, fraction = ''] = String(amount).split('.')
    const unitAmount = decimalText(BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0')))
    const kind = price.recurring.usage_type === 'metered' ? 'unit' : price.metadata?.nectar_kind === 'seat' ? 'seat' : 'flat'
    prices[id] = { id, kind, unitAmount, meterId: null, taxable: false, label: id, unitLabel: '',
      billing: { unit: unit === 'year' ? 'month' : unit, count: count * (unit === 'year' ? 12 : 1), timing: 'arrears' } }
    const quantity = item.quantity ?? 1
    insist(typeof item.id === 'string' && Number.isSafeInteger(quantity) && quantity >= 0, 'normalized_history_evidence_required', 409)
    items.push({ id: item.id, priceId: id, quantity, from: start, to: null })
  }
  const discounts = [...(source.discount ? [source.discount] : []), ...(Array.isArray(source.discounts) ? source.discounts : [])]
  for (const discount of discounts) {
    insist(discount && typeof discount === 'object' && discount.coupon && typeof discount.coupon === 'object', 'normalized_source_discount_evidence_required', 409)
    const coupon = discount.coupon
    if (coupon.amount_off !== undefined && coupon.amount_off !== null) continue
    insist(typeof coupon.percent_off === 'number' && Number.isFinite(coupon.percent_off) && coupon.percent_off >= 0 && coupon.percent_off <= 100, 'normalized_source_discount_evidence_required', 409)
    const targets = coupon.applies_to?.products
    const covered = targets ? source.items.data.filter((item: Row) => targets.includes(ref(item.price.product))).map((item: Row) => ref(item.price)) : [null]
    for (const priceId of covered) amendments.push({ id: discount.id ?? coupon.id, kind: 'discount_percent', value: String(coupon.percent_off), priceId,
      from: day(discount.start, zone) ?? start, to: day(discount.end, zone), note: '' })
  }
  const inactive = !['active', 'past_due'].includes(source.status)
  const ended = day(source.ended_at, zone) ?? (inactive ? row.occurred_on : null)
  const cancelAt = day(source.cancel_at ?? (source.cancel_at_period_end ? source.current_period_end : null), zone)
  const input: RatingInput = { version: 'nectar-rating-1', timezone: zone, tax: { mode: 'no_tax', rate: '0', jurisdiction: '', exempt: false, exemptRef: '' },
    subscription: { id: sub.id, anchorDay: sub.anchor_day, startDate: start, trialEnd: day(source.trial_end, zone),
      endDate: [ended, cancelAt].filter((value): value is string => !!value).sort()[0] ?? null, billFrom: null },
    period: { start: asOf, end: through }, items, prices, amendments, events: [] }
  return { input, source: { provider: 'stripe', reference: row.provider_ref, href: historicalHref(sub.customer_id, row.id), eventCreated: event.created,
    status: source.status, ...(source.pause_collection ? { collectionPaused: true } : {}) } }
}
