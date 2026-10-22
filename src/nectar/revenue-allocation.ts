import { prepaidRecognitionForLine } from './prepaid-revenue'
// Pure, versioned recognition of the saved once-rounded invoice consideration.
import { insist, type Row } from './core'
import { addDays, addMonths, daysBetween, isDate, validTimeZone } from './dates'
import { roundHalfAway } from './decimal'
import type { Line, Rating, RatingInput } from './rating'
import { revenueMonths, usageRevenueEntries, type RevenueInput, type RevenueMonthEntry } from './revenue-usage'
import { calendarRecognition, CALENDAR_REVENUE_POLICY_VERSION } from './calendar-recognition'

export type { RevenueInput, RevenueMonthEntry } from './revenue-usage'
export const REVENUE_POLICY_VERSION = 'nectar-revenue-1'
export interface RevenueSchedule {
  lineId: string
  kind: string
  amountCents: number
  serviceStart: string
  serviceEnd: string
  policy: string
  entries: RevenueMonthEntry[]
  basis: Row
}
const ratableKinds = new Set(['flat', 'seat', 'discount', 'credit'])
const usageKinds = new Set(['usage', 'late_usage', 'overage', 'metric_usage'])
const zeroKinds = new Set(['trial', 'trial_usage', 'paused_usage','usage_credit_application'])
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value)
const safe = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)

function validateLine(line: Line) {
  insist(object(line) && typeof line.kind === 'string' && safe(line.amountCents) && object(line.evidence), 'revenue_invalid_line', 409)
  revenueMonths(line.periodStart, line.periodEnd)
}

function ratableEntries(line: Line): RevenueMonthEntry[] {
  const calendar = calendarRecognition(line)
  if (calendar) return calendar
  const totalDays = daysBetween(line.periodStart, line.periodEnd), amount = BigInt(line.amountCents)
  return revenueMonths(line.periodStart, line.periodEnd).map(period => {
    const from = `${period}-01` > line.periodStart ? `${period}-01` : line.periodStart
    const boundary = addMonths(`${period}-01`, 1), to = boundary < line.periodEnd ? boundary : line.periodEnd
    const elapsedBefore = daysBetween(line.periodStart, from), elapsedAfter = daysBetween(line.periodStart, to)
    const before = roundHalfAway(amount * BigInt(elapsedBefore), BigInt(totalDays))
    const after = roundHalfAway(amount * BigInt(elapsedAfter), BigInt(totalDays))
    return { period, amountCents: Number(after - before), basis: { method: 'cumulative-half-away-calendar-days', from, to, totalDays, elapsedBefore, elapsedAfter, cumulativeBeforeCents: Number(before), cumulativeAfterCents: Number(after) } }
  })
}

function cancellationEntries(line: Line): RevenueMonthEntry[] {
  const months = new Map<string, { amount: bigint; components: Row[] }>()
  let expected = 0n
  for (const [side, sign] of [['earned', 1n], ['gross', -1n]] as const) {
    const rows = line.evidence[side]
    insist(Array.isArray(rows), 'revenue_cancellation_evidence_required', 409)
    for (const [index, value] of rows.entries()) {
      const component = value as Line
      validateLine(component)
      insist(['flat', 'seat', 'discount'].includes(component.kind) && component.taxable === line.taxable && component.periodStart >= line.periodStart && component.periodEnd <= line.periodEnd, 'revenue_cancellation_component_invalid', 409)
      expected += sign * BigInt(component.amountCents)
      for (const entry of ratableEntries(component)) {
        const bucket = months.get(entry.period) ?? { amount: 0n, components: [] }
        bucket.amount += sign * BigInt(entry.amountCents)
        bucket.components.push({ side, index, source: `/evidence/${side}/${index}`, amountCents: Number(sign * BigInt(entry.amountCents)), basis: entry.basis })
        months.set(entry.period, bucket)
      }
    }
  }
  insist(expected === BigInt(line.amountCents), 'revenue_cancellation_amount_mismatch', 409)
  return revenueMonths(line.periodStart, line.periodEnd).map(period => {
    const bucket = months.get(period)
    return { period, amountCents: Number(bucket ? bucket.amount : 0n), basis: { method: 'earned-minus-gross-schedules', components: bucket ? bucket.components : [] } }
  })
}

