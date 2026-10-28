import { remittancesPanel } from './remittances'
import { tooltipLink } from './tooltip'
import { unmatchedProcessorCash } from '../processor-cash-queue'
// Receivables, the finance lead's working screen: what is owed, overdue and
// collected; every open invoice and the recently settled ones; the decision
// panel for a drafted reminder (recipient and wording, approved by a person);
// then ageing, the other reminders, follow-up tasks and payments received.
import type { Bindings } from '../../auth.server'
import { canRead, can, type Actor } from '../actor'
import { BUCKETS, ageing, notices, tasks } from '../collections'
import { all } from '../core'
import { customers } from '../customers'
import { formatDate } from '../dates'
import { money } from '../decimal'
import { payments, receivablesDesk } from '../receivables'
import { addresses, area, cents, field, form, h, hidden, page, raw, select, table, tag, who, type Html } from './html'
import { icon, type IconName } from './icons'
import { personName, placeOf } from './shell'

const dayText = (date: string, year = false) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) }).format(new Date(`${date}T00:00:00Z`)).replace(/^(\w+),/, '$1')
const monthText = (month: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long' }).format(new Date(`${month}-01T00:00:00Z`))
const METHODS: Record<string, [string, IconName]> = { bank_transfer: ['Bank transfer', 'bank'], check: ['Check', 'check'], card_external: ['Card', 'card'], other: ['Other', 'receivables'] }
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const pill = (tone: string, glyph: IconName, text: string) => h`<span class="pill pill-${tone}">${icon(glyph)}<span>${text}</span></span>`

type Desk = Awaited<ReturnType<typeof receivablesDesk>>

function ledger(desk: Desk, focus: string | null, jump: string): Html {
  const open = [...desk.open].sort((a, b) => Number(b.customer_id === focus) - Number(a.customer_id === focus) || b.daysOverdue - a.daysOverdue || a.due_date.localeCompare(b.due_date))
  const rows = [...open, ...desk.settled]
  // Where the decision panel sits below the table, the row in focus links down to it.
  const lead = open.find(r => r.customer_id === focus && r.balance_cents > 0)?.id
  if (!rows.length) return h`<section class="card ledger-card">${table([], [], { empty: 'No issued invoices yet. Invoices appear here once a bill run is approved and finalized under Billing.', lead: true })}</section>`
  const row = (r: any) => {
    const owed = r.balance_cents > 0
    const status = !owed ? (r.written_off_cents > 0 ? pill('quiet', 'alert', 'Written off') : r.paid_on ? pill('good', 'paid', `Paid ${dayText(r.paid_on)}`) : pill('good', 'paid', 'Credited'))
      : r.daysOverdue > 0 ? pill(r.daysOverdue > 30 ? 'bad' : 'warn', r.daysOverdue > 30 ? 'warn' : 'clock', `${plural(r.daysOverdue, 'day')} overdue`)
      : pill('quiet', 'clock', `Due ${dayText(r.due_date)}`)
    const method = r.method ? METHODS[r.method] : null
    return h`<tr${r.customer_id === focus && owed ? raw(' class="focus"') : ''}>
      <td data-label="Customer"><a href="/app/customers/${r.customer_id}">${r.customer_name}</a><span class="sub">${placeOf(r.address ?? '') || '—'}</span>${r.id === lead ? h`<a class="jump" href="#decide">${jump}</a>` : ''}</td>
      <td data-label="Invoice"><a class="mono" href="/app/invoices/${r.id}">${r.number}</a></td>
      <td data-label="Amount" class="num">${money(owed ? r.balance_cents : r.total_cents)}${owed && r.balance_cents !== r.total_cents ? h`<span class="sub">of ${money(r.total_cents)}</span>` : ''}</td>
      <td data-label="Method"${method ? '' : raw(' data-empty')}>${method ? h`<span class="chip">${icon(method[1])}${method[0]}</span>` : ''}</td>
      <td data-label="Status">${status}</td>
      <td data-label="Due">${owed ? dayText(r.due_date) : h`<span class="sub-dash">—</span>`}</td>
      <td class="row-menu">${tooltipLink(`/app/invoices/${r.id}`,`Open invoice ${r.number}`,`invoice-tip-${r.id}`,icon('more'))}</td></tr>`
  }
  return h`<section class="card ledger-card" aria-label="Invoices"><div class="table-wrap ledger"><table><thead><tr><th scope="col">Customer</th><th scope="col">Invoice</th><th scope="col" class="num">Amount</th><th scope="col">Method</th><th scope="col">Status</th><th scope="col">Due</th><th scope="col"><span class="sr">Open</span></th></tr></thead><tbody>${rows.map(row)}</tbody></table></div></section>`
}

const factRows = (facts: [string, unknown][]) => h`<dl class="fact-rows">${facts.map(([term, value]) => h`<div><dt>${term}</dt><dd>${value}</dd></div>`)}</dl>`

async function decision(env: Bindings, actor: Actor, desk: Desk, drafts: any[], chosen: string | null): Promise<{ panel: Html; focus: string | null; shown?: string }> {
  const operator = can(actor, 'receivables'), person = actor.kind === 'member'
  if (chosen === 'none') return { panel: h``, focus: null }
  const notice = drafts.find(n => n.id === chosen) ?? drafts[0]
  if (notice) {
    const ids: string[] = JSON.parse(notice.invoice_ids)
    const owed = desk.open.filter(r => ids.includes(r.id))
    const oldest = owed.reduce((worst: any, r: any) => !worst || r.daysOverdue > worst.daysOverdue ? r : worst, null)
    const contacts = await all(env, 'SELECT name, email, role FROM nc_contacts WHERE customer_id = ? ORDER BY created_at', notice.customer_id)
    const customer = (await all(env, 'SELECT billing_email, address FROM nc_customers WHERE id = ?', notice.customer_id))[0] ?? {}
    const options = [{ email: customer.billing_email, label: 'Billing email', from: 'on the customer record' }, ...contacts.filter(c => c.email !== customer.billing_email).map(c => ({ email: c.email, label: `${c.name}, ${c.role}`, from: 'billing contact' }))].filter(o => o.email)
    const known = options.some(o => o.email === notice.recipient)
    const choice = (value: string, label: string, sub: unknown, checked: boolean) => h`<label class="choice"><input type="radio" name="recipient" value="${value}"${checked ? raw(' checked') : ''}><span>${label}<span class="sub">${sub}</span></span></label>`
    const decide = operator && person ? h`${form('reminder.approve', '/app/receivables', h`${hidden('notice', notice.id)}
        <fieldset class="choices"><legend>Who should get this reminder?</legend>${options.map(o => choice(o.email, o.label, addresses(`${o.email} (${o.from})`), o.email === notice.recipient))}
          ${choice('other', 'Another address', 'Type it below', !known)}${field('Other address', 'recipient_other', { type: 'email', value: known ? '' : notice.recipient, required: false })}</fieldset>
        <div class="mail"><p class="mail-head">Message to ${notice.customer_name}</p>${field('Subject', 'subject', { value: notice.subject })}${area('Message', 'body', notice.body, true, 9)}</div>`, 'Approve recipient and wording', { layout: 'decide-form', primary: true })}
      ${form('reminder.discard', '/app/receivables', hidden('notice', notice.id), 'Discard draft', { secondary: true, layout: 'discard-form' })}`
      : h`<div class="mail"><p class="mail-head">To ${addresses(notice.recipient)}</p><p><strong>${notice.subject}</strong></p><pre class="message">${notice.body}</pre></div>`
    return {
      focus: notice.customer_id, shown: notice.id,
      panel: h`<aside class="decision" aria-labelledby="decide"><div class="decision-head"><div><h2 id="decide">${notice.customer_name}</h2><p class="sub">${placeOf(customer.address ?? '') || 'Reminder draft'}</p></div>${tooltipLink('/app/receivables?draft=none','Close the panel','close-reminder-panel',icon('close'),'Close panel')}</div>
        <p class="banner">${icon('alert')}<span>Reminder drafted by ${personName(actor, notice.created_by)}: ${money(notice.balance_cents)} ${oldest ? `is ${plural(oldest.daysOverdue, 'day')} past due` : 'past due'}.</span></p>
        ${factRows([['Invoice', owed.map(r => r.number).join(', ') || '—'], ['Amount', money(notice.balance_cents)], ['Due date', oldest ? dayText(oldest.due_date, true) : '—']])}
        ${decide}<p class="hint panel-hint">Nectar exports the approved message for you to send from your own mail; it never sends it. Amounts and due dates stay as invoiced.</p></aside>`,
    }
  }
  const late = desk.open.filter(r => r.daysOverdue > 0)
  if (!late.length) return { focus: null, panel: h`<aside class="decision quiet" aria-labelledby="decide"><span class="empty-art">${icon('paid')}</span><h2 id="decide">Nothing past due</h2><p class="hint">When an invoice passes its due date, its customer appears here with a reminder to draft.</p></aside>` }
  const worst = late.reduce((a, b) => b.daysOverdue > a.daysOverdue ? b : a)
  const theirs = late.filter(r => r.customer_id === worst.customer_id)
  const total = theirs.reduce((sum, r) => sum + r.balance_cents, 0)
  return {
    focus: worst.customer_id,
    panel: h`<aside class="decision" aria-labelledby="decide"><div class="decision-head"><div><h2 id="decide">${worst.customer_name}</h2><p class="sub">${placeOf(worst.address ?? '') || 'Past due'}</p></div>${tooltipLink('/app/receivables?draft=none','Close the panel','close-overdue-panel',icon('close'),'Close panel')}</div>
      <p class="banner">${icon('alert')}<span>${money(total)} is ${plural(worst.daysOverdue, 'day')} past due on ${plural(theirs.length, 'invoice')}.</span></p>
      ${factRows([['Invoice', theirs.map(r => r.number).join(', ')], ['Amount', money(total)], ['Due date', dayText(worst.due_date, true)]])}
      <p class="hint">Nectar drafts the reminder from these balances; you approve the recipient and wording before anything is exported.</p>
      ${operator ? form('reminder.prepare', '/app/receivables', hidden('customer', worst.customer_id), 'Draft reminder', { primary: true }) : ''}</aside>`,
  }
}

export async function receivablesPage(env: Bindings, actor: Actor, url: URL) {
  // Reminder drafts and follow-up tasks show to the roles that handle them (GOV-001).
  const handles = can(actor, 'read') || can(actor, 'receivables')
  const [desk, age, pays, noticeList, todo, people] = await Promise.all([receivablesDesk(env, actor), ageing(env, actor), payments(env, actor), handles ? notices(env, actor) : [], handles ? tasks(env, actor) : [], customers(env, actor)])
  const operator = can(actor, 'receivables')
  const transfers=await unmatchedProcessorCash(env,actor)
  const drafts = noticeList.filter((n: any) => n.status === 'draft')
  const pending = (await all(env, "SELECT COUNT(*) AS n FROM nc_proposals WHERE status = 'pending'"))[0]?.n ?? 0
  const { panel, focus, shown } = await decision(env, actor, desk, drafts, url.searchParams.get('draft'))
  const waiting = [drafts.length && `${drafts.length === 1 ? `${personName(actor, drafts[0].created_by)} drafted a reminder to ${drafts[0].customer_name}` : `${drafts.length} reminder drafts are ready`}`, pending && `${plural(pending, 'proposal')} ${pending === 1 ? 'waits' : 'wait'} for a decision`].filter(Boolean)
  const asks = drafts.length + pending
  const strip = h`<section class="assurance" aria-label="Nectar assurance"><img src="/brand/mark.svg" alt="" width="34" height="34"><p><b>Nectar assurance:</b> ${desk.open.length + desk.settled.length ? `every balance below equals its invoice less credits and payments` : 'balances appear here once invoices are issued'}${waiting.length ? `; ${waiting.join(', and ')}.` : '. Nothing is waiting for a decision.'}</p>${asks ? h`<a class="ask-pill" href="${drafts.length ? '#decide' : '/app/proposals'}">${asks} ${asks === 1 ? 'change needs' : 'changes need'} your approval</a>` : ''}</section>`
  const subline = desk.issueMonth ? `${plural(desk.issued, `${monthText(desk.issueMonth)} invoice`)}, ${desk.paid} paid, ${desk.issued - desk.paid} open` : 'No invoices issued yet'
  const others = noticeList.filter((n: any) => n.status !== 'discarded' && n.id !== shown)
  // GOV-001: report and cadence links show only to members who can open them.
  const toReport = (href: string, content: unknown) => canRead(actor, 'reports') ? h`<a href="${href}">${content}</a>` : h`${content}`
  const main = h`<div class="desk-main"><h1>Receivables</h1><p><a href="/app/processor-events">Processor reconciliation</a></p>${handles ? h`<p><a href="/app/cadences">Collections cadences and collection holds</a></p>` : ''}${canRead(actor, 'reports') ? h`<p><a href="/app/reports/ar">Open AR report</a></p>` : ''}<p class="lede">${subline}</p>${strip}
    <dl class="tiles"><div><dt>Owed</dt><dd>${toReport('/app/reports/ar', money(desk.owedCents))}</dd></div><div${desk.overdueCents ? raw(' class="hot"') : ''}><dt>Overdue</dt><dd>${toReport('/app/reports/ar?bucket=overdue', money(desk.overdueCents))}</dd></div><div><dt>Collected in ${monthText(desk.month)}</dt><dd>${toReport(`/app/reports/collections?period=${desk.month}`, money(desk.collectedCents))}</dd></div></dl>
    ${ledger(desk, focus, shown ? 'Review the reminder' : operator ? 'Draft a reminder' : 'See what is past due')}
    <section class="ask" aria-label="Agents">${icon('sparkle')}<p>Your own agent can draft reminders and proposals here through a <b>prepare</b> credential. A person approves each one.</p>${actor.role === 'owner' ? h`<a href="/app/access#agents">Agent credentials</a>` : ''}</section></div>`
  const rest = h`<div class="desk-rest"><section class="card"><h2>Unapplied bank transfers</h2>${table(['Received','Sender','Reference','Amount','Return limit',''],transfers.map(row=>[formatDate(new Date(row.occurred_at).toISOString().slice(0,10)),row.sender||'Not supplied',row.reference||'No reference',cents(row.amount_cents),`${row.ageDays} days old · ${row.daysLeft} days left`,h`<a href="/app/processor-events?customer=${row.customer_id}#${row.id}">Review transfer</a>`]))}</section><section class="card" aria-labelledby="ageing"><h2 id="ageing">Ageing on ${formatDate(age.asOf)}</h2>
      ${table(['Customer', 'Not yet due$', '1–30 days$', '31–60 days$', '61–90 days$', 'Over 90$', 'Owed$', ''], age.customers.map((c: any) => [h`<a href="/app/customers/${c.customer}">${c.name}</a>`, ...BUCKETS.map(b => toReport(`/app/reports/ar?customer=${c.customer}&bucket=${encodeURIComponent(b)}`, cents(c[b]))), toReport(`/app/reports/ar?customer=${c.customer}`, cents(c.total)),
        operator && c.oldest > 0 ? form('reminder.prepare', '/app/receivables', hidden('customer', c.customer), 'Draft reminder', { secondary: true }) : '']), { empty: 'Nothing is owed.' })}
      ${age.customers.length ? h`<p class="hint">Total owed ${toReport('/app/reports/ar', cents((age.totals as any).total))}, of which ${toReport('/app/reports/ar?bucket=overdue', cents((age.totals as any).total - (age.totals as any).current))} is past due.</p>` : ''}</section>
    <section class="card" aria-labelledby="reminders"><h2 id="reminders">Reminders</h2><p class="hint">Nectar drafts reminders and exports approved ones for you to send from your own mail. It never sends them.</p>
      ${others.length ? others.map((n: any) => h`<article class="notice"><h3>${n.customer_name} — ${cents(n.balance_cents)} ${tag(n.status === 'draft' ? 'Draft' : n.status === 'approved' ? 'Approved' : 'Exported')}</h3>
        ${n.status === 'draft' ? h`<p><a class="go" href="/app/receivables?draft=${n.id}#decide">Review this draft</a></p>`
        : h`<p><strong>To:</strong> ${addresses(n.recipient)}<br><strong>Subject:</strong> ${n.subject}</p><pre class="message">${n.body}</pre><p><a class="download" href="/app/notices/${n.id}.txt">Download message</a> <span class="sub">Approved by ${who(actor, n.approved_by)}</span></p>`}</article>`) : h`<p class="empty">No other reminders. Draft one from the ageing table when an invoice is past due.</p>`}</section>
    <section class="card" aria-labelledby="tasks"><h2 id="tasks">Follow-up tasks</h2>
      ${table(['Task', 'Customer', 'Due', 'Status', ''], todo.map((t: any) => [t.title, t.customer_name, formatDate(t.due_date), tag(t.status === 'open' ? 'Open' : 'Done'), t.status === 'open' && operator && actor.kind === 'member' ? form('task.complete', '/app/receivables', h`${hidden('task', t.id)}${field('Outcome', 'outcome')}`, 'Mark done', { layout: 'row-form', secondary: true }) : t.outcome ?? '']), { empty: 'No follow-up tasks.' })}
      ${operator && people.length ? form('task.create', '/app/receivables', h`${select('Customer', 'customer', people.map((c: any) => ({ value: c.id, label: c.name })), people[0].id)}${field('Task', 'title')}${field('Due', 'due_date', { type: 'date' })}`, 'Add task', { layout: 'columns', secondary: true }) : ''}</section>
    ${await remittancesPanel(env, actor, url)}<section class="card" aria-labelledby="payments"><h2 id="payments">Payments received</h2><p class="hint">Record money that arrived outside Nectar (bank transfer, check, card taken elsewhere) with its reference, then allocate it on the invoice.</p>
      ${table(['Customer', 'Received', 'Method', 'Reference', 'Amount$', 'Unallocated$'], pays.map((p: any) => [p.customer_name, formatDate(p.received_on), METHODS[p.method]?.[0] ?? p.method, p.reference, cents(p.amount_cents), cents(p.unallocated_cents)]), { empty: 'No payments recorded.' })}
      ${operator && people.length ? form('payment.record', '/app/receivables', h`${select('Customer', 'customer', people.map((c: any) => ({ value: c.id, label: c.name })), people[0].id)}${field('Amount ($)', 'amount')}${field('Received on', 'received_on', { type: 'date' })}
        ${select('Method', 'method', [{ value: 'bank_transfer', label: 'Bank transfer' }, { value: 'check', label: 'Check' }, { value: 'card_external', label: 'Card (taken outside Nectar)' }, { value: 'other', label: 'Other' }], 'bank_transfer')}${field('Reference', 'reference', { hint: 'The bank or remittance reference; it must be unique per customer.' })}${field('Evidence note', 'evidence', { required: false })}`, 'Record payment', { layout: 'columns' }) : ''}</section></div>`
  return page('Receivables', actor, h`<div class="desk${panel.html ? '' : ' alone'}">${main}${panel}${rest}</div>`, { current: '/app/receivables', url })
}
