import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { formatInstant } from '../dates'
import { money } from '../decimal'
import { sandboxCustomerView } from '../test-clock'
import { sandboxView } from '../test-mode'
import { check, field, form, h, hidden, page, select, tag } from './html'

const back = '/app/settings/test-mode'
const customerBack = `${back}/{id}`
const terms = (p: { billing?: { count: number; unit: string; timing: string } }) => `${p.billing!.count} ${p.billing!.unit}${p.billing!.count === 1 ? '' : 's'} · ${p.billing!.timing}`

export async function testModePage(env: Bindings, actor: Actor, url: URL) {
  const data = await sandboxView(env, actor), source = data.source
  return page('Test mode', actor, h`<h1>Test mode ${tag('Sandbox')}</h1><p>Try copied fixed and seat prices with independent customer clocks. These are saved billing previews. Processor test keys, actual invoices, payment failures, retries and notices are not connected.</p>
    <section class="card"><h2>Copy reviewed live prices</h2><p>${source.configuration.timezone} · ${source.configuration.tax.mode === 'no_tax' ? 'No sales tax' : `${source.configuration.tax.rate}% declared tax`} · ${source.configuration.tax.jurisdiction} · USD</p><p>${source.prices.length} supported prices. ${source.excluded.length} other active prices excluded; this sandbox supports simple USD fixed and seat prices only.</p>
    ${source.copyReady ? form('sandbox.catalog.copy', back, h`${hidden('source_fingerprint', source.sourceFingerprint)}${check('I reviewed the current prices, timezone and declared tax for this sandbox copy', 'confirm')}`, 'Copy catalog') : h`<p>The owner must review tax and publish a supported price before copying.</p>`}</section>
    ${data.catalogs.map(c => h`<section class="card"><h2>Saved catalog copy</h2><p>${c.configuration.timezone} · ${c.configuration.tax.mode === 'no_tax' ? 'No sales tax' : `${c.configuration.tax.rate}% declared tax`} · ${c.configuration.tax.jurisdiction}. Future live changes do not alter this copy.</p><details><summary>Copied prices and source</summary><p style="overflow-wrap:anywhere">Source fingerprint: ${c.sourceFingerprint}</p><ul>${c.prices.map(p => h`<li>${p.label} · USD ${p.unitAmount} · ${terms(p)}</li>`)}</ul></details>
      <details><summary>Add sandbox customer</summary><p>Use a synthetic name. No live customer or payment method is copied.</p>${form('sandbox.customer.create', customerBack, h`${hidden('catalog', c.id)}${field('Synthetic customer name', 'label')}${field('Starting clock (ISO time with offset)', 'clock', { hint: 'For example, 2027-01-31T08:00:00Z.' })}${field('Trial ends (optional)', 'trial_end', { type: 'date', required: false })}${select('Copied price', 'price', c.prices.map(p => ({ value: p.id, label: `${p.label} · USD ${p.unitAmount} · ${terms(p)}` })))}${field('Quantity (one for fixed prices)', 'quantity', { type: 'number', value: '1' })}`, 'Create sandbox customer')}</details></section>`)}
    <section class="card"><h2>Sandbox customers</h2>${data.customers.length ? h`<ul>${data.customers.map(c => h`<li><a href="${back}/${c.id}">${c.label}</a> · Clock ${new Date(c.clock_at).toISOString()} · Revision ${c.revision}</li>`)}</ul>` : h`<p>No sandbox customers yet.</p>`}</section>`, { current: '/app/settings', url })
}

export async function testCustomerPage(env: Bindings, actor: Actor, url: URL, id: string) {
  const c = await sandboxCustomerView(env, actor, id), zone = c.catalog.configuration.timezone
  return page('Sandbox customer', actor, h`<p><a href="${back}">Test mode settings</a></p><h1>${c.label} ${tag('Sandbox')}</h1><section class="card"><h2>Customer clock</h2><p>Clock: ${formatInstant(c.clock_at, zone)} · ${zone}. Revision ${c.revision}.</p><p>Only this sandbox customer advances. Saved previews are not invoices, payment attempts or notices.</p>
    ${form('sandbox.clock.advance', `${back}/${c.id}`, h`${hidden('customer', c.id)}${hidden('revision', c.revision)}${field('Advance to (ISO time with offset)', 'clock', { hint: 'Forward only, up to ten years from this customer’s start.' })}${check('Advance only this sandbox customer and save newly due previews', 'confirm')}`, 'Advance test clock')}
    <details><summary>Clock history</summary><ul>${c.history.map(event => h`<li>Revision ${event.revision} · ${formatInstant(event.clock_at, zone)}</li>`)}</ul></details></section>
    <section class="card"><h2>Saved billing previews</h2>${c.previews.length ? c.previews.map(p => h`<article><h3>Due ${p.dueDate}</h3><p>Service from ${p.period.start} to ${p.period.end} (end excluded).</p><ul>${p.rating.lines.map((line: { description: string; amountCents: number }) => h`<li>${line.description}: ${money(line.amountCents)}</li>`)}</ul><p>Subtotal ${money(p.rating.subtotalCents)} · Tax ${money(p.rating.taxCents)} · Total ${money(p.rating.totalCents)}</p>${p.rating.exceptions.map((exception: { message: string }) => h`<p>${exception.message}</p>`)}</article>`) : h`<p>No billing preview is due yet. Advance through the trial or billing boundary.</p>`}</section>`, { current: '/app/settings', url })
}
