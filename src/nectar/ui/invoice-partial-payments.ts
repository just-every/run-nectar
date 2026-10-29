import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import type { Row } from '../core'
import { partialPaymentRows } from '../invoice-partial-payments'
import { cents, check, field, form, h, hidden } from './html'

export async function invoicePartialSection(env: Bindings,actor: Actor,invoice: Row) {
  if(actor.kind!=='member'||actor.role!=='owner'||invoice.status!=='issued'||invoice.retainedFinancial)return ''
  const rows=(await partialPaymentRows(env,actor,invoice.customer_id)).filter(r=>r.invoice===invoice.id),back=`/app/invoices/${invoice.id}`
  return h`<section class="card" id="partial-payment"><h2>Customer partial card payment</h2>
    <p>Prepare one exact amount with a fresh authenticator or passkey. Confirming reserves this invoice for the customer's separate acceptance on its hosted page. This test-mode payment saves no method and grants no future collection authority.</p>
    ${invoice.balanceCents>50&&!rows.some(r=>['approved','claimed','open','uncertain'].includes(r.status))?h`<details><summary>Prepare a partial payment</summary>${form('invoice.partial.prepare',back,h`${hidden('invoice',invoice.id)}${field('Payment amount in cents','amount_cents',{type:'number',value:'40000'})}`,'Review exact amount',{secondary:true})}</details>`:''}
    ${rows.map(row=>h`<article><h3>${row.status.replaceAll('_',' ')}</h3><p>${cents(row.amountCents)} now · ${cents(row.balanceCents)} balance before payment · ${cents(row.balanceCents-row.amountCents)} remaining after capture.</p><p>Invoice ${invoice.number} · Customer ${row.customer} · Stripe customer ${row.customerRef} · Account ${row.accountRef}</p>
      ${row.confirm?form('invoice.partial.confirm',back,h`${Object.entries(row.confirm).filter(([key])=>key!=='confirm').map(([key,value])=>hidden(key,value))}${check('Allow exactly this invoice, customer, account, amount and balance for separate customer acceptance.','confirm')}`,'Confirm and reserve',{secondary:true}):''}
      ${['prepared','approved'].includes(row.status)?form('invoice.partial.revoke',back,hidden('request',row.id),'Withdraw before checkout',{secondary:true}):''}
      ${['claimed','open','uncertain'].includes(row.status)?form('invoice.partial.reconcile',back,hidden('request',row.id),'Check existing checkout',{secondary:true}):''}
      ${row.payment?h`<p>Recorded payment ${row.payment}, allocated once to this invoice.</p>`:''}
    </article>`)}
  </section>`
}
