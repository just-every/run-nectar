import { invoiceTaxQuote } from './invoice-refund-tax'
// A read-only source-bound quote. It grants no authority to move money.
import type { Bindings } from '../auth.server'
import { requireRead, type Actor } from './actor'
import { BALANCE_SQL } from './balance-sql'
import { all, fingerprint, insist, one, parseJson, type Row } from './core'
import { creditPolicy } from './credit-policy'
import { cents } from './decimal'
import type { Input } from './input'

export async function previewInvoiceRefund(env: Bindings, actor: Actor, input: Input) {
  requireRead(actor, 'invoices')
  requireRead(actor, 'payments')
  return invoiceRefundQuote(env, input)
}

/** Internal calculation; public callers enforce record authority first. */
export async function invoiceRefundQuote(env: Bindings, input: Input) {
  const invoice = await one(env, `SELECT i.*,${BALANCE_SQL} AS balance_cents FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id WHERE i.id=? AND c.erased_at IS NULL`, input.text('invoice', { max: 100 }))
  insist(invoice, 'invoice_not_found', 404)
  insist(invoice.status === 'issued' && invoice.balance_cents === 0 && invoice.total_cents > 0 && invoice.currency === 'USD', 'paid_invoice_required', 409)
  const amountCents = cents(input.text('amount', { max: 20 }))
  const destination = input.text('destination', { max: 10 })
  insist(destination === 'original' || destination === 'balance', 'invalid_refund_destination')
  const allocations = await all(env, 'SELECT a.id,a.payment_id,a.amount_cents,p.method FROM nc_allocations a JOIN nc_payments p ON p.id=a.payment_id WHERE a.invoice_id=? ORDER BY a.id', invoice.id)
  insist(allocations.length === 1 && allocations[0].method === 'card_external' && allocations[0].amount_cents === invoice.total_cents, 'original_card_capture_required', 409)
  const receipt = await one(env, "SELECT id,proof_json FROM nc_native_collections WHERE payment_id=? AND invoice_id=? AND status='collected'", allocations[0].payment_id, invoice.id)
  const proof = parseJson<Row>(receipt?.proof_json, {})
  insist(proof.proof === 'succeeded-payment-intent-and-captured-charge' && proof.amountCents === invoice.total_cents && proof.currency === 'usd' && typeof proof.livemode === 'boolean', 'verified_test_card_capture_required', 409)
  let cancellation: { id: string; creditId: string; subtotalCents: number; taxCents: number; policy: Row } | null = null
  if(input.has('cancellation')) {
    const saved=await one(env,"SELECT * FROM nc_interval_cancellations WHERE id=? AND status='approved' AND customer_id=?",input.text('cancellation',{max:100}),invoice.customer_id)
    const frozen=parseJson<Row>(saved?.plan_json,{})
    insist(saved&&frozen.transition?.policy?.refundOriginal,'cancellation_refund_policy_required',409)
    const credit=await one(env,'SELECT * FROM nc_credit_notes WHERE cancellation_id=? AND invoice_id=?',saved.id,invoice.id)
    insist(credit&&credit.applied_cents===0&&credit.amount_cents===amountCents&&destination==='original'&&!await one(env,"SELECT 1 FROM nc_invoice_refunds WHERE cancellation_credit_id=? AND status='completed'",credit.id)&&!await one(env,'SELECT 1 FROM nc_usage_credit_applications WHERE credit_id=?',credit.id),'cancellation_refund_credit_unavailable',409)
    cancellation={id:saved.id,creditId:credit.id,subtotalCents:credit.subtotal_cents,taxCents:credit.tax_cents,policy:frozen.transition.policy}
  }
  const credits = await all(env, 'SELECT id,amount_cents,subtotal_cents,tax_cents,issued_at FROM nc_credit_notes WHERE invoice_id=? AND id<>? ORDER BY issued_at,id', invoice.id,cancellation?.creditId??'')
  // An unattributed credit cannot acquire invented historical tax evidence.
  insist(credits.every(row => Number.isSafeInteger(row.subtotal_cents) && Number.isSafeInteger(row.tax_cents) && row.subtotal_cents + row.tax_cents === row.amount_cents), 'refund_tax_attribution_required', 409)
  const reversedCents = credits.reduce((sum, row) => sum + row.amount_cents, 0)
  const reversedTaxCents = credits.reduce((sum, row) => sum + row.tax_cents, 0)
  insist(amountCents > 0 && amountCents <= invoice.total_cents - reversedCents, 'exceeds_refundable_amount', 409)
  const roundedTax = (BigInt(invoice.tax_cents) * BigInt(reversedCents + amountCents) * 2n + BigInt(invoice.total_cents)) / (2n * BigInt(invoice.total_cents))
  const tax = await invoiceTaxQuote(env, invoice, reversedCents, amountCents)
  if(tax&&cancellation) {
    if(tax.reversing.length===1) tax.reversing[0]={...tax.reversing[0],subtotalCents:cancellation.subtotalCents,taxCents:cancellation.taxCents}
    insist(tax.reversing.reduce((sum,line)=>sum+line.taxCents,0)===cancellation.taxCents,'cancellation_tax_attribution_required',409)
  }
  const taxCents = cancellation ? cancellation.taxCents : tax ? tax.reversing.reduce((sum, line) => sum + line.taxCents, 0) : Number(roundedTax) - reversedTaxCents
  insist(taxCents >= 0 && taxCents <= amountCents, 'refund_tax_attribution_required', 409)
  const policy = await creditPolicy(env)
  const basis = await fingerprint({ cancellation, tax, invoice: invoice.id, source: invoice.source_fingerprint, allocations, credits, receipt: receipt!.id, proof, policyRevision: policy.revision, threshold: policy.two_person_above_cents, amountCents, destination })
  return {
    invoice: invoice.id, customer: invoice.customer_id, source: `/app/invoices/${invoice.id}`,
    ...(tax ? { tax } : {}), ...(cancellation ? { cancellation } : {}), basis, currency: 'USD', amountCents, destination,
    original: { totalCents: invoice.total_cents, subtotalCents: invoice.subtotal_cents, taxCents: invoice.tax_cents, payment: allocations[0].payment_id, capture: proof.chargeRef },
    prior: { creditCents: reversedCents, taxCents: reversedTaxCents },
    reversing: { subtotalCents: amountCents - taxCents, taxCents, totalCents: amountCents },
    effects: { owedBeforeCents: 0, owedAfterCents: 0, cashCents: destination === 'original' ? -amountCents : 0, customerBalanceCents: cancellation ? -amountCents : destination === 'balance' ? amountCents : 0, revenueCents: cancellation ? 0 : -(amountCents - taxCents) },
    needsSecondApprover: policy.two_person_above_cents !== null && amountCents > policy.two_person_above_cents,
    executionAvailable: invoice.tax_cents === 0 || !!tax,
    providerOutcome: 'not-attempted',
    boundary: 'Read-only estimate from issued records. No processor refund, provider tax reversal, customer balance credit, approval or customer message is created.',
  }
}
