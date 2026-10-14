// Exact decimal arithmetic for money. Inputs are decimal text with at most six
// fractional places, held as BigInt millionths; nothing passes through a
// binary float. Every conversion to cents names its rounding: half away from
// zero, once per invoice line (RATING_VERSION records this rule).
import { insist } from './core'

export const SCALE = 1_000_000n
const DECIMAL = /^-?\d{1,12}(\.\d{1,6})?$/

/** Parses decimal text into millionths. */
export function micros(text: string, field = 'amount', { negative = false } = {}): bigint {
  const value = String(text ?? '').trim()
  insist(DECIMAL.test(value), `invalid_${field}`)
  insist(negative || !value.startsWith('-'), `invalid_${field}`)
  const sign = value.startsWith('-') ? -1n : 1n
  const [whole, fraction = ''] = value.replace('-', '').split('.')
  return sign * (BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0')))
}

/** Millionths as canonical decimal text: at least two places, trailing zeros beyond them trimmed. */
export function decimalText(value: bigint): string {
  const sign = value < 0n ? '-' : ''
  const absolute = value < 0n ? -value : value
  const whole = absolute / SCALE, fraction = (absolute % SCALE).toString().padStart(6, '0').replace(/0{1,4}$/, '')
  return `${sign}${whole}.${fraction.padEnd(2, '0')}`
}

export const canonicalDecimal = (text: string, field = 'amount', options?: { negative?: boolean }) => decimalText(micros(text, field, options))

/** numerator / denominator rounded half away from zero. */
export function roundHalfAway(numerator: bigint, denominator: bigint): bigint {
  insist(denominator > 0n, 'invalid_denominator')
  const negative = numerator < 0n
  const absolute = negative ? -numerator : numerator
  const quotient = absolute / denominator, remainder = absolute % denominator
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient
  return negative ? -rounded : rounded
}

/** unit price × quantity × (num / den), in cents, rounded once. */
export function lineCents(unitMicros: bigint, quantityMicros: bigint, num = 1n, den = 1n): bigint {
  return roundHalfAway(unitMicros * quantityMicros * num * 100n, SCALE * SCALE * den)
}

/** percent (in millionths of a percent point) of an amount in cents, rounded once. */
export const percentOf = (cents: bigint, percentMicros: bigint) => roundHalfAway(cents * percentMicros, 100n * SCALE)

/** Decimal dollars text to cents; refuses fractions of a cent. */
export function cents(text: string, field = 'amount', { negative = false } = {}): number {
  const value = micros(text, field, { negative })
  insist(value % 10_000n === 0n, `invalid_${field}`)
  const result = value / 10_000n
  insist(result <= 1_000_000_000_00n && result >= -1_000_000_000_00n, `invalid_${field}`)
  return Number(result)
}

export function money(cents: number | bigint): string {
  const value = BigInt(cents)
  const sign = value < 0n ? '−' : ''
  const absolute = value < 0n ? -value : value
  const whole = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}$${whole}.${(absolute % 100n).toString().padStart(2, '0')}`
}

export const plainMoney = (cents: number | bigint) => {
  const value = BigInt(cents), sign = value < 0n ? '-' : '', absolute = value < 0n ? -value : value
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`
}

/** Canonical decimal text as people read a quantity: thousands grouped, no trailing zeros ("3,346,678.5"). */
export function quantityText(text: string): string {
  const [whole, fraction = ''] = String(text).split('.')
  const sign = whole.startsWith('-') ? '−' : ''
  const digits = whole.replace('-', '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const rest = fraction.replace(/0+$/, '')
  return `${sign}${digits}${rest ? `.${rest}` : ''}`
}
