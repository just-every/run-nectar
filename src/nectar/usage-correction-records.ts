import type { Bindings } from '../auth.server'
import { all, parseJson } from './core'
import type { Line, RatingInput } from './rating'

export interface UsageAdjustment { id: string; correction: string; line: Line; taxCents: number }
export interface UsageCredit { id: string; number: string; availableCents: number; correction: string; source: string }
export async function effectiveReplay(env: Bindings, invoice: string) {
  const rows = await all(env, 'SELECT input_json,lines_json FROM nc_usage_replays WHERE invoice_id=? ORDER BY id DESC LIMIT 1', invoice)
  return rows.length ? { input: parseJson<RatingInput>(rows[0].input_json, null as never), lines: parseJson<Line[]>(rows[0].lines_json, []) } : null
}
export async function usageAdjustments(env: Bindings, subscription: string): Promise<UsageAdjustment[]> {
  return (await all(env, 'SELECT * FROM nc_usage_adjustments WHERE subscription_id=? AND invoice_id IS NULL ORDER BY id', subscription))
    .map(row => ({ id: row.id, correction: row.correction_id, line: parseJson<Line>(row.line_json, null as never), taxCents: row.tax_cents }))
}
export async function carriedUsageCredits(env: Bindings, customer: string): Promise<UsageCredit[]> {
  return (await all(env, `SELECT n.*, n.amount_cents-n.applied_cents-COALESCE((SELECT SUM(a.amount_cents) FROM nc_usage_credit_applications a WHERE a.credit_id=n.id),0) AS available
    FROM nc_credit_notes n WHERE n.customer_id=? AND n.correction_id IS NOT NULL ORDER BY n.issued_at,n.id`, customer))
    .filter(row => row.available>0).map(row => ({ id: row.id, number: row.number, availableCents: row.available, correction: row.correction_id, source: `/app/invoices/${row.invoice_id}#credit-${row.id}` }))
}
export function usageCreditAllocations(credits: UsageCredit[], totalCents: number) {
  let left = Math.max(0,totalCents)
  return credits.flatMap(credit => { const amountCents = Math.min(left,credit.availableCents); left-=amountCents; return amountCents ? [{ ...credit, amountCents }] : [] })
}
