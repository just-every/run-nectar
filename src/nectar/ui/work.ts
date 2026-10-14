// Receivables (ageing, payments, reminders, follow-up tasks), usage (import,
// batches, inspection before rating) and the catalog.
import type { Bindings } from '../../auth.server'
import { can, type Actor } from '../actor'
import { business } from '../business'
import { catalog } from '../catalog'
import { BUCKETS, ageing, notices, tasks } from '../collections'
import { customers } from '../customers'
import { formatDate, formatPeriod, isMonth, today } from '../dates'
import { quantityText } from '../decimal'
import { payments } from '../receivables'
import { batches, inspect } from '../usage'
import { area, cents, check, details, field, fileField, form, h, hidden, page, select, table, tag, when } from './html'

export async function receivablesPage(env: Bindings, actor: Actor, url: URL) {
  const age = await ageing(env, actor)
  const [pays, drafts, todo, people] = await Promise.all([payments(env, actor), notices(env, actor), tasks(env, actor), customers(env, actor)])
  const operator = can(actor, 'receivables')
  return page('Receivables', actor, h`<h1>Receivables</h1>
    <section class="card" aria-labelledby="ageing"><h2 id="ageing">Ageing on ${formatDate(age.asOf)}</h2>
      ${table(['Customer', 'Not yet due$', '1–30 days$', '31–60 days$', '61–90 days$', 'Over 90$', 'Owed$', ''], age.customers.map((c: any) => [h`<a href="/app/customers/${c.customer}">${c.name}</a>`, ...BUCKETS.map(b => cents(c[b])), cents(c.total),
        operator && c.oldest > 0 ? form('reminder.prepare', '/app/receivables', hidden('customer', c.customer), 'Draft reminder', { secondary: true }) : '']), { empty: 'Nothing is owed.' })}
      ${age.customers.length ? h`<p class="hint">Total owed ${cents((age.totals as any).total)}, of which ${cents((age.totals as any).total - (age.totals as any).current)} is past due.</p>` : ''}</section>
    <section class="card" aria-labelledby="reminders"><h2 id="reminders">Reminders</h2><p class="hint">Nectar drafts reminders and exports approved ones for you to send from your own mail. It never sends them.</p>
      ${drafts.filter((n: any) => n.status !== 'discarded').length ? drafts.filter((n: any) => n.status !== 'discarded').map((n: any) => h`<article class="notice"><h3>${n.customer_name} — ${cents(n.balance_cents)} ${tag(n.status === 'draft' ? 'Draft' : n.status === 'approved' ? 'Approved' : 'Exported')}</h3>
        ${n.status === 'draft' && actor.kind === 'member' && operator ? h`${form('reminder.approve', '/app/receivables', h`${hidden('notice', n.id)}${field('To', 'recipient', { type: 'email', value: n.recipient })}${field('Subject', 'subject', { value: n.subject })}${area('Message', 'body', n.body, true, 10)}`, 'Approve recipient and wording')}
          ${form('reminder.discard', '/app/receivables', hidden('notice', n.id), 'Discard', { secondary: true })}`
        : h`<p><strong>To:</strong> ${n.recipient}<br><strong>Subject:</strong> ${n.subject}</p><pre class="message">${n.body}</pre>${n.status !== 'draft' ? h`<p><a class="download" href="/app/notices/${n.id}.txt">Download message</a> <span class="sub">Approved by ${n.approved_by}</span></p>` : ''}`}</article>`) : h`<p class="empty">No reminders. Draft one from the ageing table when an invoice is past due.</p>`}</section>
    <section class="card" aria-labelledby="tasks"><h2 id="tasks">Follow-up tasks</h2>
      ${table(['Task', 'Customer', 'Due', 'Status', ''], todo.map((t: any) => [t.title, t.customer_name, formatDate(t.due_date), tag(t.status === 'open' ? 'Open' : 'Done'), t.status === 'open' && operator && actor.kind === 'member' ? form('task.complete', '/app/receivables', h`${hidden('task', t.id)}${field('Outcome', 'outcome')}`, 'Mark done', { layout: 'row-form', secondary: true }) : t.outcome ?? '']), { empty: 'No follow-up tasks.' })}
      ${operator && people.length ? form('task.create', '/app/receivables', h`${select('Customer', 'customer', people.map((c: any) => ({ value: c.id, label: c.name })), people[0].id)}${field('Task', 'title')}${field('Due', 'due_date', { type: 'date' })}`, 'Add task', { layout: 'columns', secondary: true }) : ''}</section>
    <section class="card" aria-labelledby="payments"><h2 id="payments">Payments received</h2><p class="hint">Record money that arrived outside Nectar (bank transfer, check, card taken elsewhere) with its reference, then allocate it on the invoice.</p>
      ${table(['Customer', 'Received', 'Method', 'Reference', 'Amount$', 'Unallocated$'], pays.map((p: any) => [p.customer_name, formatDate(p.received_on), p.method.replace('_', ' '), p.reference, cents(p.amount_cents), cents(p.unallocated_cents)]), { empty: 'No payments recorded.' })}
      ${operator && people.length ? form('payment.record', '/app/receivables', h`${select('Customer', 'customer', people.map((c: any) => ({ value: c.id, label: c.name })), people[0].id)}${field('Amount ($)', 'amount')}${field('Received on', 'received_on', { type: 'date' })}
        ${select('Method', 'method', [{ value: 'bank_transfer', label: 'Bank transfer' }, { value: 'check', label: 'Check' }, { value: 'card_external', label: 'Card (taken outside Nectar)' }, { value: 'other', label: 'Other' }], 'bank_transfer')}${field('Reference', 'reference', { hint: 'The bank or remittance reference; it must be unique per customer.' })}${field('Evidence note', 'evidence', { required: false })}`, 'Record payment', { layout: 'columns' }) : ''}</section>`, { current: '/app/receivables', url })
}

