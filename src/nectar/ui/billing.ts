// Billing: bill runs, the bill-run review
// and one invoice with its lines, calculation evidence, credits and payments.
import { metadataLink } from './metadata'
import { creditApprovals } from './credit-approvals'
import { notesSection } from './notes'
import type { Bindings } from '../../auth.server'
import { can, type Actor } from '../actor'
import { invoiceDetail, runDetail, runs } from '../billruns'
import { business } from '../business'
import { addDays, formatDate, formatPeriod, today } from '../dates'
import { money, quantityText } from '../decimal'
import { payments } from '../receivables'
import { cents, check, details, field, form, h, marker, hidden, page, select, table, tag, who, type Html } from './html'
import { personName } from './shell'
import { linePricing } from './pricing'

const monthName = (period: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${period}-01T00:00:00Z`))
const statusLabel = (status: string, exceptions = 0) => status === 'draft' && exceptions ? 'Needs review' : ({ draft: 'Draft', approved: 'Approved', issued: 'Issued', shadow: 'Shadow', discarded: 'Discarded', finalised: 'Finalized' } as Record<string, string>)[status] ?? status
const EXCEPTION_TITLES: Record<string, string> = { exemption_certificate: 'Exemption certificate needs review', usage_reconciliation: 'Source usage does not reconcile', missing_usage: 'Missing usage', large_change: 'Large change', incumbent_mismatch: 'Previous biller mismatch', unrated_usage: 'Unrated usage', no_billing_email: 'No billing email', tax_undeclared: 'Tax not declared', negative_total: 'Credits exceed charges' }

export async function billingPage(env: Bindings, actor: Actor, url: URL) {
  const b = (await business(env))!
  const list = await runs(env, actor)
  const now = today(b.timezone).slice(0, 7)
  const [y, m] = now.split('-').map(Number)
  const lastMonth = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}`
  return page('Billing', actor, h`<h1>Billing</h1><p><a href="/app/reports/mrr">MRR report</a> · <a href="/app/reports/billings">Billings report</a> · <a href="/app/reports/ar">AR report</a></p>
    ${can(actor, 'records') ? h`<section class="card" aria-labelledby="prepare"><h2 id="prepare">Prepare a bill run</h2><p class="hint">Drafts one invoice for every subscription period that started in the month and has ended. Nothing is issued until a person approves and finalizes it; preparing again replaces the draft.</p>
      ${form('billrun.prepare', '/app/billing/{id}', field('Month', 'period', { type: 'month', value: lastMonth }), 'Prepare draft', { layout: 'row-form' })}</section>` : ''}
    <section class="card" aria-labelledby="runs"><h2 id="runs">Bill runs</h2>${table(['Month', 'Status', 'Invoices$', 'Total$', 'Prepared'], list.map((r: any) => [h`<a href="/app/billing/${r.id}">${r.kind === 'manual' ? 'Standalone · ' : ''}${monthName(r.period)}</a>`, tag(statusLabel(r.status)), h`<a href="/app/billing/${r.id}#drafts">${r.summary.invoices ?? 0}</a>`, h`<a href="/app/billing/${r.id}#drafts">${cents(r.summary.totals?.total ?? 0)}</a>`, formatDate(new Date(r.created_at).toISOString().slice(0, 10))]), { empty: 'No bill runs yet. Prepare the first one above once a subscription period has ended.', lead: true })}</section>`, { current: '/app/billing', url })
}

