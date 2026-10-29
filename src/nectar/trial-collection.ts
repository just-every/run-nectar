import { unusableMethodGuard } from './card-lifecycle'
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, type Actor } from './actor'
import { clockInstant } from './clock'
import { canonical, commit, fingerprint, guard, insist, newId, one, stmt } from './core'
import { creditPolicy } from './credit-policy'
import type { Input } from './input'
import { requireFreshFactor } from './mfa'
import { collectionAuthority, collectionOwner } from './movein/collection-state'
import { savedCard, stripeForAccount } from './payments/stripe'
import { trialInvoiceQuote } from './trial-collection-invoice'
import { currentTrialCollection, otherTrialApprover, storedTrialCollection, trialCollectionGuard, trialCollectionView, type TrialCollectionQuote } from './trial-collection-records'

export { readTrialCollections } from './trial-collection-records'

export async function prepareTrialCollection(env: Bindings, actor: Actor, input: Input) {
  await collectionOwner(env, actor)
  input.only(['subscription', 'returnTo'])
  const invoice = await trialInvoiceQuote(env, input.text('subscription', { max: 100 }))
  const route = invoice.input.invoiceContent?.billingEntity?.route
  insist(!route || route.processor === 'stripe', 'native_invoice_route_invalid', 409)
  const selected = await stripeForAccount(env, route?.processorAccountRef ?? null)
  const binding = await one(env, 'SELECT * FROM nc_stripe_customer_bindings WHERE customer_id=? AND account_ref=?', invoice.customer, selected.account)
  insist(binding, 'native_customer_binding_required', 409)
  const card = await savedCard(selected.stripe, binding.stripe_customer_ref), policy = await creditPolicy(env)
  const quote: TrialCollectionQuote = { ...invoice, owner: actor.id, policyRevision: policy.revision,
    bindingId: binding.id, bindingRevision: binding.revision, accountRef: selected.account, ...card,
    amountCents: invoice.rating.totalCents, currency: 'usd', attempts: 1, chargeDate: invoice.trialEnd }
  const id = newId(), at = clockInstant(env), basis = await fingerprint(quote), revision = newId()
  const row = { id, subscription_id: invoice.subscription, customer_id: invoice.customer, quote_json: canonical(quote), basis_hash: basis, status: 'pending_owner', prepared_by: actor.id, revision }
  await commit(env, [collectionAuthority(env, actor),unusableMethodGuard(env,quote.accountRef,quote.customerRef,quote.paymentMethodRef),
    stmt(env, `INSERT INTO nc_trial_collections(id,subscription_id,customer_id,trial_end,quote_json,basis_hash,status,prepared_by,prepared_at,revision)
      VALUES(?,?,?,?,?,?,'pending_owner',?,?,?)`, id, invoice.subscription, invoice.customer, invoice.trialEnd, canonical(quote), basis, actor.id, at, revision),
    trialCollectionGuard(env, row, false),
  ], { actor: actorLabel(actor), action: 'trial.collection.prepare', subject: id, detail: { basis, subscription: invoice.subscription, chargeDate: quote.chargeDate, amountCents: quote.amountCents } })
  return trialCollectionView(await storedTrialCollection(env, id))
}

