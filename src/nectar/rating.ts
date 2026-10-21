import { usageCreditAllocations } from './usage-correction-records'
import { renewalOperands, RENEWAL_RATING_VERSION, type RenewalRate } from './renewal-rating'
import { metricUsage, METRIC_RATING_VERSION, type MetricPrice } from './metric-rating'
import { commitmentLines, CONTRACT_RATING_VERSION, type ContractBasis } from './commitment-rating'
// Flow 7: deterministic rating. A pure function from one subscription's
// recorded inputs for one period to invoice lines. Same inputs, same lines:
// no clock, no database, no floating point. Rules (RATING_VERSION):
// - fixed and per-seat charges are billed for the days of the period the item
//   is in effect, outside any trial: unit × quantity × days / period days;
// - per-unit usage sums the exact event quantities per price, then multiplies;
// - each line rounds once to cents, half away from zero;
// - a contract discount applies to the fixed and seat lines it covers, rounded
//   per covered line; a one-time credit applies in the period of its start;
// - usage that occurred in an earlier period and was not yet billed is billed
//   as late usage at the price in effect when it occurred;
// - tax is the declared flat rate on the taxable total, rounded once.
import { cancellationLines } from './lifecycle-rating'
import { activeSegments, blockedAt, type LifecycleInterval } from './lifecycle-math'
import { LIFECYCLE_RATING_VERSION } from './lifecycle-records'
import { addDays, daysBetween, formatDate, localDate, periodContaining } from './dates'
import { decimalText, lineCents, micros, percentOf, quantityText } from './decimal'
import { insist } from './core'
import { invoiceTotals } from './invoice-tax'
import { CHARGE_RATING_VERSION, chargeLines, type ChargeIn } from './charge-lines'
import { PRICE_MODEL_RATING_VERSION, rateQuantityPrice, type QuantityPrice } from './price-model'

export const RATING_VERSION = 'nectar-rating-1'

export interface PriceIn { id: string; kind: 'flat' | 'seat' | 'unit'; unitAmount: string; meterId: string | null; taxable: boolean; label: string; unitLabel: string; pricing?: QuantityPrice; metric?:MetricPrice }
export interface ItemIn { id: string; priceId: string; quantity: number; from: string; to: string | null }
export interface AmendmentIn { id: string; kind: 'discount_percent' | 'fixed_credit' | 'price_override'; value: string; priceId: string | null; from: string; to: string | null; note: string }
export interface EventIn { eventId: string; meterId: string; quantity: string; occurredAt: number;properties?:Record<string,import('./metric-plan').PropertyValue>;invoiceId?:string|null }
export interface RatingInput {
  version: string
  invoiceContent?: import('./invoice-content').InvoiceContent
  renewals?: RenewalRate[]
  usageAdjustments?: import('./usage-correction-records').UsageAdjustment[]
  usageCredits?: import('./usage-correction-records').UsageCredit[]
  usageCorrectionPending?: string[]
  usageCorrection?: string
  timezone: string
  tax: { mode: 'undeclared' | 'no_tax' | 'flat_rate'; rate: string; jurisdiction: string; exempt: boolean; exemptRef: string; certificate?: unknown; exception?: Exception | null }
  subscription: { id: string; anchorDay: number; startDate: string; trialEnd: string | null; endDate: string | null; billFrom: string | null }
  period: { start: string; end: string }
  items: ItemIn[]
  prices: Record<string, PriceIn>
  amendments: AmendmentIn[]
  contracts?: ContractBasis
  charges?: ChargeIn[]
  creditGovernance?: {thresholdCents: number | null; revision: number}
  lifecycle?: LifecycleInterval[]
  events: EventIn[]
}

export interface Line { kind: string; description: string; quantity: string; unitAmount: string; amountCents: number; taxable: boolean; priceId: string | null; meterId: string | null; periodStart: string; periodEnd: string; evidence: Record<string, unknown> }
export interface Exception { code: string; message: string; detail?: unknown }
export interface Rating { lines: Line[]; subtotalCents: number; taxCents: number; totalCents: number; exceptions: Exception[]; tax: Record<string, unknown>; consumedEvents: string[] }

const max = (a: string, b: string) => (a > b ? a : b)
const min = (a: string, b: string) => (a < b ? a : b)
const FAR = '9999-12-31'

/** Splits [from, to) at every boundary that falls strictly inside it. */
function split(from: string, to: string, boundaries: (string | null)[]): [string, string][] {
  const cuts = [...new Set(boundaries.filter((b): b is string => !!b && b > from && b < to))].sort()
  const points = [from, ...cuts, to]
  return points.slice(0, -1).map((start, index) => [start, points[index + 1]])
}

