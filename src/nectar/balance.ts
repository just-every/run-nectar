// INV-006: the customer credit balance. Cash overpayments (a payment's
// unallocated amount), goodwill grants and carried correction credits sit on a
// balance that applies to invoices (goodwill first, then the oldest cash) and
// whose cash part can be returned. Grants and returns follow the owner's GOV-002
// limit: above it a different authorized person executes the saved request.
// Nectar sends no money: a return records the outbound transfer the business made.
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, requireRead, type Actor } from './actor'
import { BALANCE_SQL } from './balance-sql'
import { clockInstant } from './clock'
import { all, commit, fingerprint, guard, insist, newId, one, stmt, type Row } from './core'
import { creditPolicy } from './credit-policy'
import { cents } from './decimal'
import { Input } from './input'
import { requireFreshFactor } from './mfa'
import { UNALLOCATED_SQL, issuedInvoice } from './receivables'
import { carriedUsageCredits } from './usage-correction-records'
import { CREDIT_KIND } from './assurance-credits'
import { PAID_KIND } from './assurance-paid-access'
import { assuranceExecution } from './assurance'

const GRANT_REMAINING_SQL = `g.amount_cents - COALESCE((SELECT SUM(a.amount_cents) FROM nc_balance_entries a WHERE a.grant_id=g.id),0)`

export async function balanceSources(env: Bindings, customerId: string) {
  const payments = (await all(env, `SELECT p.id,p.reference,p.received_on,p.amount_cents,(SELECT r.id FROM nc_remittances r WHERE r.payment_id=p.id) AS remittance_id,${UNALLOCATED_SQL} AS unallocated FROM nc_payments p WHERE p.customer_id=? ORDER BY p.received_on,p.id`, customerId)).filter(row => row.unallocated > 0)
  const grants = (await all(env, `SELECT g.*,${GRANT_REMAINING_SQL} AS remaining FROM nc_balance_entries g WHERE g.kind='goodwill' AND g.customer_id=? ORDER BY g.created_at,g.id`, customerId)).filter(row => row.remaining > 0)
  const carried = await carriedUsageCredits(env, customerId)
  const cashCents = payments.reduce((n, row) => n + row.unallocated, 0), goodwillCents = grants.reduce((n, row) => n + row.remaining, 0), carriedCents = carried.reduce((n, row) => n + row.availableCents, 0)
  const queuedCashCents = payments.filter(row => row.remittance_id).reduce((sum,row) => sum + row.unallocated,0)
  return { payments, grants, carried, cashCents, queuedCashCents, goodwillCents, carriedCents, totalCents: cashCents + goodwillCents + carriedCents }
}

/** Goodwill applies first, then the oldest cash, never more than the invoice owes. */
export function applicationPlan(sources: Awaited<ReturnType<typeof balanceSources>>, owedCents: number) {
  let left = Math.max(0, owedCents)
  const take = (rows: Row[], field: string) => rows.flatMap(row => { const amount = Math.min(left, row[field]); left -= amount; return amount ? [{ id: row.id as string, amount }] : [] })
  return { grants: take(sources.grants, 'remaining'), payments: take(sources.payments.filter(row => !row.remittance_id), 'unallocated') }
}

export function applicationStatements(env: Bindings, plan: ReturnType<typeof applicationPlan>, invoice: { id: string; customer_id: string }, by: string, at: number) {
  return [
    ...plan.grants.map(grant => stmt(env, "INSERT INTO nc_balance_entries(id,customer_id,kind,amount_cents,grant_id,invoice_id,mode,created_by,created_at) VALUES(?,?,'application',?,?,?,'goodwill',?,?)", newId(), invoice.customer_id, grant.amount, grant.id, invoice.id, by, at)),
    ...plan.payments.flatMap(payment => { const allocation = newId(); return [
      guard(env, 'exceeds_payment', `(SELECT ${UNALLOCATED_SQL} FROM nc_payments p WHERE p.id=?)>=?`, payment.id, payment.amount),
      stmt(env, 'INSERT INTO nc_allocations(id,payment_id,invoice_id,amount_cents,allocated_by,allocated_at) VALUES(?,?,?,?,?,?)', allocation, payment.id, invoice.id, payment.amount, by, at),
      stmt(env, "INSERT INTO nc_balance_entries(id,customer_id,kind,amount_cents,payment_id,invoice_id,mode,created_by,created_at) VALUES(?,?,'application',?,?,?,'cash',?,?)", newId(), invoice.customer_id, payment.amount, payment.id, invoice.id, by, at)] }),
  ]
}

