// A threshold is checked inside every credit issue, including direct API calls.
import type { Bindings } from '../auth.server'
import { actorLabel, requireCapability, requireMember, requireOwner, type Actor } from './actor'
import { all, commit, fingerprint, guard, insist, newId, now, one, stmt, type Row } from './core'
import { cents } from './decimal'
import type { Input } from './input'

export async function creditPolicy(env: Bindings) {
  return await one(env, 'SELECT * FROM nc_credit_policy WHERE singleton=1') ?? { two_person_above_cents: null, revision: 0 }
}

export async function configureCreditPolicy(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  const text = input.text('two_person_above', { max: 20, optional: true })
  const limit = text ? cents(text, 'two_person_above') : null
  await commit(env, [stmt(env, 'INSERT INTO nc_credit_policy (singleton,two_person_above_cents,revision,changed_by,changed_at) VALUES (1,?,1,?,?) ON CONFLICT(singleton) DO UPDATE SET two_person_above_cents=excluded.two_person_above_cents,revision=revision+1,changed_by=excluded.changed_by,changed_at=excluded.changed_at', limit, actorLabel(actor), now())],
    { actor: actorLabel(actor), action: 'credit.policy', subject: 'business', detail: { twoPersonAboveCents: limit } })
  return await creditPolicy(env)
}

export const creditBasis = (invoice: Row, policy: Row) => fingerprint({ invoice: invoice.id, balanceCents: invoice.balance_cents, totalCents: invoice.total_cents, policyRevision: policy.revision, threshold: policy.two_person_above_cents })

export async function creditRequests(env: Bindings, actor: Actor, invoice: string) {
  requireCapability(actor, 'read')
  return await all(env, 'SELECT * FROM nc_credit_requests WHERE invoice_id=? ORDER BY prepared_at DESC,id', invoice)
}

export async function prepareCreditRequest(env: Bindings, actor: Actor, input: Input, invoice: Row) {
  requireMember(actor, 'approve')
  const policy = await creditPolicy(env)
  const amount = cents(input.text('amount', { max: 20 }))
  insist(amount > 0 && amount <= invoice.balance_cents, 'exceeds_balance', 409)
  const reason = input.text('reason', { max: 500 })
  const id = newId(), basis = await creditBasis(invoice, policy)
  await commit(env, [
    guard(env, 'credit_policy_changed', 'COALESCE((SELECT revision FROM nc_credit_policy WHERE singleton=1),0)=?', policy.revision),
    stmt(env, 'INSERT INTO nc_credit_requests (id,invoice_id,amount_cents,reason,prepared_by,prepared_name,prepared_at,basis,policy_revision,balance_cents) VALUES (?,?,?,?,?,?,?,?,?,?)', id, invoice.id, amount, reason, actor.id, actorLabel(actor), now(), basis, policy.revision, invoice.balance_cents),
  ], { actor: actorLabel(actor), action: 'credit.prepare', subject: id, detail: { invoice: invoice.id, amount, reason, basis, policyRevision: policy.revision } })
  return { id: invoice.id, request: id }
}

/** Returns in-transaction guards and the saved request to close on issue. */
export async function authorizeCredit(env: Bindings, actor: Actor, input: Input, invoice: Row, amount: number, reason: string) {
  const policy = await creditPolicy(env)
  const above = policy.two_person_above_cents !== null && amount > policy.two_person_above_cents
  const request = input.has('request') ? await one(env, 'SELECT * FROM nc_credit_requests WHERE id=?', input.text('request', { max: 100 })) : null
  insist(!input.has('request') || request, 'credit_request_not_found', 404)
  insist(!above || request, 'second_approver_required', 409)
  if (request) {
    insist(request.status === 'pending', 'credit_request_already_issued', 409)
    insist(request.invoice_id === invoice.id && request.amount_cents === amount && request.reason === reason, 'credit_request_changed', 409)
    insist(request.basis === await creditBasis(invoice, policy), 'credit_request_stale', 409)
    insist(!above || request.prepared_by !== actor.id, 'second_approver_required', 409)
  }
  return { request, guards: [
    guard(env, 'credit_policy_changed', 'COALESCE((SELECT revision FROM nc_credit_policy WHERE singleton=1),0)=?', policy.revision),
    ...(request ? [guard(env, 'credit_request_already_issued', "EXISTS(SELECT 1 FROM nc_credit_requests WHERE id=? AND status='pending')", request.id),
      guard(env, 'credit_request_stale', '(SELECT i.total_cents-COALESCE((SELECT SUM(amount_cents) FROM nc_credit_notes WHERE invoice_id=i.id),0)-COALESCE((SELECT SUM(amount_cents) FROM nc_allocations WHERE invoice_id=i.id),0) FROM nc_invoices i WHERE i.id=?)=?', invoice.id, request.balance_cents)] : []),
  ] }
}
