import { cents, money, quantityText } from '../decimal'
import type { Bindings } from '../../auth.server'
import { can, type Actor } from '../actor'
import type { Row } from '../core'
import { usageThresholds } from '../usage-thresholds'
import { check, field, form, h, hidden, page, raw, select } from './html'

type ThresholdChoices = { subscriptions: Row[]; meters: Row[]; contracts: Row[] }

/** Shared labelled fields; customer forms never contain a recipient or customer selector. */
export function thresholdFields(data: ThresholdChoices, definition?: Row, { portal = false } = {}) {
  const d = definition
  return h`${d ? hidden('id', d.id) : ''}
    ${field('Alert name', 'name', { value: d?.name ?? '' })}
    ${select('Subscription', 'subscription', data.subscriptions.map(s => ({ value: s.id, label: s.external_id })), d?.subscription_id ?? '')}
    ${select('Alert type', 'kind', [{ value: 'usage', label: 'Usage quantity' }, { value: 'spend', label: 'Usage spend' }, ...(!portal ? [{ value: 'commitment', label: 'Commitment utilisation' }] : [])], d?.kind ?? 'usage')}
    ${select('Meter (usage alerts)', 'meter', data.meters.map(m => ({ value: m.id, label: `${m.name} (${m.code})` })), d?.meter_id ?? '', { required: false, blank: 'Choose for usage alerts' })}
    ${!portal ? select('Contract (commitment alerts)', 'contract', data.contracts.map(c => ({ value: c.id, label: `${c.customer_name} · ${c.clause.slice(0,120)}` })), d?.contract_id ?? '', { required: false, blank: 'Choose for commitment alerts' }) : ''}
    ${field(portal ? 'Threshold (usage units or spend in billing currency)' : 'Threshold (usage units, spend in billing currency, or commitment percent)', 'threshold', { value: d?.threshold ?? '', type: 'number', step: 'any' })}
    ${!portal ? field('Recipient billing contact email', 'recipient', { type: 'email', value: d?.recipient ?? '' }) : ''}
    ${select('Alert status', 'enabled', [{ value: 'yes', label: 'Enabled' }, { value: 'no', label: 'Disabled' }], !d || d.enabled ? 'yes' : 'no')}
    ${check(portal ? 'I agree to receive threshold emails at my bound billing contact address.' : 'I confirm this billing contact may receive threshold emails.', 'confirm_mail')}`
}

export const thresholdValue = (kind: string, value: string, currency: string) => kind === 'spend' ? money(cents(value),currency) : `${quantityText(value)}${kind === 'commitment'?'%':''}`

const mailOutcome = (status: string) => ({accepted:'accepted by provider',sending:'outcome unknown; not retried',uncertain:'outcome unknown; not retried',failed:'refused or not configured',pending:'pending',suppressed:'suppressed'}[status] ?? status)

export function thresholdCrossings(definitions: Row[], crossings: Row[], invoiceLink: (id: string) => string, prepare = false) {
  return h`<section class="card" aria-labelledby="recent-crossings"><h2 id="recent-crossings">Recent crossings</h2>
    ${crossings.length ? crossings.map(c => h`<article><h3>${definitions.find(d => d.id === c.threshold_id)?.name ?? 'Threshold crossing'}</h3>
      <p>${c.period_start} · ${thresholdValue(c.kind,c.value,c.currency)} reached ${thresholdValue(c.kind,c.threshold,c.currency)} · Email ${mailOutcome(c.email_status)}</p>
      ${c.invoice_id ? h`<a href="${invoiceLink(c.invoice_id)}">View invoice</a>` : prepare && c.kind === 'spend' ? form('usage.threshold.invoice', '/app/invoices/{id}', hidden('crossing',c.id), 'Prepare threshold invoice', {secondary:true}) : ''}</article>`) : h`<p>No threshold crossings yet.</p>`}</section>`
}

export async function usageThresholdsPage(env: Bindings, actor: Actor, url: URL) {
  const data = await usageThresholds(env, actor), editable = actor.kind === 'member' && actor.role === 'owner'
  return page('Usage alerts', actor, h`<p class="crumbs"><a href="/app/usage">Usage</a></p><h1>Usage alerts</h1>
    ${thresholdCrossings(data.definitions, data.crossings, id => `/app/invoices/${id}`, actor.kind === 'member' && can(actor,'records'))}
    <section class="card" aria-labelledby="threshold-settings"><h2 id="threshold-settings">Alert settings</h2>
      ${data.definitions.map(d => h`<article><h3>${d.name}</h3><p>${d.kind} · ${thresholdValue(d.kind,d.threshold,d.currency)} · ${d.recipient}${d.enabled ? '' : ' · Disabled'}</p>
        ${editable ? h`<details><summary>Change alert settings</summary>${form('usage.threshold.configure', '/app/usage/alerts', thresholdFields(data, d), 'Update alert', { secondary: true })}</details>` : ''}</article>`)}
      ${editable ? h`<details${!data.definitions.length ? raw(' open') : ''}><summary>Create an alert</summary>
        ${form('usage.threshold.configure', '/app/usage/alerts', thresholdFields(data), 'Create alert', { secondary: true })}</details>` : !data.definitions.length ? h`<p>No usage alerts configured.</p>` : ''}
    </section>`, { current: '/app/usage', url })
}
