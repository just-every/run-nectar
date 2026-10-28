// Customer-owned cash facts, separate from the operator's receipt projection.
import type { Bindings } from '../auth.server'
import { all, insist, one } from './core'
import { localDate } from './dates'
import { UNALLOCATED_SQL } from './receivables'
import type { CustomerSession } from './portal-session'

export async function portalReceipts(env: Bindings, session: CustomerSession, payment?: string) {
  const customer = await one(env, 'SELECT name,language,currency FROM nc_customers WHERE id=? AND erased_at IS NULL', session.customer)
  insist(customer, 'invalid_customer_session', 401)
  const merchant = await one(env, 'SELECT legal_name,timezone FROM nc_business WHERE singleton=1')
  const rows = await all(env, `SELECT r.id,r.number,p.amount_cents,p.currency,p.received_on,${UNALLOCATED_SQL} AS unallocated_cents,
    COALESCE((SELECT SUM(amount_cents) FROM nc_allocations WHERE payment_id=p.id),0) AS allocated_cents
    FROM nc_payment_receipts r JOIN nc_payments p ON p.id=r.payment_id
    WHERE p.customer_id=? AND NOT EXISTS(SELECT 1 FROM nc_erased_records e WHERE e.record_id IN(p.id,p.customer_id))
    ${payment ? 'AND p.id=?' : ''} ORDER BY p.received_on DESC,r.sequence DESC`, session.customer, ...(payment ? [payment] : []))
  if (payment) insist(rows.length === 1, 'not_found', 404)
  // Aggregate custody includes every allocation of this customer's cash, but
  // invoice identities are disclosed only for their own visible invoices.
  const allocations = await all(env, `SELECT a.payment_id,i.id AS invoice,i.number AS invoiceNumber,a.amount_cents AS amountCents,i.currency,a.allocated_at AS allocatedAt
    FROM nc_allocations a JOIN nc_invoices i ON i.id=a.invoice_id JOIN nc_payments p ON p.id=a.payment_id
    WHERE p.customer_id=? AND i.customer_id=? AND i.status='issued'
    AND NOT EXISTS(SELECT 1 FROM nc_hierarchy_sources hs WHERE hs.invoice_id=i.id)
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records e WHERE e.record_id IN(i.id,p.id,p.customer_id))
    ${payment ? 'AND p.id=?' : ''} ORDER BY a.allocated_at,a.id`, session.customer, session.customer, ...(payment ? [payment] : []))
  return { customer, merchant: { legal_name: merchant!.legal_name }, receipts: rows.map(row => ({
    id: row.id, number: row.number, amountCents: row.amount_cents, currency: row.currency,
    receivedOn: row.received_on, allocatedCents: row.allocated_cents, unallocatedCents: row.unallocated_cents,
    returnedCents: row.amount_cents - row.allocated_cents - row.unallocated_cents, custody: 'recorded_cash' as const,
    allocations: allocations.filter(a => a.payment_id === row.id).map(a => ({ invoice: a.invoice, invoiceNumber: a.invoiceNumber, amountCents: a.amountCents, currency: a.currency, allocatedOn: localDate(a.allocatedAt, merchant!.timezone) })),
  })) }
}

export type PortalReceiptData = Awaited<ReturnType<typeof portalReceipts>>
