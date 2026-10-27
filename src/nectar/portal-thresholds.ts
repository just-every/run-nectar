import type { Bindings } from '../auth.server'
import type { CustomerSession } from './portal-session'
import { portalThresholds } from './usage-thresholds'
import { thresholdCrossings, thresholdFields, thresholdValue } from './ui/usage-thresholds'
import { h, raw } from './ui/html'

export async function portalThresholdsPage(env: Bindings, session: CustomerSession, link: (path: string) => string) {
  const data = await portalThresholds(env, session)
  const configuration = (definition?: (typeof data.definitions)[number]) => h`<form class="threshold-form" method="post" action="${link('/portal/alerts')}">
    ${thresholdFields(data, definition, { portal: true })}<button type="submit">${definition ? 'Update alert' : 'Create alert'}</button></form>`
  return h`<header><p><a href="${link('/portal')}">Back to billing</a></p><h1>Usage alerts</h1></header>
    ${thresholdCrossings(data.definitions, data.crossings, id => link(`/portal/invoices/${id}`))}
    <section class="card"><h2>Alert settings</h2>
      ${data.definitions.map(d => h`<article><h3>${d.name}</h3><p>${d.kind} · ${thresholdValue(d.kind,d.threshold,session.currency)}${d.enabled ? '' : ' · Disabled'}</p>
        ${session.contactId ? h`<details><summary>Change alert settings</summary>${configuration(d)}</details>` : ''}</article>`)}
      ${session.contactId ? h`<details${!data.definitions.length ? raw(' open') : ''}><summary>Create an alert</summary>${configuration()}</details>` : h`<p>Ask your billing team for a portal link bound to your billing contact to manage alerts.</p>`}
    </section>`
}
