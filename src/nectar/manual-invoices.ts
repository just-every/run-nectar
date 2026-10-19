// A standalone invoice uses the same immutable lines, approval, numbering and
// receivables ledger as subscription invoices, without inventing a subscription.
import type { Bindings } from '../auth.server'
import { actorLabel, requireCapability, type Actor } from './actor'
import { requireBusiness, type Business } from './business'
import { certificateBasis } from './certificates'
import { all, commit, fingerprint, guard, insist, newId, now, one, stmt } from './core'
import { addDays, requireDate, today } from './dates'
import type { Input } from './input'
import { invoiceTotals } from './invoice-tax'
import { CHARGE_RATING_VERSION, chargeLines } from './charge-lines'
import { chargeInput } from './one-time-charges'

export async function manualCalculation(env: Bindings, b: Business, customerId: string, ids: string[], date: string) {
  const customer = await one(env, 'SELECT * FROM nc_customers WHERE id=?', customerId)
  insist(customer, 'customer_not_found', 404)
  const rows = await all(env, `SELECT * FROM nc_charges WHERE customer_id=? AND invoice_id IS NULL AND id IN (${ids.map(() => '?').join(',')}) ORDER BY effective_date,id`, customerId, ...ids)
  insist(rows.length === ids.length, 'charges_already_billed_or_missing', 409)
  insist(rows.every(row => row.effective_date <= date), 'charge_in_future')
  const certificate = await certificateBasis(env, customerId, b.tax_jurisdiction, { start: date, end: addDays(date, 1) })
  const tax = { mode: b.tax_mode, rate: b.tax_rate, jurisdiction: b.tax_jurisdiction, exempt: certificate?.exempt ?? !!customer.tax_exempt, exemptRef: certificate?.exemptRef ?? customer.tax_exempt_ref, ...(certificate ? { certificate: certificate.certificate, exception: certificate.exception } : {}) }
  const charges = rows.map(chargeInput), lines = chargeLines(charges)
  const input = { version: CHARGE_RATING_VERSION, customer: customerId, date, charges, tax }
  const totals = invoiceTotals(tax, lines)
  return { input, rating: { ...totals, lines, consumedEvents: [] }, fingerprint: await fingerprint(input) }
}

export async function prepareManualInvoice(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'records')
  const b = await requireBusiness(env), date = requireDate(input.text('service_date', { max: 10 }), 'service_date')
  insist(date <= today(b.timezone), 'service_date_in_future')
  const customer = input.text('customer', { max: 100 }), ids = input.list('charges')
  insist(ids.length > 0 && ids.length <= 20 && new Set(ids).size === ids.length, 'charges_required')
  const calculation = await manualCalculation(env, b, customer, ids, date)
  const { rating, fingerprint: basis } = calculation
  const run = newId(), invoice = newId(), at = now()
  const summary = { invoices: 1, shadow: 0, totals: { subtotal: rating.subtotalCents, tax: rating.taxCents, total: rating.totalCents }, exceptions: Object.fromEntries(rating.exceptions.map(e => [e.code, 1])), previous: null, skipped: [], open: [], manual: true }
  await commit(env, [
    ...ids.map(id => guard(env, 'charges_already_billed_or_missing', 'EXISTS(SELECT 1 FROM nc_charges WHERE id=? AND invoice_id IS NULL AND customer_id=?)', id, customer)),
    stmt(env, "INSERT INTO nc_bill_runs (id,period,cutoff_at,calc_version,status,summary_json,created_by,created_at,kind) VALUES (?,?,?,?,'draft',?,?,?,'manual')", run, date.slice(0, 7), at, CHARGE_RATING_VERSION, JSON.stringify(summary), actorLabel(actor), at),
    stmt(env, "INSERT INTO nc_invoices (id,bill_run_id,customer_id,subscription_id,invoice_kind,period_start,period_end,status,subtotal_cents,tax_cents,total_cents,calc_version,source_fingerprint,calculation_json,comparison_json,exceptions_json,created_at) VALUES (?,?,?,NULL,'manual',?,?,'draft',?,?,?,?,?,?,?, ?,?)", invoice, run, customer, date, addDays(date, 1), rating.subtotalCents, rating.taxCents, rating.totalCents, CHARGE_RATING_VERSION, basis, JSON.stringify({ version: CHARGE_RATING_VERSION, fingerprint: basis, tax: rating.tax, consumedEvents: [], inputs: calculation.input }), '{}', JSON.stringify(rating.exceptions), at),
    ...rating.lines.map((line, index) => stmt(env, 'INSERT INTO nc_invoice_lines (id,invoice_id,seq,kind,description,quantity,unit_amount,amount_cents,taxable,price_id,meter_id,period_start,period_end,evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)', newId(), invoice, index + 1, line.kind, line.description, line.quantity, line.unitAmount, line.amountCents, line.taxable ? 1 : 0, line.priceId, line.periodStart, line.periodEnd, JSON.stringify(line.evidence))),
  ], { actor: actorLabel(actor), action: 'invoice.manual', subject: invoice, detail: { customer, charges: ids, fingerprint: basis } })
  return { id: invoice, run }
}
