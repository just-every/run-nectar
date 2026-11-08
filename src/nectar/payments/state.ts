import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { all, fingerprint, guard, insist, one, parseJson, type Row } from '../core'
import { nativeCollectionSource } from './source'
import type { PaymentIdentity } from './stripe'
import { billingCurrency } from '../currency'

export interface NativeCollectionBasis {
  payerCustomerId?:string;payerRevision?:string;
  principal: string; sourceHash: string; sourceFingerprint: string; customerRevision: string; bindingId: string; bindingRevision: string
  invoiceId: string; invoiceNumber: string; customerId: string; entityId: string | null; route: Row
  accountRef: string; customerRef: string; paymentMethodRef: string; amountCents: number; currency: string; livemode: boolean
  card: { brand: string; last4: string; expMonth: number; expYear: number }; key: string
}
export async function storedNativeCollection(env: Bindings, id: string) {
  const row = await one(env, 'SELECT * FROM nc_native_collections WHERE id=?', id)
  insist(row, 'native_collection_not_found', 404)
  await nativeCustomerPresent(env, row.customer_id)
  row.reconfirmation = await one(env, `SELECT r.*,EXISTS(SELECT 1 FROM nc_native_reconfirmation_authority a WHERE a.id=r.id) AS authorized
    FROM nc_native_reconfirmations r WHERE r.collection_id=? ORDER BY (r.claimed_at IS NOT NULL) DESC,r.prepared_at DESC,r.rowid DESC LIMIT 1`, row.id)
  return row
}
export async function nativeCustomerPresent(env: Bindings, id: string) {
  insist(await one(env, "SELECT 1 FROM nc_customers WHERE id=? AND erased_at IS NULL AND status='active'", id)
    && !await one(env, 'SELECT 1 FROM nc_erased_records WHERE record_id=?', id), 'customer_not_found', 404)
}
export function bindingGuard(env: Bindings, basis: NativeCollectionBasis) {
  return guard(env, 'native_collection_binding_changed', 'EXISTS(SELECT 1 FROM nc_stripe_customer_bindings WHERE id=? AND customer_id=? AND account_ref=? AND stripe_customer_ref=? AND revision=?)',
    basis.bindingId, basis.payerCustomerId??basis.customerId, basis.accountRef, basis.customerRef, basis.bindingRevision)
}
export async function currentNativeCollection(env: Bindings, actor: Actor, row: Row) {
  const recovery = row.reconfirmation?.claimed_at ? row.reconfirmation : null
  const source = await nativeCollectionSource(env, row.invoice_id), basis = parseJson<NativeCollectionBasis | null>(recovery?.basis_json ?? row.basis_json, null)
  insist(basis && basis.principal === actor.id && (recovery?.prepared_by ?? row.prepared_by) === actor.id && await fingerprint(basis) === (recovery?.basis_hash ?? row.basis_hash)
    && basis.sourceHash === source.sourceHash && billingCurrency(basis.currency) === billingCurrency(source.row.currency) && billingCurrency(row.currency) === billingCurrency(basis.currency) && basis.amountCents === source.collectibleCents
    && basis.sourceFingerprint === source.row.source_fingerprint && basis.customerRevision === source.row.customer_revision,
  'native_collection_basis_changed', 409)
  const binding = await one(env, 'SELECT * FROM nc_stripe_customer_bindings WHERE id=?', basis.bindingId)
  insist(binding && binding.customer_id === source.payerId && binding.revision === basis.bindingRevision
    && binding.account_ref === basis.accountRef && binding.stripe_customer_ref === basis.customerRef, 'native_collection_binding_changed', 409)
  return { source, basis }
}
export function paymentIdentity(row: Row, basis: NativeCollectionBasis): PaymentIdentity {
  return { invoiceId: row.invoice_id, requestId: row.id, accountRef: basis.accountRef, customerRef: basis.customerRef,
    paymentMethodRef: basis.paymentMethodRef, livemode: basis.livemode, key: basis.key, amountCents: row.amount_cents, currency: basis.currency }
}
export function nativeCollectionView(row: Row): Row {
  const { basis_json, proof_json, reconfirmation, ...safe } = row
  const basis = parseJson<NativeCollectionBasis | null>(reconfirmation?.claimed_at ? reconfirmation.basis_json : basis_json, null)
  const recovery = reconfirmation ? { id: reconfirmation.id, claimedAt: reconfirmation.claimed_at, basisHash: reconfirmation.basis_hash,
    review: parseJson<Row>(reconfirmation.basis_json, {}), firstFailedAt: reconfirmation.first_failed_at, firstFailure: parseJson<Row>(reconfirmation.failure_json, {}) } : null
  return { ...safe, review: basis, reconfirmation: recovery, proof: parseJson<Row | null>(proof_json, null), instructions: {
    confirm: basis && row.status === 'pending' ? { request: row.id, basis_hash: row.basis_hash, confirm: true,
      amount_cents: basis.amountCents, account_ref: basis.accountRef, stripe_customer_ref: basis.customerRef, payment_method_ref: basis.paymentMethodRef } : null,
    reconcile: ['claimed', 'uncertain'].includes(row.status) ? { request: row.id } : null,
    reconfirm: recovery && reconfirmation.authorized && !recovery.claimedAt && row.status === 'declined' ? { request: row.id,
      recovery: recovery.id, basis_hash: recovery.basisHash, confirm: true, amount_cents: row.amount_cents,
      account_ref: row.account_ref, stripe_customer_ref: row.stripe_customer_ref, payment_method_ref: row.payment_method_ref } : null,
    prepareRecovery: row.status === 'declined' && !recovery?.claimedAt && ['insufficient_funds','do_not_honor','processing_error'].includes(parseJson<Row>(proof_json, {}).declineCode ?? row.error_code) ? { request: row.id } : null,
  } }
}
export async function nativeCollectionRows(env: Bindings, customer?: string) {
  const rows = await all(env, `SELECT r.* FROM nc_native_collections r JOIN nc_customers c ON c.id=r.customer_id
    WHERE c.erased_at IS NULL AND c.status='active' AND NOT EXISTS(SELECT 1 FROM nc_erased_records e WHERE e.record_id IN (r.id,r.invoice_id,r.customer_id))
    ${customer ? 'AND r.customer_id=?' : ''} ORDER BY r.prepared_at DESC,r.id`, ...(customer ? [customer] : []))
  return Promise.all(rows.map(row => storedNativeCollection(env, row.id)))
}
