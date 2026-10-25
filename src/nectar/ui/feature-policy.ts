import type { Row } from '../core'
import { field, form, h, hidden, select } from './html'

export function featurePolicies(product: string, features: Row[], meters: Row[], editable: boolean) {
  return features.filter(f => f.product_id === product).map(f => h`<section aria-label="${f.feature} access policy">
    <h4>${f.feature} access policy</h4>
    <p>${f.numeric_limit !== null && f.numeric_limit !== undefined ? `Numeric limit: ${f.numeric_limit}. ` : ''}${f.quota ? `${f.quota_policy}: ${f.quota} ${meters.find(m => m.id === f.meter_id)?.unit_label ?? 'units'} per subscription billing period.` : 'No usage limit.'}
      ${f.grace_days === null ? 'Unpaid invoices do not restrict this feature.' : `Unpaid invoices restrict access ${f.grace_days} calendar days after their due date.`}</p>
    ${editable ? form('feature.policy', '/app/catalog', h`${hidden('product', product)}${hidden('feature', f.feature)}
      ${field('Numeric limit', 'numeric_limit', { value: f.numeric_limit ?? '', required: false, hint: 'Blank means no numeric cap. Zero is a valid limit. Independent of the metered quota.' })}
      ${select('Quota meter', 'meter', meters.map(m => ({ value: m.id, label: `${m.name} (${m.code})` })), f.meter_id ?? '', { required: false, blank: 'No usage limit' })}
      ${field('Usage limit', 'quota', { value: f.quota ?? '', required: false, hint: 'Exact quantity, up to six decimal places. The limit is reached at this quantity.' })}
      ${select('At the limit', 'quota_policy', [{ value: 'soft', label: 'Warn and allow' }, { value: 'hard', label: 'Deny' }, { value: 'overage', label: 'Allow and bill at catalog prices' }], f.quota_policy ?? 'soft')}
      ${field('Unpaid grace (calendar days)', 'grace_days', { type: 'number', value: f.grace_days ?? '', required: false, hint: 'Blank leaves access unchanged. Payment or credit settling the balance restores access.' })}
      <p><a href="/app/settings#policy-changes">Review prepared policy changes</a></p><p class="hint">Access limits do not include free units or change billing prices. Removing the meter removes the usage limit.</p>`, 'Prepare access policy', { layout: 'columns', secondary: true }) : ''}
  </section>`)
}