/** Applied automatically when an invoice issues, if the owner's policy is automatic. */
export async function issueApplicationStatements(env: Bindings, invoice: Row, carriedCents: number) {
  if ((await creditPolicy(env)).balance_application !== 'automatic') return []
  const plan = applicationPlan(await balanceSources(env, invoice.customer_id), invoice.total_cents - carriedCents)
  return applicationStatements(env, plan, invoice as { id: string; customer_id: string }, 'balance:automatic', clockInstant(env))
}

/** The manual door: apply the available balance to one issued invoice. */
export async function applyBalance(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const invoice = await issuedInvoice(env, input.text('invoice', { max: 100 }))
  insist(invoice.balance_cents > 0, 'invoice_already_settled', 409)
  const plan = applicationPlan(await balanceSources(env, invoice.customer_id), invoice.balance_cents)
  insist(plan.grants.length || plan.payments.length, 'no_balance_available', 409)
  const applied = [...plan.grants, ...plan.payments].reduce((n, row) => n + row.amount, 0)
  const linked = await assuranceExecution(env, actor, input, CREDIT_KIND, proof => proof.customer === invoice.customer_id && proof.invoices.some((i: Row) => i.invoice === invoice.id))
  await commit(env, [
    guard(env, 'invoice_changed', `(SELECT ${BALANCE_SQL} FROM nc_invoices i WHERE i.id=?)=?`, invoice.id, invoice.balance_cents),
    ...(linked?.guards ?? []),
    ...applicationStatements(env, plan, invoice as { id: string; customer_id: string }, actorLabel(actor), clockInstant(env)),
  ], { actor: actorLabel(actor), action: 'balance.apply', subject: invoice.id, detail: { invoice: invoice.number, applied, goodwill: plan.grants.length, cash: plan.payments.length, ...(linked ? { assuranceCase: linked.case } : {}) } })
  return { id: invoice.id, appliedCents: applied }
}

// ---- governed grants and returns -------------------------------------------------
type Kind = 'goodwill' | 'return'
async function source(env: Bindings, actor: Actor, input: Input, kind: Kind) {
  requireMember(actor, 'approve')
  await requireFreshFactor(env, actor)
  const customer = await one(env, 'SELECT * FROM nc_customers WHERE id=?', input.text('customer', { max: 100 }))
  insist(customer && !customer.erased_at, 'customer_not_found', 404)
  const amount = cents(input.text('amount', { max: 20 }))
  insist(amount > 0, 'invalid_amount')
  const reason = input.text('reason', { max: 500 })
  let payment: Row | null = null, reference: string | null = null, available = 0
  if (kind === 'return') {
    payment = await one(env, `SELECT p.*,${UNALLOCATED_SQL} AS unallocated FROM nc_payments p WHERE p.id=? AND p.customer_id=?`, input.text('payment', { max: 100 }), customer.id)
    insist(payment, 'payment_not_found', 404)
    insist(amount <= payment.unallocated, 'exceeds_balance', 409)
    reference = input.text('reference', { max: 120 })
    available = payment.unallocated
  }
  const policy = await creditPolicy(env)
  const basis = await fingerprint({ kind, customer: customer.id, amount, reason, payment: payment?.id ?? null, reference, available, policyRevision: policy.revision, threshold: policy.two_person_above_cents })
  return { kind, customer, amount, reason, payment, reference, available, policy, basis }
}
const above = (policy: Row, amount: number) => policy.two_person_above_cents !== null && amount > policy.two_person_above_cents
type Source = Awaited<ReturnType<typeof source>>
const activeMember = (env: Bindings, id: string) => guard(env, 'forbidden', "EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active')", id)
const policyGuard = (env: Bindings, policy: Row) => guard(env, 'credit_policy_changed', 'COALESCE((SELECT revision FROM nc_credit_policy WHERE singleton=1),0)=?', policy.revision)
const cashGuard = (env: Bindings, s: Source) => s.payment ? [guard(env, 'balance_stale', `(SELECT ${UNALLOCATED_SQL} FROM nc_payments p WHERE p.id=?)=?`, s.payment.id, s.available)] : []

