import { collectionPlan } from './proposals'
import { collectionProposerGuards } from './collection-diagnosis'
import { requireUsdCurrency,requireUsdReporting } from './currency'
// Flow 12: ageing of open balances, reminder drafts and follow-up tasks.
// A reminder records the balances it states; it is approved by a person only
// while those balances still hold, and approval exports it for the operator
// to send from their own mail. The separate AR-001 cadence door sends through
// the configured mail adapter; this manual door never marks a message sent.
import type { Bindings } from '../auth.server'
import { requireAny, requireRead, actorLabel, requireCapability, requireMember, type Actor } from './actor'
import { requireBusiness } from './business'
import { all, canonical, commit, guard, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import { money } from './decimal'
import { addDays, daysBetween, formatDate, requireDate, today } from './dates'
import type { Input } from './input'
import { openInvoices } from './receivables'
import { collectionHold } from './cadence-holds'
import { cadenceSourceGuard, cadenceSourceSequence } from './cadence-policy'
import { clockInstant } from './clock'

export const BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'] as const
const bucket = (overdue: number) => overdue <= 0 ? 'current' : overdue <= 30 ? '1-30' : overdue <= 60 ? '31-60' : overdue <= 90 ? '61-90' : '90+'

export async function ageing(env: Bindings, actor: Actor) {
  requireRead(actor, 'invoices')
  await requireUsdReporting(env)
  const business = await requireBusiness(env)
  const day = today(business.timezone, clockInstant(env))
  const rows = (await openInvoices(env)).map((row): Row => ({ ...row, daysOverdue: Math.max(0, daysBetween(row.due_date, day)), bucket: bucket(daysBetween(row.due_date, day)) }))
  const customers = new Map<string, Row>()
  for (const row of rows) {
    const entry = customers.get(row.customer_id) ?? { customer: row.customer_id, name: row.customer_name, ...Object.fromEntries(BUCKETS.map(b => [b, 0])), total: 0, oldest: 0 }
    entry[row.bucket] += row.balance_cents; entry.total += row.balance_cents; entry.oldest = Math.max(entry.oldest, row.daysOverdue)
    customers.set(row.customer_id, entry)
  }
  const totals = Object.fromEntries([...BUCKETS, 'total'].map(key => [key, [...customers.values()].reduce((sum, entry) => sum + entry[key], 0)]))
  return { asOf: day, invoices: rows, customers: [...customers.values()].sort((a, b) => b.oldest - a.oldest), totals }
}

/** The facts a reminder states: overdue invoices and their balances now, plus recent payment evidence. */
export async function reminderBasis(env: Bindings, customerId: string) {
  const business = await requireBusiness(env)
  const day = today(business.timezone, clockInstant(env))
  const customer = await one(env, "SELECT id, name, billing_email, revision FROM nc_customers WHERE id = ? AND status='active' AND erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=nc_customers.id)", customerId)
  insist(customer, 'customer_not_found', 404)
  await requireUsdCurrency(env,{customerId})
  const candidates = (await openInvoices(env, customerId)).filter(row => row.due_date < day)
  const overdue = (await Promise.all(candidates.map(async row => {
    const held = await collectionHold(env, row.id)
    return { id: row.id, number: row.number, sourceFingerprint: row.source_fingerprint, dueDate: row.due_date, balanceCents: held.collectibleCents, daysOverdue: daysBetween(row.due_date, day),
      invoiceBalanceCents: row.balance_cents, disputedCents: held.disputedCents, holdBasis: held.basis, paused: held.paused }
  }))).filter(row => !row.paused && row.balanceCents > 0)
  const recentPayments = (await all(env, 'SELECT reference, amount_cents, received_on FROM nc_payments WHERE customer_id = ? ORDER BY received_on DESC LIMIT 3', customerId)).map(row => ({ reference: row.reference, amountCents: row.amount_cents, receivedOn: row.received_on }))
  return { business, customer, day, overdue, recentPayments, balanceCents: overdue.reduce((sum, row) => sum + row.balanceCents, 0) }
}

export function reminderDraft(basis: Awaited<ReturnType<typeof reminderBasis>>) {
  const oldest = Math.max(0, ...basis.overdue.map(row => row.daysOverdue))
  const stage = oldest > 60 ? 'final' : oldest > 30 ? 'firm' : 'friendly'
  const list = basis.overdue.map(row => `- Invoice ${row.number}, due ${formatDate(row.dueDate)}: ${money(row.balanceCents)} ${row.disputedCents ? `collectible; ${money(row.disputedCents)} disputed and excluded` : 'outstanding'}`).join('\n')
  const paid = basis.recentPayments.length ? `\n\nWe have recorded these recent payments, thank you: ${basis.recentPayments.map(row => `${money(row.amountCents)} on ${formatDate(row.receivedOn)} (ref ${row.reference})`).join('; ')}.` : ''
  const opening = stage === 'friendly' ? 'This is a friendly reminder that the following invoice(s) are past due:' : stage === 'firm' ? 'Our records show the following invoice(s) are more than 30 days past due:' : 'The following invoice(s) are more than 60 days past due and need your attention now:'
  return {
    stage,
    subject: `${stage === 'final' ? 'Final reminder' : 'Reminder'}: ${money(basis.balanceCents)} past due to ${basis.business.legal_name}`,
    body: `Hello ${basis.customer.name},\n\n${opening}\n\n${list}\n\nTotal past due: ${money(basis.balanceCents)}.${paid}\n\nIf you have already paid, please reply with the payment reference so we can match it.\n\n${basis.business.legal_name}`,
  }
}

export const basisKey = (basis: Awaited<ReturnType<typeof reminderBasis>>) => canonical(basis.overdue.map(row => [row.id, row.balanceCents, row.holdBasis]))

export async function prepareReminder(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'receivables')
  const seq = await cadenceSourceSequence(env)
  const basis = await reminderBasis(env, input.text('customer', { max: 100 }))
  insist(basis.overdue.length, 'nothing_overdue', 409)
  const draft = reminderDraft(basis)
  const id = newId()
  await commit(env, [cadenceSourceGuard(env,seq),stmt(env, "INSERT INTO nc_notices (id, customer_id, invoice_ids, balance_cents, recipient, subject, body, basis, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)",
    id, basis.customer.id, JSON.stringify(basis.overdue.map(row => row.id)), basis.balanceCents, basis.customer.billing_email, draft.subject, draft.body, basisKey(basis), actorLabel(actor), now())],
  { actor: actorLabel(actor), action: 'reminder.prepare', subject: id, detail: { customer: basis.customer.id, balance: basis.balanceCents, stage: draft.stage } })
  return { id, notice: id }
}

