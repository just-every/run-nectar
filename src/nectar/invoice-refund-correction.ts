// Refund proposals freeze the same quote and wording the human reviews.
import type { Bindings } from '../auth.server'
import { NectarError, all, canonical, fingerprint, guard, insist, one, parseJson, stmt, type Row } from './core'
import { citationsFor } from './credit-correction'
import { Input } from './input'
import { invoiceRefundQuote } from './invoice-refund-preview'

export async function planInvoiceRefundCorrection(env: Bindings, payload: Row) {
  const input = Input.of(payload)
  const quote = await invoiceRefundQuote(env, input)
  const customer = await one(env, 'SELECT revision,billing_email,language FROM nc_customers WHERE id=? AND erased_at IS NULL', quote.customer)
  insist(customer && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.billing_email), 'customer_billing_email_required', 409)
  insist(payload.recipient === undefined || payload.recipient === customer.billing_email, 'invoice_refund_recipient_fixed')
  const invoice = await one(env, 'SELECT * FROM nc_invoices WHERE id=?', quote.invoice)
  const lines = await all(env, 'SELECT * FROM nc_invoice_lines WHERE invoice_id=? ORDER BY seq,id', quote.invoice)
  const citations = citationsFor(payload, invoice!, lines)
  const reason = input.text('reason', { max: 500 }), explanation = input.text('explanation', { max: 8000 })
  const subject = input.text('subject', { max: 200 }), body = input.text('body', { max: 12000 })
  insist(!/[\r\n]/.test(subject), 'invalid_subject')
  const normalized = { invoice_refund: true, invoice: quote.invoice, amount: input.text('amount', { max: 20 }), destination: quote.destination,
    reason, explanation, subject, body, citations, recipient: customer.billing_email }
  const mail = { recipient: customer.billing_email, subject, body, explanation, citations, language: customer.language,
    outcome: 'Reserved with the completed adjustment after human approval. Provider acceptance does not confirm mailbox delivery.' }
  const basis = { invoiceRefund: await fingerprint({ quote: quote.basis, customer, lines, normalized }) }
  return { normalized, impact: { refund: quote, mail }, basis }
}

export async function checkedRefundCorrection(env: Bindings, id: string) {
  const proposal = await one(env, 'SELECT * FROM nc_proposals WHERE id=?', id)
  insist(proposal && proposal.kind === 'amendment' && proposal.status === 'pending', 'proposal_not_pending', 409)
  const payload = parseJson<Row>(proposal.payload_json, {})
  insist(payload.invoice_refund === true, 'invoice_refund_proposal_required', 409)
  let plan: Awaited<ReturnType<typeof planInvoiceRefundCorrection>>
  try { plan = await planInvoiceRefundCorrection(env, payload) } catch { throw new NectarError('proposal_stale',409) }
  insist(canonical(plan.basis) === canonical(parseJson(proposal.basis_json, {})), 'proposal_stale', 409)
  return { proposal, plan }
}

export const refundProposalGuard = (env: Bindings, proposal: Row) => guard(env, 'proposal_stale',
  "EXISTS(SELECT 1 FROM nc_proposals WHERE id=? AND kind='amendment' AND status='pending' AND payload_json=? AND basis_json=?)", proposal.id, proposal.payload_json, proposal.basis_json)

export function refundCorrectionMailStatements(env: Bindings, correction: Row, credit: string, customer: string, at: number) {
  const m = correction.mail
  return [stmt(env, `INSERT INTO nc_credit_correction_mail(proposal_id,credit_id,customer_id,recipient,subject,body,explanation,citations_json,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,'pending',?,?)`, correction.proposal.id, credit, customer, m.recipient, m.subject, m.body, m.explanation, JSON.stringify(m.citations), at, at)]
}
