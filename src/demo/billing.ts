import type { Bindings } from '../auth.server'
import { business } from '../nectar/business'
import { draftFor } from '../nectar/billruns'
import { one } from '../nectar/core'
import { addDays, addMonths } from '../nectar/dates'
import { RATING_VERSION } from '../nectar/rating'
import { customers, finance, insert } from './records'

type Payment = { daysAgo: number; method: string; reference: string; evidence: string; cents?: number }
const card = 'Card payout matched by Marcus Lee', bank = 'Matched to the bank statement by Marcus Lee'
// Two months ago every invoice was issued: four were paid in full, Birchwood Legal sent part by check and
// Summit Outfitters has paid nothing. Last month's run issued four invoices on the first; Summit's and
// Birchwood's drafts still wait for approval.
const ISSUED_LAST_MONTH = ['lakeview', 'mesa', 'cedarpine', 'lumen']
const PAYMENTS: Record<number, Record<string, Payment>> = {
  [-2]: {
    lakeview: { daysAgo: 44, method: 'card_external', reference: 'VISA-8817-0901', evidence: card },
    mesa: { daysAgo: 42, method: 'card_external', reference: 'VISA-5150-0901', evidence: card },
    cedarpine: { daysAgo: 40, method: 'bank_transfer', reference: 'ACH-CP-0901', evidence: bank },
    lumen: { daysAgo: 38, method: 'bank_transfer', reference: 'ACH-LH-0901', evidence: bank },
    birchwood: { daysAgo: 9, method: 'check', reference: 'CHK-4471', evidence: 'Check deposited; the rest promised by month end', cents: 50000 },
  },
  [-1]: {
    lakeview: { daysAgo: 17, method: 'card_external', reference: 'VISA-8817-1001', evidence: card },
    mesa: { daysAgo: 13, method: 'card_external', reference: 'VISA-5150-1001', evidence: card },
    cedarpine: { daysAgo: 4, method: 'bank_transfer', reference: 'ACH-CP-1001', evidence: bank },
  },
}
const CREDIT = { key: 'lumen', offset: -2, cents: 2500 }

