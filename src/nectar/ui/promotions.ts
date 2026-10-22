// Catalog coupons and promotion codes, and a trial's extension control.
import type { Bindings } from '../../auth.server'
import { can, type Actor } from '../actor'
import type { Row } from '../core'
import { formatDate } from '../dates'
import { promotionsView } from '../promotions'
import { check, field, form, h, hidden, select, table, tag } from './html'

const duration = (c: Row) => c.duration === 'once' ? 'once' : c.duration === 'forever' ? 'forever' : `for ${c.months} months`
const value = (c: Row) => c.kind === 'percent' ? `${c.value}%` : `$${c.value}`

export async function promotionsSection(env: Bindings, actor: Actor, products: Row[]) {
  const view = await promotionsView(env, actor)
  const approver = can(actor, 'approve') && actor.kind === 'member'
  const name = new Map(products.map(p => [p.id, p.name]))
  return h`<section class="card" aria-labelledby="promotions"><h2 id="promotions">Coupons and promotion codes</h2>
    <p>A coupon is a percentage or an amount, once, for a number of months or forever, optionally restricted to products. A promotion code redeems a coupon when a subscription is started, with an optional redemption limit, expiry date and first-time-customer rule.</p>
    ${table(['Coupon', 'Discount', 'Products', 'Status'], view.coupons.map((c: Row) => [c.name, `${value(c)} ${duration(c)}`, c.products.length ? c.products.map((id: string) => name.get(id) ?? id).join(', ') : 'All fixed and seat lines', tag(c.status)]), { empty: 'No coupons yet.' })}
    ${table(['Code', 'Coupon', 'Redeemed', 'Limit', 'Expires', 'First-time only', 'State'], view.codes.map((c: Row) => [h`<span class="mono">${c.code}</span>`, view.coupons.find((x: Row) => x.id === c.coupon_id)?.name, c.redemptions, c.max_redemptions ?? 'No limit', c.expires_on ? formatDate(c.expires_on) : 'Never', c.first_time_only ? 'Yes' : 'No', tag(c.expired ? 'Expired' : c.exhausted ? 'Exhausted' : 'Active')]), { empty: 'No promotion codes yet.' })}
    ${approver ? h`${form('coupon.create', '/app/catalog#promotions', h`${field('Coupon name', 'name')}${select('Kind', 'kind', [{ value: 'percent', label: 'Percentage off' }, { value: 'amount', label: 'Amount off ($)' }], 'percent')}${field('Value', 'value')}
        ${select('Duration', 'duration', [{ value: 'once', label: 'Once' }, { value: 'repeating', label: 'For a number of months' }, { value: 'forever', label: 'Forever (percentage only)' }], 'once')}${field('Months (repeating)', 'months', { type: 'number', required: false })}
        ${select('Restrict to a product', 'products', products.map(p => ({ value: p.id, label: p.name })), '', { required: false, blank: 'All products (percentage coupons may be restricted)' })}`, 'Create coupon', { layout: 'columns', secondary: true })}
      ${view.coupons.length ? form('promotion.create', '/app/catalog#promotions', h`${field('Code', 'code')}${select('Coupon', 'coupon', view.coupons.filter((c: Row) => c.status === 'active').map((c: Row) => ({ value: c.id, label: c.name })))}${field('Redemption limit', 'max_redemptions', { type: 'number', required: false })}${field('Expires on', 'expires_on', { type: 'date', required: false })}${check('First-time customers only', 'first_time_only')}`, 'Create promotion code', { layout: 'columns', secondary: true }) : ''}` : ''}</section>`
}

/** A running trial's end date and the operator's 14-day (or other) extension. */
export function trialSection(s: Row, actor: Actor, today: string) {
  if (!s.trial_end) return ''
  const running = s.trial_end > today && !s.trial_outcome
  const outcome = s.trial_outcome === 'converted' ? 'Converted to paid at its end date' : s.trial_outcome === 'ended_unpaid' ? 'Ended unpaid: no payment method was on file' : running ? 'Running' : 'Ended; awaiting its outcome'
  return h`<section class="card" aria-labelledby="trial"><h2 id="trial">Trial</h2>
    <p>Ends ${formatDate(s.trial_end)}. Payment method on file: ${s.trial_payment === 'card' ? 'yes' : s.trial_payment === 'none' ? 'no' : 'not recorded'}. ${outcome}. Fixed and seat charges start on the end date; extending the trial moves the first charge with it.</p>
    ${running && can(actor, 'records') && actor.kind === 'member' ? form('trial.extend', `/app/subscriptions/${s.id}`, h`${hidden('subscription', s.id)}${field('Extend by (days)', 'days', { type: 'number', value: '14' })}`, 'Extend trial', { layout: 'columns', secondary: true }) : ''}</section>`
}
