// The existing table/card language, with every total leading to its sources.
import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { report, reportInvoice } from '../reports'
import { reportLine } from '../report-lines'
import { cents, details, h, hidden, page, table } from './html'
import { quantityText } from '../decimal'
import { linePricing } from './pricing'

const tabs = (search: string) => { const params = new URLSearchParams(search); params.delete('bucket'); const query = params.size ? `?${params}` : ''; return h`<p class="crumbs"><a href="/app/billing">Billing</a> · <a href="/app/reports/mrr${query}">MRR</a> · <a href="/app/reports/billings${query}">Billings</a> · <a href="/app/reports/ar${query}">AR</a> · <a href="/app/reports/collections${query}">Collections</a></p>` }

export async function reportPage(env: Bindings, actor: Actor, metric: string, url: URL) {
  const r = await report(env, actor, metric, url)
  return page(r.title, actor, h`${tabs(url.search)}<h1>${r.title}</h1><p class="lede">${r.period}</p>
    <section class="card"><h2>Report basis</h2><p>${r.definition}</p>
      ${metric !== 'ar' ? h`<form method="get">${url.searchParams.has('customer') ? hidden('customer', url.searchParams.get('customer')) : ''}<label>Month <input type="month" name="period" value="${r.period}" required></label><button type="submit">Show month</button></form>` : ''}
      <p><a href="#contributions">Total ${cents(r.totalCents)}</a></p></section>
    <section class="card" id="contributions"><h2>Contributing ${metric === 'collections' ? 'payments' : 'invoices'}</h2>
      ${table([metric === 'collections' ? 'Payment' : 'Invoice', 'Customer', 'Contribution$'], r.entries.map(e => [h`<a href="${e.href}">${e.number}</a>`, h`<a href="/app/customers/${e.customerId}">${e.customerName}</a>`, h`<a href="${e.href}">${cents(e.amountCents)}</a>`]), { empty: metric === 'collections' ? 'No recorded payments contribute to this figure.' : 'No issued invoices contribute to this figure.' })}
      <p>Sum of contributions: ${cents(r.totalCents)}.</p></section>`, { current: '/app/billing', url })
}

export async function reportInvoicePage(env: Bindings, actor: Actor, metric: string, invoice: string, url: URL) {
  const r = await reportInvoice(env, actor, metric, invoice, url)
  return page(r.payment ? 'Payment contribution' : 'Invoice contribution', actor, h`${tabs(url.search)}<h1>${r.payment ? 'Payment' : 'Invoice'} ${r.number}</h1><p class="lede">${r.title} · ${r.customerName}</p>
    <p><a href="/app/reports/${metric}${url.search}">Back to report</a> · ${r.payment ? h`<a href="#payment-evidence">Payment evidence</a>` : h`<a href="/app/invoices/${invoice}">Open invoice</a>`}</p>
    <section class="card"><h2>Calculation of this contribution</h2>
      ${table(['Source', 'Signed contribution$'], r.components.map(c => [c.href ? h`<a href="${c.href}">${c.label}</a>` : c.label, c.href ? h`<a href="${c.href}">${cents(c.amountCents)}</a>` : cents(c.amountCents)]))}
      <p>Sum of these sources: <strong>${cents(r.totalCents)}</strong>.</p>
      ${metric === 'ar' ? h`<p class="hint">AR uses original charges and tax less the actual credit notes and payment allocations. Payments and credits are not spread across individual lines.</p>` : ''}</section>
      ${r.payment ? h`<section class="card" id="payment-evidence"><h2>Recorded payment evidence</h2><p>${r.payment.reference} · ${r.payment.receivedOn} · ${r.payment.method}</p><p>${r.payment.evidence || 'No additional evidence was recorded.'}</p><p>Unallocated money has no invoice or usage events behind it yet.</p></section>` : ''}`, { current: '/app/billing', url })
}

export async function reportLinePage(env: Bindings, actor: Actor, invoice: string, line: string, url: URL) {
  const r = await reportLine(env, actor, invoice, line)
  return page('Line evidence', actor, h`<p class="crumbs"><a href="/app/billing">Billing</a> · <a href="/app/invoices/${invoice}">Invoice ${r.number}</a></p>
    <h1>Line evidence</h1><section class="card"><h2>${r.line.description}</h2>
      <p>Invoice line amount: <strong>${cents(r.line.amount_cents)}</strong>. Quantity: ${quantityText(r.line.quantity)}.</p>
      <p>${r.line.evidence.rule}</p>${linePricing(r.line)}${details(r.line.evidence, 'Saved line calculation')}</section>
    <section class="card"><h2>Usage events behind this line</h2>
      ${table(['Event', 'Quantity$', 'Occurred (UTC)'], r.events.map(e => [e.eventId, quantityText(e.quantity), new Date(e.occurredAt).toISOString()]), { empty: 'This line has no usage events. Its amount follows the saved price, dates and terms.' })}
      ${r.events.length ? h`<p>Exact event quantity: ${quantityText(r.quantity)}. The engine rates the combined quantity and rounds the line once; it does not assign rounded cents to individual events.</p>` : ''}
      ${r.relatedLines.length ? h`<p>Other metered lines on this invoice:</p><ul>${r.relatedLines.map(l => h`<li><a href="${l.href}">${l.label}</a></li>`)}</ul>` : ''}</section>
    <section class="card"><h2>Saved invoice calculation</h2><p>These are the inputs recorded when the invoice was prepared. Later usage corrections do not rewrite this evidence.</p>
      ${details(r.calculation, 'Inputs, rule version and fingerprint')}</section>`, { current: '/app/billing', url })
}
