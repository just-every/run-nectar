// Uploaded fixed discounts retain their original calendar, never a fresh term
// at cutover. Only captured, unambiguous monthly USD semantics are installed.
import { insist } from '../core'
import { addMonthsClamped, localDate, zonedStart } from '../dates'
import { decimalText } from '../decimal'

export type ImportedAmountDiscount = {
  id: string; redemptionId: string; value: string; duration: 'once' | 'repeating' | 'forever'
  months: number | null; from: string; to: string | null; priceIds: string[]; note: string; sourceJson: string
}

export function importedAmountDiscounts(subscription: any, options: {
  zone: string; anchorDay: number; prices: any[]; supportedPrice: (price: any) => boolean
  priceId: (id: string) => string; identity: (id: string) => string
}): { discounts: any[]; amounts: ImportedAmountDiscount[] } {
  const refuse: (ok: unknown, reason: string) => asserts ok = (ok, reason) => insist(ok, 'unsupported_imported_discount', 400, { subscription: subscription.id, reason })
  refuse(subscription.discounts == null || Array.isArray(subscription.discounts), 'discounts must be fully expanded')
  const discounts: any[] = []
  for (const entry of [subscription.discount, ...(subscription.discounts ?? [])].filter(Boolean)) {
    refuse(typeof entry === 'object' && typeof entry.id === 'string' && entry.id.length > 0, 'discount identity must be captured')
    const previous = discounts.find(discount => discount.id === entry.id)
    refuse(!previous || JSON.stringify(previous) === JSON.stringify(entry), 'conflicting copies of one discount')
    if (!previous) discounts.push(entry)
  }
  const amounts: ImportedAmountDiscount[] = []
  for (const discount of discounts) {
    const coupon = discount.coupon ?? discount.source?.coupon
    refuse(coupon && typeof coupon === 'object', 'coupon must be fully expanded')
    if (coupon.amount_off == null) continue
    refuse(discounts.length === 1, 'stacked fixed discounts need source ordering qualification')
    refuse(typeof coupon.id === 'string' && coupon.id.length > 0 && !discount.deleted && !discount.promotion_code, 'missing coupon identity or unsupported promotion redemption')
    refuse(Number.isSafeInteger(coupon.amount_off) && coupon.amount_off > 0 && coupon.amount_off <= 100_000_000_000 && coupon.currency === 'usd' && coupon.percent_off == null, 'fixed coupon must have one exact USD cent amount')
    refuse(['once', 'repeating', 'forever'].includes(coupon.duration), 'unknown coupon duration')
    const months = coupon.duration === 'repeating' ? coupon.duration_in_months : null
    refuse(months === null || Number.isSafeInteger(months) && months >= 1 && months <= 36, 'repeating coupon needs its original month count')
    const date = (unix: unknown): string => {
      refuse(Number.isSafeInteger(unix) && (unix as number) > 0 && (unix as number) < 253_402_214_400, 'missing or invalid effective instant')
      const from = localDate((unix as number) * 1000, options.zone)
      refuse(zonedStart(from, options.zone) === (unix as number) * 1000 && Number(from.slice(8)) === options.anchorDay, 'fixed coupon dates must align with monthly billing boundaries')
      return from
    }
    const from = date(discount.start)
    const expectedEnd = coupon.duration === 'forever' ? null : addMonthsClamped(from, months ?? 1)
    const to = discount.end == null ? expectedEnd : date(discount.end)
    refuse(to === expectedEnd, 'captured expiry disagrees with the original duration')
    refuse(!subscription.trial_end && !subscription.pause_collection && !subscription.schedule, 'fixed discount with trial, pause or schedule is not qualified')
    refuse((subscription.items?.data ?? []).every((item: any) => {
      const price = options.prices.find(price => price.id === (typeof item.price === 'string' ? item.price : item.price?.id))
      return options.supportedPrice(price) && price.recurring?.usage_type !== 'metered'
    }), 'fixed discount requires supported monthly fixed or seat prices')
    const restrictions = coupon.applies_to?.products
    refuse(coupon.applies_to == null || Array.isArray(restrictions) && restrictions.length > 0 && restrictions.every((product: unknown) => typeof product === 'string'), 'product restrictions must be captured')
    const scoped = restrictions ? options.prices.filter(price => restrictions.includes(typeof price.product === 'string' ? price.product : price.product?.id)) : []
    refuse(!restrictions || restrictions.every((product: string) => scoped.some(price => (typeof price.product === 'string' ? price.product : price.product?.id) === product)) && scoped.every(options.supportedPrice), 'restricted products need supported captured prices')
    amounts.push({
      id: options.identity(subscription.id + ':' + discount.id), redemptionId: options.identity('redemption:' + subscription.id + ':' + discount.id),
      value: decimalText(BigInt(coupon.amount_off) * 10_000n), duration: coupon.duration, months, from, to,
      priceIds: [...new Set<string>(scoped.map(price => options.priceId(price.id)))].sort(), note: 'Imported Stripe amount coupon',
      sourceJson: JSON.stringify({ provider: 'stripe', subscription: subscription.id, discount: discount.id, coupon: coupon.id, start: discount.start, end: discount.end ?? null, duration: coupon.duration, months }),
    })
  }
  return { discounts, amounts }
}
