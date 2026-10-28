import type { Bindings } from '../../auth.server'
import { can, type Actor } from '../actor'
import { all } from '../core'
import { portalChangeSettings } from '../portal-change-policy'
import { check, checks, field, form, h, page, tag } from './html'

export async function portalChangeSettingsPage(env: Bindings, actor: Actor, url: URL) {
  const { policy, requests } = await portalChangeSettings(env, actor)
  const prices = actor.role === 'owner' ? await all(env, `SELECT p.id,p.nickname,p.unit_amount,p.kind,pr.name FROM nc_prices p JOIN nc_products pr ON pr.id=p.product_id LEFT JOIN nc_price_intervals b ON b.price_id=p.id WHERE p.status='active' AND p.kind IN ('flat','seat') AND p.pricing_model='simple' AND COALESCE(b.interval_unit,'month')='month' AND COALESCE(b.interval_count,1)=1 AND COALESCE(b.billing_timing,'arrears')='arrears' ORDER BY pr.name,p.id`) : []
  const back = '/app/settings/portal-changes'
  return page('Portal change requests', actor, h`<h1>Portal change requests</h1><p>Requests wait for a person. They never change subscriptions, invoices or payments. Use the existing governed change flow after reviewing current terms.</p>
    <section class="card"><h2>Merchant restrictions</h2><p>Only approved catalog choices appear in the customer request form. Seat reductions below the minimum are refused. Pause execution is not available in this request flow.</p><p>Approved revision: ${policy.revision}. Minimum seats: ${policy.minimumSeats}.</p>
    ${actor.role === 'owner' ? form('portal.change.policy', back, h`${checks('Catalog choices for requests', 'prices', prices.map(p => ({ value: p.id, label: `${p.name} · ${p.nickname || p.unit_amount} · ${p.kind}` })), policy.prices)}${field('Minimum seats', 'minimum_seats', { type: 'number', value: policy.minimumSeats })}${check('Merchant permits pausing (execution remains unavailable)', 'pause_allowed', { checked: policy.pauseAllowed })}`, 'Prepare restrictions') : ''}
    ${can(actor, 'read') ? h`<p><a href="/app/settings#policy-changes">Review prepared policy changes</a></p>` : ''}</section>
    <section class="card"><h2>Pending requests</h2>${requests.length ? requests.map((r: Record<string, any>) => h`<article><h3>${r.customer_name} ${tag('Pending review')}</h3><p>${r.target_label} · ${r.unit_amount} ${r.currency} per seat · ${r.quantity} seats</p><p>${r.requested_on} · Approved policy revision ${r.policy_revision}</p><p>${r.below_minimum ? 'Below signed minimum; human review required.' : 'Merchant review required.'}</p><a href="/app/subscriptions/${r.subscription_id}">Review subscription</a></article>`) : h`<p>No requests yet.</p>`}</section>`, { current: '/app/settings', url })
}
