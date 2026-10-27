// Threshold consideration is an advance settlement of cumulative usage, never
// consumption of its source events. The ordinary bill still rates the complete
// window, including nonlinear tiers and included quantities, before subtracting
// the exact consideration and tax already issued.
import { insist } from './core'
import { all, parseJson } from './core'
import type { Bindings } from '../auth.server'
import type { RevenueMonthEntry } from './revenue-usage'
import type { Line, Rating, RatingInput } from './rating'

export interface ThresholdSettlement {
  invoice: string
  crossing: string
  sourceFingerprint: string
  from: string
  to: string
  cutoff: number
  subtotalCents: number
  taxCents: number
  revenueEntries: RevenueMonthEntry[]
}

export interface ThresholdInvoiceBasis {
  crossing: string
  threshold: string
  thresholdRevision: string
  cutoff: number
  scope: { customer: string; subscription: string; from: string; to: string }
  eventIds: string[]
  subscriptionRevision: string
  customerRevision: string
  businessRevision: number
}

export async function thresholdSettlements(env: Bindings, subscription: string, period: { start: string; end: string }): Promise<ThresholdSettlement[]> {
  const rows = await all(env, `SELECT * FROM nc_threshold_settlements WHERE subscription_id=? AND remainder_invoice_id IS NULL
    AND period_start<? AND period_end>? ORDER BY cutoff_at,invoice_id`, subscription, period.end, period.start)
  insist(rows.every(row => row.period_start >= period.start && row.period_end <= period.end), 'threshold_window_unsupported', 409)
  return rows.map(row => ({ invoice: row.invoice_id, crossing: row.crossing_id, sourceFingerprint: row.source_fingerprint,
    from: row.period_start, to: row.period_end, cutoff: row.cutoff_at, subtotalCents: row.subtotal_cents,
    taxCents: row.tax_cents, revenueEntries: parseJson<RevenueMonthEntry[]>(row.revenue_json, []) }))
}

export function thresholdSettlementLines(settlements: ThresholdSettlement[]): Line[] {
  return settlements.map(saved => ({
    kind: 'threshold_settlement', description: 'Previously invoiced usage threshold consideration',
    quantity: '1', unitAmount: '', amountCents: -saved.subtotalCents, taxable: false,
    priceId: null, meterId: null, periodStart: saved.from, periodEnd: saved.to,
    evidence: { rule: 'subtract exact issued consideration once after complete cumulative rating; original tax is subtracted separately',
      thresholdInvoice: saved.invoice, crossing: saved.crossing, sourceFingerprint: saved.sourceFingerprint,
      originalSubtotalCents: saved.subtotalCents, originalTaxCents: saved.taxCents,
      revenueEntries: saved.revenueEntries.map(entry => ({ ...entry, amountCents: -entry.amountCents,
        basis: { method: 'reverse-issued-threshold-consideration', invoice: saved.invoice, original: entry.basis } })) },
  }))
}

export function settleThresholdConsideration(input: RatingInput, rating: Rating): Rating {
  if (input.thresholdInvoice) rating = { ...rating, consumedEvents: [] }
  const settlements = input.thresholdSettlements ?? []
  if (!settlements.length) return rating
  insist(new Set(settlements.map(saved => saved.invoice)).size === settlements.length, 'threshold_duplicate_settlement', 409)
  const subtotal = settlements.reduce((sum, saved) => sum + saved.subtotalCents, 0)
  const tax = settlements.reduce((sum, saved) => sum + saved.taxCents, 0)
  const subtotalCents = rating.subtotalCents - subtotal, taxCents = rating.taxCents - tax
  const totalCents = subtotalCents + taxCents
  insist([subtotalCents, taxCents, totalCents].every(Number.isSafeInteger), 'threshold_amount_out_of_range', 409)
  const exceptions = [...rating.exceptions]
  if (subtotalCents < 0 || totalCents < 0) exceptions.push({ code: 'negative_total', message: 'Previously issued threshold consideration exceeds the final accrued charges. Resolve the difference with a credit note before issue.' })
  return { ...rating, subtotalCents, taxCents, totalCents,
    lines: [...rating.lines, ...thresholdSettlementLines(settlements)], exceptions,
    tax: { ...rating.tax, thresholdSettlementTaxCents: -tax, thresholdInvoices: settlements.map(saved => saved.invoice) } }
}
