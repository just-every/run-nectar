// Purchase purpose is immutable before ordinary approval/numbering/issue.
// Funding and revenue are distinct: an unpaid issued purchase grants no units.
import type { Bindings } from '../auth.server'
import { actorLabel, requireOwner, type Actor } from './actor'
import { requireBusiness, type Business } from './business'
import { commit, fingerprint, guard, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import { addDays, requireDate, today } from './dates'
import { clockInstant } from './clock'
import { invoiceContent } from './invoice-content'
import type { Input } from './input'
import { requireFreshFactor } from './mfa'
import { PREPAID_VERSION } from './prepaid-types'
import type { Line } from './rating'

export async function prepaidPurchaseCalculation(env: Bindings, business: Business, customer: string, intentId: string, date: string) {
  const intent = await one(env, "SELECT * FROM nc_prepaid_funding_intents WHERE id=? AND status='pending' AND customer_id=?", intentId, customer)
  insist(intent, 'prepaid_funding_not_pending', 409)
  const terms = parseJson<Row>(intent.terms_json, {})
  const input = { version: PREPAID_VERSION, customer, date, prepaidPurchase: { intent: intent.id, subscription: intent.subscription_id, amountCents: intent.amount_cents, terms },
    tax: { mode: 'no_tax' as const, jurisdiction: '', rate: '0', exempt: false, exemptRef: '' }, invoiceContent: await invoiceContent(env, business, customer) }
  const line: Line = { kind: 'prepaid_purchase', description: 'Prepaid service purchase · contract liability until consumption or expiry', quantity: '1', unitAmount: '', amountCents: intent.amount_cents, taxable: false, priceId: null, meterId: null, periodStart: date, periodEnd: addDays(date, 1),
    evidence: { prepaidPurchase: intent.id, subscription: intent.subscription_id, purpose: 'prepaid-contract-liability', amountCents: intent.amount_cents, taxRule: 'No service consideration is consumed by this purchase; original consumption tax remains on the service invoice.' } }
  return { input, fingerprint: await fingerprint(input), rating: { lines: [line], subtotalCents: intent.amount_cents, taxCents: 0, totalCents: intent.amount_cents, tax: { mode: 'no_tax', rule: 'Prepaid liability purchase, service tax remains at consumption' }, consumedEvents: [], exceptions: [] } }
}
export async function preparePrepaidPurchase(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor); await requireFreshFactor(env, actor)
  const business = await requireBusiness(env), id = input.text('intent', { max: 100 })
  const intent = await one(env, "SELECT * FROM nc_prepaid_funding_intents WHERE id=? AND status='pending'", id)
  insist(intent && !intent.invoice_id, 'prepaid_purchase_already_prepared', 409)
  const date = requireDate(input.text('issue_date', { max: 10, optional: true }) || today(business.timezone, clockInstant(env)))
  insist(date <= today(business.timezone, clockInstant(env)), 'invalid_issue_date')
  const calculation = await prepaidPurchaseCalculation(env, business, intent.customer_id, id, date), run = newId(), invoice = newId(), at = now(), line = calculation.rating.lines[0]
  await commit(env, [guard(env, 'prepaid_purchase_already_prepared', "EXISTS(SELECT 1 FROM nc_prepaid_funding_intents WHERE id=? AND status='pending' AND invoice_id IS NULL)", id),
    stmt(env, "INSERT INTO nc_bill_runs(id,period,cutoff_at,calc_version,status,summary_json,created_by,created_at,kind) VALUES(?,?,?,?,'draft',?,?,?,'manual')", run, date.slice(0, 7), at, PREPAID_VERSION, JSON.stringify({ invoices: 1, prepaidPurchase: id }), actorLabel(actor), at),
    stmt(env, "INSERT INTO nc_invoices(id,bill_run_id,customer_id,subscription_id,invoice_kind,period_start,period_end,status,subtotal_cents,tax_cents,total_cents,calc_version,source_fingerprint,calculation_json,comparison_json,exceptions_json,created_at) VALUES(?,?,?,?,'manual',?,?,'draft',?,0,?,?,?,?,'{}','[]',?)", invoice, run, intent.customer_id, intent.subscription_id, date, addDays(date, 1), intent.amount_cents, intent.amount_cents, PREPAID_VERSION, calculation.fingerprint, JSON.stringify({ ...calculation.rating, inputs: calculation.input, fingerprint: calculation.fingerprint, version: PREPAID_VERSION }), at),
    stmt(env, 'INSERT INTO nc_invoice_lines(id,invoice_id,seq,kind,description,quantity,unit_amount,amount_cents,taxable,price_id,meter_id,period_start,period_end,evidence_json) VALUES(?,?,1,?,?,?,?,?,0,NULL,NULL,?,?,?)', newId(), invoice, line.kind, line.description, line.quantity, line.unitAmount, line.amountCents, line.periodStart, line.periodEnd, JSON.stringify(line.evidence)),
    stmt(env, 'UPDATE nc_prepaid_funding_intents SET invoice_id=? WHERE id=?', invoice, id)], { actor: actorLabel(actor), action: 'prepaid.purchase.prepare', subject: invoice, detail: { intent: id, amountCents: intent.amount_cents } })
  return { id: invoice, invoice, run, intent: id }
}
export function prepaidPurchaseIssueStatements(env: Bindings, invoice: Row, input: Row) {
  if (!input.prepaidPurchase) return []
  return [guard(env, 'prepaid_purchase_source_changed', "EXISTS(SELECT 1 FROM nc_prepaid_funding_intents f JOIN nc_invoice_lines l ON l.invoice_id=f.invoice_id WHERE f.id=? AND f.invoice_id=? AND f.customer_id=? AND f.status='pending' AND f.amount_cents=? AND l.kind='prepaid_purchase' AND l.amount_cents=f.amount_cents AND json_extract(l.evidence_json,'$.prepaidPurchase')=f.id)", input.prepaidPurchase.intent, invoice.id, invoice.customer_id, invoice.subtotal_cents)]
}
