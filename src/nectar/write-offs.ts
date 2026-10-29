// AR-004: a person with approval writes off an uncollectable balance. The saved
// request holds the exact balance, amount, reason and bad-debt journal effect;
// above the owner's GOV-002 limit a different authorized person executes it.
// Execution reduces the invoice balance (issued evidence is never edited), saves
// the journal posting in the same transaction and stops collection. A recovery
// pairs a recorded payment allocation with the write-off it reverses.
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, requireRead, type Actor } from './actor'
import { UNALLOCATED_SQL, issuedInvoice } from './receivables'
import { BALANCE_SQL } from './balance-sql'
import { all, canonical, commit, fingerprint, guard, insist, newId, one, parseJson, stmt, type Row } from './core'
import { clockInstant } from './clock'
import { creditPolicy } from './credit-policy'
import { cents } from './decimal'
import type { Input } from './input'
import { ledgerPostingView, postingStatement, postLedgerEntry, type LedgerPosting } from './ledger-postings'
import { BAD_DEBT_ACCOUNT, RECEIVABLE_ACCOUNT, type JournalLine } from './ledger/quickbooks'
import { requireFreshFactor } from './mfa'

const docNumber = (prefix: string, id: string) => `${prefix}-${id.replaceAll('-', '').slice(0, 16)}`
const entry = (amountCents: number, recovery: boolean): JournalLine[] => recovery
  ? [{ side: 'debit', account: RECEIVABLE_ACCOUNT, amountCents, customer: true }, { side: 'credit', account: BAD_DEBT_ACCOUNT, amountCents }]
  : [{ side: 'debit', account: BAD_DEBT_ACCOUNT, amountCents }, { side: 'credit', account: RECEIVABLE_ACCOUNT, amountCents, customer: true }]

/** The accounting effect saved with the request: what the approver is approving. */
async function accountingEffect(invoice: Row, amountCents: number) {
  const route = parseJson<Row>(invoice.billing_route_json, {})
  return { ledger: 'quickbooks-online', companyRef: typeof route.ledgerCompanyRef === 'string' ? route.ledgerCompanyRef : null, entityId: route.entityId ?? null, invoice: invoice.number, amountCents, entries: entry(amountCents, false) }
}
const basisOf = (invoice: Row, policy: Row, effect: unknown, amount: number, reason: string) => fingerprint({ invoice: invoice.id, balanceCents: invoice.balance_cents, totalCents: invoice.total_cents, amount, reason, effect, policyRevision: policy.revision, threshold: policy.two_person_above_cents })
const above = (policy: Row, amount: number) => policy.two_person_above_cents !== null && amount > policy.two_person_above_cents
const activeMember = (env: Bindings, id: string) => guard(env, 'forbidden', "EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active')", id)

async function source(env: Bindings, actor: Actor, invoiceId: string, amountText: string, reasonText: string) {
  requireMember(actor, 'approve')
  await requireFreshFactor(env, actor)
  const invoice = await issuedInvoice(env, invoiceId)
  const amount = cents(amountText)
  insist(amount > 0, 'invalid_amount')
  insist(amount <= invoice.balance_cents, 'exceeds_balance', 409)
  const customer = await one(env, 'SELECT * FROM nc_customers WHERE id=?', invoice.customer_id)
  insist(customer && !customer.erased_at, 'customer_not_found', 404)
  const policy = await creditPolicy(env), effect = await accountingEffect(invoice, amount)
  return { invoice, amount, reason: reasonText, policy, effect, customer, basis: await basisOf(invoice, policy, effect, amount, reasonText) }
}
const policyGuard = (env: Bindings, policy: Row) => guard(env, 'credit_policy_changed', 'COALESCE((SELECT revision FROM nc_credit_policy WHERE singleton=1),0)=?', policy.revision)
const balanceGuard = (env: Bindings, invoiceId: string, balance: number) => guard(env, 'write_off_stale', `(SELECT ${BALANCE_SQL} FROM nc_invoices i WHERE i.id=? AND i.status='issued')=?`, invoiceId, balance)

