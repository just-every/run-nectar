// Catalog coupons and promotion codes, and a trial's extension control.
import type { Bindings } from '../../auth.server'
import { can, type Actor } from '../actor'
import type { Row } from '../core'
import { formatDate } from '../dates'
import { promotionsView } from '../promotions'
import { readTrialCollections } from '../trial-collection'
import { cents } from './html'
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
        ${select('Duration', 'duration', [{ value: 'once', label: 'Once' }, { value: 'repeating', label: 'For a number of months' }, { value: 'forever', label: 'Forever' }], 'once')}${field('Months (repeating)', 'months', { type: 'number', required: false })}
        ${select('Restrict to a product', 'products', products.map(p => ({ value: p.id, label: p.name })), '', { required: false, blank: 'All products' })}`, 'Create coupon', { layout: 'columns', secondary: true })}
      ${view.coupons.length ? form('promotion.create', '/app/catalog#promotions', h`${field('Code', 'code')}${select('Coupon', 'coupon', view.coupons.filter((c: Row) => c.status === 'active').map((c: Row) => ({ value: c.id, label: c.name })))}${field('Redemption limit', 'max_redemptions', { type: 'number', required: false })}${field('Expires on', 'expires_on', { type: 'date', required: false })}${check('First-time customers only', 'first_time_only')}`, 'Create promotion code', { layout: 'columns', secondary: true }) : ''}` : ''}</section>`
}

/** A running trial's end date and the operator's 14-day (or other) extension. */
export function trialSection(s: Row, actor: Actor, today: string) {
  if (!s.trial_end) return ''
  const running = s.trial_end > today && !s.trial_outcome
  const outcome = s.trial_outcome === 'converted' ? 'Converted to paid at its end date' : s.trial_outcome === 'ended_unpaid' ? 'Ended unpaid: no payment method was on file' : running ? 'Running' : 'Ended; awaiting its outcome'
  return h`<section class="card" aria-labelledby="trial"><h2 id="trial">Trial</h2>
    <p>Ends ${formatDate(s.trial_end)}. Recorded payment-method choice: ${s.trial_payment === 'card' ? 'card' : s.trial_payment === 'none' ? 'none' : 'not recorded'}. This choice does not verify a processor card. ${outcome}. Fixed and seat charges start on the end date; extending the trial moves the first charge with it.</p>
    ${running && can(actor, 'records') && actor.kind === 'member' ? form('trial.extend', `/app/subscriptions/${s.id}`, h`${hidden('subscription', s.id)}${field('Extend by (days)', 'days', { type: 'number', value: '14' })}`, 'Extend trial', { layout: 'columns', secondary: true }) : ''}</section>`
}


/** A separate exact-term policy; ordinary invoices retain manual collection. */
export async function trialCollectionSection(env: Bindings, actor: Actor, subscription: Row) {
  if (!subscription.trial_end || actor.kind !== 'member' || !can(actor, 'approve')) return ''
  const rows = await readTrialCollections(env, actor, subscription.id), back = `/app/subscriptions/${subscription.id}`
  return h`<section class="card" id="trial-collection"><h2>First trial payment</h2>
    <p>Automatic collection starts only after the owner confirms the exact invoice, saved card, amount and trial end date below. Another active approver confirms the policy when available. Changed dates or terms require new approval. An uncertain payment is never retried automatically.</p>
    ${actor.role === 'owner' && !subscription.trial_outcome && !rows.some(row => ['pending_owner','pending_approval','active','claimed','uncertain'].includes(row.status)) ? form('trial.collection.prepare',back,h`${hidden('subscription',subscription.id)}`,'Review first trial payment',{secondary:true}) : ''}
    ${rows.map(row => h`<article><h3>${row.status.replaceAll('_',' ')}</h3>
      <p>${cents(row.quote.amountCents)} USD on ${formatDate(row.quote.chargeDate)} only · ${row.quote.card.brand} ending ${row.quote.card.last4} · Account ${row.quote.accountRef} · Customer ${row.quote.customerRef}</p>
      ${table(['First invoice line','Amount'],row.quote.rating.lines.map(line=>[line.description,cents(line.amountCents)]))}
      ${row.approvalMode ? h`<p>Approval: ${row.approvalMode}. Prepared by ${row.preparedBy}; approved by ${row.approvedBy}.</p>` : ''}
      ${actor.role === 'owner' && row.preparedBy === actor.id && row.instructions.confirm ? form('trial.collection.confirm',back,h`${Object.entries(row.instructions.confirm).filter(([key])=>key!=='confirm').map(([key,value])=>hidden(key,value))}${check(`Authorize one charge of ${cents(row.quote.amountCents)} on ${formatDate(row.quote.chargeDate)} to this exact saved card.`,'confirm')}${check('If no other active approver exists, explicitly confirm this policy as the single approver.','confirm_single')}`,'Authorize this first payment',{primary:true}) : ''}
      ${row.instructions.approve && row.preparedBy !== actor.id ? form('trial.collection.approve',back,h`${hidden('request',row.id)}${hidden('basis_hash',row.basis)}${select('Decision','decision',[{value:'approved',label:'Approve exact terms'},{value:'rejected',label:'Reject'}])}`,'Confirm independent decision',{secondary:true}) : ''}
      ${actor.role==='owner' && ['pending_owner','pending_approval','active'].includes(row.status) ? form('trial.collection.revoke',back,h`${hidden('request',row.id)}`,'Revoke authorization',{secondary:true}) : ''}
      ${row.invoice ? h`<p><a href="/app/invoices/${row.invoice}">View the issued invoice and existing payment outcome</a></p>` : ''}
      ${row.errorCode ? h`<p>${row.errorCode.replaceAll('_',' ')}. No automatic retry is permitted.</p>` : ''}
    </article>`)}
  </section>`
}
