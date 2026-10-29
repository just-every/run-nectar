import type { Bindings } from '../auth.server'
import { h, hidden } from './ui/html'
import { customerText } from './locale'
import { ownInvoicePartials } from './invoice-partial-payments'
import type { CustomerSession } from './portal-session'
import { parseJson, type Row } from './core'

export function partialCustomerView(row: Row) {
  const basis=parseJson<Row>(row.basis_json,{})
  return { kind:row.payment_kind,scheduledOn:basis.scheduledOn??null,claimedAt:row.claimed_at, id: row.id, invoice: row.invoice_id, status: row.status, amountCents: row.amount_cents, balanceCents: row.balance_cents,
    basisHash: row.basis_hash, accountRef: row.account_ref, payment: row.payment_id }
}
export async function invoicePartialPage(env: Bindings, session: CustomerSession, invoice: string, link: (path:string)=>string) {
  if(session.audience!=='hosted')return ''
  const L=customerText(session.language),rows=await ownInvoicePartials(env,session,invoice)
  return rows.map(row=>{const basis=parseJson<Row>(row.basis_json,{});return h`<section class="card" data-partial="${row.id}"><h2>${L.t(row.payment_kind==='scheduled_ach'?'schedule.title':'partial.title')}</h2>
    <dl><dt>${L.t('partial.amount')}</dt><dd>${L.money(row.amount_cents)}</dd><dt>${L.t('partial.before')}</dt><dd>${L.money(row.balance_cents)}</dd>
    <dt>${L.t('partial.after')}</dt><dd>${L.money(row.balance_cents-row.amount_cents)}</dd><dt>${L.t('partial.account')}</dt><dd>${row.account_ref}</dd></dl>
    ${row.payment_kind==='scheduled_ach'?h`<dl><dt>${L.t('schedule.date')}</dt><dd>${L.day(basis.scheduledOn)}</dd><dt>${L.t('schedule.method')}</dt><dd>${basis.method.summary.bankName} · ${basis.method.summary.last4}</dd></dl>`:''}
    <p>${L.t(row.payment_kind==='scheduled_ach'?'schedule.boundary':'partial.boundary')}</p><p>${L.t(row.payment_kind==='scheduled_ach'?(row.status==='open'&&row.claimed_at?'schedule.pending':`schedule.status.${row.status}`):`partial.status.${row.status}`)}</p>
    ${row.status==='approved'?h`<form method="post" action="${link(row.payment_kind==='scheduled_ach'?'/portal/invoice-payment/schedule':'/portal/invoice-payment/start')}">${hidden('request',row.id)}${hidden('basis_hash',row.basis_hash)}
      <p><label><input type="checkbox" name="accept" value="true" required> ${L.t(row.payment_kind==='scheduled_ach'?'schedule.accept':'partial.accept')}</label></p><button type="submit">${L.t(row.payment_kind==='scheduled_ach'?'schedule.submit':'partial.pay')}</button></form>`:''}
    ${row.payment_kind==='scheduled_ach'&&['approved','open'].includes(row.status)&&!row.claimed_at?h`<form method="post" action="${link('/portal/invoice-payment/withdraw')}">${hidden('request',row.id)}${hidden('withdraw','true')}<button type="submit">${L.t('schedule.withdraw')}</button></form>`:''}
    ${['open','claimed','uncertain'].includes(row.status)&&(row.payment_kind==='card'||row.claimed_at)?h`<form method="post" action="${link('/portal/invoice-payment/check')}">${hidden('request',row.id)}<button type="submit">${L.t('partial.check')}</button></form>`:''}
  </section>`})
}
