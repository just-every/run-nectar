// One-time charges and standalone work are prepared on the customer record.
import { can, type Actor } from '../actor'
import { plainMoney } from '../decimal'
import type { Row } from '../core'
import { priceRate } from './pricing'
import { cents, check, field, form, h, hidden, select, table } from './html'

export function chargeSection(c: Row, prices: Row[], actor: Actor, today: string) {
  const pending = c.charges.filter((r: Row) => !r.invoice_id)
  return h`<section class="card" aria-labelledby="one-time"><h2 id="one-time">One-time charges</h2>
    ${table(['Charge', 'Date', 'Amount$', 'Billing'], c.charges.map((r: Row) => [r.description, r.effective_date, cents(r.amount_cents), r.invoice_id ? h`<a href="/app/invoices/${r.invoice_id}">Invoiced</a>` : r.subscription_id ? 'Next subscription invoice' : 'Ready for a standalone invoice']), { empty: 'No one-time charges.' })}
    ${can(actor, 'records') ? h`<details><summary>Add a one-time charge</summary>${form('charge.add', `/app/customers/${c.id}`, h`${hidden('customer', c.id)}
      ${select('Add to subscription', 'subscription', c.subscriptions.filter((s: Row) => s.billing_mode === 'live').map((s: Row) => ({ value: s.id, label: s.external_id || `Subscription from ${s.start_date}` })), '', { required: false, blank: 'Standalone work' })}
      ${select('Catalogue price', 'price', prices.map(p => ({ value: p.id, label: `${p.name} v${p.version}: ${priceRate(p)}` })), '', { required: false, blank: 'Custom amount' })}
      ${field('Quantity for a catalogue price', 'quantity', { value: '1', required: false })}${field('Custom total ($)', 'amount', { required: false, hint: 'Leave empty when using a catalogue price. A custom amount is approved with its invoice.' })}
      ${field('Charge description', 'description', { required: false })}${field('Service date', 'effective_date', { type: 'date', value: today })}${check('Custom charge is taxable', 'taxable', { checked: true })}`, 'Add charge', { layout: 'columns', secondary: true })}</details>
      ${pending.length ? form('invoice.manual', '/app/invoices/{id}', h`${hidden('customer', c.id)}<fieldset><legend>Bill selected charges immediately</legend>${pending.map((r: Row) => check(`${r.description} — ${plainMoney(r.amount_cents)} USD`, 'charges', { value: r.id }))}</fieldset>${field('Invoice service date', 'service_date', { type: 'date', value: today, hint: 'Choose a date on or after the selected charges. The draft still needs approval before numbering and issue.' })}`, 'Prepare standalone invoice', { secondary: true }) : ''}` : ''}
  </section>`
}

export function addonSection(s: Row, prices: Row[], actor: Actor) {
  if (!prices.length || !can(actor, 'approve') || s.billing_mode !== 'live') return ''
  return h`<section class="card" aria-labelledby="addons"><h2 id="addons">Attach an add-on</h2><p class="hint">A named approver adds this immutable catalogue price from the selected date. The next draft prorates recurring charges for the days in effect.</p>${form('subscription.addon', `/app/subscriptions/${s.id}`, h`${hidden('subscription', s.id)}${select('Add-on price', 'price', prices.map(p => ({ value: p.id, label: `${p.name} v${p.version}: ${priceRate(p)}` })))}${field('Add-on seats', 'quantity', { type: 'number', value: '1' })}${field('Add-on effective date', 'effective_date', { type: 'date' })}`, 'Approve and attach add-on', { layout: 'columns', secondary: true })}</section>`
}
