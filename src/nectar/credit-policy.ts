// A threshold is checked inside every credit issue, including direct API calls.
import type { Bindings } from '../auth.server'
import { actorLabel, can, requireAny, requireMember, requireOwner, requireRead, type Actor } from './actor'
import { all, commit, fingerprint, guard, insist, newId, now, one, stmt, type Row } from './core'
import { BALANCE_SQL } from './balance-sql'
import { cents } from './decimal'
import { preparePolicyChange } from './policy-changes'
import type { Input } from './input'
import { requireFreshFactor } from './mfa'

export async function creditPolicy(env: Bindings) {
  return await one(env, 'SELECT * FROM nc_credit_policy WHERE singleton=1') ?? { two_person_above_cents: null, support_limit_cents: 0, balance_application: 'manual', revision: 0 }
}

/** GOV-001: the most a support credit may be, zero until the owner sets one. */
export const supportLimitCents = (policy: Row) => Number(policy.support_limit_cents ?? 0)

export async function configureCreditPolicy(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  const text = input.text('two_person_above', { max: 20, optional: true })
  const limit = text ? cents(text, 'two_person_above') : null
  const current = await creditPolicy(env)
  const supportText = input.text('support_limit', { max: 20, optional: true })
  const support = supportText ? cents(supportText, 'support_limit') : supportText === '' ? 0 : supportLimitCents(current)
  // GOV-007: changing the support role's credit limit asks for a fresh factor.
  if (support !== supportLimitCents(current)) await requireFreshFactor(env, actor)
  const application = input.text('balance_application', { max: 10, optional: true }) || current.balance_application
  insist(application === 'manual' || application === 'automatic', 'invalid_balance_application')
  return await preparePolicyChange(env, actor, 'credit', { twoPersonAboveCents: limit, supportLimitCents: support, balanceApplication: application })
}

export const creditBasis = (invoice: Row, policy: Row) => fingerprint({ invoice: invoice.id, balanceCents: invoice.balance_cents, totalCents: invoice.total_cents, policyRevision: policy.revision, threshold: policy.two_person_above_cents })

export async function creditRequests(env: Bindings, actor: Actor, invoice: string) {
  requireRead(actor, 'invoices')
  return await all(env, 'SELECT * FROM nc_credit_requests WHERE invoice_id=? ORDER BY prepared_at DESC,id', invoice)
}

/** Build preparation and its guards so proposal binding can share the same commit. */
export async function creditRequestStatements(env: Bindings, actor: Actor, input: Input, invoice: Row) {
  requireMember(actor, 'approve')
  const policy = await creditPolicy(env)
  const amount = cents(input.text('amount', { max: 20 }))
  insist(invoice.status === 'issued', 'invoice_not_issued', 409)
  insist(amount > 0 && amount <= invoice.balance_cents, 'exceeds_balance', 409)
  const reason = input.text('reason', { max: 500 })
  const id = newId(), basis = await creditBasis(invoice, policy)
  return { request: id, result: { id: invoice.id, request: id }, statements: [
    guard(env, 'credit_policy_changed', 'COALESCE((SELECT revision FROM nc_credit_policy WHERE singleton=1),0)=?', policy.revision),
    guard(env, 'credit_request_stale', `(SELECT ${BALANCE_SQL} FROM nc_invoices i WHERE i.id=? AND status='issued')=?`, invoice.id, invoice.balance_cents),
    stmt(env, 'INSERT INTO nc_credit_requests (id,invoice_id,amount_cents,reason,prepared_by,prepared_name,prepared_at,basis,policy_revision,balance_cents) VALUES (?,?,?,?,?,?,?,?,?,?)', id, invoice.id, amount, reason, actor.id, actorLabel(actor), now(), basis, policy.revision, invoice.balance_cents),
  ], audits: [{ actor: actorLabel(actor), action: 'credit.prepare', subject: id, detail: { invoice: invoice.id, amount, reason, basis, policyRevision: policy.revision } }] }
}

export async function prepareCreditRequest(env: Bindings, actor: Actor, input: Input, invoice: Row) {
  const prepared = await creditRequestStatements(env, actor, input, invoice)
  await commit(env, prepared.statements, prepared.audits)
  return prepared.result
}

/** Returns in-transaction guards and the saved request to close on issue. */
export async function authorizeCredit(env: Bindings, actor: Actor, input: Input, invoice: Row, amount: number, reason: string, proposalId?: string,cancellationId?:string) {
  const policy = await creditPolicy(env)
  // GOV-001: a member without approval issues only bounded support credits,
  // never above the owner-set limit and never through a saved request.
  const bounded = !can(actor, 'approve')
  if (bounded) {
    requireAny(actor, ['credits.limited'])
    insist(!input.has('request') && !proposalId, 'forbidden', 403)
    insist(amount <= supportLimitCents(policy), 'exceeds_support_limit', 403)
  }
  // GOV-007: credits above the support limit ask for a fresh factor.
  if (amount > supportLimitCents(policy)) await requireFreshFactor(env, actor)
  const above = policy.two_person_above_cents !== null && amount > policy.two_person_above_cents
  const request = input.has('request') ? await one(env, 'SELECT * FROM nc_credit_requests WHERE id=?', input.text('request', { max: 100 })) : null
  insist(!input.has('request') || request, 'credit_request_not_found', 404)
  insist(!above || request, 'second_approver_required', 409)
  if (request) {
    const binding = await one(env, 'SELECT proposal_id FROM nc_credit_correction_requests WHERE request_id=?', request.id)
    insist(!binding || binding.proposal_id === proposalId, 'credit_request_proposal_bound', 409)
    const cancellation=await one(env,'SELECT cancellation_id FROM nc_interval_cancel_requests WHERE request_id=?',request.id)
    insist(!cancellation||cancellation.cancellation_id===cancellationId,'credit_request_cancellation_bound',409)
    insist(request.status === 'pending', 'credit_request_already_issued', 409)
    insist(request.invoice_id === invoice.id && request.amount_cents === amount && request.reason === reason, 'credit_request_changed', 409)
    insist(request.basis === await creditBasis(invoice, policy), 'credit_request_stale', 409)
    insist(!above || request.prepared_by !== actor.id, 'second_approver_required', 409)
  }
  return { request, guards: [
    guard(env, 'credit_policy_changed', 'COALESCE((SELECT revision FROM nc_credit_policy WHERE singleton=1),0)=?', policy.revision),
    ...(bounded ? [guard(env, 'forbidden', "EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active')", actor.id)] : []),
    ...(request ? [guard(env, 'credit_request_already_issued', "EXISTS(SELECT 1 FROM nc_credit_requests WHERE id=? AND status='pending')", request.id),
      guard(env, 'credit_request_proposal_bound', 'NOT EXISTS(SELECT 1 FROM nc_credit_correction_requests WHERE request_id=? AND proposal_id<>?)', request.id, proposalId ?? ''),
      guard(env,'credit_request_cancellation_bound','NOT EXISTS(SELECT 1 FROM nc_interval_cancel_requests WHERE request_id=? AND cancellation_id<>?)',request.id,cancellationId??''),
      guard(env, 'credit_request_stale', `(SELECT ${BALANCE_SQL} FROM nc_invoices i WHERE i.id=?)=?`, invoice.id, request.balance_cents)] : []),
  ] }
}
