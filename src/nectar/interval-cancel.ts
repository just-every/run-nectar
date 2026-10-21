// CAT-001 inherits SUB-003: preserve issued originals and govern the exact
// unused-service credit, including paid service carried as customer liability.
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, type Actor } from './actor'
import { requireBusiness } from './business'
import { all, commit, guard, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import { authorizeCredit, creditBasis, creditPolicy } from './credit-policy'
import { clockInstant } from './clock'
import { localDate } from './dates'
import { Input } from './input'
import { documentNumberAllocation } from './invoice-numbering'
import { cancellationPlan } from './interval-cancel-plan'
import { lifecyclePolicy } from './lifecycle-policy'
import { issuedInvoice } from './receivables'
import { REVENUE_POLICY_VERSION } from './revenue-allocation'
import { requireSubscription } from './subscriptions'

export interface CancellationTransition {
  id: string; date: string; reason: string; mode: string; requested: string; policy: Row
}

export function cancellationIssuedGuard(env: Bindings, subscription: string, date: string, invoices: string[]) {
  return guard(env, 'cancellation_stale', "NOT EXISTS(SELECT 1 FROM nc_invoices WHERE subscription_id=? AND status='issued' AND period_end>? AND id NOT IN (SELECT value FROM json_each(?)))", subscription, date, JSON.stringify(invoices))
}

export function cancellationTransitionStatements(env: Bindings, author: { id: string; name: string }, sub: Row, term: Row | null, transition: CancellationTransition) {
  const { id, date, reason, mode, requested, policy } = transition, at = now()
  return [
    guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND revision=?)', sub.id, sub.revision),
    guard(env, 'policy_changed', 'COALESCE((SELECT revision FROM nc_lifecycle_policy WHERE singleton=1),0)=?', policy.revision),
    ...(term ? [guard(env, 'stale', "EXISTS(SELECT 1 FROM nc_renewal_terms WHERE id=? AND revision=? AND status='active' AND cancelled_at IS NULL)", term.id, term.revision)] : []),
    stmt(env, "INSERT INTO nc_subscription_lifecycle (id,subscription_id,kind,effective_date,access,reason,author_id,author,created_at,policy_json) VALUES (?,?,'cancel',?,'suspend',?,?,?,?,?)", id, sub.id, date, reason, author.id, author.name, at, JSON.stringify({ ...policy, mode, requested })),
    stmt(env, 'UPDATE nc_subscriptions SET end_date=?,revision=?,updated_at=? WHERE id=?', date, newId(), at, sub.id),
    ...(term ? [stmt(env, 'UPDATE nc_renewal_terms SET auto_renew=0,cancelled_at=?,token_hash=NULL,revision=? WHERE id=?', at, newId(), term.id)] : []),
  ]
}

