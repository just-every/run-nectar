import { paymentMethodName } from './payment-method-name'
import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { readPaymentReceipt } from '../payment-receipts'
import { cents, h, page, table } from './html'

export async function paymentReceiptPage(env: Bindings, actor: Actor, payment: string, url: URL) {
  const receipt = await readPaymentReceipt(env, actor, payment)
  return page(`Receipt ${receipt.number}`, actor, h`<h1>Receipt ${receipt.number}</h1>
    <p>Recorded cash received. A manually recorded payment is not proof of bank settlement.</p>
    <p><a href="/app/customers/${receipt.customer}">Customer record</a></p>
    <section class="card"><h2>Payment</h2>
      ${table(['Receipt', 'Received on', 'Method', 'Amount', 'Allocated', 'Cash-balance returns', 'Unallocated'], [[receipt.number, receipt.receivedOn,
        paymentMethodName(receipt.method), cents(receipt.amountCents, receipt.currency), cents(receipt.allocatedCents, receipt.currency), cents(receipt.returnedCents, receipt.currency), cents(receipt.unallocatedCents, receipt.currency)]])}
      ${receipt.erased ? h`<p>Personal data erased; retained financial facts.</p>` : ''}
    </section>
    <section class="card"><h2>Invoice allocations</h2>
      ${table(['Invoice', 'Amount'], receipt.allocations.map(a => [h`<a href="${a.sourcePath}">${a.invoiceNumber}</a>`, cents(a.amountCents, a.currency)]), { empty: 'No invoice allocations.' })}
    </section>
    <section class="card"><h2>Recorded sources</h2><p>These confirmed sources reconcile to this one payment.</p>
      ${table(['Source', 'Reference', 'Confirmed by'], receipt.recordedSources.map(s => [s.kind === 'bank_deposit' ? 'Bank deposit' : 'Ordinary remittance', s.reference, s.confirmedBy]), { empty: 'No retained remittance sources.' })}
    </section>
    <section class="card"><h2>Processor provenance</h2>
      ${table(['Source', 'Invoice'], receipt.provenance.map(p => [({verified_external_ach:'Verified external ACH settlement',native_card_collection:'Native card collection',automatic_invoice_collection:'Automatic invoice collection',payment_link_checkout:'Payment link checkout'} as Record<string,string>)[p.kind],
        h`<a href="${p.sourcePath}">Original invoice</a>`]), { empty: 'No retained verified processor source linked to this payment.' })}
    </section>`, { url, current: '/app/receivables' })
}
