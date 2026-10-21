// Only an actual, fully allocated purchase payment can create a paid lot.
import type { Bindings } from '../auth.server'
import { actorLabel, requireOwner, type Actor } from './actor'
import { commit, guard, insist, newId, now, one, stmt } from './core'
import type { Input } from './input'
import { requireFreshFactor } from './mfa'
import { prepaidGrantStatements, prepaidTerms } from './prepaid-records'
export interface PrepaidFundingProof { paymentId: string; invoiceId: string; amountCents: number; providerRef: string }
export async function prepaidFundingStatements(env: Bindings, id: string, proof: PrepaidFundingProof): Promise<D1PreparedStatement[]> {
  const intent = await one(env, "SELECT * FROM nc_prepaid_funding_intents WHERE id=? AND status='pending'", id)
  insist(intent && intent.invoice_id === proof.invoiceId && intent.amount_cents === proof.amountCents, 'prepaid_funding_changed', 409)
  const line = await one(env, "SELECT id FROM nc_invoice_lines WHERE invoice_id=? AND kind='prepaid_purchase' AND amount_cents=?", proof.invoiceId, proof.amountCents)
  insist(line, 'prepaid_purchase_required', 409)
  const grant = newId()
  return [guard(env, 'prepaid_funding_already_applied', "EXISTS(SELECT 1 FROM nc_prepaid_funding_intents WHERE id=? AND status='pending' AND invoice_id=?)", id, proof.invoiceId),
    guard(env, 'prepaid_actual_payment_required', "EXISTS(SELECT 1 FROM nc_invoices i JOIN nc_payments p ON p.id=? WHERE i.id=? AND i.status='issued' AND i.customer_id=? AND p.customer_id=i.customer_id AND i.total_cents=? AND (SELECT COALESCE(SUM(amount_cents),0) FROM nc_allocations WHERE invoice_id=i.id)>=i.total_cents AND EXISTS(SELECT 1 FROM nc_allocations a WHERE a.invoice_id=i.id AND a.payment_id=p.id AND a.amount_cents>0))", proof.paymentId, proof.invoiceId, intent.customer_id, proof.amountCents),
    ...(intent.consent_id ? [guard(env, 'prepaid_consent_revoked', "EXISTS(SELECT 1 FROM nc_prepaid_consents WHERE id=? AND status='active')", intent.consent_id)] : []),
    stmt(env, "UPDATE nc_prepaid_funding_intents SET status='funded',funded_at=?,payment_id=?,provider_ref=? WHERE id=?", now(), proof.paymentId, proof.providerRef, id),
    ...prepaidGrantStatements(env, grant, intent.subscription_id, intent.customer_id, prepaidTerms(intent), intent.request_id, id, proof.invoiceId, line.id)]
}
export async function confirmPrepaidFunding(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor); await requireFreshFactor(env, actor); insist(input.flag('confirm'), 'prepaid_funding_confirmation_required')
  const id = input.text('intent', { max: 100 }), intent = await one(env, 'SELECT * FROM nc_prepaid_funding_intents WHERE id=?', id)
  insist(intent, 'prepaid_funding_not_found', 404)
  const payment = await one(env, 'SELECT p.id,p.reference FROM nc_allocations a JOIN nc_payments p ON p.id=a.payment_id WHERE a.invoice_id=? ORDER BY a.allocated_at DESC,a.id LIMIT 1', intent.invoice_id)
  insist(payment, 'prepaid_actual_payment_required', 409)
  const statements = await prepaidFundingStatements(env, id, { paymentId: payment.id, invoiceId: intent.invoice_id, amountCents: intent.amount_cents, providerRef: payment.reference })
  await commit(env, statements, { actor: actorLabel(actor), action: 'prepaid.fund', subject: id, detail: { invoice: intent.invoice_id, payment: payment.id, amountCents: intent.amount_cents } })
  return { id, status: 'funded' }
}
