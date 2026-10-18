// Versioned, exact quantity pricing. Tier boundaries are cumulative and
// inclusive; graduated bands charge only their occupied units. Zero units
// never activate a band or a flat fee. Round only the final invoice line.
import { insist } from './core'
import { canonicalDecimal, decimalText, micros, roundHalfAway, SCALE } from './decimal'
import type { Input } from './input'

export const PRICE_MODEL_RATING_VERSION = 'nectar-rating-2'
export type PricingModel = 'graduated' | 'volume' | 'package' | 'stair_step'
export interface PriceTier { upTo: string | null; unitAmount: string; flatAmount: string }
export interface QuantityPrice { model: PricingModel; tiers: PriceTier[]; packageSize?: string }

const amount = (value: unknown, field: string): string => {
  insist(typeof value === 'string', `invalid_${field}`)
  const text = canonicalDecimal(value, field)
  insist(micros(text) <= 1_000_000n * SCALE, `invalid_${field}`)
  return text
}

/** Reads either a JSON body or a JSON-encoded tiers form field. */
export function readQuantityPrice(input: Input, kind: string): QuantityPrice | undefined {
  const model = input.text('pricing_model', { max: 20, optional: true }) || 'simple'
  if (model === 'simple') {
    insist(!input.has('tiers') && !input.has('package_size'), 'unexpected_price_model_fields')
    return undefined
  }
  insist(['graduated', 'volume', 'package', 'stair_step'].includes(model), 'invalid_pricing_model')
  insist(kind === 'seat' || kind === 'unit', 'invalid_pricing_model_kind')
  insist(!input.has('unit_amount'), 'unit_amount_is_in_tiers')
  const limits = input.list('tier_limit', { keepEmpty: true }), units = input.list('tier_unit_amount', { keepEmpty: true }), fees = input.list('tier_flat_amount', { keepEmpty: true })
  const values = input.has('tiers') ? input.json('tiers') : limits.map((limit, i) => ({ up_to: limit || null, ...(units[i] ? { unit_amount: units[i] } : {}), ...(fees[i] ? { flat_amount: fees[i] } : {}) })).filter((_, i) => limits[i] || units[i] || fees[i])
  insist(Array.isArray(values) && values.length > 0 && values.length <= 100, 'invalid_tiers')
  let lower = 0n
  const tiers: PriceTier[] = values.map((value, index) => {
    insist(value && typeof value === 'object' && !Array.isArray(value), 'invalid_tiers')
    insist(Object.keys(value).every(key => ['up_to', 'unit_amount', 'flat_amount'].includes(key)), 'invalid_tiers')
    const last = index === values.length - 1
    insist(last ? value.up_to === null : typeof value.up_to === 'string', 'invalid_tier_boundary')
    const upTo = last ? null : canonicalDecimal(value.up_to, 'tier_boundary')
    if (upTo !== null) {
      const upper = micros(upTo)
      insist(upper > lower, 'invalid_tier_order')
      lower = upper
    }
    const unitAmount = model === 'stair_step' && value.unit_amount === undefined ? '0.00' : amount(value.unit_amount, 'tier_unit_amount')
    const flatAmount = value.flat_amount === undefined && model !== 'stair_step' ? '0.00' : amount(value.flat_amount, 'tier_flat_amount')
    insist(model !== 'stair_step' || micros(unitAmount) === 0n, 'stair_step_requires_flat_amount')
    return { upTo, unitAmount, flatAmount }
  })
  if (model === 'package') {
    insist(tiers.length === 1, 'package_requires_one_tier')
    const packageSize = canonicalDecimal(input.text('package_size', { max: 24 }), 'package_size')
    insist(micros(packageSize) > 0n, 'invalid_package_size')
    return { model, tiers, packageSize }
  }
  insist(!input.has('package_size'), 'unexpected_package_size')
  return { model: model as PricingModel, tiers }
}

/** Converts immutable storage into rating input, without adding fields to old inputs. */
export function storedQuantityPrice(row: { pricing_model: string; tiers_json: string; package_size: string | null }): QuantityPrice | undefined {
  if (row.pricing_model === 'simple') return undefined
  const tiers = JSON.parse(row.tiers_json) as PriceTier[]
  return { model: row.pricing_model as PricingModel, tiers, ...(row.package_size !== null ? { packageSize: row.package_size } : {}) }
}

// A product of two six-place decimals has twelve exact decimal places.
const exactDollars = (value: bigint) => {
  const whole = value / (SCALE * SCALE)
  const fraction = (value % (SCALE * SCALE)).toString().padStart(12, '0').replace(/0+$/, '').padEnd(2, '0')
  return `${whole}.${fraction}`
}

export function rateQuantityPrice(price: QuantityPrice, quantity: bigint, days = 1n, periodDays = 1n) {
  insist(quantity >= 0n, 'invalid_quantity')
  const breakdown: Record<string, unknown>[] = []
  let total = 0n, lower = 0n
  if (quantity > 0n) for (let index = 0; index < price.tiers.length; index++) {
    const tier = price.tiers[index]
    const upper = tier.upTo === null ? null : micros(tier.upTo)
    const selected = upper === null || quantity <= upper
    if (price.model === 'graduated' || selected) {
      const units = price.model === 'graduated' ? (upper === null || quantity < upper ? quantity : upper) - lower : quantity
      const blocks = price.model === 'package' ? (quantity + micros(price.packageSize!) - 1n) / micros(price.packageSize!) : null
      const charged = blocks === null ? units : blocks * SCALE
      const exact = micros(tier.unitAmount) * charged + micros(tier.flatAmount) * SCALE
      total += exact
      breakdown.push({ tier: index + 1, fromExclusive: decimalText(lower), upTo: tier.upTo, quantity: decimalText(units), unitAmount: tier.unitAmount, flatAmount: tier.flatAmount,
        ...(blocks === null ? {} : { blocks: blocks.toString(), packageSize: price.packageSize }), amountExact: exactDollars(exact) })
    }
    if (selected) break
    lower = upper!
  }
  const cents = roundHalfAway(total * days * 100n, SCALE * SCALE * periodDays)
  insist(cents <= BigInt(Number.MAX_SAFE_INTEGER), 'amount_too_large')
  return { amountCents: Number(cents), evidence: {
    rule: `${price.model} pricing; sum exact tier amounts, prorate by days, then round half away from zero once`,
    pricingModel: price.model, quantity: decimalText(quantity), tiers: breakdown, amountExact: exactDollars(total),
    days: Number(days), periodDays: Number(periodDays), roundingNumerator: (total * days * 100n).toString(), roundingDenominator: (SCALE * SCALE * periodDays).toString(),
  } }
}
