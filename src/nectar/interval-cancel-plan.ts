// Cancellation corrections replay only immutable issued advance-service inputs.
import type { Bindings } from '../auth.server'
import { all, fingerprint, insist, parseJson, type Row } from './core'
import { invoiceTotals } from './invoice-tax'
import { rate, rateIntervalService, type Line, type RatingInput } from './rating'
import { expandBillingWindows } from './interval-rating'
import { billingServiceWindows, composeBillingWindows } from './billing-composition'
import { BALANCE_SQL } from './receivables'
import { recognitionForLine } from './revenue-allocation'

const recurring = (line: Line) => ['flat', 'seat', 'discount', 'cancellation_credit'].includes(line.kind)

/** Bypass window validation only after retaining and validating the original
 * window. A cancellation changes earned service, never its saved denominator. */
function earnedInput(input: RatingInput, date: string, transition: string): RatingInput {
  return { ...input,
    subscription: { ...input.subscription, endDate: date }, events: [], charges: [], usageAdjustments: [], usageCredits: [],
    amendments: input.amendments.filter(amendment => amendment.kind !== 'fixed_credit'),
    lifecycle: [...input.lifecycle ?? [], { id: transition, kind: 'cancellation', from: date, to: null, access: 'suspend', creditUnused: true }] }
}

function revenueDeltas(before: Line[], after: Line[], input: RatingInput) {
  const amounts = new Map<string, number>()
  for (const [lines, sign] of [[before, -1], [after, 1]] as const) for (const [index, line] of lines.entries()) {
    const schedule = recognitionForLine(line, input, `cancellation:${sign}:${index}`)
    for (const entry of schedule.entries) amounts.set(entry.period, (amounts.get(entry.period) ?? 0) + sign * entry.amountCents)
  }
  return [...amounts].sort(([a], [b]) => a.localeCompare(b)).map(([period, deltaCents]) => ({ period, deltaCents }))
}

export async function cancellationPlan(env: Bindings, subscription: string, date: string, transition: string, creditUnused: boolean) {
  const invoices = await all(env, `SELECT i.*,${BALANCE_SQL} AS balance_cents FROM nc_invoices i WHERE i.subscription_id=? AND i.status='issued' AND i.period_end>? ORDER BY i.period_start,i.id`, subscription, date)
  const credits = []
  for (const invoice of invoices) {
    const saved = parseJson<Row>(invoice.calculation_json, {}), input = saved.inputs as RatingInput
    insist(input?.billing, 'period_already_invoiced', 409)
    const windows = billingServiceWindows(input.billing)
    const future = windows.filter(window => window.period.end > date)
    // A combined invoice can contain already-earned arrears alongside future
    // advance service. Only the latter is corrected; issued future arrears
    // still cannot silently lose service through this cancellation door.
    insist(future.every(window => window.terms.timing === 'advance'), 'period_already_invoiced', 409)
    const before = rate(input)
    insist(before.subtotalCents === invoice.subtotal_cents && before.taxCents === invoice.tax_cents && before.totalCents === invoice.total_cents, 'cancellation_source_mismatch', 409)
    if (!creditUnused) continue
    insist(!(await all(env, 'SELECT id FROM nc_credit_notes WHERE invoice_id=?', invoice.id)).length, 'cancellation_source_already_adjusted', 409)
    const keys = new Set(future.map(window => window.key))
    const affected = (line: Line) => recurring(line) && keys.has((line.evidence.calendar as Row | undefined)?.windowKey)
    const original = before.lines.filter(affected)
    const expanded = expandBillingWindows(input)
    const earned = windows.flatMap((window, index) => {
      if (!keys.has(window.key)) return []
      const calendar = original.find(line => (line.evidence.calendar as Row | undefined)?.windowKey === window.key)?.evidence.calendar
      insist(calendar, 'cancellation_source_mismatch', 409)
      return rateIntervalService(earnedInput(expanded[index], date, transition), false).lines.filter(recurring)
        .map(line => ({ ...line, evidence: { ...line.evidence, calendar } }))
    })
    const replacement = [...before.lines.filter(line => !affected(line)), ...earned]
    const corrected = invoiceTotals(input.tax, replacement)
    // A prior historical usage correction keeps its exact saved tax delta;
    // the cancellation must not reverse that unrelated tax a second time.
    const historicalTax = before.lines.filter(line => line.kind === 'usage_correction').reduce((sum, line) => sum + Number(line.evidence.taxDeltaCents ?? 0), 0)
    corrected.taxCents += historicalTax
    corrected.totalCents += historicalTax
    insist(!corrected.exceptions.length, 'cancellation_calculation_blocked', 409, corrected.exceptions)
    const subtotalCents = before.subtotalCents - corrected.subtotalCents, taxCents = before.taxCents - corrected.taxCents
    const amountCents = subtotalCents + taxCents
    insist([subtotalCents, taxCents, amountCents].every(Number.isSafeInteger) && subtotalCents >= 0 && taxCents >= 0, 'cancellation_credit_invalid', 409)
    if (!amountCents) continue
    credits.push({ invoice: invoice.id, number: invoice.number, originalFingerprint: invoice.source_fingerprint,
      balanceCents: invoice.balance_cents, subtotalCents, taxCents, amountCents,
      appliedCents: Math.min(amountCents, Math.max(0, invoice.balance_cents)),
      carriedCents: Math.max(0, amountCents - invoice.balance_cents),
      period: input.period, calendar: composeBillingWindows(future)[0], original, earned,
      revenue: revenueDeltas(original, earned, input), source: `/app/invoices/${invoice.id}` })
  }
  const plan = { subscription, date, transition, creditUnused, invoices: invoices.map(invoice => invoice.id), credits,
    amountCents: credits.reduce((sum, credit) => sum + credit.amountCents, 0) }
  insist(Number.isSafeInteger(plan.amountCents), 'cancellation_credit_invalid', 409)
  return { ...plan, fingerprint: await fingerprint(plan) }
}
