// Customer answer evidence is an allowlist of saved financial operands, never
// the operator invoice projection or the original raw calculation document.
import type { Bindings } from '../auth.server'
import type { CustomerSession } from './portal-session'
import { all, insist, one, parseJson, type Row } from './core'
import { BALANCE_SQL } from './receivables'
import { customerReportLine } from './report-lines'

export const customerInvoiceSource = (id: string) => `/portal/evidence/invoices/${encodeURIComponent(id)}`

export async function customerAnswerInvoice(env: Bindings, session: CustomerSession, id: string) {
  const row = await one(env, `SELECT i.id,i.customer_id,i.subscription_id,i.invoice_kind,i.number,i.period_start,i.period_end,i.issue_date,i.due_date,
    i.subtotal_cents,i.tax_cents,i.total_cents,i.calculation_json,${BALANCE_SQL} AS balanceCents
    FROM nc_invoices i WHERE i.id=? AND i.customer_id=? AND i.status='issued'`, id, session.customer)
  insist(row, 'invoice_not_found', 404)
  const calculation = parseJson<Row>(row.calculation_json, {}), inputs = calculation.inputs ?? {}
  const lines = await all(env, 'SELECT id,kind,price_id,meter_id,description,quantity,unit_amount,amount_cents,evidence_json FROM nc_invoice_lines WHERE invoice_id=? ORDER BY seq', id)
  const credits = await all(env, 'SELECT number,amount_cents FROM nc_credit_notes WHERE invoice_id=? AND customer_id=? ORDER BY issued_at', id, session.customer)
  const allocations = await all(env, 'SELECT a.amount_cents,p.received_on,p.method FROM nc_allocations a JOIN nc_payments p ON p.id=a.payment_id WHERE a.invoice_id=? AND p.customer_id=? ORDER BY a.allocated_at', id, session.customer)
  const invoice = { ...row, calculation_json: undefined,
    credits, allocations: allocations.map((payment, index) => ({ ...payment, reference: String(index + 1) })),
    creditedCents: credits.reduce((sum, credit) => sum + credit.amount_cents, 0),
    paidCents: allocations.reduce((sum, payment) => sum + payment.amount_cents, 0),
    lines: lines.map(line => { const evidence = parseJson<Row>(line.evidence_json, {}); return { ...line, evidence_json: undefined,
      evidence: Object.fromEntries(['minimumCents','nominalMinimumCents','earnedCents','previouslySettledCents','priorInvoices'].filter(key => key in evidence).map(key => [key, evidence[key]])) } }),
    calculation: { tax: calculation.tax, inputs: {
      prices: Object.fromEntries(Object.entries(inputs.prices ?? {}).map(([key, price]) => { const p = price as Row; return [key, { unitAmount: p.unitAmount, pricing: p.pricing }] })),
      contracts: { commitments: (inputs.contracts?.commitments ?? []).map((window: Row) => ({ minimumCents: window.minimumCents })) },
      amendments: (inputs.amendments ?? []).map((amendment: Row) => ({ id: amendment.id, kind: amendment.kind, value: amendment.value })),
    } },
  }
  return { invoice, source: customerInvoiceSource(id), href: `/portal/invoices/${encodeURIComponent(id)}` }
}

export async function customerAnswerLine(env: Bindings, session: CustomerSession, invoice: string, line: string) {
  const record = await customerReportLine(env, session, invoice, line)
  return { line: { id: record.line.id, description: record.line.description, quantity: record.line.quantity, amount_cents: record.line.amount_cents },
    events: record.events.map(event => ({ eventId: event.eventId, meterId: event.meterId, quantity: event.quantity, occurredAt: event.occurredAt })), quantity: record.quantity }
}
