// The existing table/card language, with every total leading to its sources.
import type { Bindings } from '../../auth.server'
import { canRead, can, type Actor } from '../actor'
import { report, reportInvoice } from '../reports'
import { reportLine } from '../report-lines'
import { cents, details, h, hidden, page, table } from './html'
import { quantityText } from '../decimal'
import { linePricing } from './pricing'

// GOV-001: a report reader opens line evidence; the invoice page itself needs invoice reads.
const opens = (actor: Actor, href: string) => !/^\/app\/invoices\/[^/#?]+(?:[#?]|$)/.test(href) || canRead(actor, 'invoices')
const tabs = (search: string, actor: Actor) => { const params = new URLSearchParams(search); params.delete('bucket'); const query = params.size ? `?${params}` : ''; return h`<p class="crumbs">${can(actor, 'read') ? h`<a href="/app/billing">Billing</a> · ` : ''}<a href="/app/reports/mrr${query}">MRR</a> · <a href="/app/reports/billings${query}">Billings</a> · <a href="/app/reports/ar${query}">AR</a> · <a href="/app/reports/collections${query}">Collections</a> · <a href="/app/reports/credits${query}">Credits</a> · <a href="/app/reports/tax${query}">Invoice tax</a> · <a href="/app/reports/unbilled${query}">Unbilled usage</a></p>` }

export async function reportPage(env: Bindings, actor: Actor, metric: string, url: URL) {
  const r = await report(env, actor, metric, url)
  return page(r.title, actor, h`${tabs(url.search, actor)}<h1>${r.title}</h1><p class="lede">${r.period}</p>
    ${can(actor,'export') ? h`<p><a href="/app/exports/reports/${metric}.csv${url.search}">Download CSV</a> · ${actor.kind==='member'?h`<a href="/app/report-schedule">Your monthly email schedule</a>`:''}</p>` : ''}
    <section class="card"><h2>Report basis</h2><p>${r.definition}</p>
      ${metric !== 'ar' ? h`<form method="get">${url.searchParams.has('customer') ? hidden('customer', url.searchParams.get('customer')) : ''}<label>Month <input type="month" name="period" value="${r.period}" required></label><button type="submit">Show month</button></form>` : ''}
      <p><a href="#contributions">Total ${cents(r.totalCents)}</a></p></section>
    <section class="card" id="contributions"><h2>Contributing ${metric === 'collections' ? 'payments' : metric === 'unbilled' ? 'subscription periods' : metric==='credits'?'credit notes':'invoices'}</h2>
      ${table([metric === 'collections' ? 'Payment' : metric === 'unbilled' ? 'Subscription period' : metric==='credits'?'Credit note':'Invoice', 'Customer', 'Contribution$'], r.entries.map(e => [h`<a href="${e.href}">${e.number}</a>`, h`<a href="/app/customers/${e.customerId}">${e.customerName}</a>`, h`<a href="${e.href}">${cents(e.amountCents)}</a>`]), { empty: metric === 'collections' ? 'No recorded payments contribute to this figure.' : 'No source records contribute to this figure.' })}
      <p>Sum of contributions: ${cents(r.totalCents)}.</p></section>`, { current: '/app/billing', url })
}

export async function reportInvoicePage(env: Bindings, actor: Actor, metric: string, invoice: string, url: URL) {
  const r = await reportInvoice(env, actor, metric, invoice, url)
  const sourceTitle=r.unbilled?'Unbilled usage':r.credit?'Credit note':r.payment?'Payment':'Invoice'
  return page(`${sourceTitle} contribution`, actor, h`${tabs(url.search, actor)}<h1>${sourceTitle} ${r.number}</h1><p class="lede">${r.title} · ${r.customerName}</p>
    <p><a href="/app/reports/${metric}${url.search}">Back to report</a> · ${r.unbilled ? h`<a href="${r.unbilled.subscriptionHref}">Subscription preview</a>` : r.payment ? h`<a href="#payment-evidence">Payment evidence</a>` : canRead(actor, 'invoices') ? h`<a href="/app/invoices/${r.invoice?.id ?? invoice}">Open invoice</a>` : ''}</p>
    <section class="card"><h2>Calculation of this contribution</h2>
      ${table(['Source', 'Signed contribution$'], r.components.map(c => [c.href && opens(actor, c.href) ? h`<a href="${c.href}">${c.label}</a>` : c.label, c.href && opens(actor, c.href) ? h`<a href="${c.href}">${cents(c.amountCents)}</a>` : cents(c.amountCents)]))}
      <p>Sum of these sources: <strong>${cents(r.totalCents)}</strong>.</p>
      ${metric === 'ar' ? h`<p class="hint">AR uses original charges and tax less the actual credit notes and payment allocations. Payments and credits are not spread across individual lines.</p>` : ''}</section>
      ${r.unbilled ? h`<section class="card"><h2>Current rating evidence</h2><p>This is a live calculation from recorded inputs. An issued invoice has its own immutable evidence.</p>${r.unbilled.exceptions.length?details({exceptions:r.unbilled.exceptions},'Rating exceptions'):''}${r.unbilled.lines.map(l=>h`<section id="${l.lineId}"><h3>${l.description} · ${cents(l.amountCents)}</h3>${details(l.evidence,'Exact line calculation')}${table(['Event','Quantity','Occurred (UTC)'],l.events.map(e=>[e.eventId,e.quantity,new Date(e.occurredAt).toISOString()]),{empty:'No usage events contribute to this line.'})}</section>`)}${details(r.unbilled.calculation,'Rating inputs and fingerprint')}</section>`:''}
      ${r.payment ? h`<section class="card" id="payment-evidence"><h2>Recorded payment evidence</h2><p>${r.payment.reference} · ${r.payment.receivedOn} · ${r.payment.method}</p><p>${r.payment.evidence || 'No additional evidence was recorded.'}</p><p>Unallocated money has no invoice or usage events behind it yet.</p></section>` : ''}`, { current: '/app/billing', url })
}

export async function reportLinePage(env: Bindings, actor: Actor, invoice: string, line: string, url: URL) {
  const r = await reportLine(env, actor, invoice, line)
  return page('Line evidence', actor, h`<p class="crumbs">${can(actor, 'read') ? h`<a href="/app/billing">Billing</a> · ` : ''}${canRead(actor, 'invoices') ? h`<a href="/app/invoices/${invoice}">Invoice ${r.number}</a>` : h`Invoice ${r.number}`}</p>
    <h1>Line evidence</h1><section class="card"><h2>${r.line.description}</h2>
      <p>Invoice line amount: <strong>${cents(r.line.amount_cents)}</strong>. Quantity: ${quantityText(r.line.quantity)}.</p>
      <p>${r.line.evidence.rule}</p>${linePricing(r.line)}${details(r.line.evidence, 'Saved line calculation')}</section>
    <section class="card"><h2>Usage events behind this line</h2>
      ${table(['Event', 'Quantity$', 'Occurred (UTC)'], r.events.map(e => [e.eventId, quantityText(e.quantity), new Date(e.occurredAt).toISOString()]), { empty: 'This line has no usage events. Its amount follows the saved price, dates and terms.' })}
      ${r.line.evidence.exactQuantity?h`<p>Metric ${r.line.evidence.aggregation}: exact quantity ${r.line.evidence.exactQuantity.numerator} / ${r.line.evidence.exactQuantity.denominator}; the six-place quantity above is a display. Snapshots before this period supply context only.</p>`:''}
      ${r.events.length && !r.line.evidence.exactQuantity ? h`<p>Exact event quantity: ${quantityText(r.quantity)}. ${r.line.evidence.includedQuantity ? `Included quantity: ${r.line.evidence.includedQuantity}; billable overage: ${r.line.quantity}.` : ''} The engine rates the billable quantity and rounds the line once; it does not assign rounded cents to individual events.</p>` : ''}
      ${r.relatedLines.length ? h`<p>Other metered lines on this invoice:</p><ul>${r.relatedLines.map(l => h`<li><a href="${l.href}">${l.label}</a></li>`)}</ul>` : ''}</section>
    <section class="card"><h2>Saved invoice calculation</h2><p>These are the inputs recorded when the invoice was prepared. Later usage corrections do not rewrite this evidence.</p>
      ${details(r.calculation, 'Inputs, rule version and fingerprint')}</section>`, { current: '/app/billing', url })
}
