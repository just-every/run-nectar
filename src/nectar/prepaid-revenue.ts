// Purchase consideration remains deferred until its append-only ledger earns it.
import { insist, type Row } from './core'
import type { Line } from './rating'
import type { RevenueInput, RevenueSchedule } from './revenue-allocation'

const safe = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value)
export function prepaidRecognitionForLine(line: Line, input: RevenueInput, lineId: string): RevenueSchedule | null {
  if (!['prepaid_purchase','prepaid_drawdown'].includes(line.kind)) return null
  const purchase = line.kind === 'prepaid_purchase'
  const entries = purchase ? [] : line.evidence.revenueEntries
  insist(purchase ? line.amountCents > 0 && typeof line.evidence.prepaidPurchase === 'string' && line.evidence.purpose === 'prepaid-contract-liability'
    : line.amountCents <= 0 && object(line.evidence.prepaid) && Array.isArray(entries) && entries.length > 0,
    'revenue_prepaid_evidence_required', 409)
  insist(Array.isArray(entries) && entries.every(entry => /^\d{4}-(0[1-9]|1[0-2])$/.test(entry.period) && safe(entry.amountCents) && object(entry.basis)), 'revenue_prepaid_evidence_required', 409)
  insist(purchase || entries.reduce((sum, entry) => sum + BigInt(entry.amountCents), 0n) === BigInt(line.amountCents), 'revenue_prepaid_does_not_reconcile', 409)
  return {lineId,kind:line.kind,amountCents:line.amountCents,serviceStart:line.periodStart,serviceEnd:line.periodEnd,
    policy:purchase?'prepaid-liability-purchase':'prepaid-service-redemption',entries,
    basis:{version:'nectar-prepaid-revenue-1',timezone:input.timezone,lineKind:line.kind,quantity:line.quantity,unitAmount:line.unitAmount,priceId:line.priceId,meterId:line.meterId,evidence:line.evidence,
      ...(purchase?{recognitionCustody:'Append-only original purchase ledger; unconsumed consideration remains deferred.'}:{})}}
}
export function recognizedPrepaidPurchase(schedule: RevenueSchedule, rows: Row[]): RevenueSchedule {
  if (schedule.kind !== 'prepaid_purchase') return schedule
  const selected = rows.filter(row => row.purchase_line_id === schedule.lineId)
  insist(new Set(selected.map(row => row.id)).size === selected.length && selected.every(row => safe(row.recognition_cents) && /^\d{4}-\d{2}-\d{2}$/.test(row.service_date)), 'revenue_prepaid_ledger_invalid', 409)
  const recognized = selected.reduce((sum, row) => sum + BigInt(row.recognition_cents), 0n)
  insist(recognized >= 0n && recognized <= BigInt(schedule.amountCents), 'revenue_prepaid_liability_overdrawn', 409)
  return {...schedule,entries:selected.map(row => ({period:row.service_date.slice(0,7),amountCents:row.recognition_cents,
    basis:{method:'append-only-prepaid-purchase-recognition',entry:row.id,grant:row.grant_id,recognitionDate:row.service_date,serviceInvoice:row.service_invoice_id,
      source:`/app/prepaid/${row.subscription_id}/entries/${encodeURIComponent(row.id)}`}}))}
}