const covers = (a: AmendmentIn, from: string, to: string) => a.from <= from && (a.to ?? FAR) >= to
const unitFor = (input: RatingInput, price: PriceIn, from: string, to: string) => {
  const override = input.amendments.find(a => a.kind === 'price_override' && a.priceId === price.id && covers(a, from, to))
  insist(!override || !price.pricing, 'override_price_model')
  return { unit: override ? override.value : price.unitAmount, override }
}

export function rate(input: RatingInput, presentCancellationCredits = true): Rating {
  if(input.renewals?.length){const expanded=renewalOperands(input),result=rate(expanded.input,presentCancellationCredits);return {...result,lines:result.lines.map(expanded.restore)}}
  insist(input.version === RENEWAL_RATING_VERSION || input.version === METRIC_RATING_VERSION || input.version === CONTRACT_RATING_VERSION || input.version === RATING_VERSION || input.version === PRICE_MODEL_RATING_VERSION || input.version === CHARGE_RATING_VERSION || input.version === LIFECYCLE_RATING_VERSION, 'unsupported_rating_version')
  insist(!Object.values(input.prices).some(price => price.pricing) || input.version === RENEWAL_RATING_VERSION || input.version === METRIC_RATING_VERSION || input.version === CONTRACT_RATING_VERSION || input.version === PRICE_MODEL_RATING_VERSION || input.version === CHARGE_RATING_VERSION || input.version === LIFECYCLE_RATING_VERSION, 'unsupported_rating_version')
  const { period, subscription: sub } = input
  const periodDays = BigInt(daysBetween(period.start, period.end))
  const lines: Line[] = [], exceptions: Exception[] = [], consumed: string[] = []
  if (input.invoiceContent?.poRequired && !input.invoiceContent.poNumber) exceptions.push({ code: 'po_required', message: 'A purchase order number is required before this invoice can be approved or issued.' })
  const activeFrom = max(max(period.start, sub.startDate), sub.billFrom ?? period.start)
  const activeTo = min(period.end, sub.endDate ?? FAR)
  const billFrom = sub.trialEnd ? max(activeFrom, sub.trialEnd) : activeFrom
  const trialDays = sub.trialEnd && sub.trialEnd > activeFrom ? daysBetween(activeFrom, min(sub.trialEnd, activeTo)) : 0
  const label = (price: PriceIn) => price.label
  const boundaries = input.amendments.flatMap(a => [a.from, a.to])

  // Fixed and per-seat charges, prorated by days in effect.
  const recurring: { line: Line; from: string; to: string }[] = []
  for (const item of [...input.items].sort((a, b) => a.from.localeCompare(b.from) || a.id.localeCompare(b.id))) {
    const price = input.prices[item.priceId]
    if (!price || price.kind === 'unit') continue
    const from = max(item.from, billFrom), to = min(item.to ?? FAR, activeTo)
    if (from >= to) continue
    for (const [activeStart, activeEnd] of activeSegments(from, to, input.lifecycle ?? [])) for (const [start, end] of split(activeStart, activeEnd, boundaries)) {
      const days = BigInt(daysBetween(start, end))
      const { unit, override } = unitFor(input, price, start, end)
      const quantity = BigInt(item.quantity) * 1_000_000n
      const modeled = price.pricing ? rateQuantityPrice(price.pricing, quantity, days, periodDays) : null
      const amount = modeled ? BigInt(modeled.amountCents) : lineCents(micros(unit), quantity, days, periodDays)
      const prorated = days !== periodDays
      const line: Line = {
        kind: price.kind, quantity: String(item.quantity), unitAmount: modeled ? '' : unit, amountCents: Number(amount), taxable: price.taxable, priceId: price.id, meterId: null, periodStart: start, periodEnd: end,
        description: `${label(price)}${price.kind === 'seat' ? ` × ${item.quantity} seat${item.quantity === 1 ? '' : 's'}` : ''}${prorated ? ` (${days} of ${periodDays} days)` : ''}${override ? ' at contract price' : ''}`,
        evidence: modeled ? { ...modeled.evidence, item: item.id } : { rule: prorated ? 'unit × quantity × days ÷ period days, rounded half away from zero' : 'unit × quantity', item: item.id, days: Number(days), periodDays: Number(periodDays), unit, quantity: item.quantity, override: override?.id ?? null },
      }
      lines.push(line)
      recurring.push({ line, from: start, to: end })
    }
  }

  // Contract discounts on the fixed and seat lines they cover.
  for (const amendment of input.amendments.filter(a => a.kind === 'discount_percent')) {
    const covered = recurring.filter(entry => covers(amendment, entry.from, entry.to))
    if (!covered.length) continue
    const parts = covered.map(entry => ({ line: entry.line.description, cents: -Number(percentOf(BigInt(entry.line.amountCents), micros(amendment.value))), taxable: entry.line.taxable }))
    for (const taxable of [true, false]) {
      const group = parts.filter(part => part.taxable === taxable)
      if (!group.length) continue
      lines.push({ kind: 'discount', description: `Contract discount ${amendment.value}%${amendment.note ? ` (${amendment.note})` : ''}`, quantity: '1', unitAmount: '', amountCents: group.reduce((sum, part) => sum + part.cents, 0), taxable, priceId: null, meterId: null, periodStart: period.start, periodEnd: period.end, evidence: { rule: 'percent of each covered line, rounded half away from zero per line', amendment: amendment.id, percent: amendment.value, parts: group } })
    }
  }

  // One-time contract credits, in the period where they start.
  const creditDate = (date: string) => {
    let effective = date
    for (const interval of [...(input.lifecycle ?? [])].sort((a,b) => a.from.localeCompare(b.from)))
      if (interval.from <= effective && (interval.to ?? FAR) > effective) effective = interval.to ?? FAR
    return effective
  }
  for (const amendment of input.amendments.filter(a => a.kind === 'fixed_credit' && creditDate(a.from) >= period.start && creditDate(a.from) < period.end)) {
    const amount = Number(lineCents(micros(amendment.value), 1_000_000n))
    lines.push({ kind: 'credit', description: `Contract credit${amendment.note ? ` (${amendment.note})` : ''}`, quantity: '1', unitAmount: amendment.value, amountCents: -amount, taxable: true, priceId: null, meterId: null, periodStart: period.start, periodEnd: period.end, evidence: { rule: 'one-time credit in the period it starts', amendment: amendment.id } })
  }

  // Usage: group by (original period, price in effect, override), sum exactly, then rate.
  const metricResult=metricUsage(input)
  lines.push(...metricResult.lines);exceptions.push(...metricResult.exceptions);consumed.push(...metricResult.consumed)
  const metricSources=new Set(Object.values(input.prices).flatMap(p=>p.metric?[p.metric.sourceId]:[]))
  const groups = new Map<string, { late: boolean; start: string; end: string; price: PriceIn; unit: string; override: string | null; trial: boolean; paused: boolean; events: EventIn[] }>()
  const unrated: EventIn[] = []
  for (const event of [...input.events].sort((a, b) => a.occurredAt - b.occurredAt || a.eventId.localeCompare(b.eventId))) {
    if(event.invoiceId)continue
    if(metricSources.has(event.meterId)&&!input.items.some(i=>!input.prices[i.priceId]?.metric&&input.prices[i.priceId]?.meterId===event.meterId))continue
    const date = localDate(event.occurredAt, input.timezone)
    const item = input.items.find(candidate => input.prices[candidate.priceId]?.meterId === event.meterId && candidate.from <= date && (candidate.to ?? FAR) > date)
    const inactive = blockedAt(date, input.lifecycle ?? []).length > 0
    const startOk = date >= max(sub.startDate, sub.billFrom ?? sub.startDate) && (date < (sub.endDate ?? FAR) || inactive)
    if (!item || !startOk || date >= period.end) { if (date < period.end) unrated.push(event); continue }
    const price = input.prices[item.priceId]
    const late = date < period.start
    const window = late ? periodContaining(sub.anchorDay, date) : period
    const trial = !!sub.trialEnd && date < sub.trialEnd
    const { unit, override } = unitFor(input, price, date, addDays(date, 1))
    const paused = inactive
    const key = [window.start, price.id, unit, trial, paused].join('|')
    const group = groups.get(key) ?? { late, start: window.start, end: window.end, price, unit, override: override?.id ?? null, trial, paused, events: [] }
    group.events.push(event)
    groups.set(key, group)
  }
  const allowances=new Map<string,bigint>()
  for (const group of [...groups.values()].sort((a, b) => a.start.localeCompare(b.start) || a.price.id.localeCompare(b.price.id))) {
    const total = group.events.reduce((sum, event) => sum + micros(event.quantity, 'quantity'), 0n)
    const allowance=input.contracts?.included.find(a=>a.price===group.price.id && a.from<=group.start && a.to>=group.end)
    const allowanceKey=[group.price.id,group.start].join('|')
    const usedBefore=(input.contracts?.invoices??[]).flatMap(i=>i.lines).filter(l=>l.priceId===group.price.id&&l.periodStart===group.start&&l.evidence.includedQuantity).reduce((n,l)=>n+micros(String(l.evidence.includedQuantity)),0n)
    const originalAllowance=allowance?micros(allowance.quantity):0n
    const available=originalAllowance>usedBefore?originalAllowance-usedBefore:0n
    const left=allowance?(allowances.get(allowanceKey)??available):0n
    const included=group.trial||group.paused?0n:total<left?total:left
    if(allowance&&!group.trial&&!group.paused)allowances.set(allowanceKey,left-included)
    const billable=total-included
    const modeled = group.price.pricing ? rateQuantityPrice(group.price.pricing, billable) : null
    const amount = group.trial || group.paused ? 0n : modeled ? BigInt(modeled.amountCents) : lineCents(micros(group.unit), billable)
    consumed.push(...group.events.map(event => event.eventId))
    lines.push({
      kind: group.paused ? 'paused_usage' : group.trial ? 'trial_usage' : group.late ? 'late_usage' : allowance ? 'overage' : 'usage',
      description: `${group.late ? `Late usage from the period starting ${formatDate(group.start)}: ` : ''}${group.price.label} — ${quantityText(decimalText(billable))} ${group.price.unitLabel}${group.paused ? ' while inactive (not charged)' : group.trial ? ' during trial (not charged)' : ''}`,
      quantity: decimalText(billable), unitAmount: modeled ? '' : group.unit, amountCents: Number(amount), taxable: group.price.taxable, priceId: group.price.id, meterId: group.price.meterId, periodStart: group.start, periodEnd: group.end,
      evidence: { ...(allowance?{contract:allowance.contract,rawQuantity:decimalText(total),includedQuantity:decimalText(included),billableQuantity:decimalText(billable)}:{}), ...(modeled ? modeled.evidence : { rule: 'sum of event quantities × unit, rounded half away from zero once' }), ...(group.paused ? { rule: 'usage while paused or canceled is recorded and not charged' } : {}), ...(group.trial ? { rule: 'usage during a trial is recorded and not charged', unchargedAmountCents: modeled?.amountCents } : {}), events: group.events.length, eventIds: group.events.map(event => event.eventId), first: new Date(group.events[0].occurredAt).toISOString(), last: new Date(group.events[group.events.length - 1].occurredAt).toISOString(), override: group.override, late: group.late },
    })
  }
  if (unrated.length) exceptions.push({ code: 'unrated_usage', message: `${unrated.length} usage event(s) for this customer have no metered price in effect when they occurred; they are not billed.`, detail: unrated.map(event => event.eventId) })
  if (trialDays > 0) lines.push({ kind: 'trial', description: `Trial: ${trialDays} day(s) not charged`, quantity: String(trialDays), unitAmount: '', amountCents: 0, taxable: false, priceId: null, meterId: null, periodStart: activeFrom, periodEnd: min(sub.trialEnd!, activeTo), evidence: { rule: 'fixed and seat charges start when the trial ends', trialEnd: sub.trialEnd } })

  if (input.charges) lines.push(...chargeLines(input.charges))
  const finalLines = presentCancellationCredits ? cancellationLines(input, lines, input => rate(input, false)) : lines
  const committed=commitmentLines(input,finalLines)
  const adjustments=input.usageAdjustments??[]
  const correctedLines=[...committed.lines,...adjustments.map(a=>a.line)]
  const totals = invoiceTotals(input.tax, correctedLines)
  // Historical lines are not taxed at today's rate. Their exact signed saved
  // tax deltas are added once, even when ordinary charges have different tax.
  const correctionTax=adjustments.reduce((n,a)=>n+a.taxCents,0)
  totals.taxCents+=correctionTax;totals.totalCents+=correctionTax
  if(adjustments.length)totals.tax.historicalCorrectionTaxCents=correctionTax
  insist([totals.subtotalCents,totals.taxCents,totals.totalCents].every(Number.isSafeInteger),'correction_amount_out_of_range')
  if(input.usageCorrectionPending?.length)exceptions.push({code:'usage_correction_pending',message:'A historical usage correction awaits a human decision. Resolve it before issuing.',detail:input.usageCorrectionPending})
  const applicationLines:Line[]=usageCreditAllocations(input.usageCredits??[],totals.totalCents).map(c=>({kind:'usage_credit_application',description:`Carried historical correction ${c.number}: ${c.amountCents} cents applied after invoice total`,quantity:'1',unitAmount:'',amountCents:0,taxable:false,priceId:null,meterId:null,periodStart:period.start,periodEnd:period.end,evidence:{credit:c.id,correction:c.correction,appliedCents:c.amountCents,source:c.source,rule:'Customer liability application; not new consideration, tax or revenue'}}))
  return { ...totals, lines: [...correctedLines,...applicationLines], exceptions: [...exceptions, ...committed.exceptions, ...totals.exceptions], consumedEvents: [...new Set(consumed)] }
}
