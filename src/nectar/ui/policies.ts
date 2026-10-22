import type { Bindings } from '../../auth.server'
import { can, type Actor } from '../actor'
import type { Row } from '../core'
import { policyChanges } from '../policy-changes'
import { cents, check, form, h, hidden, table, tag, who } from './html'

const labels: Record<string, string> = { usage: 'Historical usage disposition', feature: 'Feature access policy', credit: 'Credit and write-off approval threshold', certificate: 'Certificate reminder mail', tax: 'Declared tax policy', lifecycle: 'Cancellation, reactivation and proration policy' }
const value = (row: Row) => row.kind === 'usage' ? row.payload.disposition.replaceAll('_',' ') : row.kind === 'feature'
  ? `${row.payload.productName} / ${row.payload.feature}: ${row.payload.quota === null ? 'no usage limit' : `${row.payload.quota} ${row.payload.meterName}`}; ${row.payload.policy}; unpaid grace ${row.payload.graceDays === null ? 'disabled' : `${row.payload.graceDays} days`}`
  : row.kind === 'credit'
  ? row.payload.twoPersonAboveCents === null ? 'No second-person credit threshold' : h`Second person above ${cents(row.payload.twoPersonAboveCents)}`
  : row.kind === 'certificate' ? row.payload.enabled ? 'Enabled' : 'Disabled'
  : row.kind === 'lifecycle' ? `${row.payload.creditUnused ? 'Credit unused recurring service' : 'No unused-service credit'}; reactivate within ${row.payload.reactivationDays} days; plan changes: ${({invoice_now:'prorate and invoice now',next_invoice:'prorate on next invoice',none:'no proration'} as Record<string,string>)[row.payload.prorationPolicy]??(row.payload.prorationPolicy===null?'not configured':'unchanged')}`
  : `${row.payload.jurisdiction}: ${row.payload.mode === 'no_tax' ? 'No sales tax' : `${row.payload.rate}% flat rate`}. ${row.payload.note}`

export async function policySection(env: Bindings, actor: Actor) {
  const rows = await policyChanges(env, actor)
  const back = '/app/settings#policy-changes'
  return h`<section class="card" aria-labelledby="policy-changes"><h2 id="policy-changes">Policy changes</h2>
    <p class="hint">The owner prepares exact values. A different owner or finance approver confirms them before they apply. With no other active approver, the owner confirms in a second step recorded as single-approver.</p>
    ${rows.filter(r => r.status === 'pending').map(r => h`<article><h3>${labels[r.kind]}</h3><p>${value(r)}</p><p class="sub">Prepared by ${who(actor, r.prepared_by)}</p>
      ${r.stale ? h`<p class="hint">This policy changed since preparation. Reject this request and prepare it again.</p>`
        : actor.kind === 'member' && can(actor, 'approve') ? r.prepared_by_id !== actor.id || r.singleAllowed
          ? form('policy.decide', back, h`${hidden('request', r.id)}${hidden('decision', 'approved')}${r.singleAllowed ? check('I confirm this exact policy change as the single approver', 'confirm_single') : ''}`, r.singleAllowed ? 'Confirm single-approver change' : 'Approve policy change', { secondary: true })
          : h`<p class="hint">Another approver must confirm this policy change. You prepared it.</p>` : ''}
      ${actor.kind === 'member' && can(actor, 'approve') ? form('policy.decide', back, h`${hidden('request', r.id)}${hidden('decision', 'rejected')}`, 'Reject policy change', { secondary: true }) : ''}</article>`)}
    ${table(['Policy', 'Exact change', 'Prepared by', 'Status', 'Approval', 'Decided by'], rows.filter(r => r.status !== 'pending').map(r => [labels[r.kind], value(r), who(actor, r.prepared_by), tag(r.status), r.approval_mode ?? '—', r.decided_by ? who(actor, r.decided_by) : '—']), { empty: 'No policy decisions yet.' })}
  </section>`
}