/** Every current kind is explicit. Unsupported kinds or missing evidence refuse;
 * neither invoice date nor current catalogue values substitute for source facts. */
export function recognitionForLine(line: Line, input: RevenueInput, lineId: string): RevenueSchedule {
  validateLine(line)
  insist(typeof lineId === 'string' && lineId.length > 0 && validTimeZone(input.timezone), 'revenue_context_required', 409)
  const prepaid = prepaidRecognitionForLine(line, input, lineId)
  if (prepaid) return prepaid
  let entries: RevenueMonthEntry[], policy: string
  if (line.kind==='usage_correction') {
    const saved=line.evidence.revenueEntries
    insist(typeof line.evidence.correction==='string' && Array.isArray(saved) && saved.length>0,'revenue_correction_evidence_required',409)
    entries=saved as RevenueMonthEntry[];policy='historical-usage-replay-delta'
    insist(entries.every(e=>/^\d{4}-(0[1-9]|1[0-2])$/.test(e.period)&&safe(e.amountCents)&&object(e.basis)),'revenue_correction_evidence_required',409)
  }
  else if (ratableKinds.has(line.kind)) { entries = ratableEntries(line); policy = entries.some(entry => entry.basis.version === CALENDAR_REVENUE_POLICY_VERSION) ? 'ratable-contract-months-v2' : 'ratable-service-days' }
  else if (usageKinds.has(line.kind)) { policy = 'consumption-quantity-largest-remainder'; entries = usageRevenueEntries(input, line, lineId) }
  else if (line.kind === 'cancellation_credit') { policy = 'earned-minus-gross'; entries = cancellationEntries(line) }
  else if (line.kind === 'one_time') {
    insist(addDays(line.periodStart, 1) === line.periodEnd && typeof line.evidence.charge === 'string', 'revenue_one_time_service_evidence_required', 409)
    policy = 'one-time-service-date'
    entries = [{ period: line.periodStart.slice(0, 7), amountCents: line.amountCents, basis: { method: policy, recognitionDate: line.periodStart, chargeId: line.evidence.charge } }]
  } else if (line.kind === 'commitment_trueup') {
    const evidence = line.evidence
    insist(typeof evidence.contract === 'string' && [evidence.minimumCents, evidence.earnedCents, evidence.previouslySettledCents].every(value => safe(value) && value >= 0) && line.amountCents === Math.max(0, Number(evidence.minimumCents) - Number(evidence.earnedCents) - Number(evidence.previouslySettledCents)), 'revenue_commitment_settlement_evidence_required', 409)
    policy = 'unused-minimum-at-settlement'
    // periodEnd is the exclusive contractual expiry/early-settlement date, not
    // the preceding service day; no unused minimum is recognized before expiry.
    entries = [{ period: line.periodEnd.slice(0, 7), amountCents: line.amountCents, basis: { method: policy, recognitionDate: line.periodEnd, contractId: evidence.contract, minimumCents: evidence.minimumCents, earnedCents: evidence.earnedCents, previouslySettledCents: evidence.previouslySettledCents } }]
  } else {
    insist(zeroKinds.has(line.kind) && line.amountCents === 0, 'revenue_unsupported_line_kind', 409, { kind: line.kind })
    policy = 'zero-consideration'
    entries = revenueMonths(line.periodStart, line.periodEnd).map(period => ({ period, amountCents: 0, basis: { method: policy } }))
  }
  insist(entries.length > 0 && entries.every(entry => safe(entry.amountCents)) && entries.reduce((sum, entry) => sum + BigInt(entry.amountCents), 0n) === BigInt(line.amountCents), 'revenue_line_does_not_reconcile', 409)
  return { lineId, kind: line.kind, amountCents: line.amountCents, serviceStart: line.periodStart, serviceEnd: line.periodEnd, policy,
    entries, basis: { version: REVENUE_POLICY_VERSION, timezone: input.timezone, lineKind: line.kind, quantity: line.quantity, unitAmount: line.unitAmount, priceId: line.priceId, meterId: line.meterId, evidence: line.evidence } }
}

