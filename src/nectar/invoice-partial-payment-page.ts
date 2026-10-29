import type { Bindings } from '../auth.server'
import { h, hidden } from './ui/html'
import { customerText } from './locale'
import { ownInvoicePartials } from './invoice-partial-payments'
import type { CustomerSession } from './portal-session'
import type { Row } from './core'

export function partialCustomerView(row: Row) {
  return { id: row.id, invoice: row.invoice_id, status: row.status, amountCents: row.amount_cents, balanceCents: row.balance_cents,
    basisHash: row.basis_hash, accountRef: row.account_ref, payment: row.payment_id }
}
export async function invoicePartialPage(env: Bindings, session: CustomerSession, invoice: string, link: (path:string)=>string) {
  if(session.audience!=='hosted')return ''
  const L=customerText(session.language),rows=await ownInvoicePartials(env,session,invoice)
  return rows.map(row=>h`<section class="card" data-partial="${row.id}"><h2>${L.t('partial.title')}</h2>
    <dl><dt>${L.t('partial.amount')}</dt><dd>${L.money(row.amount_cents)}</dd><dt>${L.t('partial.before')}</dt><dd>${L.money(row.balance_cents)}</dd>
    <dt>${L.t('partial.after')}</dt><dd>${L.money(row.balance_cents-row.amount_cents)}</dd><dt>${L.t('partial.account')}</dt><dd>${row.account_ref}</dd></dl>
    <p>${L.t('partial.boundary')}</p><p>${L.t(`partial.status.${row.status}`)}</p>
    ${row.status==='approved'?h`<form method="post" action="${link('/portal/invoice-payment/start')}">${hidden('request',row.id)}${hidden('basis_hash',row.basis_hash)}
      <p><label><input type="checkbox" name="accept" value="true" required> ${L.t('partial.accept')}</label></p><button type="submit">${L.t('partial.pay')}</button></form>`:''}
    ${['open','claimed','uncertain'].includes(row.status)?h`<form method="post" action="${link('/portal/invoice-payment/check')}">${hidden('request',row.id)}<button type="submit">${L.t('partial.check')}</button></form>`:''}
  </section>`)
}