const monthName = (month: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${month}-01T00:00:00Z`))
const dayName = (date: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${date}T00:00:00Z`))
const quietDays = (days: string[]) => days.length ? `${days.length} day${days.length === 1 ? '' : 's'}, from ${dayName(days[0])}` : 'none'

export async function usagePage(env: Bindings, actor: Actor, url: URL) {
  const b = (await business(env))!
  const month = isMonth(url.searchParams.get('period')) ? url.searchParams.get('period')! : today(b.timezone).slice(0, 7)
  const view = await inspect(env, actor, month)
  const recent = await batches(env, actor)
  return page('Usage', actor, h`<h1>Usage</h1>
    ${can(actor, 'usage') ? h`<section class="card" aria-labelledby="import"><h2 id="import">Import usage</h2><p class="hint">A CSV with columns event_id, customer, meter, quantity, occurred_at (ISO 8601 with an offset). An event id already recorded with the same values is a duplicate and changes nothing; with different values it is rejected.</p>
      ${form('usage.submit', '/app/usage', fileField('Usage file (CSV)', 'file', { required: true, accept: '.csv,text/csv' }), 'Import usage', { multipart: true, layout: 'row-form' })}</section>` : ''}
    <section class="card" aria-labelledby="inspect"><div class="card-head"><h2 id="inspect">Before rating: ${monthName(month)}</h2><form method="get" action="/app/usage" class="row-form">${field('Month', 'period', { type: 'month', value: month })}<button type="submit" class="secondary">Show</button></form></div>
      <p class="hint">Periods run midnight to midnight in ${view.timezone}.</p>
      ${view.subscriptions.length ? view.subscriptions.map((s: any) => h`<article class="inspect"><h3>${s.customer} <span class="sub">${s.externalId} · ${formatPeriod(s.period.start, s.period.end)}</span></h3>
        ${table(['Meter', 'Events$', 'Period total$', 'Already billed$', 'Days without usage', 'Arrived after period end'], s.meters.map((m: any) => [m.meter, m.events, `${quantityText(m.total)} ${m.unit}`, m.billed, quietDays(m.daysWithoutUsage), m.receivedAfterPeriodEnd.length ? `${m.receivedAfterPeriodEnd.length} late` : 'none']))}
        ${s.unbilledFromEarlierPeriods ? h`<p class="hint">${s.unbilledFromEarlierPeriods} unbilled event(s) from earlier periods will be billed as late usage.</p>` : ''}
        ${details({ 'Period from': s.boundaries.from, 'Period to': s.boundaries.to, Timezone: s.boundaries.timezone })}</article>`) : h`<p class="empty">No metered subscription has a period starting in ${monthName(month)}.</p>`}
      ${view.unattributed.length ? h`<h3>Events no price rates</h3>${table(['Event', 'Customer', 'Meter', 'Quantity$', 'Occurred'], view.unattributed.map((e: any) => [e.event_id, e.customer, e.meter, quantityText(e.quantity), e.occurred_text]))}` : ''}</section>
    <section class="card" aria-labelledby="batches"><h2 id="batches">Recent imports</h2>${table(['When', 'Source', 'Accepted$', 'Duplicates$', 'Rejected$', ''], recent.map((r: any) => [when(r.created_at, b.timezone), r.filename || r.source, r.accepted, r.duplicates, r.rejected, JSON.parse(r.report_json).length ? details(Object.fromEntries(JSON.parse(r.report_json).slice(0, 50).map((o: any) => [`Row ${o.row} ${o.eventId}`, `${o.status}: ${o.reason}`])), 'Rows not accepted') : '']), { empty: 'No usage imported yet.' })}</section>`, { current: '/app/usage', url })
}

