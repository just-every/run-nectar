// Threshold consideration is an advance settlement of cumulative usage, never
// consumption of its source events. The ordinary bill still rates the complete
// window, including nonlinear tiers and included quantities, before subtracting
// the exact consideration and tax already issued.
import { insist } from './core'
import { all, guard, parseJson } from './core'
import type { Bindings } from '../auth.server'
import { requireBusiness } from './business'
import { localDate } from './dates'
import type { RevenueMonthEntry } from './revenue-usage'
import type { Line, Rating, RatingInput } from './rating'
import { usageCreditApplicationLines } from './usage-correction-records'

interface SettlementCredit {
  id: string
  amountCents: number
  subtotalCents: number | null
  taxCents: number | null
  issuedAt: number
  revenue: { date: string; amountCents: number; basis: string } | null
}

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
  originalSubtotalCents: number
  originalTaxCents: number
  credits: SettlementCredit[]
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
  // Ordinary rating includes every earlier unconsumed usage event. Its advance
  // consideration must follow it even when the original remainder was skipped.
  const rows = await all(env, `SELECT * FROM nc_threshold_settlements WHERE subscription_id=? AND remainder_invoice_id IS NULL
    AND period_start<? ORDER BY cutoff_at,invoice_id`, subscription, period.end)
  insist(rows.every(row => row.period_end <= period.end), 'threshold_window_unsupported', 409)
  if (!rows.length) return []
  const business = await requireBusiness(env)
  const credits = await all(env, `SELECT n.*,r.recognition_date,r.amount_cents AS revenue_cents,r.basis_json AS revenue_basis
    FROM nc_credit_notes n JOIN nc_threshold_settlements s ON s.invoice_id=n.invoice_id
    LEFT JOIN nc_revenue_credits r ON r.credit_id=n.id
    WHERE s.subscription_id=? AND s.remainder_invoice_id IS NULL AND s.period_start<? ORDER BY n.issued_at,n.id`, subscription, period.end)
  return rows.map(row => {
    const notes: SettlementCredit[] = credits.filter(note => note.invoice_id === row.invoice_id).map(note => ({
      id: note.id, amountCents: note.amount_cents, subtotalCents: note.subtotal_cents, taxCents: note.tax_cents, issuedAt: note.issued_at,
      revenue: note.recognition_date ? { date: note.recognition_date, amountCents: note.revenue_cents, basis: note.revenue_basis } : null,
    }))
    const subtotalCents = row.subtotal_cents - notes.reduce((sum, note) => sum + (note.subtotalCents ?? note.amountCents), 0)
    const taxCents = row.tax_cents - notes.reduce((sum, note) => sum + (note.taxCents ?? 0), 0)
    insist([subtotalCents, taxCents].every(Number.isSafeInteger) && subtotalCents >= 0 && taxCents >= 0, 'threshold_credit_attribution_unsupported', 409)
    const revenueEntries = [...parseJson<RevenueMonthEntry[]>(row.revenue_json, []), ...notes.map(note => ({
      period: note.revenue?.date.slice(0, 7) ?? localDate(note.issuedAt, business.timezone).slice(0, 7),
      amountCents: note.revenue?.amountCents ?? -(note.subtotalCents ?? note.amountCents),
      basis: { method: 'issued-threshold-credit', credit: note.id, original: note.revenue ? parseJson(note.revenue.basis, {}) : { issuedAt: note.issuedAt } },
    }))]
    insist(revenueEntries.reduce((sum, entry) => sum + entry.amountCents, 0) === subtotalCents, 'threshold_credit_revenue_mismatch', 409)
    return { invoice: row.invoice_id, crossing: row.crossing_id, sourceFingerprint: row.source_fingerprint,
      from: row.period_start, to: row.period_end, cutoff: row.cutoff_at, subtotalCents, taxCents, revenueEntries,
      originalSubtotalCents: row.subtotal_cents, originalTaxCents: row.tax_cents, credits: notes }
  })
}

export function priorSettlementGuards(env: Bindings, subscription: string, period: { start: string; end: string }, saved: ThresholdSettlement[], currentWindowOnly = false) {
  return [guard(env, 'source_changed', `SELECT COUNT(*)=? FROM nc_threshold_settlements WHERE subscription_id=? AND remainder_invoice_id IS NULL
    AND period_start<? ${currentWindowOnly ? 'AND period_start>=?' : ''}`, saved.length, subscription, period.end, ...(currentWindowOnly ? [period.start] : [])),
  ...saved.flatMap(prior => [
    guard(env, 'source_changed', `EXISTS(SELECT 1 FROM nc_threshold_settlements WHERE invoice_id=? AND source_fingerprint=?
      AND subtotal_cents=? AND tax_cents=? AND remainder_invoice_id IS NULL)`, prior.invoice, prior.sourceFingerprint, prior.originalSubtotalCents, prior.originalTaxCents),
    guard(env, 'source_changed', '(SELECT COUNT(*) FROM nc_credit_notes WHERE invoice_id=?)=?', prior.invoice, prior.credits.length),
    ...prior.credits.flatMap(note => [
      guard(env, 'source_changed', `EXISTS(SELECT 1 FROM nc_credit_notes WHERE id=? AND invoice_id=? AND amount_cents=?
        AND subtotal_cents IS ? AND tax_cents IS ? AND issued_at=?)`, note.id, prior.invoice, note.amountCents, note.subtotalCents, note.taxCents, note.issuedAt),
      note.revenue ? guard(env, 'source_changed', `EXISTS(SELECT 1 FROM nc_revenue_credits WHERE credit_id=? AND recognition_date=? AND amount_cents=? AND basis_json=?)`,
        note.id, note.revenue.date, note.revenue.amountCents, note.revenue.basis)
        : guard(env, 'source_changed', 'NOT EXISTS(SELECT 1 FROM nc_revenue_credits WHERE credit_id=?)', note.id),
    ]),
  ])]
}

export function thresholdSettlementLines(settlements: ThresholdSettlement[]): Line[] {
  return settlements.map(saved => ({
    kind: 'threshold_settlement', description: 'Previously invoiced usage threshold consideration',
    quantity: '1', unitAmount: '', amountCents: -saved.subtotalCents, taxable: false,
    priceId: null, meterId: null, periodStart: saved.from, periodEnd: saved.to,
    evidence: { rule: 'subtract exact issued consideration once after complete cumulative rating; original tax is subtracted separately',
      thresholdInvoice: saved.invoice, crossing: saved.crossing, sourceFingerprint: saved.sourceFingerprint,
      originalSubtotalCents: saved.originalSubtotalCents, originalTaxCents: saved.originalTaxCents,
      credits: saved.credits,
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
    lines: [...rating.lines.filter(line => line.kind !== 'usage_credit_application'), ...thresholdSettlementLines(settlements),
      ...usageCreditApplicationLines(input.usageCredits ?? [], totalCents, input.period)], exceptions,
    tax: { ...rating.tax, thresholdSettlementTaxCents: -tax, thresholdInvoices: settlements.map(saved => saved.invoice) } }
}