export async function prepareIntervalCancellation(env: Bindings, actor: Actor, sub: Row, term: Row | null, transition: CancellationTransition, plan: Awaited<ReturnType<typeof cancellationPlan>>) {
  requireMember(actor, 'approve')
  if (!plan.credits.length) return null
  const policy = await creditPolicy(env), id = newId(), at = now()
  const saved = { plan, transition, subscriptionRevision: sub.revision, termRevision: term?.revision ?? null, creditPolicyRevision: policy.revision }
  const statements = [
    cancellationIssuedGuard(env, sub.id, transition.date, plan.invoices),
    guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND revision=?)', sub.id, sub.revision),
    guard(env, 'policy_changed', 'COALESCE((SELECT revision FROM nc_lifecycle_policy WHERE singleton=1),0)=?', transition.policy.revision),
    guard(env, 'credit_policy_changed', 'COALESCE((SELECT revision FROM nc_credit_policy WHERE singleton=1),0)=?', policy.revision),
    stmt(env, 'INSERT INTO nc_interval_cancellations(id,subscription_id,customer_id,effective_date,reason,transition_id,plan_json,basis,prepared_by,prepared_name,prepared_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, sub.id, sub.customer_id, transition.date, transition.reason, transition.id, JSON.stringify(saved), plan.fingerprint, actor.id, actorLabel(actor), at),
  ]
  for (const credit of plan.credits) {
    const invoice = await issuedInvoice(env, credit.invoice), request = newId()
    statements.push(
      guard(env, 'credit_request_stale', '(SELECT COUNT(*) FROM nc_credit_notes WHERE invoice_id=?)=0', invoice.id),
      stmt(env, 'INSERT INTO nc_credit_requests(id,invoice_id,amount_cents,reason,prepared_by,prepared_name,prepared_at,basis,policy_revision,balance_cents) VALUES(?,?,?,?,?,?,?,?,?,?)', request, invoice.id, credit.amountCents, transition.reason, actor.id, actorLabel(actor), at, await creditBasis(invoice, policy), policy.revision, invoice.balance_cents),
      stmt(env, 'INSERT INTO nc_interval_cancel_requests(request_id,cancellation_id,invoice_id,customer_id) VALUES(?,?,?,?)', request, id, invoice.id, sub.customer_id))
  }
  await commit(env, statements, { actor: actorLabel(actor), action: 'subscription.cancel.prepare', subject: id, detail: { subscription: sub.id, date: transition.date, reason: transition.reason, plan } })
  return { id: sub.id, cancellation: id, status: 'pending', endDate: transition.date, credits: plan.credits, amountCents: plan.amountCents }
}

