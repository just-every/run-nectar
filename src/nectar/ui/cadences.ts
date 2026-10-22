import type { Bindings } from '../../auth.server'
import { can, type Actor } from '../actor'
import { cadenceReport } from '../cadence-actions'
import type { Row } from '../core'
import { money, plainMoney } from '../decimal'
import { area, check, details, field, form, h, hidden, page, select, table } from './html'

const outcome: Record<string, string> = { awaiting_approval: 'Needs human approval', pending: 'Approved; awaiting send', sending: 'Send claimed; outcome not recorded',
  accepted: 'Provider accepted', suppressed: 'Development send suppressed', failed: 'Send failed or mail not configured', rejected: 'Provider rejected',
  rate_limited: 'Provider rate limited', uncertain: 'Outcome uncertain', superseded: 'Superseded; no attempt' }
const stageLabel = (stage: number) => stage < 0 ? `${-stage} days before due` : `${stage} days overdue`

export async function cadencesPage(env: Bindings, actor: Actor, url: URL) {
  const report = await cadenceReport(env, actor)
  const worker = actor.kind === 'member' && can(actor, 'receivables')
  const approver = actor.kind === 'member' && can(actor, 'approve')
  const invoice = report.invoices.find(row => row.id === url.searchParams.get('invoice')) ?? report.invoices[0]
  const target = invoice ? `/app/cadences?invoice=${invoice.id}` : '/app/cadences'
  const rules = report.policy.rules.length ? [...report.policy.rules, { segment: '', minimum_cents: 0, subject: '', body: '' }] : [
    { segment: 'standard', minimum_cents: 0, subject: 'Payment reminder: {invoice}', body: 'Please arrange payment of {balance} to {business}.' },
    { segment: '', minimum_cents: 0, subject: '', body: '' },
  ]
  const ruleTable = (entries: Row[]) => table(['Segment', 'Minimum collectible', 'Subject', 'Message'], entries.map(row => [row.segment, money(row.minimum_cents), row.subject, row.body]))
  const policyRequests = report.requests.map(request => h`<section class="card"><h3>Policy prepared by ${request.prepared_by}</h3>
    <p>${request.status}${request.stale ? ' · Source policy changed' : ''}${request.approval_mode ? ` · ${request.approval_mode}` : ''}. Automatic sends ${request.payload.enabled ? 'enabled' : 'disabled'}; ${request.payload.require_human ? 'human approval required' : 'approved policy authorizes each send'}.</p>
    ${ruleTable(request.payload.rules)}${request.status === 'pending' && approver ? h`${form('cadence.policy.decide', target, h`${hidden('request', request.id)}${hidden('decision', 'approved')}${request.singleAllowed ? check('I confirm this exact policy as the only available approver', 'confirm_single') : ''}`, 'Approve exact policy')}
      ${form('cadence.policy.decide', target, h`${hidden('request', request.id)}${hidden('decision', 'rejected')}`, 'Reject policy', { secondary: true })}` : ''}</section>`)
  const chosen = invoice ? h`<section class="card"><h2>Invoice ${invoice.number}</h2><p>${invoice.customer_name} · Due ${invoice.due_date}</p>
    <p><strong>Collectible now: ${money(invoice.collectibleCents)}</strong> · Invoice balance: ${money(invoice.balanceCents)} · Disputed: ${money(invoice.disputedCents)}</p>
    <p>${invoice.hold === 'paid' ? 'Paid: collection stopped.' : invoice.hold === 'written_off' ? 'Written off as bad debt: collection stopped.' : invoice.hold === 'promise' ? `Promise hold through ${invoice.promisedThrough}, inclusive.` : invoice.hold === 'disputed' ? 'Collection paused: the remaining amount is disputed.' : 'No current collection hold.'}</p>
    ${details({ 'Invoice balance': money(invoice.balanceCents), 'Disputed amount': money(invoice.disputedCents), 'Collectible amount': money(invoice.collectibleCents), 'Promise through': invoice.promisedThrough ?? 'None', 'Collection hold': invoice.hold ?? 'None', Segment: invoice.segment ?? 'Not enrolled' })}
    <p><a href="/app/invoices/${invoice.id}">Open invoice and recorded payments</a></p>
    ${worker && !invoice.segment ? form('cadence.enroll', target, h`${hidden('invoice', invoice.id)}${field('Customer segment', 'segment', { value: 'standard' })}${field('Recorded transfer terms', 'transfer_terms', { hint: 'Record the customer’s agreed transfer terms. This does not verify a bank account or payment.' })}`, 'Enroll invoice') : ''}
    ${worker && invoice.balanceCents > 0 ? h`<h3>Promise to pay</h3><p>Reminders pause through this date in the business timezone and resume the following day.</p>
      ${form('cadence.promise', target, h`${hidden('invoice', invoice.id)}${field('Promised payment date', 'pay_date', { type: 'date' })}${field('Promise evidence', 'note')}`, 'Record promise')}
      <h3>Disputed line amount</h3><p>Only the recorded amount is excluded from collection. This does not change debt or attribute any tax to a line.</p>
      ${form('cadence.dispute', target, h`${hidden('invoice', invoice.id)}${select('Invoice line', 'line', invoice.lines.filter(row => row.amount_cents > 0).map(row => ({ value: row.id, label: `${row.description} · ${money(row.amount_cents)}` })))}${field('Disputed amount ($)', 'amount')}${field('Dispute reason', 'reason')}`, 'Record line dispute')}` : ''}
    ${invoice.transfer_terms ? h`<p class="hint">Operator-recorded terms: ${invoice.transfer_terms}</p>` : ''}</section>` : ''
  const deliveries = report.deliveries.map(delivery => h`<section class="card"><h3><a href="/app/cadences?invoice=${delivery.invoice_id}">${delivery.invoice_number} · ${delivery.customer_name}</a></h3>
    <p>${stageLabel(delivery.stage)} · ${outcome[delivery.status] || delivery.status}. Requested ${money(delivery.collectible_cents)}.</p>
    ${details({ Recipient: delivery.recipient, 'Approved by': delivery.approved_by ?? 'Not approved', 'Approval basis': delivery.approval_mode === 'policy' ? 'Owner-approved policy' : delivery.approval_mode === 'human' ? 'Human approval' : 'Awaiting approval' })}
    <details><summary>Exact reminder</summary><h4>${delivery.subject}</h4><p class="message">${delivery.body}</p></details>
    ${worker && delivery.status === 'awaiting_approval' ? form('cadence.approve', `/app/cadences?invoice=${delivery.invoice_id}`, h`${hidden('delivery', delivery.id)}${hidden('recipient', delivery.recipient)}${hidden('subject', delivery.subject)}${hidden('body', delivery.body)}`, 'Approve exact reminder') : ''}
    <p class="hint">Provider acceptance does not confirm mailbox delivery. A claimed or uncertain send is never retried automatically.</p></section>`)
  return page('Collections cadences', actor, h`<h1>Collections cadences</h1>
    <p>Reminders for recorded transfer invoices, three days before due and one, seven and fifteen days overdue. The daily job uses the business timezone; after missed days it selects only the latest stage. Promises, disputed amounts and actual recorded payments are checked before every send.</p>
    <section class="card"><h2>Current policy</h2><p>Cadences ${report.policy.enabled ? 'enabled' : 'disabled'}. ${report.policy.require_human ? 'Each reminder needs human approval.' : 'The approved policy authorizes reminders.'}</p>${ruleTable(report.policy.rules)}
    <p class="hint">Rules apply in order: the first matching segment with a satisfied minimum balance wins. Segments are explicitly recorded at enrollment. Approval of a reminder queues it for the next daily tick or Run now.</p>
    ${worker ? form('cadence.run', target, '', 'Run due cadences now') : ''}</section>
    ${actor.role === 'owner' ? h`<section class="card"><h2>Prepare a policy change</h2><p>Another approver confirms the exact policy. If no other approver exists, the owner confirms it a second time.</p>
      ${form('cadence.policy.prepare', target, h`${check('Enable cadences', 'enabled', { checked: report.policy.enabled })}${check('Require human approval for every reminder', 'require_human', { checked: report.policy.require_human })}
      <p>Use {invoice}, {balance}, {stage} and {business} in wording. The current collectible amount and excluded disputes are always appended. Leave the segment empty to remove a rule.</p>
      ${rules.map((rule, index) => h`<fieldset><legend>Rule ${index + 1}</legend>${field('Segment', 'rule_segment', { value: rule.segment, required: false })}${field('Minimum collectible balance ($)', 'rule_minimum', { value: plainMoney(rule.minimum_cents), required: false })}${field('Subject', 'rule_subject', { value: rule.subject, required: false })}${area('Reminder wording', 'rule_body', rule.body, false)}</fieldset>`)}`, 'Prepare exact policy')}
    </section>` : ''}${policyRequests}
    <section class="card"><h2>Choose an invoice</h2>${report.invoices.length ? h`<form method="get" action="/app/cadences">${select('Issued invoice', 'invoice', report.invoices.map(row => ({ value: row.id, label: `${row.number} · ${row.customer_name}` })), invoice?.id)}<button type="submit">Open collection record</button></form>` : h`<p>No issued invoices yet.</p>`}</section>${chosen}
    <section class="card"><h2>Dispute history</h2>${table(['Invoice', 'Disputed', 'Reason', 'Outcome'], report.disputes.map(row => [h`<a href="/app/invoices/${row.invoice_id}">Open invoice</a>`, money(row.amount_cents), row.reason,
      row.resolved_at ? row.outcome : worker ? form('cadence.resolve', target, h`${hidden('dispute', row.id)}${field('Resolution evidence', 'outcome')}`, 'Resolve dispute') : 'Open']))}</section>
    <section class="card"><h2>Owner escalations</h2>${table(['Invoice', 'Assigned owner', 'Task'], report.escalations.map(row => [h`<a href="/app/invoices/${row.invoice_id}">Open invoice</a>`, row.owner_name, h`<a href="/app/receivables#tasks">${row.task_status}</a>`]))}</section>
    <h2>Reminder custody</h2>${deliveries.length ? deliveries : h`<section class="card"><p>No cadence reminders reserved.</p></section>`}`, { current: '/app/cadences', url })
}