/** Execution statements shared by the direct door and the approved request. */
async function executeStatements(env: Bindings, actor: Actor, id: string, s: Awaited<ReturnType<typeof source>>, mode: 'single-person' | 'two-person', saved: boolean) {
  const at = clockInstant(env)
  const postingId = newId(), posting = postingStatement(env, { id: postingId, kind: 'bad_debt', sourceId: id, writeOffId: id, invoiceId: s.invoice.id, customerId: s.invoice.customer_id,
    entityId: s.effect.entityId, companyRef: s.effect.companyRef, amountCents: s.amount, lines: entry(s.amount, false), docNumber: docNumber('WO', id) })
  return { postingId, statements: [
    policyGuard(env, s.policy), activeMember(env, actor.id), balanceGuard(env, s.invoice.id, s.invoice.balance_cents),
    guard(env, 'customer_erased', 'EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND erased_at IS NULL)', s.invoice.customer_id),
    ...(saved
      ? [guard(env, 'write_off_not_pending', "EXISTS(SELECT 1 FROM nc_write_offs WHERE id=? AND status='pending')", id),
         ...(mode === 'two-person' ? [guard(env, 'second_approver_required', 'EXISTS(SELECT 1 FROM nc_write_offs WHERE id=? AND prepared_by_id<>?)', id, actor.id)] : []),
         stmt(env, "UPDATE nc_write_offs SET status='executed',approved_by_id=?,approved_name=?,approved_at=?,approval_mode=? WHERE id=? AND status='pending'", actor.id, actorLabel(actor), at, mode, id)]
      : [stmt(env, "INSERT INTO nc_write_offs(id,invoice_id,customer_id,amount_cents,reason,effect_json,balance_cents,basis,policy_revision,prepared_by_id,prepared_name,prepared_at,status,approved_by_id,approved_name,approved_at,approval_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'executed',?,?,?,?)",
          id, s.invoice.id, s.invoice.customer_id, s.amount, s.reason, canonical(s.effect), s.invoice.balance_cents, s.basis, s.policy.revision, actor.id, actorLabel(actor), at, actor.id, actorLabel(actor), at, mode)]),
    posting,
  ] }
}

const audit = (actor: Actor, id: string, s: Awaited<ReturnType<typeof source>>, mode: string, prepared: string, postingId: string) =>
  ({ actor: actorLabel(actor), action: 'writeoff.execute', subject: id, detail: { invoice: s.invoice.number, amount: s.amount, balanceBefore: s.invoice.balance_cents, reason: s.reason, effect: s.effect, preparedBy: prepared, approvedBy: actorLabel(actor), approval: mode, posting: postingId } })

async function finish(env: Bindings, actor: Actor, id: string, postingId: string, invoiceId: string) {
  const posting = await postLedgerEntry(env, actor, postingId)
  return { id: invoiceId, writeOff: id, posting: { id: posting.id, status: posting.status, error: posting.error } }
}

/** Direct execution: allowed only at or below the owner's two-person limit. */
export async function issueWriteOff(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const s = await source(env, actor, input.text('invoice', { max: 100 }), input.text('amount', { max: 20 }), input.text('reason', { max: 500 }))
  insist(!above(s.policy, s.amount), 'second_approver_required', 409)
  const id = newId(), run = await executeStatements(env, actor, id, s, 'single-person', false)
  await commit(env, run.statements, audit(actor, id, s, 'single-person', actorLabel(actor), run.postingId))
  return await finish(env, actor, id, run.postingId, s.invoice.id)
}