function entryStatement(env: Bindings, s: Source, requestId: string, by: string, at: number) {
  return s.kind === 'goodwill'
    ? stmt(env, "INSERT INTO nc_balance_entries(id,customer_id,kind,amount_cents,request_id,created_by,created_at) VALUES(?,?,'goodwill',?,?,?,?)", newId(), s.customer.id, s.amount, requestId, by, at)
    : stmt(env, "INSERT INTO nc_balance_entries(id,customer_id,kind,amount_cents,payment_id,request_id,created_by,created_at) VALUES(?,?,'return',?,?,?,?,?)", newId(), s.customer.id, s.amount, s.payment!.id, requestId, by, at)
}
const audit = (actor: Actor, id: string, s: Source, mode: string, preparedBy: string) => ({ actor: actorLabel(actor), action: `balance.${s.kind}`, subject: id,
  detail: { customer: s.customer.id, amount: s.amount, reason: s.reason, payment: s.payment?.reference ?? null, reference: s.reference, approval: mode, preparedBy, approvedBy: actorLabel(actor) } })

async function direct(env: Bindings, actor: Actor, input: Input, kind: Kind) {
  requireMember(actor, 'approve')
  const s = await source(env, actor, input, kind)
  insist(!above(s.policy, s.amount), 'second_approver_required', 409)
  // Only a single-person goodwill grant can name an assurance case: paid service that ended is credited back to the balance.
  insist(kind === 'goodwill' || !input.has('assurance_case'), 'assurance_fix_kind_unsupported', 409)
  const linked = kind === 'goodwill' ? await assuranceExecution(env, actor, input, PAID_KIND, proof => proof.customer === s.customer.id && s.amount <= proof.remainingCents) : null
  const id = newId(), at = clockInstant(env), by = actorLabel(actor)
  await commit(env, [policyGuard(env, s.policy), activeMember(env, actor.id), ...cashGuard(env, s), ...(linked?.guards ?? []),
    stmt(env, "INSERT INTO nc_balance_requests(id,kind,customer_id,amount_cents,reason,payment_id,reference,basis,policy_revision,available_cents,prepared_by_id,prepared_name,prepared_at,status,approved_by_id,approved_name,approved_at,approval_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'executed',?,?,?,'single-person')",
      id, kind, s.customer.id, s.amount, s.reason, s.payment?.id ?? null, s.reference, s.basis, s.policy.revision, s.available, actor.id, by, at, actor.id, by, at),
    entryStatement(env, s, id, by, at)], linked ? { ...audit(actor, id, s, 'single-person', by), detail: { ...audit(actor, id, s, 'single-person', by).detail, assuranceCase: linked.case } } : audit(actor, id, s, 'single-person', by))
  return { id: s.customer.id, request: id }
}
export const grantGoodwill = (env: Bindings, actor: Actor, input: Input) => direct(env, actor, input, 'goodwill')
export const returnBalance = (env: Bindings, actor: Actor, input: Input) => direct(env, actor, input, 'return')

export async function prepareBalanceRequest(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  insist(!input.has('assurance_case'), 'assurance_fix_kind_unsupported', 409)
  const kind = input.text('kind', { max: 10 })
  insist(kind === 'goodwill' || kind === 'return', 'invalid_balance_kind')
  const s = await source(env, actor, input, kind)
  const id = newId()
  await commit(env, [policyGuard(env, s.policy), activeMember(env, actor.id), ...cashGuard(env, s),
    stmt(env, "INSERT INTO nc_balance_requests(id,kind,customer_id,amount_cents,reason,payment_id,reference,basis,policy_revision,available_cents,prepared_by_id,prepared_name,prepared_at,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')",
      id, kind, s.customer.id, s.amount, s.reason, s.payment?.id ?? null, s.reference, s.basis, s.policy.revision, s.available, actor.id, actorLabel(actor), clockInstant(env))],
  { actor: actorLabel(actor), action: 'balance.prepare', subject: id, detail: { kind, customer: s.customer.id, amount: s.amount, payment: s.payment?.reference ?? null, reference: s.reference, basis: s.basis } })
  return { id: s.customer.id, request: id }
}