export async function runPage(env: Bindings, actor: Actor, id: string, url: URL) {
  const run = await runDetail(env, actor, id)
  const s = run.summary as any
  const live = run.invoices.filter((i: any) => i.status !== 'shadow' && i.status !== 'discarded')
  const shadow = run.invoices.filter((i: any) => i.status === 'shadow')
  const exceptions = run.invoices.flatMap((i: any) => i.exceptions.map((e: any) => ({ ...e, invoice: i })))
  const approver = actor.kind === 'member' && can(actor, 'approve')
  const previous = s.previous?.totals ? s.totals.total - s.previous.totals.total : null
  const actions = run.status === 'draft' && approver ? h`<div class="actions">
      ${form('invoice.approve', `/app/billing/${run.id}`, h`${hidden('run', run.id)}${exceptions.length ? check('I reviewed the exceptions', 'acknowledge') : ''}`, exceptions.length ? 'Approve reviewed drafts' : 'Approve clean drafts', { primary: true })}
      ${form('invoice.finalise', `/app/billing/${run.id}`, h`${hidden('run', run.id)}${field('Invoice date (default today)', 'issue_date', { type: 'date', required: false })}`, 'Finalize approved', { secondary: true })}</div>` : ''
  const row = (i: any): unknown[] => [h`<a href="/app/invoices/${i.id}">${i.customer_name}</a><span class="sub">${i.external_id}${i.number ? ` · ${i.number}` : ''}</span>`, formatPeriod(i.period_start, i.period_end), h`<a href="/app/invoices/${i.id}#lines">${cents(i.subtotal_cents)}</a>`, h`<a href="/app/invoices/${i.id}#lines">${cents(i.tax_cents)}</a>`, h`<a href="/app/invoices/${i.id}#lines">${cents(i.total_cents)}</a>`,
    i.comparison.previous ? h`<span class="delta"><span class="arrow">${i.comparison.previous.deltaCents >= 0 ? '↑' : '↓'}</span>${money(Math.abs(i.comparison.previous.deltaCents))}</span>` : h`<span class="sub">first invoice</span>`, tag(statusLabel(i.status, i.exceptions.length)), h`<a class="go" href="/app/invoices/${i.id}">Review →</a>`]
  const title = `${monthName(run.period)} ${run.kind === 'manual' ? 'standalone invoice' : 'bill run'}`
  return page(title, actor, h`<div class="title-row"><h1>${title}</h1>${tag(statusLabel(run.status))}</div>
    <p class="sub">Prepared ${formatDate(new Date(run.created_at).toISOString().slice(0, 10))} by ${who(actor, run.created_by)}</p>
    <section class="card figures-card"><dl class="figures">
      <div><dt>Invoices</dt><dd><a href="#drafts">${s.invoices}</a></dd></div><div><dt>Subtotal</dt><dd><a href="#drafts">${cents(s.totals.subtotal)}</a></dd></div><div><dt>Tax</dt><dd><a href="#drafts">${cents(s.totals.tax)}</a></dd></div><div><dt>Total</dt><dd><a href="#drafts">${cents(s.totals.total)}</a></dd></div>
      <div><dt>${s.previous ? h`<a href="/app/billing/${s.previous.run}">vs ${monthName(s.previous.period)}</a>` : 'Previous run'}</dt><dd class="delta">${previous === null ? '—' : h`<span class="arrow">${previous >= 0 ? '↑' : '↓'}</span>${previous >= 0 ? '+' : '−'}${money(Math.abs(previous))}${s.previous.totals.total ? h`<span class="sub">${(Math.abs(previous) * 100 / s.previous.totals.total).toFixed(1)}% change</span>` : ''}`}</dd></div></dl></section>
    <section class="card exceptions" aria-labelledby="exc"><div class="card-head"><h2 id="exc">Exceptions</h2>${exceptions.length ? h`<span class="count">${exceptions.length} item${exceptions.length === 1 ? '' : 's'}</span>` : ''}</div>
      ${exceptions.length ? h`<ul>${exceptions.map((e: any) => h`<li class="exception${['tax_undeclared', 'exemption_certificate', 'negative_total', 'usage_reconciliation'].includes(e.code) ? ' blocking' : ''}">${marker('alert')}<strong>${EXCEPTION_TITLES[e.code] ?? e.code}</strong><span><b>${e.invoice.customer_name}:</b> ${e.message}</span><a href="/app/invoices/${e.invoice.id}">View →</a></li>`)}</ul>` : h`<p class="empty">No exceptions. Every draft rated cleanly.</p>`}
      ${s.open?.length ? h`<p class="hint">Not yet ended, so not drafted: ${s.open.map((o: any) => `${o.customer} (ends ${formatDate(addDays(o.periodEnd, -1))})`).join(', ')}.</p>` : ''}
      ${s.skipped?.length ? h`<p class="hint">Skipped: ${s.skipped.map((o: any) => `${o.customer} — ${o.reason}`).join('; ')}.</p>` : ''}</section>
    <section class="card" aria-labelledby="drafts"><div class="card-head"><h2 id="drafts">${run.status === 'draft' ? 'Draft invoices' : 'Invoices'} (${live.length})</h2><div class="toolbar">${actions}${can(actor, 'export') ? h`<a class="download" href="/app/billing/${run.id}.json">Download bill run (JSON)</a>` : ''}</div></div>
      ${table(['Customer', 'Period', 'Subtotal$', 'Tax$', 'Total$', 'Change vs last$', 'Status', ''], live.map(row), { empty: 'No invoices in this run.' })}</section>
    ${shadow.length ? h`<section class="card" aria-labelledby="shadow"><h2 id="shadow">Shadow drafts (${shadow.length})</h2><p class="hint">Moved-in subscriptions, rated for comparison with the previous biller. They cannot be approved until the owner adopts the subscription.</p>
      ${table(['Customer', 'Period', 'Subtotal$', 'Previous biller$', 'Agrees'], shadow.map((i: any) => [h`<a href="/app/invoices/${i.id}">${i.customer_name}</a>`, formatPeriod(i.period_start, i.period_end), cents(i.subtotal_cents), i.comparison.incumbent?.found ? cents(i.comparison.incumbent.incumbentSubtotalCents) : '—', tag(i.comparison.incumbent?.found ? (i.comparison.incumbent.reconciled ? 'Reconciled' : 'Not reconciled') : 'No Stripe invoice')]))}</section>` : ''}
    ${details({ Run: run.id, 'Rating rules': run.calc_version, Cutoff: new Date(run.cutoff_at).toISOString(), 'Finalized by': personName(actor, run.finalised_by) })}`, { current: '/app/billing', url })
}