export async function prepareWriteOff(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const s = await source(env, actor, input.text('invoice', { max: 100 }), input.text('amount', { max: 20 }), input.text('reason', { max: 500 }))
  const id = newId()
  await commit(env, [policyGuard(env, s.policy), activeMember(env, actor.id), balanceGuard(env, s.invoice.id, s.invoice.balance_cents),
    stmt(env, "INSERT INTO nc_write_offs(id,invoice_id,customer_id,amount_cents,reason,effect_json,balance_cents,basis,policy_revision,prepared_by_id,prepared_name,prepared_at,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'pending')",
      id, s.invoice.id, s.invoice.customer_id, s.amount, s.reason, canonical(s.effect), s.invoice.balance_cents, s.basis, s.policy.revision, actor.id, actorLabel(actor), clockInstant(env))],
  { actor: actorLabel(actor), action: 'writeoff.prepare', subject: id, detail: { invoice: s.invoice.number, amount: s.amount, balance: s.invoice.balance_cents, reason: s.reason, effect: s.effect, basis: s.basis, policyRevision: s.policy.revision } })
  return { id: s.invoice.id, request: id }
}

/** Execution of a saved request: above the limit its approver is a different person. */
export async function approveWriteOff(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const request = await one(env, 'SELECT * FROM nc_write_offs WHERE id=?', input.text('request', { max: 100 }))
  insist(request, 'write_off_request_not_found', 404)
  insist(request.status === 'pending', 'write_off_already_executed', 409)
  const s = await source(env, actor, request.invoice_id, (request.amount_cents / 100).toFixed(2), request.reason)
  insist(s.invoice.balance_cents === request.balance_cents && s.basis === request.basis && s.policy.revision === request.policy_revision, 'write_off_stale', 409)
  const different = request.prepared_by_id !== actor.id
  insist(different || !above(s.policy, s.amount), 'second_approver_required', 409)
  const mode = different ? 'two-person' : 'single-person', run = await executeStatements(env, actor, request.id, s, mode, true)
  await commit(env, run.statements, audit(actor, request.id, s, mode, request.prepared_name, run.postingId))
  return await finish(env, actor, request.id, run.postingId, s.invoice.id)
}

/** A later recovery is recorded against the write-off: money in, bad debt reversed in the ledger. */
export async function recoverWriteOff(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  await requireFreshFactor(env, actor)
  const writeOff = await one(env, "SELECT w.*,COALESCE((SELECT SUM(amount_cents) FROM nc_write_off_recoveries WHERE write_off_id=w.id),0) AS recovered_cents FROM nc_write_offs w WHERE w.id=? AND w.status='executed'", input.text('write_off', { max: 100 }))
  insist(writeOff, 'write_off_not_found', 404)
  const payment = await one(env, `SELECT p.*,${UNALLOCATED_SQL} AS unallocated FROM nc_payments p WHERE p.id=?`, input.text('payment', { max: 100 }))
  insist(payment, 'payment_not_found', 404)
  insist(!await one(env, 'SELECT 1 FROM nc_remittances WHERE payment_id=?', payment.id), 'remittance_confirmation_required', 409)
  insist(payment.customer_id === writeOff.customer_id, 'different_customer', 409)
  const amount = cents(input.text('amount', { max: 20 }))
  insist(amount > 0, 'invalid_amount')
  insist(amount <= payment.unallocated, 'exceeds_payment', 409)
  insist(amount <= writeOff.amount_cents - writeOff.recovered_cents, 'exceeds_write_off', 409)
  const invoice = await one(env, 'SELECT number FROM nc_invoices WHERE id=?', writeOff.invoice_id)
  const id = newId(), allocation = newId(), postingId = newId(), at = clockInstant(env)
  const effect = parseJson<Row>(writeOff.effect_json, {})
  await commit(env, [
    activeMember(env, actor.id),
    guard(env, 'exceeds_payment', `(SELECT ${UNALLOCATED_SQL} FROM nc_payments p WHERE p.id=?)>=?`, payment.id, amount),
    guard(env, 'customer_erased', 'EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND erased_at IS NULL)', writeOff.customer_id),
    stmt(env, 'INSERT INTO nc_allocations(id,payment_id,invoice_id,amount_cents,allocated_by,allocated_at) VALUES(?,?,?,?,?,?)', allocation, payment.id, writeOff.invoice_id, amount, actorLabel(actor), at),
    stmt(env, 'INSERT INTO nc_write_off_recoveries(id,write_off_id,invoice_id,customer_id,payment_id,allocation_id,amount_cents,recorded_by,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)', id, writeOff.id, writeOff.invoice_id, writeOff.customer_id, payment.id, allocation, amount, actorLabel(actor), at),
    postingStatement(env, { id: postingId, kind: 'bad_debt_recovery', sourceId: id, writeOffId: writeOff.id, invoiceId: writeOff.invoice_id, customerId: writeOff.customer_id, entityId: effect.entityId ?? null,
      companyRef: effect.companyRef ?? null, amountCents: amount, lines: entry(amount, true), docNumber: docNumber('WR', id) }),
  ], { actor: actorLabel(actor), action: 'writeoff.recover', subject: id, detail: { writeOff: writeOff.id, invoice: invoice?.number, payment: payment.reference, amount, posting: postingId } })
  const posting = await postLedgerEntry(env, actor, postingId)
  return { id: writeOff.invoice_id, recovery: id, writeOff: writeOff.id, posting: { id: posting.id, status: posting.status, error: posting.error } }
}

