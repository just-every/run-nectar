import type { Bindings } from '../auth.server'
import { business } from '../nectar/business'
import { one } from '../nectar/core'
import { addDays, addMonths } from '../nectar/dates'
import { rated } from '../nectar/inputs'
import { RATING_VERSION } from '../nectar/rating'
import { customers, insert } from './records'

/** Use Nectar's rating engine so drafts can be approved and issued normally. */
export async function seedBilling(env: Bindings, actor: string, month: string, at: number) {
  const b = (await business(env))!
  for (const offset of [-2, -1]) {
    const start = addMonths(month, offset), end = addMonths(start, 1), issued = offset === -2
    const run = `demo-run-${offset}`, totals = { subtotal: 0, tax: 0, total: 0 }
    await insert(env, 'nc_bill_runs', { id: run, period: start.slice(0, 7), cutoff_at: at, calc_version: RATING_VERSION, status: issued ? 'finalised' : 'draft', summary_json: '{}', created_by: actor, created_at: Date.parse(end), finalised_by: issued ? actor : null, finalised_at: issued ? Date.parse(end) : null }).run()
    for (const [index, [key]] of customers.entries()) {
      const id = `demo-invoice-${offset}-${key}`
      const existing = await one(env, 'SELECT subtotal_cents, tax_cents, total_cents FROM nc_invoices WHERE id = ?', id)
      if (existing) { totals.subtotal += existing.subtotal_cents; totals.tax += existing.tax_cents; totals.total += existing.total_cents; continue }
      const { rating: r, input, fingerprint } = await rated(env, b, `demo-sub-${key}`, { start, end })
      totals.subtotal += r.subtotalCents; totals.tax += r.taxCents; totals.total += r.totalCents
      const rows = [insert(env, 'nc_invoices', { id, bill_run_id: run, customer_id: `demo-${key}`, subscription_id: `demo-sub-${key}`, period_start: start, period_end: end, status: issued ? 'issued' : 'draft', number: issued ? `RB-${String(index + 1).padStart(6, '0')}` : null, issue_date: issued ? end : null, due_date: issued ? addDays(end, 14) : null, subtotal_cents: r.subtotalCents, tax_cents: r.taxCents, total_cents: r.totalCents, calc_version: RATING_VERSION, source_fingerprint: fingerprint, calculation_json: JSON.stringify({ version: RATING_VERSION, fingerprint, tax: r.tax, consumedEvents: r.consumedEvents, inputs: input }), comparison_json: '{}', exceptions_json: JSON.stringify(r.exceptions), approved_fingerprint: issued ? fingerprint : null, approved_by: issued ? actor : null, approved_at: issued ? Date.parse(end) : null, issued_by: issued ? actor : null, issued_at: issued ? Date.parse(end) : null, created_at: Date.parse(end) })]
      r.lines.forEach((line, i) => rows.push(insert(env, 'nc_invoice_lines', { id: `${id}-line-${i}`, invoice_id: id, seq: i + 1, kind: line.kind, description: line.description, quantity: line.quantity, unit_amount: line.unitAmount, amount_cents: line.amountCents, taxable: line.taxable ? 1 : 0, price_id: line.priceId, meter_id: line.meterId, period_start: line.periodStart, period_end: line.periodEnd, evidence_json: JSON.stringify(line.evidence) })))
      if (issued) {
        for (const event of r.consumedEvents) rows.push(env.DB.prepare('UPDATE nc_usage_events SET invoice_id = ? WHERE event_id = ? AND invoice_id IS NULL').bind(id, event))
        const paid = index < 2 ? r.totalCents : index === 2 ? 50000 : 0
        if (paid) rows.push(
          insert(env, 'nc_payments', { id: `demo-payment-${key}`, customer_id: `demo-${key}`, amount_cents: paid, received_on: addDays(end, 7), method: 'bank_transfer', reference: `REMIT-${key.toUpperCase()}-0907`, evidence: 'Matched to the bank statement by Rosa Bennett', recorded_by: actor, recorded_at: Date.parse(addDays(end, 7)) }),
          insert(env, 'nc_allocations', { id: `demo-allocation-${key}`, payment_id: `demo-payment-${key}`, invoice_id: id, amount_cents: paid, allocated_by: actor, allocated_at: Date.parse(addDays(end, 7)) }),
        )
        if (key === 'juniper') rows.push(insert(env, 'nc_credit_notes', { id: 'demo-credit-juniper', number: 'RB-CN-000001', invoice_id: id, customer_id: 'demo-juniper', amount_cents: 2500, reason: 'Service interruption goodwill credit', issued_by: actor, issued_at: Date.parse(addDays(end, 3)) }))
      }
      await env.DB.batch(rows)
    }
    await env.DB.prepare("UPDATE nc_bill_runs SET summary_json = ? WHERE id = ? AND summary_json = '{}'").bind(JSON.stringify({ invoices: 6, shadow: 0, totals, exceptions: {}, skipped: [], open: [], previous: null }), run).run()
  }
}
