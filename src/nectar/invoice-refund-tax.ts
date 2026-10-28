// Provider transactions are attached only after matching immutable native lines.
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, type Actor } from './actor'
import { clockInstant } from './clock'
import { all, canonical, commit, guard, insist, one, newId, parseJson, stmt, type Row } from './core'
import type { Input } from './input'
import { requireFreshFactor } from './mfa'
import { providerReference, providerUnavailable, stripeForAccount, type StripeClient } from './payments/stripe'
import { refundActorGuard } from './prepaid-refund-records'

async function transactionLines(stripe: StripeClient, id: string, livemode: boolean) {
  const transaction = await stripe(`/tax/transactions/${encodeURIComponent(id)}`)
  insist(transaction.object === 'tax.transaction' && transaction.id === id && transaction.livemode === livemode && transaction.currency === 'usd' && !transaction.shipping_cost, 'invoice_tax_transaction_mismatch', 409)
  const lines = await stripe(`/tax/transactions/${encodeURIComponent(id)}/line_items?limit=100`)
  insist(lines.object === 'list' && lines.has_more === false && Array.isArray(lines.data) && lines.data.length > 0, 'invoice_tax_lines_incomplete', 409)
  return { transaction, lines: lines.data as Row[] }
}
export async function bindInvoiceTax(env: Bindings, actor: Actor, input: Input) {
  try { return await bindTax(env,actor,input) } catch(error) { return providerUnavailable(error) }
}
async function bindTax(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve'); await requireFreshFactor(env, actor)
  insist(input.flag('confirm'), 'confirmation_required')
  const generation=(await one(env,'SELECT value FROM nc_privacy_generation WHERE id=1'))!.value
  const invoice = await one(env, 'SELECT i.* FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id WHERE i.id=? AND c.erased_at IS NULL', input.text('invoice', { max: 100 }))
  insist(invoice && invoice.status === 'issued' && invoice.tax_cents > 0, 'taxed_issued_invoice_required', 409)
  const receipt = await one(env, "SELECT proof_json FROM nc_native_collections WHERE invoice_id=? AND status='collected'", invoice.id)
  const proof = parseJson<Row>(receipt?.proof_json, {})
  insist(proof.proof === 'succeeded-payment-intent-and-captured-charge' && typeof proof.livemode === 'boolean' && proof.amountCents === invoice.total_cents, 'verified_test_card_capture_required', 409)
  const { stripe } = await stripeForAccount(env, proof.accountRef)
  const id = providerReference(input.text('transaction', { max: 255 })), { transaction, lines } = await transactionLines(stripe, id, proof.livemode)
  const originals = await all(env, 'SELECT id,amount_cents FROM nc_invoice_lines WHERE invoice_id=? ORDER BY seq,id', invoice.id)
  insist(transaction.type === 'transaction' && !transaction.reversal && transaction.reference === invoice.id && transaction.customer === proof.customerRef && lines.length === originals.length, 'invoice_tax_transaction_mismatch', 409)
  insist(lines.every(line => line.type === 'transaction' && line.livemode === proof.livemode && line.tax_behavior === 'exclusive' && Number.isSafeInteger(line.amount) && line.amount > 0 && Number.isSafeInteger(line.amount_tax) && line.amount_tax >= 0 && originals.some(original => original.id === line.reference && original.amount_cents === line.amount)) && new Set(lines.map(line => line.reference)).size === originals.length && lines.reduce((sum, line) => sum + line.amount, 0) === invoice.subtotal_cents && lines.reduce((sum, line) => sum + line.amount_tax, 0) === invoice.tax_cents, 'invoice_tax_lines_mismatch', 409)
  const typed = originals.map(original => { const line = lines.find(line => line.reference === original.id)!; return { id: providerReference(line.id), reference: original.id, amountCents: line.amount, taxCents: line.amount_tax } })
  await commit(env, [refundActorGuard(env, actor), guard(env,'invoice_tax_source_changed','(SELECT value FROM nc_privacy_generation WHERE id=1)=?',generation),guard(env, 'invoice_tax_already_adjusted', 'NOT EXISTS(SELECT 1 FROM nc_credit_notes WHERE invoice_id=?) AND NOT EXISTS(SELECT 1 FROM nc_invoice_refunds WHERE invoice_id=?)', invoice.id, invoice.id),
    stmt(env, 'INSERT INTO nc_invoice_tax(invoice_id,customer_id,account_ref,livemode,transaction_ref,lines_json,bound_by,bound_at) VALUES(?,?,?,?,?,?,?,?)', invoice.id, invoice.customer_id, proof.accountRef, proof.livemode ? 1 : 0, id, canonical(typed), actor.id, clockInstant(env))], { actor: actorLabel(actor), action: 'invoice.tax.bind', subject: invoice.id, detail: { transaction: id } })
  return { invoice: invoice.id, transaction: id, subtotalCents: invoice.subtotal_cents, taxCents: invoice.tax_cents }
}

