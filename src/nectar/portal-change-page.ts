import type { Bindings } from '../auth.server'
import type { CustomerSession } from './portal-session'
import { customerText } from './locale'
import { portalChangeData, portalChangeOptions, portalChangeSubscriptions } from './portal-change-requests'
import { h } from './ui/html'

export async function portalChangesPage(env: Bindings, session: CustomerSession, subscription: string | undefined, link: (path: string) => string) {
  const L = customerText(session.language, session.currency)
  const intro = h`<h1>${L.t('portal.change.heading')}</h1><p>${L.t('portal.change.pendingOnly')}</p><p><a href="${link('/portal')}">${L.t('portal.back')}</a></p>`
  if (!subscription) {
    const subscriptions = await portalChangeSubscriptions(env, session)
    const status = await portalChangeData(env, session)
    return h`${intro}${'requests' in status ? status.requests?.map(r => h`<section class="card"><h2>${L.t('portal.change.pending')}</h2><p>${r.targetName} · ${L.amount(r.unitAmount,r.currency)} · ${L.percent(r.quantity)}</p><p>${L.day(r.requestedOn)}</p><p>${L.t('portal.change.review')}</p></section>`) : ''}${subscriptions.map((s, index) => h`<section class="card"><a href="${link(`/portal/changes/${s.id}`)}">${L.t('portal.change.subscription', { number: index + 1 })}</a>${s.has_term ? h`<p><a href="${link(`/portal/renewal/${s.id}`)}">${L.t('renewal.manage.title')}</a></p>` : ''}${s.has_return ? h`<p><a href="${link(`/portal/return/${s.id}`)}">${L.t('return.offer.title')}</a></p>` : ''}</section>`)}`
  }
  const data = await portalChangeOptions(env, session, subscription)
  return h`${intro}<section class="card"><h2>${data.current.product_name}</h2><dl><dt>${L.t('portal.change.current')}</dt><dd>${data.current.nickname || data.current.product_name} · ${L.amount(data.current.unit_amount)}</dd>${data.current.kind === 'seat' ? h`<dt>${L.t('portal.change.seats')}</dt><dd>${L.percent(data.quantity)}</dd><dt>${L.t('portal.change.minimum')}</dt><dd>${L.percent(data.policy.minimumSeats)}</dd>` : ''}</dl>
    ${data.previewTargets.length ? h`<form method="post" action="${link('/portal/change.request')}"><input type="hidden" name="subscription" value="${subscription}"><input type="hidden" name="item" value="${data.item}"><input type="hidden" name="basis" value="${data.basis}"><input type="hidden" name="policy_revision" value="${data.policy.revision}"><input type="hidden" name="confirm" value="yes">
      <p><label>${L.t('portal.change.target')}<br><select name="target_price">${data.previewTargets.map(p => h`<option value="${p.id}">${p.nickname || p.product_name} · ${L.amount(p.unit_amount)}</option>`)}</select></label></p>
      ${data.current.kind === 'seat' ? h`<p><label>${L.t('portal.change.seats')}<br><input name="quantity" type="number" min="${data.policy.minimumSeats}" max="1000000" value="${data.quantity}" required></label></p>` : h`<input type="hidden" name="quantity" value="1">`}
      <button type="submit" formaction="${link('/portal/change.preview')}">${L.t('portal.change.previewButton')}</button> ${data.targets.length ? h`<button type="submit">${L.t('portal.change.submit')}</button>` : ''}</form>` : h`<p>${L.t('portal.change.unavailable')}</p>`}</section>
    <section class="card"><h2>${L.t('portal.change.requests')}</h2>${data.requests.length ? data.requests.map(r => h`<article><h3>${L.t('portal.change.pending')}</h3><p>${r.targetName} · ${L.amount(r.unitAmount,r.currency)}</p><dl><dt>${L.t('portal.change.date')}</dt><dd>${L.day(r.requestedOn)}</dd><dt>${L.t('portal.change.quantity')}</dt><dd>${L.percent(r.quantity)}</dd></dl><p>${L.t(r.belowContractMinimum ? 'portal.change.contractMinimum' : 'portal.change.review')}</p>${!r.current ? h`<p>${L.t('portal.change.stale')}</p>` : ''}</article>`) : h`<p>${L.t('portal.change.empty')}</p>`}</section>`
}
