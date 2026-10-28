import type { Bindings } from '../auth.server'
import { all, parseJson } from './core'
import type { Line, RatingInput } from './rating'

export interface UsageAdjustment { source?:'plan-change';id: string; correction: string; line: Line; taxCents: number }
export interface UsageCredit { id: string; number: string; availableCents: number; issuedAt: number; correction: string; source: string }
export async function effectiveReplay(env: Bindings, invoice: string) {
  const rows = await all(env, 'SELECT input_json,lines_json FROM nc_usage_replays WHERE invoice_id=? ORDER BY id DESC LIMIT 1', invoice)
  return rows.length ? { input: parseJson<RatingInput>(rows[0].input_json, null as never), lines: parseJson<Line[]>(rows[0].lines_json, []) } : null
}
export async function usageAdjustments(env: Bindings, subscription: string): Promise<UsageAdjustment[]> {
  const historical=(await all(env, 'SELECT * FROM nc_usage_adjustments WHERE subscription_id=? AND invoice_id IS NULL AND target_invoice_id IS NULL ORDER BY id', subscription))
    .map(row => ({ id: row.id, correction: row.correction_id, line: parseJson<Line>(row.line_json, null as never), taxCents: row.tax_cents }))
  const plan=(await all(env,'SELECT * FROM nc_plan_change_adjustments WHERE subscription_id=? AND invoice_id IS NULL ORDER BY id',subscription)).map(row=>({source:'plan-change' as const,id:row.id,correction:row.id,line:{...parseJson<Line>(row.line_json,null as never),taxable:false},taxCents:row.tax_cents}))
  return [...historical,...plan]
}
export async function carriedUsageCredits(env: Bindings, customer: string): Promise<UsageCredit[]> {
  return (await all(env, `SELECT n.*, n.amount_cents-n.applied_cents-COALESCE((SELECT SUM(a.amount_cents) FROM nc_usage_credit_applications a WHERE a.credit_id=n.id),0) AS available
    FROM nc_credit_notes n WHERE NOT EXISTS(SELECT 1 FROM nc_prepaid_refund_credits x WHERE x.credit_id=n.id) AND NOT EXISTS(SELECT 1 FROM nc_invoice_refunds r WHERE r.cancellation_credit_id=n.id AND r.status IN ('pending','claimed','uncertain','completed')) AND n.customer_id=? AND (n.correction_id IS NOT NULL OR n.cancellation_id IS NOT NULL OR n.plan_change_id IS NOT NULL OR EXISTS(SELECT 1 FROM nc_invoice_refunds r WHERE r.id=n.invoice_refund_id AND r.status='completed' AND r.destination='balance')) ORDER BY n.issued_at,n.id`, customer))
    .filter(row => row.available>0).map(row => ({ id: row.id, number: row.number, availableCents: row.available, issuedAt: row.issued_at, correction: row.correction_id??row.cancellation_id??row.plan_change_id??row.invoice_refund_id, source: `/app/invoices/${row.invoice_id}#credit-${row.id}` }))
}
export function usageCreditAllocations(credits: UsageCredit[], totalCents: number) {
  let left = Math.max(0,totalCents)
  return credits.flatMap(credit => { const amountCents = Math.min(left,credit.availableCents); left-=amountCents; return amountCents ? [{ ...credit, amountCents }] : [] })
}

export function usageCreditApplicationLines(credits: UsageCredit[], totalCents: number, period: {start:string;end:string}): Line[] {
  return usageCreditAllocations(credits,totalCents).map(c=>({kind:'usage_credit_application',description:`Carried historical correction ${c.number}: ${c.amountCents} cents applied after invoice total`,quantity:'1',unitAmount:'',amountCents:0,taxable:false,priceId:null,meterId:null,periodStart:period.start,periodEnd:period.end,
    evidence:{credit:c.id,correction:c.correction,appliedCents:c.amountCents,source:c.source,rule:'Customer liability application; not new consideration, tax or revenue'}}))
}