// Allocate gross consideration chronologically over the provider's original
// lines. Cumulative rounding makes a final remainder reverse every cent once.
export function taxReversalPlan(lines: Row[], before: number, amount: number) {
  const cumulative = (gross: number) => {
    let remaining = gross
    return lines.map(line => {
      const taken = Math.min(remaining, line.amountCents + line.taxCents); remaining -= taken
      const tax = Number((BigInt(line.taxCents) * BigInt(taken) * 2n + BigInt(line.amountCents + line.taxCents)) / (2n * BigInt(line.amountCents + line.taxCents)))
      return { subtotalCents: taken - tax, taxCents: tax }
    })
  }
  const prior = cumulative(before), after = cumulative(before + amount)
  return lines.map((line, index) => ({ originalLineItem: line.id, subtotalCents: after[index].subtotalCents - prior[index].subtotalCents, taxCents: after[index].taxCents - prior[index].taxCents })).filter(line => line.subtotalCents + line.taxCents > 0)
}
export async function invoiceTaxQuote(env: Bindings, invoice: Row, prior: number, amount: number) {
  const saved = await one(env, 'SELECT * FROM nc_invoice_tax WHERE invoice_id=?', invoice.id)
  if (!saved) return null
  const lines = parseJson<Row[]>(saved.lines_json, [])
  insist(lines.length && lines.reduce((sum, line) => sum + line.amountCents + line.taxCents, 0) === invoice.total_cents, 'invoice_tax_source_changed', 409)
  const reversing = taxReversalPlan(lines, prior, amount)
  return { transactionRef: saved.transaction_ref, accountRef: saved.account_ref, livemode: !!saved.livemode, lines, reversing }
}

const refundState = (env: Bindings, r: Row) => guard(env, 'invoice_refund_state_changed', 'EXISTS(SELECT 1 FROM nc_invoice_refunds WHERE id=? AND revision=?)', r.id, r.revision)
async function saveTax(env: Bindings, actor: Actor, r: Row, reference: string | null) {
  await commit(env, [refundActorGuard(env, actor), refundState(env, r), stmt(env, `UPDATE nc_invoice_refunds SET status='uncertain',tax_claimed_at=COALESCE(tax_claimed_at,?),tax_ref=?,revision=? WHERE id=?`, clockInstant(env), reference, newId(), r.id)], { actor: actorLabel(actor), action: reference ? 'invoice.refund.tax.confirm' : 'invoice.refund.tax.claim', subject: r.id, detail: { transaction: reference } })
  return (await one(env, 'SELECT * FROM nc_invoice_refunds WHERE id=?', r.id))!
}
export async function reverseInvoiceTax(env: Bindings, actor: Actor, r: Row, q: Row, supplied?: string) {
  if (!q.tax) return { refund: r, proof: null }
  const { stripe } = await stripeForAccount(env, q.tax.accountRef)
  let id = r.tax_ref || supplied
  if (!id) {
    insist(await one(env,'SELECT 1 FROM nc_invoice_refund_authority WHERE refund_id=?',r.id),'invoice_refund_authority_inactive',409)
    insist(!r.tax_claimed_at, 'invoice_refund_tax_unconfirmed', 409)
    r = await saveTax(env, actor, r, null)
    const fields = new URLSearchParams({ mode: 'partial', original_transaction: q.tax.transactionRef, reference: r.id })
    q.tax.reversing.forEach((line: Row, index: number) => {
      fields.set(`line_items[${index}][original_line_item]`, line.originalLineItem)
      fields.set(`line_items[${index}][reference]`, `${r.id}-${index}`)
      fields.set(`line_items[${index}][amount]`, String(-line.subtotalCents))
      fields.set(`line_items[${index}][amount_tax]`, String(-line.taxCents))
    })
    const transaction = await stripe('/tax/transactions/create_reversal', fields, `nectar-invoice-tax-${r.intent_key}`)
    id = providerReference(transaction.id)
    // Retain the returned identity before a later read can fail. Recovery is
    // read-only; a missing response requires an independently supplied receipt.
    r = await saveTax(env, actor, r, id)
  }
  id = providerReference(id)
  const { transaction, lines } = await transactionLines(stripe, id, q.tax.livemode)
  insist(transaction.type === 'reversal' && transaction.reference === r.id && transaction.reversal?.original_transaction === q.tax.transactionRef && lines.length === q.tax.reversing.length, 'invoice_refund_tax_receipt_mismatch', 409)
  insist(q.tax.reversing.every((expected: Row, index: number) => lines.some(line => line.reference === `${r.id}-${index}` && line.type === 'reversal' && line.reversal?.original_line_item === expected.originalLineItem && line.amount === -expected.subtotalCents && line.amount_tax === -expected.taxCents)), 'invoice_refund_tax_receipt_mismatch', 409)
  if (r.tax_ref !== id) r = await saveTax(env, actor, r, id)
  return { refund: r, proof: { transactionRef: id, originalTransactionRef: q.tax.transactionRef, subtotalCents: -q.reversing.subtotalCents, taxCents: -q.reversing.taxCents } }
}
