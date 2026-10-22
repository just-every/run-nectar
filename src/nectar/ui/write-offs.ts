// Bad-debt write-offs on the invoice: the owner's two-person limit, each
// request's exact balance and accounting effect, executions with both people,
// recoveries against them and the ledger posting each one saved.
import { can, type Actor } from '../actor'
import type { Row } from '../core'
import { money } from '../decimal'
import { cents, field, form, h, hidden, select, table, tag, who } from './html'

const posting = (rows: Row[]) => rows.length ? rows.map(p => h`${p.kind === 'bad_debt' ? 'Bad debt' : 'Recovery'} ${p.docNumber}: ${p.status === 'posted' ? h`posted, ledger entry ${p.ledgerRef}` : h`pending${p.error ? h` (${p.error})` : ''}`}`).map(x => h`<span class="sub">${x}</span>`) : '—'

export function writeOffSection(i: Row, actor: Actor, pays: Row[]) {
  const back = `/app/invoices/${i.id}`, threshold = i.creditPolicy.two_person_above_cents, approver = can(actor, 'approve') && actor.kind === 'member'
  const rows: Row[] = i.writeOffs, requests = rows.filter(r => r.status === 'pending'), executed = rows.filter(r => r.status === 'executed')
  const stale = (r: Row) => r.balanceCents !== i.balanceCents
  const pending = (i.writeOffs as Row[]).flatMap(r => r.postings as Row[]).filter(p => p.status === 'pending')
  return h`<section class="card" aria-labelledby="write-offs"><h2 id="write-offs">Bad debt write-offs</h2>
    <p>${threshold === null ? 'No second-person threshold is set for write-offs.' : h`Write-offs above ${cents(threshold)} need an approver who did not prepare them.`} A write-off removes the balance from ageing and collection, saves a bad-debt journal for the ledger and leaves the issued invoice unchanged.</p>
    ${table(['Amount$', 'Reason', 'Prepared by', 'Approved by', 'Status', 'Recovered$', 'Ledger'], rows.map((r: Row) => [cents(r.amountCents), r.reason, who(actor, r.preparedBy), r.approvedBy ? h`${who(actor, r.approvedBy)} <span class="sub">${r.approval}</span>` : '—',
      r.status === 'pending' && stale(r) ? 'Needs a new request' : tag(r.status === 'executed' ? 'Executed' : 'Pending'), cents(r.recoveredCents), posting(r.postings)]), { empty: 'No write-offs.' })}
    ${approver && i.balanceCents > 0 ? h`${form('writeoff.prepare', back, h`${hidden('invoice', i.id)}${field('Write-off amount ($)', 'amount', { hint: `The balance is ${money(i.balanceCents)}.` })}${field('Reason', 'reason')}`, 'Prepare write-off for approval', { layout: 'columns', secondary: true })}
      ${form('writeoff.issue', back, h`${hidden('invoice', i.id)}${field('Write-off amount ($)', 'amount')}${field('Reason', 'reason')}`, 'Write off now', { layout: 'columns', secondary: true })}` : ''}
    ${approver ? requests.filter(r => !stale(r)).map((r: Row) => h`<p>Review ${cents(r.amountCents)} for ${r.reason}, prepared by ${who(actor, r.preparedBy)}; effect: debit ${r.effect.entries[0].account}, credit ${r.effect.entries[1].account}. A changed balance or policy requires a new request.</p>
      ${r.preparedBy !== actor.email || threshold === null || r.amountCents <= threshold ? form('writeoff.approve', back, hidden('request', r.id), 'Approve write-off', { secondary: true }) : h`<p class="hint">Another approver must execute this write-off. You prepared it.</p>`}`) : ''}
    ${approver && pays.length ? executed.filter(r => r.netCents > 0).map((r: Row) => form('writeoff.recover', back, h`${hidden('write_off', r.id)}${select('Payment', 'payment', pays.map((p: Row) => ({ value: p.id, label: `${p.reference} — ${money(p.unallocated_cents)} unallocated` })), pays[0].id)}${field('Recovered amount ($)', 'amount', { hint: `Up to ${money(r.netCents)} of this write-off is outstanding.` })}`, 'Record recovery', { layout: 'columns', secondary: true })) : ''}
    ${approver && pending.length ? form('ledger.post', back, '', 'Retry pending ledger postings', { secondary: true }) : ''}</section>`
}
