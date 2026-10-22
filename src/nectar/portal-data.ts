import { sharedCreditReasonSql } from './shared-credit-custody'
// Dedicated safe projections: no operator read models, raw calculation inputs,
// internal notes, metadata, credentials, audit actors or unissued invoices.
import type { Bindings } from '../auth.server'
import { all, insist, one } from './core'
import { BALANCE_SQL, GOODWILL_APPLIED_SQL } from './receivables'
import type { CustomerSession } from './portal-session'

export async function portalData(env: Bindings, session: CustomerSession, invoiceId?: string) {
  const customer = await one(env, 'SELECT name,language FROM nc_customers WHERE id=? AND erased_at IS NULL', session.customer)
  insist(customer, 'invalid_customer_session', 401)
  const merchant = await one(env, 'SELECT legal_name,currency FROM nc_business WHERE singleton=1')
  const brand = await one(env, 'SELECT brand_name,brand_color FROM nc_portal_policy WHERE singleton=1')
  const invoices = await all(env, `SELECT i.id,i.number,i.issue_date,i.due_date,i.subtotal_cents,i.tax_cents,i.total_cents,${BALANCE_SQL} AS balance_cents,
    COALESCE((SELECT SUM(COALESCE(applied_cents,amount_cents)) FROM nc_credit_notes WHERE invoice_id=i.id),0) + COALESCE((SELECT SUM(amount_cents) FROM nc_usage_credit_applications WHERE invoice_id=i.id),0) + ${GOODWILL_APPLIED_SQL} AS credited_cents,
    COALESCE((SELECT SUM(amount_cents) FROM nc_allocations WHERE invoice_id=i.id),0) AS paid_cents
    FROM nc_invoices i WHERE i.customer_id=? AND i.status='issued' ${invoiceId ? 'AND i.id=?' : ''} ORDER BY i.issue_date DESC,i.number DESC`, session.customer, ...(invoiceId ? [invoiceId] : []))
  if (invoiceId) insist(invoices.length === 1, 'not_found', 404)
  const selected = invoiceId ? {
    lines: await all(env, 'SELECT description,quantity,unit_amount,amount_cents,period_start,period_end FROM nc_invoice_lines WHERE invoice_id=? ORDER BY seq', invoiceId),
    credits: await all(env, `SELECT n.number,COALESCE(n.applied_cents,n.amount_cents) AS amount_cents,${sharedCreditReasonSql('n')} AS reason FROM nc_credit_notes n WHERE n.invoice_id=? AND n.customer_id=? ORDER BY n.issued_at,n.number,n.id`, invoiceId, session.customer),
    payments: await all(env, 'SELECT a.amount_cents,p.received_on,p.method FROM nc_allocations a JOIN nc_payments p ON p.id=a.payment_id WHERE a.invoice_id=? AND p.customer_id=? ORDER BY p.received_on', invoiceId, session.customer),
  } : null
  if(selected)selected.credits.push(...await all(env,`SELECT n.number,a.amount_cents,${sharedCreditReasonSql('n')} AS reason FROM nc_usage_credit_applications a JOIN nc_credit_notes n ON n.id=a.credit_id WHERE a.invoice_id=? AND a.customer_id=? ORDER BY a.applied_at,a.id`,invoiceId,session.customer))
  return { customer, merchant, brand, invoices, ...(selected ? selected : {}) }
}