/** A person approves the exact recipient and wording; balances must be unchanged since the draft. A follow-up task is opened. */
export async function approveReminder(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'receivables')
  const seq = await cadenceSourceSequence(env)
  const notice = await one(env, 'SELECT * FROM nc_notices WHERE id = ?', input.text('notice', { max: 100 }))
  insist(notice, 'notice_not_found', 404)
  insist(notice.status === 'draft', 'already_decided', 409)
  // The page offers the customer's known addresses as choices, or 'other' with the address typed beside it.
  const chosen = input.text('recipient', { max: 200 })
  const recipient = (chosen === 'other' ? input.text('recipient_other', { max: 200 }) : chosen).toLowerCase()
  insist(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient), 'invalid_recipient')
  const subject = input.text('subject', { max: 200 }), body = input.text('body', { max: 8000 })
  const basis = await reminderBasis(env, notice.customer_id)
  insist(basisKey(basis) === notice.basis, 'balances_changed', 409)
  const at = now()
  await commit(env, [
    cadenceSourceGuard(env,seq),
    guard(env, 'stale', "EXISTS(SELECT 1 FROM nc_notices WHERE id = ? AND status = 'draft')", notice.id),
    stmt(env, "UPDATE nc_notices SET recipient = ?, subject = ?, body = ?, status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?", recipient, subject, body, actorLabel(actor), at, notice.id),
    stmt(env, "INSERT INTO nc_tasks (id, customer_id, invoice_id, title, due_date, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)",
      newId(), notice.customer_id, parseJson<string[]>(notice.invoice_ids, [])[0] ?? null, `Follow up on the reminder to ${recipient}`, addDays(basis.day, 7), actorLabel(actor), at),
  ], { actor: actorLabel(actor), action: 'reminder.approve', subject: notice.id, detail: { recipient, subject, balance: notice.balance_cents } })
  return { id: notice.id, status: 'approved' }
}

