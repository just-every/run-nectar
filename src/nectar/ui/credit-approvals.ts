// Credit policy and pending decisions on the invoice that will be credited.
import { can, type Actor } from '../actor'
import type { Row } from '../core'
import { plainMoney } from '../decimal'
import { cents, field, form, h, hidden, table, who } from './html'

export function creditApprovals(i: Row, actor: Actor) {
  const back = `/app/invoices/${i.id}`, threshold = i.creditPolicy.two_person_above_cents
  const stale = (r: Row) => r.policy_revision !== i.creditPolicy.revision || r.balance_cents !== i.balanceCents
  return h`<section class="card" aria-labelledby="credit-approvals"><h2 id="credit-approvals">Credit approvals</h2>
    <p>${threshold === null ? 'No second-person credit threshold is set.' : h`Credits above ${cents(threshold)} need an approver who did not prepare them.`}</p>
    ${can(actor, 'approve') && i.balanceCents > 0 ? form('credit.prepare', back, h`${hidden('invoice', i.id)}${field('Requested credit ($)', 'amount')}${field('Credit reason', 'reason')}`, 'Prepare credit for approval', { layout: 'columns', secondary: true }) : ''}
    ${table(['Amount$', 'Reason', 'Prepared by', 'Status'], i.creditRequests.map((r: Row) => [cents(r.amount_cents), r.reason, who(actor, r.prepared_name), r.status === 'pending' && stale(r) ? 'Needs a new request' : r.status]), { empty: 'No credit requests.' })}
    ${can(actor, 'approve') ? i.creditRequests.filter((r: Row) => r.status === 'pending' && !stale(r)).map((r: Row) => h`<p>Review ${cents(r.amount_cents)} for ${r.reason}, prepared by ${who(actor, r.prepared_name)}. A changed balance or policy requires a new request.</p>${r.prepared_by !== actor.id || threshold === null || r.amount_cents <= threshold ? form('credit.approve', back, hidden('request', r.id), 'Approve and issue credit', { secondary: true }) : h`<p class="hint">Another approver must issue this credit.</p>`}`) : ''}
    ${actor.role === 'owner' ? form('credit.policy', back, field('Second person required above ($)', 'two_person_above', { value: threshold === null ? '' : plainMoney(threshold), required: false, hint: 'Applies to every credit, including API requests. Leave empty to remove the threshold; zero requires two people for every credit.' }), 'Save credit approval policy', { secondary: true }) : ''}
  </section>`
}
