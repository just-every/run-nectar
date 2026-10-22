// Source-day allocation retains the complete metric measurement denominator.
// Nonadditive day weights normalize exactly, like the native revenue allocator.
import { canonical, insist, type Row } from './core'
import { addDays, localDate, zonedStart } from './dates'
import { aggregateMetric } from './metric-aggregate'
import { addRational, compareRational, divideRational, multiplyRational, parseRational, rational, type Rational } from './metric-plan'
import type { Line, RatingInput } from './rating'
export function prepaidQuantity(line: Line): Rational {
  const exact = line.evidence.exactQuantity as Row | undefined
  return exact ? rational(BigInt(exact.numerator), BigInt(exact.denominator)) : parseRational(line.quantity)
}
export function weightedIntegers(total: bigint, weights: { date: string; weight: Rational }[]) {
  insist(total >= 0n && weights.every(row=>row.weight.n >= 0n), 'prepaid_negative_source_weights')
  const sum = weights.reduce((value, row) => addRational(value, row.weight), rational(0n))
  if (!sum.n) { insist(total === 0n, 'prepaid_source_weights_required'); return weights.map(row => ({ date: row.date, amount: 0n })) }
  const parts = weights.map(row => { const share = multiplyRational(rational(total), divideRational(row.weight, sum)); return { date: row.date, amount: share.n / share.d, remainder: rational(share.n % share.d, share.d) } })
  let remaining = total - parts.reduce((value, row) => value + row.amount, 0n)
  for (const row of [...parts].sort((a, b) => -compareRational(a.remainder, b.remainder) || a.date.localeCompare(b.date))) if (remaining > 0n) { row.amount++; remaining-- }
  insist(remaining === 0n, 'prepaid_source_weights_invalid')
  return parts.sort((a, b) => a.date.localeCompare(b.date)).map(({date,amount}) => ({date,amount}))
}
export function prepaidDays(input: RatingInput, line: Line) {
  const days = new Map<string, Rational>()
  if (line.kind !== 'metric_usage') {
    const ids = new Set(line.evidence.eventIds as string[])
    for (const event of input.events.filter(event => ids.has(event.eventId))) {
      const day = localDate(event.occurredAt, input.timezone), amount = parseRational(event.quantity)
      insist(amount.n >= 0n, 'prepaid_negative_usage')
      days.set(day, addRational(days.get(day) ?? rational(0n), amount))
    }
  } else {
    const price = input.prices[line.priceId!], metric = price.metric!
    const events = input.events.filter(event => event.meterId === metric.sourceId).map(event => ({...event,properties:event.properties ?? {}}))
    const from = zonedStart(line.periodStart, input.timezone), to = zonedStart(line.periodEnd, input.timezone)
    const active = line.evidence.activeIntervals as {from:number;to:number}[]
    for (let date = line.periodStart; date < line.periodEnd; date = addDays(date, 1)) {
      const a = zonedStart(date, input.timezone), b = zonedStart(addDays(date, 1), input.timezone)
      const spans = active.map(interval => ({from:Math.max(a,interval.from),to:Math.min(b,interval.to)})).filter(interval => interval.from < interval.to)
      const result = aggregateMetric(metric.plan, events, {from,to,active:spans}).find(row => canonical(row.dimensions) === canonical(metric.dimensions))
      if (result) days.set(date, rational(BigInt(result.exact.numerator), BigInt(result.exact.denominator)))
    }
  }
  const quantity = prepaidQuantity(line), micros = quantity.n * 1000000n / quantity.d
  const weights = [...days].map(([date,weight]) => ({date,weight}))
  return weightedIntegers(micros, weights).map(row => ({date:row.date,unitsN:Number(row.amount)}))
}