// Lines read plan, seats, usage, then adjustments; each shows its rule under it,
// and its own dates when they differ from the invoice's period.
const LINE_ORDER: Record<string, number> = { flat: 0, seat: 1, usage: 2, late_usage: 2, trial_usage: 2, discount: 3, credit: 4, trial: 5 }
const lineTable = (lines: any[], period: { start: string; end: string }, invoice: string | null): Html => table(['Charge', 'Quantity$', 'Unit$', 'Amount$', ''], [...lines].sort((a, b) => (LINE_ORDER[a.kind] ?? 6) - (LINE_ORDER[b.kind] ?? 6)).map(line => [h`${invoice ? h`<a href="/app/invoices/${invoice}/lines/${line.id}">${line.description}</a>` : line.description}${line.period_start !== period.start || line.period_end !== period.end ? h`<span class="sub">${formatPeriod(line.period_start, line.period_end)}</span>` : ''}${line.evidence?.rule ? h`<span class="line-rule">Rule: ${line.evidence.rule}.</span>` : ''}${linePricing(line)}`, quantityText(line.quantity), line.unit_amount ? `$${line.unit_amount}` : '', cents(line.amount_cents), details({ Rule: line.evidence.rule, ...Object.fromEntries(Object.entries(line.evidence).filter(([key]) => key !== 'rule')) })]), { lines: true })