export async function approveBalanceRequest(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const request = await one(env, 'SELECT * FROM nc_balance_requests WHERE id=?', input.text('request', { max: 100 }))
  insist(request, 'balance_request_not_found', 404)
  insist(request.status === 'pending', 'balance_request_already_executed', 409)
  const s = await sourceFromRequest(env, actor, request)
  insist(s.basis === request.basis, 'balance_request_stale', 409)
  const different = request.prepared_by_id !== actor.id
  insist(different || !above(s.policy, s.amount), 'second_approver_required', 409)
  const mode = different ? 'two-person' : 'single-person', at = clockInstant(env), by = actorLabel(actor)
  await commit(env, [policyGuard(env, s.policy), activeMember(env, actor.id), ...cashGuard(env, s),
    guard(env, 'balance_request_already_executed', "EXISTS(SELECT 1 FROM nc_balance_requests WHERE id=? AND status='pending')", request.id),
    ...(mode === 'two-person' ? [guard(env, 'second_approver_required', 'EXISTS(SELECT 1 FROM nc_balance_requests WHERE id=? AND prepared_by_id<>?)', request.id, actor.id)] : []),
    stmt(env, "UPDATE nc_balance_requests SET status='executed',approved_by_id=?,approved_name=?,approved_at=?,approval_mode=? WHERE id=? AND status='pending'", actor.id, by, at, mode, request.id),
    entryStatement(env, s, request.id, by, at)], audit(actor, request.id, s, mode, request.prepared_name))
  return { id: request.customer_id, request: request.id }
}

async function sourceFromRequest(env: Bindings, actor: Actor, request: Row): Promise<Source> {
  return source(env, actor, Input.of({ customer: request.customer_id, amount: (request.amount_cents / 100).toFixed(2), reason: request.reason, ...(request.payment_id ? { payment: request.payment_id, reference: request.reference } : {}) }), request.kind)
}

/** The customer's balance with its own ledger, for the customer record and the JSON door. */
export async function balanceView(env: Bindings, actor: Actor, customerId: string) {
  requireRead(actor, 'payments')
  const sources = await balanceSources(env, customerId)
  const requests = await all(env, 'SELECT * FROM nc_balance_requests WHERE customer_id=? ORDER BY prepared_at,id', customerId)
  const entries = await all(env, "SELECT e.*,i.number AS invoice_number,p.reference AS payment_reference FROM nc_balance_entries e LEFT JOIN nc_invoices i ON i.id=e.invoice_id LEFT JOIN nc_payments p ON p.id=e.payment_id WHERE e.customer_id=? ORDER BY e.created_at,e.id", customerId)
  const receipts = await all(env, `SELECT p.id,p.reference,p.received_on,p.amount_cents,${UNALLOCATED_SQL} AS unallocated FROM nc_payments p WHERE p.customer_id=? ORDER BY p.received_on,p.id`, customerId)
  const allocations = await all(env, 'SELECT a.*,i.number AS invoice_number,p.reference FROM nc_allocations a JOIN nc_invoices i ON i.id=a.invoice_id JOIN nc_payments p ON p.id=a.payment_id WHERE p.customer_id=? ORDER BY a.allocated_at,a.id', customerId)
  const ledger = [
    ...receipts.map(p => ({ at: p.received_on, kind: 'receipt', amountCents: p.amount_cents, reference: p.reference, id: p.id })),
    ...allocations.map(a => ({ at: a.allocated_at, kind: 'allocation', amountCents: a.amount_cents, invoice: a.invoice_number, reference: a.reference, id: a.id })),
    ...entries.filter(e => !(e.kind === 'application' && e.mode === 'cash')).map(e => ({ at: e.created_at, kind: e.kind, amountCents: e.amount_cents, mode: e.mode, invoice: e.invoice_number, reference: e.payment_reference, id: e.id })),
  ]
  const { payments: _p, grants: _g, carried: _c, ...totals } = sources
  return { customer: customerId, ...totals, payments: sources.payments.map(p => ({ id: p.id, reference: p.reference, unallocatedCents: p.unallocated })), grants: sources.grants.map(g => ({ id: g.id, remainingCents: g.remaining })), carriedCredits: sources.carried.map(c => ({ id: c.id, number: c.number, availableCents: c.availableCents })),
    requests: requests.map(r => ({ id: r.id, kind: r.kind, amountCents: r.amount_cents, reason: r.reason, status: r.status, preparedBy: r.prepared_name, approvedBy: r.approved_name, approval: r.approval_mode, payment: r.payment_id, reference: r.reference, availableCents: r.available_cents })),
    entries: entries.map(e => ({ id: e.id, kind: e.kind, amountCents: e.amount_cents, mode: e.mode, invoice: e.invoice_id, payment: e.payment_id, grant: e.grant_id, request: e.request_id, createdBy: e.created_by })), ledger }
}