export function recognitionForRating(input: RatingInput, rating: Pick<Rating, 'lines' | 'subtotalCents'>, lineIds?: readonly string[]): RevenueSchedule[] {
  insist(Array.isArray(rating.lines) && safe(rating.subtotalCents), 'revenue_rating_required', 409)
  insist(lineIds === undefined || lineIds.length === rating.lines.length && new Set(lineIds).size === lineIds.length, 'revenue_line_id_mismatch', 409)
  const schedules = rating.lines.map((line, index) => recognitionForLine(line, input, lineIds ? lineIds[index] : `line:${index + 1}`))
  insist(schedules.reduce((sum, schedule) => sum + BigInt(schedule.amountCents), 0n) === BigInt(rating.subtotalCents), 'revenue_invoice_does_not_reconcile', 409)
  return schedules
}

/** Supports raw D1 rows and the existing invoice-detail JSON representation. */
export function savedRevenueLine(row: Row): Line {
  const evidence = typeof row.evidence_json === 'string' ? JSON.parse(row.evidence_json) : row.evidence
  insist(object(evidence) && typeof row.description === 'string' && typeof row.quantity === 'string' && typeof row.unit_amount === 'string' && [true, false, 0, 1].includes(row.taxable), 'revenue_saved_line_evidence_required', 409)
  const line: Line = { kind: row.kind, description: row.description, quantity: row.quantity, unitAmount: row.unit_amount, amountCents: row.amount_cents,
    taxable: row.taxable === true || row.taxable === 1, priceId: row.price_id, meterId: row.meter_id, periodStart: row.period_start, periodEnd: row.period_end, evidence }
  validateLine(line)
  return line
}

export function recognitionForSavedInvoice(invoice: Row, lines: readonly Row[], timezone: string): RevenueSchedule[] {
  insist(invoice.status === 'issued' && typeof invoice.id === 'string' && safe(invoice.subtotal_cents) && Array.isArray(lines), 'revenue_issued_invoice_required', 409)
  const calculation = typeof invoice.calculation_json === 'string' ? JSON.parse(invoice.calculation_json) : invoice.calculation
  insist(object(calculation) && object(calculation.inputs), 'revenue_saved_calculation_required', 409)
  const inputs = calculation.inputs
  insist(typeof inputs.timezone === 'string' || invoice.invoice_kind === 'manual', 'revenue_saved_timezone_required', 409)
  const input: RevenueInput = { timezone: typeof inputs.timezone === 'string' ? inputs.timezone : timezone,
    ...(inputs.events === undefined ? {} : { events: inputs.events }), ...(inputs.period === undefined ? {} : { period: inputs.period }) }
  insist(lines.every(line => typeof line.id === 'string' && (line.invoice_id === undefined || line.invoice_id === invoice.id)) && new Set(lines.map(line => line.id)).size === lines.length, 'revenue_saved_line_ownership_mismatch', 409)
  const schedules = lines.map(row => {
    const line=savedRevenueLine(row)
    if(!inputs.consolidation)return recognitionForLine(line,input,row.id)
    const provenance=line.evidence.hierarchy
    insist(object(provenance),'revenue_division_source_required',409)
    const section=inputs.consolidation.sections?.find((s:Row)=>s.sourceInvoice===provenance.sourceInvoice&&s.customer===provenance.child)
    insist(section&&object(section.calculation?.inputs),'revenue_division_source_required',409)
    const original=section.calculation.inputs
    insist(typeof original.timezone==='string','revenue_saved_timezone_required',409)
    return recognitionForLine(line,{timezone:original.timezone,...(original.events?{events:original.events}:{}),...(original.period?{period:original.period}:{})},row.id)
  })
  insist(schedules.reduce((sum, schedule) => sum + BigInt(schedule.amountCents), 0n) === BigInt(invoice.subtotal_cents), 'revenue_invoice_does_not_reconcile', 409)
  return schedules
}