export async function decideIntervalCancellation(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const id = input.text('cancellation', { max: 100 }), decision = input.text('decision', { max: 10 })
  insist(decision === 'approved' || decision === 'rejected', 'invalid_decision')
  const row = await one(env, 'SELECT * FROM nc_interval_cancellations WHERE id=?', id)
  insist(row, 'cancellation_not_found', 404)
  insist(row.status === 'pending', 'cancellation_already_decided', 409)
  const pending = guard(env, 'cancellation_already_decided', "EXISTS(SELECT 1 FROM nc_interval_cancellations WHERE id=? AND status='pending')", id)
  if (decision === 'rejected') {
    await commit(env, [pending, stmt(env, "UPDATE nc_interval_cancellations SET status='rejected',decided_by=?,decided_at=? WHERE id=?", actorLabel(actor), now(), id)], { actor: actorLabel(actor), action: 'subscription.cancel.reject', subject: id })
    return { id: row.subscription_id, cancellation: id, status: 'rejected' }
  }
  const saved = parseJson<Row>(row.plan_json, {}), sub = await requireSubscription(env, row.subscription_id)
  const [policy, lifecycle, term] = await Promise.all([creditPolicy(env), lifecyclePolicy(env), one(env, "SELECT * FROM nc_renewal_terms WHERE subscription_id=? AND status='active' AND cancelled_at IS NULL", sub.id)])
  insist(sub.revision === saved.subscriptionRevision && (term?.revision ?? null) === saved.termRevision && lifecycle.revision === saved.transition.policy.revision && policy.revision === saved.creditPolicyRevision, 'cancellation_stale', 409)
  const plan = await cancellationPlan(env, sub.id, row.effective_date, row.transition_id, saved.transition.policy.creditUnused)
  insist(plan.fingerprint === row.basis, 'cancellation_stale', 409)
  const above = policy.two_person_above_cents !== null && plan.amountCents > policy.two_person_above_cents
  insist(!above || row.prepared_by !== actor.id, 'second_approver_required', 409)
  const business = await requireBusiness(env), customer = await one(env, 'SELECT * FROM nc_customers WHERE id=? AND erased_at IS NULL', row.customer_id)
  insist(customer, 'customer_not_found', 404)
  const bindings = await all(env, 'SELECT * FROM nc_interval_cancel_requests WHERE cancellation_id=?', id)
  insist(bindings.length === plan.credits.length, 'cancellation_stale', 409)
  const statements = [pending,
    cancellationIssuedGuard(env, sub.id, row.effective_date, plan.invoices),
    guard(env, 'credit_policy_changed', 'COALESCE((SELECT revision FROM nc_credit_policy WHERE singleton=1),0)=?', policy.revision),
    stmt(env, "UPDATE nc_interval_cancellations SET status='approved',decided_by=?,decided_at=? WHERE id=?", actorLabel(actor), now(), id),
    ...cancellationTransitionStatements(env, { id: row.prepared_by, name: row.prepared_name }, sub, term, saved.transition)]
  const documents = []
  let numberingBusiness = { ...business }, offset = 0
  for (const credit of plan.credits) {
    const binding = bindings.find(binding => binding.invoice_id === credit.invoice)
    insist(binding, 'cancellation_stale', 409)
    const invoice = await issuedInvoice(env, credit.invoice)
    const authorization = await authorizeCredit(env, actor, Input.of({ request: binding.request_id }), invoice, credit.amountCents, row.reason, undefined, id)
    const allocation = await documentNumberAllocation(env, numberingBusiness, customer, 'credit-note', offset++)
    const creditId = newId(), issuedAt = clockInstant(env), issueMonth = localDate(issuedAt, business.timezone).slice(0, 7)
    statements.push(...authorization.guards, ...allocation.statements,
      guard(env, 'cancellation_stale', '(SELECT COUNT(*) FROM nc_credit_notes WHERE invoice_id=?)=0', invoice.id),
      stmt(env, 'INSERT INTO nc_credit_notes(id,number,invoice_id,customer_id,amount_cents,reason,issued_by,issued_at,applied_cents,subtotal_cents,tax_cents,cancellation_id,billing_entity_id,billing_route_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', creditId, allocation.number, invoice.id, row.customer_id, credit.amountCents, row.reason, actorLabel(actor), issuedAt, credit.appliedCents, credit.subtotalCents, credit.taxCents, id, allocation.entityId, allocation.routeJson),
      stmt(env, 'INSERT INTO nc_revenue_credits(id,credit_id,invoice_id,customer_id,recognition_date,amount_cents,policy_version,basis_json) VALUES(?,?,?,?,?,?,?,?,?)', creditId, creditId, invoice.id, row.customer_id, `${issueMonth}-01`, -credit.subtotalCents, REVENUE_POLICY_VERSION, JSON.stringify({ method: 'unused-advance-service-credit', cancellation: id, originalInvoice: invoice.id, originalTaxUnchanged: true, taxDeltaCents: -credit.taxCents, servicePeriodDeltas: credit.revenue, original: credit.original, earned: credit.earned, calendar: credit.calendar })),
      stmt(env, "UPDATE nc_credit_requests SET status='issued',approved_by=?,approved_at=?,credit_id=? WHERE id=?", actorLabel(actor), now(), creditId, binding.request_id))
    if (customer.credit_prefix !== null && customer.credit_prefix !== undefined) customer.next_credit_number++
    else numberingBusiness = { ...numberingBusiness, next_credit_number: numberingBusiness.next_credit_number + 1 }
    documents.push({ id: creditId, number: allocation.number, invoice: invoice.id, amountCents: credit.amountCents, appliedCents: credit.appliedCents, carriedCents: credit.carriedCents })
  }
  await commit(env, statements, [
    { actor: actorLabel(actor), action: 'subscription.cancel', subject: sub.id, detail: { id: row.transition_id, date: row.effective_date, reason: row.reason, cancellation: id, preparedBy: row.prepared_name, documents } },
    ...documents.map(document => ({ actor: actorLabel(actor), action: 'credit.issue', subject: document.id, detail: { ...document, cancellation: id, preparedBy: row.prepared_name } })),
  ])
  return { id: sub.id, cancellation: id, transition: row.transition_id, endDate: row.effective_date, status: 'approved', credits: documents }
}

/** Caller enforces subscription read authority before exposing these records. */
export async function intervalCancellations(env: Bindings, subscription: string) {
  return (await all(env, 'SELECT * FROM nc_interval_cancellations WHERE subscription_id=? ORDER BY prepared_at,id', subscription)).map(row => ({ ...row, plan: parseJson<Row>(row.plan_json, {}), plan_json: undefined }))
}
