import { can, type Actor } from '../actor'
import type { Row } from '../core'
import { check, form, h, hidden, table, who } from './html'
import { pricingTiers } from './pricing'

export function catalogueApprovals(rows: Row[], meters: Row[], actor: Actor) {
  const back = '/app/catalog#price-approvals'
  return h`<section class="card" aria-labelledby="price-approvals"><h2 id="price-approvals">Price revisions</h2>
    <p class="hint">The first price is catalogue setup. Later versions are prepared before publication; a different approver confirms the saved terms. With no other active approver, the owner explicitly confirms as single-approver.</p>
    ${rows.filter(r => r.status === 'pending').map(r => h`<article><h3>${r.product_name} v${r.version}</h3>
      <p>${r.payload.nickname || 'Unnamed price'} · ${r.payload.pricing ? `${r.payload.pricing.model.replace('_', '-')} ${r.payload.kind === 'seat' ? 'seats' : 'usage'}` : r.payload.kind === 'flat' ? 'Flat monthly' : r.payload.kind === 'seat' ? 'Per seat monthly' : 'Per unit'} · ${r.payload.taxable ? 'Taxable' : 'Not taxable'}${r.payload.meterId ? ` · Meter ${meters.find(m => m.id === r.payload.meterId)?.code}` : ''}</p>
      ${r.payload.pricing ? pricingTiers(r.payload.pricing) : h`<p>Unit price $${r.payload.amount}</p>`}<p>Prepared by ${who(actor, r.prepared_by)}</p>
      ${r.stale ? h`<p class="hint">Another price version was published. Reject this request and prepare the next version again.</p>`
        : actor.kind === 'member' && can(actor, 'approve') ? r.prepared_by_id !== actor.id || r.singleAllowed
          ? form('price.decide', back, h`${hidden('request', r.id)}${hidden('decision', 'approved')}${r.singleAllowed ? check('I confirm these exact price terms as the single approver', 'confirm_single') : ''}`, r.singleAllowed ? 'Confirm and publish as single-approver' : 'Approve and publish price', { secondary: true })
          : h`<p class="hint">Another approver must publish this price revision. You prepared it.</p>` : ''}
      ${actor.kind === 'member' && can(actor, 'approve') ? form('price.decide', back, h`${hidden('request', r.id)}${hidden('decision', 'rejected')}`, 'Reject price revision', { secondary: true }) : ''}</article>`)}
    ${table(['Product', 'Version$', 'Status', 'Prepared by', 'Decided by', 'Approval'], rows.filter(r => r.status !== 'pending').map(r => [r.product_name, r.version, r.status, who(actor, r.prepared_by), r.decided_by ? who(actor, r.decided_by) : '—', r.approval_mode ?? '—']), { empty: 'No price revision decisions yet.' })}
  </section>`
}
