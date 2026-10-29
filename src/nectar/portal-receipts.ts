import type { Bindings } from '../auth.server'
import { all, insist, one } from './core'
import { financialPdf } from './invoice-pdf'
import { customerText } from './locale'
import type { CustomerSession } from './portal-session'
import { UNALLOCATED_SQL } from './receivables'
import { h } from './ui/html'

// Customer authority is always the current signed session. Operator receipt
// projections contain source references and must never become customer views.
export async function portalReceiptData(env: Bindings, session: CustomerSession, payment?: string) {
  const customer = await one(env, 'SELECT name,language,currency FROM nc_customers WHERE id=? AND erased_at IS NULL', session.customer)
  insist(customer, 'invalid_customer_session', 401)
  const merchant = await one(env, 'SELECT legal_name FROM nc_business WHERE singleton=1')
  const receipts = await all(env, `SELECT r.id,r.number,p.amount_cents AS amountCents,p.currency,p.received_on AS receivedOn,
    COALESCE((SELECT SUM(amount_cents) FROM nc_allocations WHERE payment_id=p.id),0) AS allocatedCents,
    COALESCE((SELECT SUM(amount_cents) FROM nc_balance_entries WHERE kind='return' AND payment_id=p.id),0) AS returnedCents,
    ${UNALLOCATED_SQL} AS unallocatedCents
    FROM nc_payment_receipts r JOIN nc_payments p ON p.id=r.payment_id
    WHERE p.customer_id=? ${payment ? 'AND p.id=?' : ''} ORDER BY r.sequence DESC`, session.customer, ...(payment ? [payment] : []))
  if (payment) insist(receipts.length === 1, 'not_found', 404)
  const allocations = payment ? await all(env, `SELECT i.id AS invoice,i.number,a.amount_cents AS amountCents,i.currency
    FROM nc_allocations a JOIN nc_invoices i ON i.id=a.invoice_id JOIN nc_payments p ON p.id=a.payment_id
    WHERE p.id=? AND p.customer_id=? AND i.customer_id=? AND i.status='issued'
    AND NOT EXISTS(SELECT 1 FROM nc_hierarchy_sources hs WHERE hs.invoice_id=i.id)
    ORDER BY a.allocated_at,a.id`, payment, session.customer, session.customer) : []
  return { customer, merchant, receipts, allocations, custody: 'recorded_cash' }
}

export function portalReceiptPage(data: Awaited<ReturnType<typeof portalReceiptData>>, payment: string | undefined, link: (path: string) => string) {
  const L = customerText(data.customer.language, data.customer.currency)
  return h`<h1>${L.t('portal.receipts.heading')}</h1><p>${data.customer.name}</p><p>${L.t('portal.receipts.recorded')}</p><p><a href="${link('/portal')}">${L.t('portal.back')}</a>${payment ? h` · <a href="${link('/portal/receipts')}">${L.t('portal.receipts.heading')}</a>` : ''}</p>
    ${data.receipts.length ? data.receipts.map(row => h`<section class="card"><h2>${payment ? row.number : h`<a href="${link(`/portal/receipts/${row.id}`)}">${row.number}</a>`}</h2>
      <dl><dt>${L.t('portal.receipts.received')}</dt><dd>${L.day(row.receivedOn)}</dd><dt>${L.t('portal.receipts.amount')}</dt><dd>${L.money(row.amountCents,row.currency)}</dd><dt>${L.t('portal.receipts.allocated')}</dt><dd>${L.money(row.allocatedCents,row.currency)}</dd><dt>${L.t('portal.receipts.returned')}</dt><dd>${L.money(row.returnedCents,row.currency)}</dd><dt>${L.t('portal.receipts.unallocated')}</dt><dd>${L.money(row.unallocatedCents,row.currency)}</dd></dl>
      ${payment ? h`<p><a href="${link(`/portal/receipts/${row.id}`)}&amp;format=pdf">${L.t('portal.receipts.pdf')}</a></p><h3>${L.t('portal.receipts.allocations')}</h3>${data.allocations.map(a => h`<p><a href="${link(`/portal/invoices/${a.invoice}`)}">${a.number}</a> · ${L.money(a.amountCents,a.currency)}</p>`)}` : ''}</section>`) : h`<p>${L.t('portal.receipts.empty')}</p>`}`
}

export function portalReceiptPdf(data: Awaited<ReturnType<typeof portalReceiptData>>) {
  const row = data.receipts[0], L = customerText(data.customer.language, row.currency)
  const rows = [L.t('portal.receipts.heading'), row.number, data.merchant?.legal_name, data.customer.name,
    L.t('portal.receipts.recorded'), `${L.t('portal.receipts.received')}: ${L.day(row.receivedOn)}`,
    ...[['amount',row.amountCents],['allocated',row.allocatedCents],['returned',row.returnedCents],['unallocated',row.unallocatedCents]].map(([key,value]) => `${L.t(`portal.receipts.${key}`)}: ${L.money(Number(value),row.currency)}`),
    L.t('portal.receipts.allocations'), ...data.allocations.map(a => `${a.number}: ${L.money(a.amountCents,a.currency)}`)]
  return financialPdf(rows, { color: '#245c46', logo: '' })
}