export async function discardReminder(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'receivables')
  const notice = await one(env, 'SELECT * FROM nc_notices WHERE id = ?', input.text('notice', { max: 100 }))
  insist(notice && notice.status === 'draft', 'notice_not_found', 404)
  await commit(env, [stmt(env, "UPDATE nc_notices SET status = 'discarded' WHERE id = ? AND status = 'draft'", notice.id)], { actor: actorLabel(actor), action: 'reminder.discard', subject: notice.id })
  return { id: notice.id }
}

/** The approved reminder as a plain-text message file the operator sends themselves. */
export async function exportReminder(env: Bindings, actor: Actor, id: string) {
  requireCapability(actor, 'receivables')
  const seq = await cadenceSourceSequence(env)
  const notice = await one(env, 'SELECT * FROM nc_notices WHERE id = ?', id)
  insist(notice, 'notice_not_found', 404)
  insist(notice.status === 'approved' || notice.status === 'exported', 'not_approved', 409)
  insist(basisKey(await reminderBasis(env, notice.customer_id)) === notice.basis, 'balances_changed', 409)
  let proposalGuards: D1PreparedStatement[] = []
  if (notice.proposal_id) {
    const proposal = await one(env, 'SELECT * FROM nc_proposals WHERE id=?', notice.proposal_id)
    insist(proposal?.status === 'approved', 'proposal_stale', 409)
    const saved = parseJson<Row>(proposal.basis_json, {})
    const current = await collectionPlan(env, parseJson<Row>(proposal.payload_json, {}))
    insist(canonical(current.basis) === canonical(saved), 'proposal_stale', 409)
    proposalGuards = await collectionProposerGuards(env, proposal)
  }
  if (notice.status === 'approved') await commit(env, [cadenceSourceGuard(env,seq),...proposalGuards,stmt(env, "UPDATE nc_notices SET status = 'exported', exported_at = ? WHERE id = ? AND status = 'approved'", now(), id)], { actor: actorLabel(actor), action: 'reminder.export', subject: id })
  const text = `To: ${notice.recipient}\nSubject: ${notice.subject}\n\n${notice.body}\n`
  return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="reminder-${id.slice(0, 8)}.txt"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } })
}

export async function notices(env: Bindings, actor: Actor) {
  requireAny(actor, ['read', 'receivables'])
  return await all(env, 'SELECT n.*, c.name AS customer_name FROM nc_notices n JOIN nc_customers c ON c.id = n.customer_id ORDER BY n.created_at DESC LIMIT 100')
}

export async function tasks(env: Bindings, actor: Actor) {
  requireAny(actor, ['read', 'receivables'])
  return await all(env, "SELECT t.*, c.name AS customer_name, i.number AS invoice_number FROM nc_tasks t JOIN nc_customers c ON c.id = t.customer_id LEFT JOIN nc_invoices i ON i.id = t.invoice_id ORDER BY t.status DESC, t.due_date LIMIT 200")
}

export async function createTask(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'receivables')
  const customer = await one(env, 'SELECT id FROM nc_customers WHERE id = ?', input.text('customer', { max: 100 }))
  insist(customer, 'customer_not_found', 404)
  const invoice = input.text('invoice', { max: 100, optional: true }) || null
  if (invoice) insist(await one(env, "SELECT 1 FROM nc_invoices WHERE id = ? AND customer_id = ? AND status = 'issued'", invoice, customer.id), 'invoice_not_found', 404)
  const id = newId()
  await commit(env, [stmt(env, "INSERT INTO nc_tasks (id, customer_id, invoice_id, title, due_date, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)", id, customer.id, invoice, input.text('title', { max: 200 }), requireDate(input.text('due_date', { max: 10 }), 'due_date'), actorLabel(actor), now())],
    { actor: actorLabel(actor), action: 'task.create', subject: id })
  return { id }
}

export async function completeTask(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'receivables')
  const task = await one(env, 'SELECT * FROM nc_tasks WHERE id = ?', input.text('task', { max: 100 }))
  insist(task, 'task_not_found', 404)
  insist(task.status === 'open', 'already_done', 409)
  const outcome = input.text('outcome', { max: 1000 })
  await commit(env, [stmt(env, "UPDATE nc_tasks SET status = 'done', done_by = ?, done_at = ?, outcome = ? WHERE id = ? AND status = 'open'", actorLabel(actor), now(), outcome, task.id)], { actor: actorLabel(actor), action: 'task.complete', subject: task.id, detail: { outcome } })
  return { id: task.id }
}
