// Usage (import, batches, inspection before rating) and the catalog.
import type { Bindings } from '../../auth.server'
import { can, type Actor } from '../actor'
import { business } from '../business'
import { catalog } from '../catalog'
import { formatPeriod, isMonth, today } from '../dates'
import { quantityText } from '../decimal'
import { batches, inspect } from '../usage'
import { catalogueApprovals } from './price-approvals'
import { pricingTiers, quantityPriceForm } from './pricing'
import { check, details, field, fileField, form, h, hidden, page, select, table, tag, when } from './html'

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
        <p><a href="/app/subscriptions/${s.subscription}?preview_period=${month}#upcoming">Upcoming invoice and calculation</a></p>
        ${details({ 'Period from': s.boundaries.from, 'Period to': s.boundaries.to, Timezone: s.boundaries.timezone })}</article>`) : h`<p class="empty">No metered subscription has a period starting in ${monthName(month)}.</p>`}
      ${view.unattributed.length ? h`<h3>Events no price rates</h3>${table(['Event', 'Customer', 'Meter', 'Quantity$', 'Occurred'], view.unattributed.map((e: any) => [e.event_id, e.customer, e.meter, quantityText(e.quantity), e.occurred_text]))}` : ''}</section>
    <section class="card" aria-labelledby="source"><h2 id="source">Source control totals</h2><p class="hint">Compare each customer's daily meter count and exact quantity with the sending system, in ${view.timezone}. Differences block invoice issue until resolved or acknowledged.</p>
      ${can(actor, 'usage') ? form('usage.control', '/app/usage?period=' + month, h`${field('Customer external id', 'customer')}${field('Meter code', 'meter')}${field('Day', 'day', { type: 'date' })}${field('Expected events', 'expected_count', { type: 'number' })}${field('Expected quantity', 'expected_quantity')}`, 'Record source totals', { layout: 'columns', secondary: true }) : ''}
      ${table(['Day', 'Customer', 'Meter', 'Source events / quantity', 'Ingested events / quantity', 'State', ''], view.controls.map(c => [c.day, c.customerName, c.meter, `${c.expectedCount} / ${c.expectedQuantity}`, `${c.actualCount} / ${c.actualQuantity}`, c.mismatch ? c.acknowledged ? `Acknowledged: ${c.reason}` : 'Blocked: totals differ' : 'Reconciled', c.mismatch && !c.acknowledged && actor.kind === 'member' && can(actor, 'approve') ? form('usage.acknowledge', '/app/usage?period=' + month, h`${hidden('control', c.id)}${hidden('basis', c.basis)}${field('Reason', 'reason')}`, 'Acknowledge difference', { secondary: true }) : '']), { empty: 'No source totals recorded for this month.' })}</section>
    <section class="card" aria-labelledby="batches"><h2 id="batches">Recent imports</h2>${table(['When', 'Source', 'Accepted$', 'Duplicates$', 'Rejected$', ''], recent.map((r: any) => [when(r.created_at, b.timezone), r.filename || r.source, r.accepted, r.duplicates, r.rejected, JSON.parse(r.report_json).length ? details(Object.fromEntries(JSON.parse(r.report_json).slice(0, 50).map((o: any) => [`Row ${o.row} ${o.eventId}`, `${o.status}: ${o.reason}`])), 'Rows not accepted') : '']), { empty: 'No usage imported yet.' })}</section>`, { current: '/app/usage', url })
}

export async function catalogPage(env: Bindings, actor: Actor, url: URL) {
  const c = await catalog(env, actor)
  const records = can(actor, 'records')
  return page('Catalog', actor, h`<h1>Catalog</h1>
    <section class="card" aria-labelledby="products"><h2 id="products">Products and prices</h2><p class="hint">A price never changes once written: a new price is a new version, and subscriptions keep the version they use until a change moves them.</p>
      ${c.products.length ? c.products.map((p: any) => h`<article class="product"><h3>${p.name} <span class="sub">${p.code}${p.origin === 'import' ? ' · moved in' : ''}</span></h3>
        ${table(['Version$', 'Kind', 'Unit price / tiers', 'Meter', 'Taxable', 'Status', ''], c.prices.filter((x: any) => x.product_id === p.id).map((x: any) => [x.version, x.pricing ? `${x.pricing.model.replace('_', '-')} ${x.kind === 'seat' ? 'seats' : 'usage'}` : x.kind === 'flat' ? 'Flat monthly' : x.kind === 'seat' ? 'Per seat monthly' : 'Per unit', x.pricing ? pricingTiers(x.pricing) : `$${x.unit_amount}`, x.meter_code ?? '—', x.taxable ? 'Yes' : 'No', tag(x.status === 'active' ? 'Active' : 'Retired'), records && x.status === 'active' ? form('price.retire', '/app/catalog', hidden('price', x.id), 'Retire', { secondary: true }) : '']), { empty: 'No prices yet.' })}
        <p>Grants: ${c.features.filter((f: any) => f.product_id === p.id).map((f: any) => f.feature).join(', ') || 'no features'}</p>
        ${records ? h`<div class="inline-forms">${form('price.create', '/app/catalog', h`${hidden('product', p.id)}${select('Kind', 'kind', [{ value: 'flat', label: 'Flat monthly' }, { value: 'seat', label: 'Per seat monthly' }, { value: 'unit', label: 'Per unit (metered)' }], 'flat')}${field('Unit price ($)', 'unit_amount', { hint: 'Up to six decimal places, e.g. 0.0004' })}
          ${select('Meter (per unit only)', 'meter', c.meters.map((m: any) => ({ value: m.id, label: `${m.code} (${m.unit_label})` })), '', { required: false, blank: '—' })}${field('Name for this price', 'nickname', { required: false })}${check('Taxable', 'taxable', { checked: true })}`, c.prices.some((x: any) => x.product_id === p.id) ? 'Prepare price version' : 'Add price version', { layout: 'columns', secondary: true })}
          ${quantityPriceForm(p.id, c.meters, !c.prices.some((x: any) => x.product_id === p.id))}${form('feature.grant', '/app/catalog', h`${hidden('product', p.id)}${field('Feature code', 'feature')}${field('Note', 'note', { required: false })}`, 'Grant feature', { layout: 'columns', secondary: true })}</div>` : ''}</article>`) : h`<p class="empty">No products yet.</p>`}
      ${records ? h`<h3>Add a product</h3>${form('product.create', '/app/catalog', h`${field('Code', 'code', { hint: 'Lowercase letters, digits, dots, dashes.' })}${field('Name', 'name')}${field('Description', 'description', { required: false })}`, 'Add product', { layout: 'columns' })}` : ''}</section>
    ${catalogueApprovals(c.priceRequests, c.meters, actor)}
    <section class="card" aria-labelledby="meters"><h2 id="meters">Meters</h2>${table(['Code', 'Name', 'Unit'], c.meters.map((m: any) => [m.code, m.name, m.unit_label]), { empty: 'No meters yet.' })}
      ${records ? form('meter.create', '/app/catalog', h`${field('Code (the meter name in usage files)', 'code')}${field('Name', 'name')}${field('Unit', 'unit_label', { hint: 'For example: API call, GB, message.' })}`, 'Add meter', { layout: 'columns', secondary: true }) : ''}</section>`, { current: '/app/catalog', url })
}
