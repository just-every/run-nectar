// Exact, explicitly approved authority for one first invoice on one trial date.
import type { Bindings } from '../auth.server'
import { requireMember, type Actor } from './actor'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, canonical, fingerprint, guard, insist, one, parseJson, type Row } from './core'
import { creditPolicy } from './credit-policy'
import { today } from './dates'
import { currentFingerprint } from './billruns'
import { savedCard, stripeForAccount } from './payments/stripe'
import { matchTrialInvoice, trialInvoiceQuote, type TrialInvoiceQuote } from './trial-collection-invoice'

export interface TrialCollectionQuote extends TrialInvoiceQuote {
  owner: string; policyRevision: number; bindingId: string; bindingRevision: string
  accountRef: string; customerRef: string; paymentMethodRef: string; livemode: boolean
  card: { brand: string; last4: string; expMonth: number; expYear: number }
  amountCents: number; currency: 'usd'; attempts: 1; chargeDate: string
}
export const otherTrialApprover = "SELECT 1 FROM nc_members WHERE id<>? AND status='active' AND role IN ('owner','finance')"
export const trialQuote = (row: Row) => parseJson<TrialCollectionQuote>(row.quote_json, null as never)
export async function storedTrialCollection(env: Bindings, id: string) {
  const row = await one(env, `SELECT r.* FROM nc_trial_collections r JOIN nc_customers c ON c.id=r.customer_id
    WHERE r.id=? AND c.erased_at IS NULL AND c.status='active' AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (r.id,r.customer_id,r.subscription_id))`, id)
  insist(row, 'trial_collection_not_found', 404)
  return row
}
export function trialCollectionGuard(env: Bindings, row: Row, requireApproved = true) {
  const q = trialQuote(row)
  return guard(env, 'trial_collection_authority_changed', `EXISTS(SELECT 1 FROM nc_trial_collections r
    JOIN nc_subscriptions s ON s.id=r.subscription_id JOIN nc_customers c ON c.id=r.customer_id
    JOIN nc_members m ON m.id=r.prepared_by JOIN oa_operators o ON o.email=m.email
    JOIN nc_stripe_customer_bindings b ON b.id=?
    WHERE r.id=? AND r.revision=? AND r.basis_hash=? AND r.status=?
      AND s.revision=? AND s.trial_end=? AND s.trial_payment='card' AND s.trial_outcome IS NULL AND s.billing_mode='live'
      AND (s.end_date IS NULL OR s.end_date>s.trial_end) AND c.revision=? AND c.status='active' AND c.erased_at IS NULL
      AND m.role='owner' AND m.status='active' AND o.role='owner' AND o.status='active'
      AND b.customer_id=c.id AND b.revision=? AND b.account_ref=? AND b.stripe_customer_ref=?
      AND EXISTS(SELECT 1 FROM nc_business WHERE singleton=1 AND revision=? AND timezone=?)
      AND COALESCE((SELECT revision FROM nc_credit_policy WHERE singleton=1),0)=?
      ${requireApproved ? "AND r.owner_confirmed_at IS NOT NULL AND EXISTS(SELECT 1 FROM nc_members f WHERE f.id=r.approved_by AND f.status='active' AND f.role IN ('owner','finance'))" : ''})
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (?,?,?))`, q.bindingId, row.id, row.revision, row.basis_hash, row.status,
    q.subscriptionRevision, q.trialEnd, q.customerRevision, q.bindingRevision, q.accountRef, q.customerRef, q.businessRevision, q.timezone, q.policyRevision, row.id, q.customer, q.subscription)
}
export async function currentTrialCollection(env: Bindings, row: Row, exactDate = false) {
  const q = trialQuote(row), business = await requireBusiness(env), policy = await creditPolicy(env)
  insist(q && await fingerprint(q) === row.basis_hash && q.subscription === row.subscription_id && q.customer === row.customer_id
    && q.owner === row.prepared_by && q.currency === 'usd' && q.trialEnd === row.trial_end && q.chargeDate === q.trialEnd
    && q.window.dueDate === q.chargeDate && q.amountCents === q.rating.totalCents && q.attempts === 1,
  'trial_collection_basis_changed', 409)
  const date = today(business.timezone, clockInstant(env))
  insist(q.businessRevision === business.revision && q.timezone === business.timezone && q.policyRevision === policy.revision,
    'trial_collection_terms_changed', 409)
  insist(exactDate ? date === q.chargeDate : date <= q.chargeDate, 'trial_collection_date_changed', 409)
  const sub = await one(env, 'SELECT * FROM nc_subscriptions WHERE id=?', q.subscription)
  insist(sub && sub.revision === q.subscriptionRevision && sub.trial_end === q.trialEnd && !sub.trial_outcome, 'trial_collection_terms_changed', 409)
  if (row.invoice_id) {
    const invoice = await one(env, 'SELECT * FROM nc_invoices WHERE id=?', row.invoice_id)
    insist(invoice && invoice.subscription_id === q.subscription && invoice.customer_id === q.customer
      && invoice.total_cents === q.amountCents && invoice.source_fingerprint === q.fingerprint
      && await currentFingerprint(env, business, invoice) === q.fingerprint, 'trial_collection_terms_changed', 409)
  } else {
    const { owner, policyRevision, bindingId, bindingRevision, accountRef, customerRef, paymentMethodRef, livemode, card, amountCents, currency, attempts, chargeDate, ...saved } = q
    matchTrialInvoice(saved, await trialInvoiceQuote(env, q.subscription))
  }
  const selected = await stripeForAccount(env, q.accountRef)
  const card = await savedCard(selected.stripe, q.customerRef)
  insist(canonical(card) === canonical({ customerRef: q.customerRef, paymentMethodRef: q.paymentMethodRef, livemode: q.livemode, card: q.card }), 'trial_collection_card_changed', 409)
  return { q, selected }
}
export function trialCollectionView(row: Row) {
  const q = trialQuote(row)
  return { id: row.id, subscription: row.subscription_id, customer: row.customer_id, status: row.status, basis: row.basis_hash,
    quote: q, preparedBy: row.prepared_by, preparedAt: row.prepared_at, ownerConfirmedAt: row.owner_confirmed_at,
    approvedBy: row.approved_by, approvedAt: row.approved_at, approvalMode: row.approval_mode, invoice: row.invoice_id,
    nativeRequest: row.native_request_id, errorCode: row.error_code, endedAt: row.ended_at,
    instructions: { confirm: row.status === 'pending_owner' ? { request: row.id, basis_hash: row.basis_hash, confirm: true,
      amount_cents: q.amountCents, account_ref: q.accountRef, stripe_customer_ref: q.customerRef, payment_method_ref: q.paymentMethodRef, trial_end: q.trialEnd } : null,
      approve: row.status === 'pending_approval' ? { request: row.id, basis_hash: row.basis_hash, decision: 'approved' } : null,
      consequences: 'One saved-card charge on this exact trial end date only. Changed terms or date need new explicit authorization. Unknown outcomes are never retried.' } }
}
export async function readTrialCollections(env: Bindings, actor: Actor, subscription?: string) {
  requireMember(actor, 'approve')
  insist(subscription === undefined || /^[\w-]{1,100}$/.test(subscription), 'invalid_subscription')
  return (await all(env, `SELECT r.*,n.status AS native_status,n.error_code AS native_error FROM nc_trial_collections r JOIN nc_customers c ON c.id=r.customer_id
    LEFT JOIN nc_native_collections n ON n.id=r.native_request_id
    WHERE c.erased_at IS NULL AND c.status='active' AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (r.id,r.customer_id,r.subscription_id)) ${subscription ? 'AND r.subscription_id=?' : ''} ORDER BY r.prepared_at,r.id`, ...(subscription ? [subscription] : [])))
    .map(row => trialCollectionView(['claimed','uncertain'].includes(row.status) && ['collected','declined','customer_action_required'].includes(row.native_status)
      ? { ...row, status: row.native_status, error_code: row.native_error } : row))
}