export interface WriteOffView { id: string; invoice: string; invoiceNumber: string; customer: string; amountCents: number; reason: string; status: string; balanceCents: number; effect: Row; preparedBy: string; preparedAt: number
  approvedBy: string | null; approvedAt: number | null; approval: string | null; recoveredCents: number; netCents: number; recoveries: Row[]; postings: LedgerPosting[] }

/** Callers authorize with invoice reads. Statuses and amounts only; ledger error text is a code. */
export async function writeOffsFor(env: Bindings, invoiceId?: string): Promise<WriteOffView[]> {
  const rows = await all(env, `SELECT w.*,i.number AS invoice_number FROM nc_write_offs w JOIN nc_invoices i ON i.id=w.invoice_id ${invoiceId ? 'WHERE w.invoice_id=?' : ''} ORDER BY w.prepared_at,w.id`, ...(invoiceId ? [invoiceId] : []))
  const recoveries = await all(env, `SELECT r.*,p.reference FROM nc_write_off_recoveries r JOIN nc_payments p ON p.id=r.payment_id ${invoiceId ? 'WHERE r.invoice_id=?' : ''} ORDER BY r.recorded_at,r.id`, ...(invoiceId ? [invoiceId] : []))
  const postings = await all(env, `SELECT * FROM nc_ledger_postings ${invoiceId ? 'WHERE invoice_id=?' : ''} ORDER BY created_at,id`, ...(invoiceId ? [invoiceId] : []))
  return rows.map(row => {
    const mine = recoveries.filter(r => r.write_off_id === row.id), recovered = mine.reduce((n, r) => n + r.amount_cents, 0)
    return { id: row.id, invoice: row.invoice_id, invoiceNumber: row.invoice_number, customer: row.customer_id, amountCents: row.amount_cents, reason: row.reason, status: row.status, balanceCents: row.balance_cents,
      effect: parseJson<Row>(row.effect_json, {}), preparedBy: row.prepared_name, preparedAt: row.prepared_at, approvedBy: row.approved_name, approvedAt: row.approved_at, approval: row.approval_mode,
      recoveredCents: recovered, netCents: row.status === 'executed' ? row.amount_cents - recovered : 0,
      recoveries: mine.map(r => ({ id: r.id, payment: r.payment_id, reference: r.reference, amountCents: r.amount_cents, recordedBy: r.recorded_by, recordedAt: r.recorded_at })),
      postings: postings.filter(p => p.write_off_id === row.id).map(ledgerPostingView) }
  })
}

export async function writeOffList(env: Bindings, actor: Actor, invoiceId?: string) {
  requireRead(actor, 'invoices')
  return { writeOffs: await writeOffsFor(env, invoiceId) }
}
