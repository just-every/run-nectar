// Customer-scoped downloadable records never reuse operator custody projections.
import type { Bindings } from '../auth.server'
import { all, insist, one } from './core'
import { customerText } from './locale'
import { portalPage } from './portal-page'
import type { CustomerSession } from './portal-session'
import { sharedCreditReasonSql } from './shared-credit-custody'
import { h } from './ui/html'

export async function portalFinancialDocuments(env: Bindings, session: CustomerSession) {
  const [receipts,credits]=await Promise.all([
    all(env,`SELECT r.number,p.id,p.amount_cents,p.currency,p.received_on FROM nc_payment_receipts r JOIN nc_payments p ON p.id=r.payment_id
      WHERE p.customer_id=? ORDER BY r.sequence`,session.customer),
    all(env,`SELECT n.id,n.number,n.amount_cents,i.currency,i.number AS invoice_number FROM nc_credit_notes n JOIN nc_invoices i ON i.id=n.invoice_id
      WHERE n.customer_id=? AND i.customer_id=? AND i.status IN ('issued','void') ORDER BY n.issued_at,n.id`,session.customer,session.customer),
  ])
  return {receipts,credits}
}

export async function portalFinancialDownload(env: Bindings,session: CustomerSession,kind:'receipts'|'credits',id:string) {
  const L=customerText(session.language,session.currency)
  const merchant=await one(env,'SELECT legal_name FROM nc_business WHERE singleton=1')
  const customer=await one(env,'SELECT name FROM nc_customers WHERE id=? AND erased_at IS NULL',session.customer)
  insist(customer,'not_found',404)
  const record=kind==='receipts'?await one(env,`SELECT r.number,p.currency,p.amount_cents,p.received_on AS date FROM nc_payment_receipts r
    JOIN nc_payments p ON p.id=r.payment_id WHERE p.id=? AND p.customer_id=?`,id,session.customer):
    await one(env,`SELECT n.number,n.amount_cents,i.currency,i.number AS invoice_number,${sharedCreditReasonSql('n')} AS reason FROM nc_credit_notes n
      JOIN nc_invoices i ON i.id=n.invoice_id WHERE n.id=? AND n.customer_id=? AND i.customer_id=? AND i.status IN ('issued','void')`,id,session.customer,session.customer)
  insist(record,'not_found',404)
  const allocations=kind==='receipts'?await all(env,`SELECT i.number,a.amount_cents FROM nc_allocations a JOIN nc_invoices i ON i.id=a.invoice_id
    WHERE a.payment_id=? AND i.customer_id=? ORDER BY i.number`,id,session.customer):[]
  const title=L.t(kind==='receipts'?'portal.documents.receipt':'portal.documents.credit')
  const response=portalPage(title,h`<h1>${title} ${record.number}</h1><p>${customer.name}</p><dl><dt>${L.t('portal.total')}</dt><dd>${L.money(record.amount_cents,record.currency)}</dd>
    ${record.date?h`<dt>${L.t('portal.issued')}</dt><dd>${L.day(record.date)}</dd>`:''}
    ${record.invoice_number?h`<dt>${L.t('portal.documents.invoice')}</dt><dd>${record.invoice_number}</dd>`:''}</dl>
    ${record.reason?h`<p>${record.reason==='unused_paid_credit'?L.t('portal.prepaid.entry.refund'):record.reason}</p>`:''}
    ${allocations.map(row=>h`<p>${row.number} · ${L.money(row.amount_cents,record.currency)}</p>`)}`,{lang:L.tag,name:merchant?.legal_name??''})
  const headers=new Headers(response.headers)
  headers.set('content-disposition',`attachment; filename="${kind==='receipts'?'receipt':'credit'}-${record.number.replace(/[^A-Za-z0-9_-]/g,'_')}.html"`)
  headers.set('content-security-policy',"default-src 'none'; style-src 'none'; sandbox")
  return new Response(response.body,{headers})
}
