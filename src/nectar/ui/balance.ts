// The customer's credit balance on the customer record: cash overpayments,
// goodwill and carried credits, its own ledger and the governed forms.
import type { Bindings } from '../../auth.server'
import { can, canRead, type Actor } from '../actor'
import { balanceView } from '../balance'
import { creditPolicy } from '../credit-policy'
import { money } from '../decimal'
import { formatDate } from '../dates'
import { cents, field, form, h, hidden, select, table, tag, who } from './html'

export async function balanceSection(env: Bindings, actor: Actor, customerId: string) {
  if (!canRead(actor, 'payments')) return ''
  const view = await balanceView(env, actor, customerId), policy = await creditPolicy(env)
  const approver = can(actor, 'approve') && actor.kind === 'member', back = `/app/customers/${customerId}#balance`
  const pending = view.requests.filter(r => r.status === 'pending')
  const threshold = policy.two_person_above_cents
  return h`<section class="card" aria-labelledby="balance"><h2 id="balance">Credit balance</h2>
    <dl class="figures"><div><dt>Available now</dt><dd>${cents(view.totalCents-view.queuedCashCents)}</dd></div><div><dt>Cash overpayments</dt><dd>${cents(view.cashCents)}</dd></div><div><dt>Goodwill</dt><dd>${cents(view.goodwillCents)}</dd></div><div><dt>Carried correction credit</dt><dd>${cents(view.carriedCents)}</dd></div></dl>
    ${view.queuedCashCents ? h`<p>${cents(view.queuedCashCents)} of recorded cash awaits a separate <a href="/app/receivables#remittances">remittance allocation review</a>. It stays in the financial balance and does not apply automatically.</p>` : ''}
    <p>The balance applies to the next invoices ${policy.balance_application === 'automatic' ? 'automatically when they issue' : 'when an approver applies it'}, goodwill first and then the oldest cash. ${threshold === null ? 'No second-person threshold is set for balance actions.' : h`Grants and returns above ${cents(threshold)} need an approver who did not prepare them.`} Nectar sends no money: a return records the transfer the business made.</p>
    ${table(['Date', 'Entry', 'Amount$', 'Detail'], view.ledger.map((e: any) => [typeof e.at === 'string' ? formatDate(e.at) : new Date(e.at).toISOString().slice(0, 10), ({ receipt: 'Payment received', allocation: 'Payment allocated to invoice', goodwill: 'Goodwill credit', application: 'Applied to invoice', return: 'Returned to customer' } as Record<string, string>)[e.kind], cents(e.amountCents), e.kind === 'application' || e.kind === 'allocation' ? `${e.kind === 'allocation' ? 'Cash' : e.mode === 'goodwill' ? 'Goodwill' : 'Cash'} to ${e.invoice}` : e.reference ?? '—']), { empty: 'No balance activity.' })}
    ${table(['Request', 'Amount$', 'Reason', 'Prepared by', 'Approved by', 'Status'], view.requests.map((r: any) => [r.kind === 'goodwill' ? 'Goodwill credit' : `Return of ${r.reference}`, cents(r.amountCents), r.reason, who(actor, r.preparedBy), r.approvedBy ? h`${who(actor, r.approvedBy)} <span class="sub">${r.approval}</span>` : '—', tag(r.status === 'executed' ? 'Executed' : 'Pending')]), { empty: 'No balance requests.' })}
    ${approver ? h`${form('balance.goodwill', back, h`${hidden('customer', customerId)}${field('Goodwill amount ($)', 'amount')}${field('Reason', 'reason')}`, 'Grant goodwill credit', { layout: 'columns', secondary: true })}
      ${view.payments.length ? form('balance.return', back, h`${hidden('customer', customerId)}${select('Overpayment', 'payment', view.payments.map((p: any) => ({ value: p.id, label: `${p.reference} — ${money(p.unallocatedCents)} unallocated` })), view.payments[0].id)}${field('Amount to return ($)', 'amount')}${field('Reason', 'reason')}${field('Transfer reference', 'reference', { hint: 'The wire or check reference of the money you sent back.' })}`, 'Record return of balance', { layout: 'columns', secondary: true }) : ''}
      ${form('balance.prepare', back, h`${hidden('customer', customerId)}${select('Request', 'kind', [{ value: 'goodwill', label: 'Goodwill credit' }, { value: 'return', label: 'Return of an overpayment' }], 'goodwill')}${field('Amount ($)', 'amount')}${field('Reason', 'reason')}${view.payments.length ? select('Overpayment (returns)', 'payment', view.payments.map((p: any) => ({ value: p.id, label: `${p.reference} — ${money(p.unallocatedCents)} unallocated` })), view.payments[0].id, { required: false, blank: 'None' }) : ''}${field('Transfer reference (returns)', 'reference', { required: false })}`, 'Prepare for a second approver', { layout: 'columns', secondary: true })}
      ${pending.map((r: any) => h`<p>Review ${r.kind === 'goodwill' ? 'goodwill credit' : `return of ${r.reference}`} for ${cents(r.amountCents)}, prepared by ${who(actor, r.preparedBy)}.</p>${r.preparedBy !== actor.email || threshold === null || r.amountCents <= threshold ? form('balance.approve', back, hidden('request', r.id), 'Approve balance request', { secondary: true }) : h`<p class="hint">Another approver must execute this request. You prepared it.</p>`}`)}` : ''}</section>`
}
