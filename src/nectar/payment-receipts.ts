import type { Bindings } from '../auth.server'
import { requireRead, type Actor } from './actor'
import { all, insist, one, type Row } from './core'
import { UNALLOCATED_SQL } from './receivables'

export const paymentReceiptPath = (payment: string) => `/app/payments/${encodeURIComponent(payment)}/receipt`

/** Closed financial projection. No reference, evidence, provider JSON or actor narrative. */
export async function readPaymentReceipts(env: Bindings, actor: Actor, customer: string, payment: string | null = null) {
  requireRead(actor, 'payments'); requireRead(actor, 'invoices')
  insist(/^[\w-]{1,100}$/.test(customer), 'invalid_customer')
  const rows = await all(env, `SELECT r.id,r.number,r.sequence,p.customer_id,p.amount_cents,p.currency,p.received_on,p.method,p.recorded_at,${UNALLOCATED_SQL} AS unallocated_cents,
    c.erased_at,EXISTS(SELECT 1 FROM nc_erased_records e WHERE e.record_id IN(p.id,c.id)) AS erased
    FROM nc_payment_receipts r JOIN nc_payments p ON p.id=r.payment_id JOIN nc_customers c ON c.id=p.customer_id
    WHERE p.customer_id=? AND (? IS NULL OR p.id=?) ORDER BY r.sequence`, customer, payment, payment)
  const [allAllocations, allProvenance] = await Promise.all([
    all(env, `SELECT a.id,a.payment_id,a.invoice_id,i.number,a.amount_cents,i.currency,a.allocated_at
      FROM nc_allocations a JOIN nc_invoices i ON i.id=a.invoice_id JOIN nc_payments p ON p.id=a.payment_id
      WHERE p.customer_id=? AND (? IS NULL OR p.id=?) ORDER BY a.allocated_at,a.id`, customer, payment, payment),
    all(env, `SELECT n.id,n.payment_id,n.invoice_id,'native_card_collection' AS kind FROM nc_native_collections n
      JOIN nc_payments p ON p.id=n.payment_id WHERE p.customer_id=? AND (? IS NULL OR p.id=?) AND n.status='collected'
      AND NOT EXISTS(SELECT 1 FROM nc_erased_records e WHERE e.record_id IN(n.id,n.customer_id,n.invoice_id))
      UNION ALL SELECT n.id,n.payment_id,n.invoice_id,'automatic_invoice_collection' AS kind FROM nc_automatic_collections n JOIN nc_payments p ON p.id=n.payment_id WHERE p.customer_id=? AND (? IS NULL OR p.id=?) AND n.status='collected' AND NOT EXISTS(SELECT 1 FROM nc_erased_records e WHERE e.record_id IN(n.id,n.customer_id,n.invoice_id))
      UNION ALL SELECT n.id,n.payment_id,n.invoice_id,'payment_link_checkout' AS kind FROM nc_payment_link_attributions n JOIN nc_payments p ON p.id=n.payment_id WHERE p.customer_id=? AND (? IS NULL OR p.id=?) AND NOT EXISTS(SELECT 1 FROM nc_erased_records e WHERE e.record_id IN(n.id,n.customer_id,n.invoice_id))
      UNION ALL SELECT n.id,n.payment_id,n.invoice_id,'verified_external_ach' AS kind FROM nc_ach_payment_evidence n
      JOIN nc_payments p ON p.id=n.payment_id WHERE p.customer_id=? AND (? IS NULL OR p.id=?)
      AND NOT EXISTS(SELECT 1 FROM nc_erased_records e WHERE e.record_id IN(n.id,n.customer_id,n.invoice_id))`, customer, payment, payment, customer, payment, payment, customer, payment, payment, customer, payment, payment),
  ])
  const group = (facts: Row[]) => {
    const grouped = new Map<string, Row[]>()
    for (const fact of facts) {
      const entries = grouped.get(fact.payment_id) ?? []
      entries.push(fact); grouped.set(fact.payment_id, entries)
    }
    return grouped
  }
  const allSources = await all(env, `SELECT r.payment_id,o.kind,o.source_reference,o.confirmed_at,o.confirmed_by
    FROM nc_remittance_origins o JOIN nc_remittances r ON r.id=o.receipt_id
    WHERE r.customer_id=? AND (? IS NULL OR r.payment_id=?) AND r.status='confirmed' AND o.confirmed_at IS NOT NULL
    ORDER BY o.kind,o.source_reference`, customer, payment, payment)
  const allocationsByPayment = group(allAllocations), provenanceByPayment = group(allProvenance), sourcesByPayment = group(allSources)
  return rows.map(row => {
    const erased = !!row.erased_at || !!row.erased
    const allocations = (allocationsByPayment.get(row.id) ?? [])
    const allocatedCents = allocations.reduce((sum, a) => sum + a.amount_cents, 0)
    // Include parent-payer allocations exactly once without copying child identities.
    const allocationFacts = allocations.map(a => ({ id: a.id, invoice: a.invoice_id, invoiceNumber: a.number,
      amountCents: a.amount_cents, currency: a.currency, allocatedAt: a.allocated_at, sourcePath: `/app/invoices/${encodeURIComponent(a.invoice_id)}` }))
    const provenance = erased ? [] : (provenanceByPayment.get(row.id) ?? [])
    return { id: row.id, number: row.number, sequence: row.sequence, payment: row.id, customer: row.customer_id,
      amountCents: row.amount_cents, currency: row.currency, receivedOn: row.received_on, method: row.method,
      recordedAt: row.recorded_at, allocatedCents, returnedCents: row.amount_cents - allocatedCents - row.unallocated_cents, unallocatedCents: row.unallocated_cents,
      allocations: allocationFacts, recordedSources: erased ? [] : (sourcesByPayment.get(row.id) ?? []).map(s => ({ kind: s.kind, reference: s.source_reference, confirmedAt: s.confirmed_at, confirmedBy: s.confirmed_by })), erased, custody: 'recorded_cash' as const,
      provenance: provenance.map(p => ({ id: p.id, kind: p.kind, invoice: p.invoice_id,
        sourcePath: p.invoice_id ? `/app/invoices/${encodeURIComponent(p.invoice_id)}` : `/app/payments/${encodeURIComponent(row.id)}/receipt` })), sourcePath: paymentReceiptPath(row.id) }
  })
}

export async function readPaymentReceipt(env: Bindings, actor: Actor, payment: string) {
  requireRead(actor, 'payments'); requireRead(actor, 'invoices')
  const source = await one(env, 'SELECT customer_id FROM nc_payments WHERE id=?', payment)
  insist(source, 'payment_receipt_not_found', 404)
  const receipt = (await readPaymentReceipts(env, actor, source.customer_id, payment)).find(row => row.payment === payment)
  insist(receipt, 'payment_receipt_not_found', 404)
  return receipt
}

export type PaymentReceipt = Awaited<ReturnType<typeof readPaymentReceipt>>
