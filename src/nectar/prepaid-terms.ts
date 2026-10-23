import { requireUsdCurrency } from './currency'
// Conservative pending-CT governance: exact owner consent and a second person.
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, requireOwner, type Actor } from './actor'
import { all, commit, guard, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import { canonicalDecimal, cents, micros } from './decimal'
import { requireDate } from './dates'
import type { Input } from './input'
import { requireFreshFactor } from './mfa'
import { requireSubscription } from './subscriptions'
import { prepaidFundingIntentStatements, prepaidGrantStatements, prepaidRevisionGuard } from './prepaid-records'
import type { PrepaidTerms } from './prepaid-types'

const OTHER = "SELECT 1 FROM nc_members WHERE status='active' AND role IN ('owner','finance') AND id<>?"
function quantity(input: Input, name: string, kind: string, optional = false) {
  const text = input.text(name, { max: 24, optional })
  if (!text) return null
  const amount = kind === 'money' ? BigInt(cents(text, name)) : micros(canonicalDecimal(text, name))
  insist(amount >= 0n && amount <= BigInt(Number.MAX_SAFE_INTEGER), 'prepaid_quantity_out_of_range')
  return Number(amount)
}
function readTerms(input: Input): PrepaidTerms {
  const kind = input.text('kind', { max: 10 }), source = input.text('source', { max: 20 })
  insist(kind === 'money' || kind === 'units', 'invalid_prepaid_kind')
  insist(source === 'purchase' || source === 'promotion', 'invalid_prepaid_source')
  const amountN = quantity(input, 'amount', kind)!
  insist(amountN > 0, 'invalid_prepaid_amount')
  const valueCents = source === 'promotion' ? 0 : kind === 'money' ? amountN : cents(input.text('purchase_amount', { max: 24 }))
  insist(source === 'promotion' || valueCents > 0, 'prepaid_purchase_amount_required')
  const effectiveDate = requireDate(input.text('effective_date', { max: 10 }), 'effective_date'), expiresDate = input.text('expires_date', { max: 10, optional: true }) || null
  insist(!expiresDate || requireDate(expiresDate, 'expires_date') > effectiveDate, 'invalid_prepaid_expiry')
  insist(input.flag('expiry_consent'), 'prepaid_expiry_consent_required')
  const rolloverMonths = input.integer('rollover_months', { min: 0, max: 120, optional: true }) ?? 0
  const rolloverPercent = input.integer('rollover_percent', { min: 0, max: 100, optional: true }) ?? 100
  return { kind, source, amountN, valueCents, meterId: kind === 'units' ? input.text('meter', { max: 100 }) : input.text('meter', { max: 100, optional: true }) || null,
    effectiveDate, expiresDate, priority: input.integer('priority', { min: 0, max: 100000, optional: true }) ?? 100,
    rolloverMonths, rolloverPercent, rolloverCapN: quantity(input, 'rollover_cap', kind, true), expiryConsent: true }
}
export async function preparePrepaid(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor); await requireFreshFactor(env, actor)
  const sub = await requireSubscription(env, input.text('subscription', { max: 100 }))
  insist(!sub.erased_at, 'customer_erased', 410)
  await requireUsdCurrency(env,{subscriptionId:sub.id})
  const terms = readTerms(input), mode = input.text('mode', { max: 10, optional: true }) || 'grant'
  insist(mode === 'grant' || mode === 'consent', 'invalid_prepaid_mode')
  if (terms.meterId) insist(await one(env, 'SELECT id FROM nc_meters WHERE id=?', terms.meterId), 'meter_not_found', 404)
  const payload: Row = { terms, allocationPolicy: 'Across dollar and unit grants: priority, earliest expiry, effective date, then immutable grant ID. Exact source-day weights retain the complete usage pricing interval.' }
  if (mode === 'consent') {
    insist(terms.source === 'purchase' && input.flag('funding_consent'), 'prepaid_funding_consent_required')
    payload.thresholdN = quantity(input, 'threshold', terms.kind)
    payload.fundingConsent = true
  }
  const account = await one(env, 'SELECT revision FROM nc_prepaid_accounts WHERE subscription_id=?', sub.id), revision = account?.revision ?? 0, id = newId()
  await commit(env, [stmt(env, 'INSERT OR IGNORE INTO nc_prepaid_accounts(subscription_id,customer_id,revision) VALUES(?,?,0)', sub.id, sub.customer_id), prepaidRevisionGuard(env, sub.id, revision),
    stmt(env, 'INSERT INTO nc_prepaid_requests(id,subscription_id,customer_id,kind,payload_json,base_revision,prepared_by_id,prepared_by,prepared_at) VALUES(?,?,?,?,?,?,?,?,?)', id, sub.id, sub.customer_id, mode, JSON.stringify(payload), revision, actor.id, actorLabel(actor), now())],
    { actor: actorLabel(actor), action: 'prepaid.prepare', subject: id, detail: { subscription: sub.id, kind: mode, payload } })
  return { id, request: id, status: 'pending', payload }
}
export async function decidePrepaid(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve'); await requireFreshFactor(env, actor)
  const request = await one(env, 'SELECT * FROM nc_prepaid_requests WHERE id=?', input.text('request', { max: 100 }))
  insist(request, 'prepaid_request_not_found', 404); insist(request.status === 'pending', 'prepaid_already_decided', 409)
  const decision = input.text('decision', { max: 10 }); insist(['approved','rejected'].includes(decision), 'invalid_decision')
  const statements = [guard(env, 'prepaid_already_decided', "EXISTS(SELECT 1 FROM nc_prepaid_requests WHERE id=? AND status='pending')", request.id)]
  const single = request.prepared_by_id === actor.id
  if (decision === 'approved') {
    if (single) { requireOwner(actor); insist(!await one(env, OTHER, actor.id), 'second_approver_required', 409); insist(input.flag('confirm_single'), 'single_confirmation_required', 409); statements.push(guard(env, 'second_approver_required', `NOT EXISTS(${OTHER})`, actor.id)) }
    statements.push(prepaidRevisionGuard(env, request.subscription_id, request.base_revision), guard(env, 'preparer_inactive', "EXISTS(SELECT 1 FROM nc_members WHERE id=? AND role='owner' AND status='active')", request.prepared_by_id))
    const payload = parseJson<Row>(request.payload_json, {}), terms = payload.terms as PrepaidTerms
    if (request.kind === 'consent') statements.push(stmt(env, "UPDATE nc_prepaid_consents SET status='revoked',revoked_at=? WHERE subscription_id=? AND status='active'", now(), request.subscription_id),
      stmt(env, 'INSERT INTO nc_prepaid_consents(id,subscription_id,customer_id,request_id,terms_json,threshold_n,approved_at) VALUES(?,?,?,?,?,?,?)', request.id, request.subscription_id, request.customer_id, request.id, JSON.stringify(terms), payload.thresholdN, now()), stmt(env, 'UPDATE nc_prepaid_accounts SET revision=revision+1 WHERE subscription_id=?', request.subscription_id))
    else if (terms.source === 'promotion') statements.push(...prepaidGrantStatements(env, request.id, request.subscription_id, request.customer_id, terms, request.id, null, null, null))
    else statements.push(...prepaidFundingIntentStatements(env, request.id, request.subscription_id, request.customer_id, terms, request.id, null))
  }
  statements.push(stmt(env, 'UPDATE nc_prepaid_requests SET status=?,decided_by_id=?,decided_by=?,decided_at=?,approval_mode=? WHERE id=?', decision, actor.id, actorLabel(actor), now(), single ? 'single-approver' : 'two-person', request.id))
  await commit(env, statements, { actor: actorLabel(actor), action: `prepaid.${decision}`, subject: request.id, detail: { preparedBy: request.prepared_by, mode: single ? 'single-approver' : 'two-person' } })
  return { id: request.id, status: decision, fundingIntent: decision === 'approved' && request.kind === 'grant' && parseJson<Row>(request.payload_json, {}).terms.source === 'purchase' ? request.id : null }
}
export async function revokePrepaidConsent(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor); await requireFreshFactor(env, actor)
  const id = input.text('consent', { max: 100 })
  await commit(env, [guard(env, 'prepaid_consent_not_active', "EXISTS(SELECT 1 FROM nc_prepaid_consents WHERE id=? AND status='active')", id), stmt(env, "UPDATE nc_prepaid_consents SET status='revoked',revoked_at=? WHERE id=?", now(), id),
    stmt(env, 'UPDATE nc_prepaid_accounts SET revision=revision+1 WHERE subscription_id=(SELECT subscription_id FROM nc_prepaid_consents WHERE id=?)', id)], { actor: actorLabel(actor), action: 'prepaid.consent.revoke', subject: id })
  return { id, status: 'revoked' }
}