/** Draft through Nectar's own bill run code so drafts compare, approve and issue normally. */
export async function seedBilling(env: Bindings, actor: string, month: string, at: number) {
  const b = (await business(env))!, today = new Date(at).toISOString().slice(0, 10)
  let previousTotals = { subtotal: 0, tax: 0, total: 0 }
  for (const offset of [-2, -1]) {
    const start = addMonths(month, offset), end = addMonths(start, 1), finalised = offset === -2
    const run = `demo-run-${offset}`, totals = { subtotal: 0, tax: 0, total: 0 }
    const counts: Record<string, number> = {}
    await insert(env, 'nc_bill_runs', { id: run, period: start.slice(0, 7), cutoff_at: at, calc_version: RATING_VERSION, status: finalised ? 'finalised' : 'draft', summary_json: '{}', created_by: finance, created_at: Date.parse(end), finalised_by: finalised ? actor : null, finalised_at: finalised ? Date.parse(end) : null }).run()
    const issuing = finalised ? customers.map(([key]) => key as string) : ISSUED_LAST_MONTH
    for (const [key] of customers) {
      const issued = issuing.includes(key)
      const number = issued ? `FN-${String((finalised ? 2035 : 2041) + issuing.indexOf(key)).padStart(6, '0')}` : null
      const id = `demo-invoice-${offset}-${key}`
      const existing = await one(env, 'SELECT subtotal_cents, tax_cents, total_cents FROM nc_invoices WHERE id = ?', id)
      if (existing) { totals.subtotal += existing.subtotal_cents; totals.tax += existing.tax_cents; totals.total += existing.total_cents; continue }
      const sub = await one(env, 'SELECT s.*, c.billing_email FROM nc_subscriptions s JOIN nc_customers c ON c.id = s.customer_id WHERE s.id = ?', `demo-sub-${key}`)
      const { rating: r, input, fingerprint, comparison, exceptions } = await draftFor(env, b, sub!, { start, end })
      for (const exception of exceptions) counts[exception.code] = (counts[exception.code] ?? 0) + 1
      totals.subtotal += r.subtotalCents; totals.tax += r.taxCents; totals.total += r.totalCents
      const rows = [insert(env, 'nc_invoices', { id, bill_run_id: run, customer_id: `demo-${key}`, subscription_id: `demo-sub-${key}`, period_start: start, period_end: end, status: issued ? 'issued' : 'draft', number, issue_date: issued ? end : null, due_date: issued ? addDays(end, b.payment_terms_days) : null, subtotal_cents: r.subtotalCents, tax_cents: r.taxCents, total_cents: r.totalCents, calc_version: RATING_VERSION, source_fingerprint: fingerprint, calculation_json: JSON.stringify({ version: RATING_VERSION, fingerprint, tax: r.tax, consumedEvents: r.consumedEvents, inputs: input }), comparison_json: JSON.stringify(comparison), exceptions_json: JSON.stringify(exceptions), approved_fingerprint: issued ? fingerprint : null, approved_by: issued ? actor : null, approved_at: issued ? Date.parse(end) : null, issued_by: issued ? actor : null, issued_at: issued ? Date.parse(end) : null, created_at: Date.parse(end) })]
      r.lines.forEach((line, i) => rows.push(insert(env, 'nc_invoice_lines', { id: `${id}-line-${i}`, invoice_id: id, seq: i + 1, kind: line.kind, description: line.description, quantity: line.quantity, unit_amount: line.unitAmount, amount_cents: line.amountCents, taxable: line.taxable ? 1 : 0, price_id: line.priceId, meter_id: line.meterId, period_start: line.periodStart, period_end: line.periodEnd, evidence_json: JSON.stringify(line.evidence) })))
      if (issued) {
        for (const event of r.consumedEvents) rows.push(env.DB.prepare('UPDATE nc_usage_events SET invoice_id = ? WHERE event_id = ? AND invoice_id IS NULL').bind(id, event))
        const payment = PAYMENTS[offset][key], credit = key === CREDIT.key && offset === CREDIT.offset ? CREDIT.cents : 0
        if (payment) {
          const day = addDays(today, -payment.daysAgo)
          const received = day < end ? (end < today ? end : today) : day
          const paid = payment.cents ?? r.totalCents - credit
          rows.push(
            insert(env, 'nc_payments', { id: `demo-payment-${key}${offset}`, customer_id: `demo-${key}`, amount_cents: paid, received_on: received, method: payment.method, reference: payment.reference, evidence: payment.evidence, recorded_by: finance, recorded_at: Date.parse(received) }),
            insert(env, 'nc_allocations', { id: `demo-allocation-${key}${offset}`, payment_id: `demo-payment-${key}${offset}`, invoice_id: id, amount_cents: paid, allocated_by: finance, allocated_at: Date.parse(received) }),
          )
        }
        if (credit) rows.push(insert(env, 'nc_credit_notes', { id: `demo-credit-${key}`, number: 'FN-CN-000001', invoice_id: id, customer_id: `demo-${key}`, amount_cents: credit, reason: 'Service interruption goodwill credit', issued_by: actor, issued_at: Date.parse(addDays(end, 3)) }))
      }
      await env.DB.batch(rows)
    }
    const previous = finalised ? null : { run: 'demo-run--2', period: addMonths(month, -2).slice(0, 7), totals: previousTotals }
    previousTotals = totals
    await env.DB.prepare("UPDATE nc_bill_runs SET summary_json = ? WHERE id = ? AND summary_json = '{}'").bind(JSON.stringify({ invoices: 6, shadow: 0, totals, exceptions: counts, skipped: [], open: [], previous }), run).run()
  }
}