export async function catalogPage(env: Bindings, actor: Actor, url: URL) {
  const c = await catalog(env, actor)
  const records = can(actor, 'records')
  return page('Catalog', actor, h`<h1>Catalog</h1>
    <section class="card" aria-labelledby="products"><h2 id="products">Products and prices</h2><p class="hint">A price never changes once written: a new price is a new version, and subscriptions keep the version they use until a change moves them.</p>
      ${c.products.length ? c.products.map((p: any) => h`<article class="product"><h3>${p.name} <span class="sub">${p.code}${p.origin === 'import' ? ' · moved in' : ''}</span></h3>
        ${table(['Version$', 'Kind', 'Unit price$', 'Meter', 'Taxable', 'Status', ''], c.prices.filter((x: any) => x.product_id === p.id).map((x: any) => [x.version, x.kind === 'flat' ? 'Flat monthly' : x.kind === 'seat' ? 'Per seat monthly' : 'Per unit', `$${x.unit_amount}`, x.meter_code ?? '—', x.taxable ? 'Yes' : 'No', tag(x.status === 'active' ? 'Active' : 'Retired'), records && x.status === 'active' ? form('price.retire', '/app/catalog', hidden('price', x.id), 'Retire', { secondary: true }) : '']), { empty: 'No prices yet.' })}
        <p>Grants: ${c.features.filter((f: any) => f.product_id === p.id).map((f: any) => f.feature).join(', ') || 'no features'}</p>
        ${records ? h`<div class="inline-forms">${form('price.create', '/app/catalog', h`${hidden('product', p.id)}${select('Kind', 'kind', [{ value: 'flat', label: 'Flat monthly' }, { value: 'seat', label: 'Per seat monthly' }, { value: 'unit', label: 'Per unit (metered)' }], 'flat')}${field('Unit price ($)', 'unit_amount', { hint: 'Up to six decimal places, e.g. 0.0004' })}
          ${select('Meter (per unit only)', 'meter', c.meters.map((m: any) => ({ value: m.id, label: `${m.code} (${m.unit_label})` })), '', { required: false, blank: '—' })}${field('Name for this price', 'nickname', { required: false })}${check('Taxable', 'taxable', { checked: true })}`, 'Add price version', { layout: 'columns', secondary: true })}
          ${form('feature.grant', '/app/catalog', h`${hidden('product', p.id)}${field('Feature code', 'feature')}${field('Note', 'note', { required: false })}`, 'Grant feature', { layout: 'columns', secondary: true })}</div>` : ''}</article>`) : h`<p class="empty">No products yet.</p>`}
      ${records ? h`<h3>Add a product</h3>${form('product.create', '/app/catalog', h`${field('Code', 'code', { hint: 'Lowercase letters, digits, dots, dashes.' })}${field('Name', 'name')}${field('Description', 'description', { required: false })}`, 'Add product', { layout: 'columns' })}` : ''}</section>
    <section class="card" aria-labelledby="meters"><h2 id="meters">Meters</h2>${table(['Code', 'Name', 'Unit'], c.meters.map((m: any) => [m.code, m.name, m.unit_label]), { empty: 'No meters yet.' })}
      ${records ? form('meter.create', '/app/catalog', h`${field('Code (the meter name in usage files)', 'code')}${field('Name', 'name')}${field('Unit', 'unit_label', { hint: 'For example: API call, GB, message.' })}`, 'Add meter', { layout: 'columns', secondary: true }) : ''}</section>`, { current: '/app/catalog', url })
}
