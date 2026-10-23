import { canRead,type Actor } from '../actor'
import type { Row } from '../core'
import { decimalText } from '../decimal'
import { cents, h, table } from './html'

export function customerBillingRecordSection(customer: Row,actor:Actor) {
  const record = customer.billingRecord
  if (!record) return ''
  return h`${record.processorPayments ? h`<section class="card"><h2>Processor payments</h2>${table(['Invoice', 'Status', 'Amount', 'Payment intent', 'Charge'], record.processorPayments.map((p: Row) => [h`<a href="/app/invoices/${p.invoice}">${p.invoice}</a>`, p.status, cents(p.amountCents,p.currency), p.paymentIntentRef, p.chargeRef]), { empty: 'No native processor collection records.' })}</section>` : ''}
    ${record.paymentMethods ? h`<section class="card"><h2>Verified card history</h2><p>Card summaries verified when collection was prepared. These saved facts do not confirm the current default card.</p>${table(['Brand', 'Last four', 'Expiry'], record.paymentMethods.map((p: Row) => [p.card.brand, p.card.last4, `${p.card.expMonth}/${p.card.expYear}`]), { empty: 'No verified card summaries.' })}</section>` : ''}
    ${record.creditBalance ? h`<section class="card"><h2>Credit balance</h2><dl class="figures"><div><dt>Available cash</dt><dd>${cents(record.creditBalance.cashCents,customer.currency)}</dd></div><div><dt>Goodwill</dt><dd>${cents(record.creditBalance.goodwillCents,customer.currency)}</dd></div><div><dt>Carried corrections</dt><dd>${cents(record.creditBalance.carriedCents,customer.currency)}</dd></div><div><dt>Total available</dt><dd>${cents(record.creditBalance.totalCents,customer.currency)}</dd></div></dl></section>` : ''}
    ${record.prepaid ? h`<section class="card"><h2>Prepaid balances</h2>${record.prepaid.map((s: Row) => h`<article><h3>${canRead(actor,'invoices')?h`<a href="/app/prepaid/${s.subscription}">Subscription ${s.subscription}</a>`:h`Subscription ${s.subscription}`}</h3><p>As of ${s.asOf}</p>${table(['Kind', 'Meter', 'Remaining', 'Available', 'Purchased liability$'], s.balances.map((b: Row) => [b.kind, b.meterId ?? 'All meters', b.kind === 'money' ? cents(b.remainingN) : decimalText(BigInt(b.remainingN)), b.kind === 'money' ? cents(b.availableN) : decimalText(BigInt(b.availableN)), cents(b.liabilityCents)]), { empty: 'No prepaid balances.' })}</article>`)}</section>` : ''}
    ${record.refunds ? h`<section class="card"><h2>Refund lifecycle</h2>${table(['Request', 'Status', 'Amount', 'Processor refund', 'Requested', 'Approved', 'Returned'], record.refunds.map((r: Row) => [h`<a href="${r.source}">${r.id}</a>`, r.status, cents(r.amountCents), r.refundRef, r.requestedAt, r.approvedAt, r.refundedOn]), { empty: 'No prepaid refund requests.' })}</section>` : ''}
    <section class="card"><h2>Customer audit events</h2>${table(['Sequence', 'When', 'Action', 'Record'], record.auditEvents.map((event: Row) => [event.seq, event.at, event.action, event.subject]), { empty: 'No customer audit events.' })}</section>`
}
