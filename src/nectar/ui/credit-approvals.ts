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
    ${table(['Amount$', 'Reason', 'Prepared by', 'Status'], i.creditRequests.map((r: Row) => [cents(r.amount_cents), r.purpose === 'invoice-void' ? `Invoice void: ${r.reason}` : r.reason, who(actor, r.prepared_name), r.status === 'pending' && stale(r) ? 'Needs a new request' : r.status]), { empty: 'No credit requests.' })}
    ${can(actor, 'approve') ? i.creditRequests.filter((r: Row) => r.status === 'pending' && r.purpose !== 'invoice-void' && !stale(r)).map((r: Row) => h`<p>Review ${cents(r.amount_cents)} for ${r.reason}, prepared by ${who(actor, r.prepared_name)}. A changed balance or policy requires a new request.</p>${r.prepared_by !== actor.id || threshold === null || r.amount_cents <= threshold ? form('credit.approve', back, hidden('request', r.id), 'Approve and issue credit', { secondary: true }) : h`<p class="hint">Another approver must issue this credit.</p>`}`) : ''}
    <p>Support credits go up to ${cents(Number(i.creditPolicy.support_limit_cents ?? 0))}${Number(i.creditPolicy.support_limit_cents ?? 0) === 0 ? ' (no support credits until the owner sets a limit)' : ''}.</p>
    ${actor.role === 'owner' ? form('credit.policy', '/app/settings#policy-changes', h`${field('Second person required above ($)', 'two_person_above', { value: threshold === null ? '' : plainMoney(threshold), required: false, hint: 'Applies to every credit, including API requests. Leave empty to remove the threshold; zero requires two people for every credit.' })}${field('Support credit limit ($)', 'support_limit', { value: plainMoney(Number(i.creditPolicy.support_limit_cents ?? 0)), required: false, hint: 'The most a Support member may credit at once. Zero means support cannot credit.' })}`, 'Prepare credit approval policy', { secondary: true }) : ''}
  </section>`
}
