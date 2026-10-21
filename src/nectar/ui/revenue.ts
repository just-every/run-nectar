// Intended destination: src/nectar/ui/revenue.ts.
import type { Bindings } from '../../auth.server'
import { can, type Actor } from '../actor'
import { revenueReport, revenueSource } from '../revenue-reports'
import { cents, details, h, hidden, page, table } from './html'

const custody = (value: string) => value === 'issue-snapshot' ? 'Saved at issue' : value === 'derived-imported-originals' ? 'Read-only imported source' : 'Derived from saved originals; no records changed'
const movements: Record<string, string> = { billing: 'Original line billed', recognition: 'Line revenue recognized', 'credit-billing': 'Credit note issued', 'credit-recognition': 'Contra-revenue recognized' }
const kind = (value: string) => movements[value] ?? value

export async function revenuePage(env: Bindings, actor: Actor, url: URL) {
  const report = await revenueReport(env, actor, url)
  return page('Revenue schedules', actor, h`<p class="crumbs"><a href="/app/billing">Billing</a> · <a href="/app/reports/billings">Billings report</a></p>
    <h1>Revenue schedules</h1><p class="lede">${report.from === report.to ? report.from : `${report.from} through ${report.to}`}</p>
    ${can(actor, 'export') ? h`<p><a href="/app/exports/revenue.csv${url.search}">Download revenue CSV</a> · <a href="/app/exports/revenue-journal.csv${url.search}">Download monthly journal CSV</a></p><p class="hint">The journal is a read-only pretax export for ledger mapping. It excludes tax and cash entries; it does not close a period or post to a ledger.</p>` : ''}
    <section class="card"><h2>Report basis</h2><p>${report.definition}</p>
      <form method="get">${report.customerId ? hidden('customer', report.customerId) : ''}<label>From month <input type="month" name="from" value="${report.from}" required></label><label>Through month <input type="month" name="to" value="${report.to}" required></label><button type="submit">Show months</button></form>
      <p>Opening signed position ${cents(report.openingCents)} + net billings ${cents(report.netBillingsCents)} − recognized revenue ${cents(report.recognizedCents)} = closing signed position <strong>${cents(report.closingCents)}</strong>.</p>
      <p>At the end of ${report.to}: accrued contract assets <strong>${cents(report.accruedContractAssetCents)}</strong>; deferred revenue liabilities <strong>${cents(report.deferredLiabilityCents)}</strong>. These show each invoice’s position before netting.</p>
    </section>
    <section class="card"><h2>Monthly roll-forward</h2>
      ${table(['Month', 'Opening$', 'Original billings$', 'Credits$', 'Net billings$', 'Recognized$', 'Closing$', 'Accrued assets$', 'Deferred liabilities$'], report.months.map(month => [month.period, cents(month.openingCents), cents(month.billingsCents), cents(month.creditsCents), cents(month.netBillingsCents), cents(month.recognizedCents), cents(month.closingCents), cents(month.accruedContractAssetCents), cents(month.deferredLiabilityCents)]))}
      <p class="hint">A negative signed position is accrued service revenue awaiting billing. Monthly arrears do not create a deferred-revenue liability.</p>
    </section>
    <section class="card" id="contributions"><h2>Source journal contributions</h2>
      <p>Billing and recognition are separate journal movements. Add billing movements and subtract recognition movements to calculate the change in signed position.</p>
      ${table(['Month', 'Movement', 'Document', 'Customer', 'Contribution$', 'Schedule custody'], report.contributions.map(row => [row.period, kind(row.kind), h`<a href="${row.href}">${row.number || 'Retained document'}</a>`, h`<a href="/app/customers/${row.customerId}">${row.customerName}</a>`, cents(row.amountCents), custody(row.custody)]), { empty: 'No issued invoice lines or credit notes contribute in these months.' })}
    </section>`, { url, current: '/app/billing' })
}

export async function revenueSourcePage(env: Bindings, actor: Actor, invoice: string, url: URL) {
  const source = await revenueSource(env, actor, invoice, url)
  return page('Revenue source', actor, h`<p class="crumbs"><a href="/app/revenue${url.search}">Revenue schedules</a> · <a href="${source.source?.href??`/app/invoices/${source.invoice.id}`}">${source.source?`${source.source.provider} invoice`:'Invoice'} ${source.invoice.number || 'Retained document'}</a></p>
    <h1>Revenue source</h1><p class="lede">${source.invoice.customerName} · ${source.invoice.number || 'Retained document'}</p>
    <section class="card"><h2>Issued consideration</h2><p>Issued ${source.invoice.issueDate}. Revenue consideration ${cents(source.invoice.subtotalCents)}; original tax ${cents(source.invoice.taxCents)}; original invoice total ${cents(source.invoice.totalCents)}.</p>
      <p>${custody(source.custody)}. Credit notes remain separate from original schedules and original tax.</p>
    </section>
    ${source.schedules.map(schedule => h`<section class="card" id="line-${schedule.lineId}"><h2>${schedule.kind.replaceAll('_', ' ')} schedule</h2>
      <p><a href="${source.source?.href??`/app/invoices/${source.invoice.id}/lines/${schedule.lineId}`}">Original line evidence</a> · ${schedule.serviceStart} through ${schedule.serviceEnd} (end exclusive) · ${cents(schedule.amountCents)}.</p>
      <p>Recognition policy: ${schedule.policy.replaceAll('-', ' ')}.</p>
      ${table(['Recognition month', 'Signed revenue$'], schedule.entries.map(entry => [entry.period, cents(entry.amountCents)]))}
      ${details({ line: schedule.lineId, policyVersion: source.policyVersion, sourceFingerprint: source.invoice.sourceFingerprint, basis: schedule.basis, entries: schedule.entries }, 'Schedule basis and exact allocation')}
    </section>`)}
    <section class="card"><h2>Credit-note contra-revenue</h2>
      ${source.credits.length ? source.credits.map(credit => h`<article id="credit-${credit.id}"><h3>${credit.number || 'Retained credit note'}</h3><p>${cents(credit.amountCents)} recognized in ${credit.period}. The original invoice lines and tax remain unchanged.</p>${details(credit.basis, 'Credit journal basis')}</article>`) : h`<p>No issued credit notes.</p>`}
    </section>
    <section class="card"><h2>Journal movements</h2>
      ${table(['Month', 'Movement', 'Contribution$'], source.contributions.map(row => [row.period, kind(row.kind), cents(row.amountCents)]))}
    </section>`, { url, current: '/app/billing' })
}
