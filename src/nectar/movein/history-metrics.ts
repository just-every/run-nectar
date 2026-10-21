import { intervalRecurringSeries } from '../interval-reports'
// The actual billed recurring series, read once across native and incumbent
// history. Native monthly semantics stay those of reports.mrr; captured service
// schedules supply imported months without reconstructing current plan values.
import type { Bindings } from '../../auth.server'
import { all, insist } from '../core'
import { isDate, isMonth } from '../dates'
import { historicalRevenueInvoices } from './history-revenue'

export interface HistoricalMrrMonth {
  period: string
  amountCents: number
  sourceCount: number
}

const validMonth = (value: unknown): value is string => typeof value === 'string' && isMonth(value) && value >= '0001-01' && value <= '9999-12' && isDate(`${value}-01`)
const monthIndex = (value: string) => Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1
const monthAt = (index: number) => `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`

/** One native scan plus the fixed-read incumbent projection. There is no
 * report recursion, per-invoice query or arbitrary history horizon. The finite
 * calendar-date domain bounds zero filling; malformed dates are refused. */
export async function historicalMrrSeries(env: Bindings, throughMonth: string, customerId: string | null): Promise<HistoricalMrrMonth[]> {
  insist(validMonth(throughMonth), 'invalid_period')
  insist(customerId === null || /^[\w-]{1,100}$/.test(customerId), 'invalid_customer')
  const [native, historical,intervals] = await Promise.all([
    all(env, `SELECT i.id AS invoice_id,substr(i.period_start,1,7) AS period,l.amount_cents
      FROM nc_invoices i JOIN nc_invoice_lines l ON l.invoice_id=i.id
      WHERE i.status='issued' AND i.invoice_kind='recurring' AND i.subscription_id IS NOT NULL
        AND i.billing_key='legacy-monthly-arrears' AND l.kind IN ('flat','seat','usage','overage','metric_usage','discount','cancellation_credit')
        AND substr(i.period_start,1,7)<=? AND (? IS NULL OR i.customer_id=?)
      ORDER BY i.period_start,i.id,l.seq`, throughMonth, customerId, customerId),
    historicalRevenueInvoices(env, null, customerId),
    intervalRecurringSeries(env,throughMonth,customerId),
  ])
  const months = new Map<string, { amount: bigint; sources: Set<string> }>()
  const contribute = (period: unknown, amount: unknown, invoice: unknown) => {
    insist(validMonth(period) && typeof amount === 'number' && Number.isSafeInteger(amount) && typeof invoice === 'string' && invoice.length > 0, 'history_mrr_evidence_required', 409)
    if (period > throughMonth) return
    const month = months.get(period) ?? { amount: 0n, sources: new Set<string>() }
    month.amount += BigInt(amount); month.sources.add(invoice); months.set(period, month)
  }
  for (const line of [...native,...intervals]) contribute(line.period, line.amount_cents, line.invoice_id)
  for (const record of historical) for (const schedule of record.schedules) {
    if (schedule.kind !== 'imported_recurring' && schedule.kind !== 'imported_discount') continue
    for (const entry of schedule.entries) contribute(entry.period, entry.amountCents, record.invoice.id)
  }
  if (!months.size) return []
  const first = [...months.keys()].sort()[0], series: HistoricalMrrMonth[] = []
  for (let index = monthIndex(first); index <= monthIndex(throughMonth); index++) {
    const period = monthAt(index), month = months.get(period), amount = month?.amount ?? 0n
    insist(amount >= BigInt(Number.MIN_SAFE_INTEGER) && amount <= BigInt(Number.MAX_SAFE_INTEGER), 'history_mrr_total_out_of_range', 409)
    series.push({ period, amountCents: Number(amount), sourceCount: month?.sources.size ?? 0 })
  }
  return series
}