export async function invoicePage(env: Bindings, actor: Actor, id: string, url: URL) {
  const i = await invoiceDetail(env, actor, id)
  const approver = actor.kind === 'member' && can(actor, 'approve')
  const pays = i.status === 'issued' && can(actor, 'receivables') ? (await payments(env, actor, i.customer_id)).filter((p: any) => p.unallocated_cents > 0) : []
  const title = i.number ? `Invoice ${i.number}` : i.status === 'shadow' ? 'Shadow draft' : 'Draft invoice'
  const incumbent = i.comparison.incumbent
  return page(title, actor, h`<p class="crumbs"><a href="/app/billing/${i.bill_run_id}">Bill run</a> · <a href="/app/customers/${i.customer_id}">${i.customer_name}</a></p>
    <div class="title-row"><h1>${title}</h1>${tag(statusLabel(i.status, i.status === 'draft' ? i.exceptions.length : 0))}</div><p>${metadataLink('invoice',i.id)}</p>
    ${i.status === 'issued' ? h`<p><a href="/app/answers?customer=${i.customer_id}&invoice=${i.id}">Ask about this invoice</a></p>` : ''}
    <section class="card summary"><dl class="figures"><div><dt>Customer</dt><dd>${i.customer_name}<span class="sub">${i.external_id}</span></dd></div><div><dt>Period</dt><dd>${formatPeriod(i.period_start, i.period_end)}</dd></div>
      ${i.issue_date ? h`<div><dt>Issued</dt><dd>${formatDate(i.issue_date)}</dd></div><div><dt>Due</dt><dd>${formatDate(i.due_date)}</dd></div>` : ''}
      <div><dt>Total</dt><dd class="money">${cents(i.total_cents)}</dd></div>${i.status === 'issued' ? h`<div><dt>Owed</dt><dd class="money">${cents(i.balanceCents)}</dd></div>` : ''}</dl></section>
    ${i.exceptions.length ? h`<section class="card exceptions" aria-labelledby="exc"><div class="card-head"><h2 id="exc">Exceptions</h2><span class="count">${i.exceptions.length} item${i.exceptions.length === 1 ? '' : 's'}</span></div><ul>${i.exceptions.map((e: any) => h`<li class="exception">${marker('alert')}<strong>${EXCEPTION_TITLES[e.code] ?? e.code}</strong><span>${e.message}</span></li>`)}</ul></section>` : ''}
    <section class="card" aria-labelledby="lines"><h2 id="lines">Charges</h2>${lineTable(i.lines, { start: i.period_start, end: i.period_end }, i.status === 'issued' ? i.id : null)}
      <dl class="totals"><div><dt>Subtotal</dt><dd>${cents(i.subtotal_cents)}</dd></div><div><dt>Tax${i.calculation.tax?.rate ? ` (${i.calculation.tax.rate}%)` : ''}</dt><dd>${cents(i.tax_cents)}</dd></div><div class="grand"><dt>Total</dt><dd>${cents(i.total_cents)}</dd></div></dl>
      <p class="hint">Tax: ${i.calculation.tax?.rule ?? ''}.</p></section>
    ${i.comparison.previous || incumbent?.found ? h`<section class="card" aria-labelledby="cmp"><h2 id="cmp">Comparison</h2>
      ${i.comparison.previous ? h`<p>Previous invoice ${i.comparison.previous.number}: subtotal ${cents(i.comparison.previous.subtotalCents)}; change ${money(i.comparison.previous.deltaCents)}.</p>` : ''}
      ${incumbent?.found ? h`<p>Previous biller (${incumbent.invoices.join(', ')}): ${incumbent.reconciled ? 'agrees on every price.' : 'differs; reconcile each price below.'}</p>${table(['Price', 'Nectar$', 'Previous biller$', 'Difference$'], incumbent.rows.map((r: any) => [r.price, cents(r.nectarCents), cents(r.incumbentCents), cents(r.nectarCents - r.incumbentCents)]))}` : ''}</section>` : ''}
    ${i.status === 'draft' && approver ? h`<section class="card" aria-labelledby="decide"><h2 id="decide">Approve</h2><p class="hint">Approval names these exact inputs. If usage, prices, contract terms or tax change before finalizing, the approval no longer holds.</p>
      ${form('invoice.approve', `/app/invoices/${i.id}`, h`${hidden('invoice', i.id)}${i.exceptions.length ? check('I reviewed the exceptions above', 'acknowledge') : ''}`, 'Approve this invoice', { primary: true })}</section>` : ''}
    ${i.status === 'approved' && approver ? h`<section class="card"><h2>Finalize</h2>${form('invoice.finalise', `/app/invoices/${i.id}`, h`${hidden('invoice', i.id)}${field('Invoice date (default today)', 'issue_date', { type: 'date', required: false, hint: 'Any day from the service date for standalone work, or the end of the subscription period, up to today.' })}`, 'Number and issue this invoice', { layout: 'row-form' })}</section>` : ''}
    ${i.status === 'issued' ? h`<section class="card" aria-labelledby="recv"><h2 id="recv">Credits and payments</h2>
      ${table(['Credit note', 'Reason', 'Amount$'], i.credits.map((c: any) => [h`<span id="credit-${c.id}">${c.number}</span> ${metadataLink('credit-note',c.id)}`, c.reason, cents(c.amount_cents)]), { empty: 'No credit notes.' })}
      ${table(['Payment', 'Received', 'Allocated$'], i.allocations.map((a: any) => [a.reference, formatDate(a.received_on), cents(a.amount_cents)]), { empty: 'No payments allocated.' })}
      <p>Invoiced ${cents(i.total_cents)} = credited ${cents(i.creditedCents)} + paid ${cents(i.paidCents)} + owed ${cents(i.balanceCents)}.</p>
      ${approver && i.balanceCents > 0 ? form('credit.issue', `/app/invoices/${i.id}`, h`${hidden('invoice', i.id)}${field('Credit amount ($)', 'amount')}${field('Reason', 'reason')}`, 'Issue credit note', { layout: 'columns', secondary: true }) : ''}
      ${pays.length && i.balanceCents > 0 ? form('payment.allocate', `/app/invoices/${i.id}`, h`${hidden('invoice', i.id)}${select('Payment', 'payment', pays.map((p: any) => ({ value: p.id, label: `${p.reference} — ${money(p.unallocated_cents)} unallocated` })), pays[0].id)}${field('Amount ($)', 'amount')}`, 'Allocate payment', { layout: 'columns', secondary: true }) : ''}</section>` : ''}
    ${i.status === 'issued' ? creditApprovals(i, actor) : ''}
    ${await notesSection(env,actor,i.customer_id,'invoice',i.id,`/app/invoices/${i.id}#notes`)}
    ${details({ Invoice: i.id, 'Rating rules': i.calc_version, 'Source fingerprint': i.source_fingerprint, 'Approved fingerprint': i.approved_fingerprint ?? '—', 'Approved by': personName(actor, i.approved_by), 'Issued by': personName(actor, i.issued_by), 'Usage events billed': (i.calculation.consumedEvents ?? []).length }, 'Calculation details')}`, { current: '/app/billing', url })
}