export async function confirmTrialCollection(env: Bindings, actor: Actor, input: Input) {
  await collectionOwner(env, actor)
  input.only(['request', 'basis_hash', 'confirm', 'confirm_single', 'amount_cents', 'account_ref', 'stripe_customer_ref', 'payment_method_ref', 'trial_end', 'returnTo'])
  const row = await storedTrialCollection(env, input.text('request', { max: 100 }))
  insist(row.status === 'pending_owner' && row.prepared_by === actor.id, 'trial_collection_not_pending', 409)
  const { q } = await currentTrialCollection(env, row)
  insist(input.flag('confirm') && input.text('basis_hash', { max: 100 }) === row.basis_hash
    && input.integer('amount_cents', { min: 50, max: 99999999 }) === q.amountCents && input.text('trial_end', { max: 10 }) === q.trialEnd
    && input.text('account_ref', { max: 255 }) === q.accountRef && input.text('stripe_customer_ref', { max: 255 }) === q.customerRef
    && input.text('payment_method_ref', { max: 255 }) === q.paymentMethodRef, 'trial_collection_confirmation_changed', 409)
  const other = !!await one(env, otherTrialApprover, actor.id), at = clockInstant(env)
  insist(other || input.flag('confirm_single'), 'single_approver_confirmation_required', 409)
  await commit(env, [collectionAuthority(env, actor), trialCollectionGuard(env, row, false),
    guard(env, 'trial_collection_approvers_changed', `${other ? 'EXISTS' : 'NOT EXISTS'}(${otherTrialApprover})`, actor.id),
    stmt(env, 'UPDATE nc_trial_collections SET status=?,owner_confirmed_at=?,approved_by=?,approved_at=?,approval_mode=?,revision=? WHERE id=?',
      other ? 'pending_approval' : 'active', at, other ? null : actor.id, other ? null : at, other ? null : 'single-approver', newId(), row.id),
  ], { actor: actorLabel(actor), action: 'trial.collection.owner.confirm', subject: row.id,
    detail: { basis: row.basis_hash, amountCents: q.amountCents, chargeDate: q.chargeDate, accountRef: q.accountRef, customerRef: q.customerRef, paymentMethodRef: q.paymentMethodRef, approvalMode: other ? 'awaiting-independent-approval' : 'single-approver' } })
  return trialCollectionView(await storedTrialCollection(env, row.id))
}

export async function approveTrialCollection(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve'); await requireFreshFactor(env, actor)
  input.only(['request', 'basis_hash', 'decision', 'returnTo'])
  const row = await storedTrialCollection(env, input.text('request', { max: 100 })), decision = input.text('decision', { max: 10 })
  insist(row.status === 'pending_approval' && row.owner_confirmed_at && row.prepared_by !== actor.id, 'second_approver_required', 409)
  insist(['approved', 'rejected'].includes(decision) && input.text('basis_hash', { max: 100 }) === row.basis_hash, 'trial_collection_confirmation_changed', 409)
  await currentTrialCollection(env, row)
  await commit(env, [trialCollectionGuard(env, row, false),
    guard(env, 'forbidden', "EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','finance'))", actor.id),
    stmt(env, 'UPDATE nc_trial_collections SET status=?,approved_by=?,approved_at=?,approval_mode=?,revision=? WHERE id=?', decision === 'approved' ? 'active' : 'rejected', actor.id, clockInstant(env), 'two-person', newId(), row.id),
  ], { actor: actorLabel(actor), action: `trial.collection.${decision}`, subject: row.id, detail: { basis: row.basis_hash, preparedBy: row.prepared_by, approvalMode: 'two-person' } })
  return trialCollectionView(await storedTrialCollection(env, row.id))
}

export async function revokeTrialCollection(env: Bindings, actor: Actor, input: Input) {
  await collectionOwner(env, actor)
  input.only(['request', 'returnTo'])
  const row = await storedTrialCollection(env, input.text('request', { max: 100 }))
  insist(['pending_owner', 'pending_approval', 'active'].includes(row.status), 'trial_collection_already_claimed', 409)
  await commit(env, [collectionAuthority(env, actor), guard(env, 'trial_collection_already_claimed', "EXISTS(SELECT 1 FROM nc_trial_collections WHERE id=? AND revision=? AND status IN ('pending_owner','pending_approval','active'))", row.id, row.revision),
    stmt(env, "UPDATE nc_trial_collections SET status='revoked',ended_at=?,revision=? WHERE id=?", clockInstant(env), newId(), row.id),
  ], { actor: actorLabel(actor), action: 'trial.collection.revoke', subject: row.id, detail: { basis: row.basis_hash } })
  return trialCollectionView(await storedTrialCollection(env, row.id))
}
