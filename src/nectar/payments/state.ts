import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { all, fingerprint, guard, insist, one, parseJson, type Row } from '../core'
import { nativeCollectionSource } from './source'
import type { PaymentIdentity } from './stripe'

export interface NativeCollectionBasis {
  principal: string; sourceHash: string; sourceFingerprint: string; customerRevision: string; bindingId: string; bindingRevision: string
  invoiceId: string; invoiceNumber: string; customerId: string; entityId: string | null; route: Row
  accountRef: string; customerRef: string; paymentMethodRef: string; amountCents: number; currency: 'usd'; livemode: boolean
  card: { brand: string; last4: string; expMonth: number; expYear: number }; key: string
}
export async function storedNativeCollection(env: Bindings, id: string) {
  const row = await one(env, 'SELECT * FROM nc_native_collections WHERE id=?', id)
  insist(row, 'native_collection_not_found', 404)
  await nativeCustomerPresent(env, row.customer_id)
  return row
}
export async function nativeCustomerPresent(env: Bindings, id: string) {
  insist(await one(env, "SELECT 1 FROM nc_customers WHERE id=? AND erased_at IS NULL AND status='active'", id)
    && !await one(env, 'SELECT 1 FROM nc_erased_records WHERE record_id=?', id), 'customer_not_found', 404)
}
export function bindingGuard(env: Bindings, basis: NativeCollectionBasis) {
  return guard(env, 'native_collection_binding_changed', 'EXISTS(SELECT 1 FROM nc_stripe_customer_bindings WHERE id=? AND customer_id=? AND account_ref=? AND stripe_customer_ref=? AND revision=?)',
    basis.bindingId, basis.customerId, basis.accountRef, basis.customerRef, basis.bindingRevision)
}
export async function currentNativeCollection(env: Bindings, actor: Actor, row: Row) {
  const source = await nativeCollectionSource(env, row.invoice_id), basis = parseJson<NativeCollectionBasis | null>(row.basis_json, null)
  insist(basis && basis.principal === actor.id && row.prepared_by === actor.id && await fingerprint(basis) === row.basis_hash
    && basis.sourceHash === source.sourceHash && basis.amountCents === source.row.balance_cents
    && basis.sourceFingerprint === source.row.source_fingerprint && basis.customerRevision === source.row.customer_revision,
  'native_collection_basis_changed', 409)
  const binding = await one(env, 'SELECT * FROM nc_stripe_customer_bindings WHERE id=?', basis.bindingId)
  insist(binding && binding.customer_id === source.row.customer_id && binding.revision === basis.bindingRevision
    && binding.account_ref === basis.accountRef && binding.stripe_customer_ref === basis.customerRef, 'native_collection_binding_changed', 409)
  return { source, basis }
}
export function paymentIdentity(row: Row, basis: NativeCollectionBasis): PaymentIdentity {
  return { invoiceId: row.invoice_id, requestId: row.id, accountRef: basis.accountRef, customerRef: basis.customerRef,
    paymentMethodRef: basis.paymentMethodRef, livemode: basis.livemode, key: basis.key, amountCents: row.amount_cents }
}
export function nativeCollectionView(row: Row): Row {
  const basis = parseJson<NativeCollectionBasis | null>(row.basis_json, null), { basis_json, proof_json, ...safe } = row
  return { ...safe, review: basis, proof: parseJson<Row | null>(proof_json, null), instructions: {
    confirm: basis && row.status === 'pending' ? { request: row.id, basis_hash: row.basis_hash, confirm: true,
      amount_cents: basis.amountCents, account_ref: basis.accountRef, stripe_customer_ref: basis.customerRef, payment_method_ref: basis.paymentMethodRef } : null,
    reconcile: ['claimed', 'uncertain'].includes(row.status) ? { request: row.id } : null,
  } }
}
export async function nativeCollectionRows(env: Bindings, customer?: string) {
  return await all(env, `SELECT r.* FROM nc_native_collections r JOIN nc_customers c ON c.id=r.customer_id
    WHERE c.erased_at IS NULL AND c.status='active' AND NOT EXISTS(SELECT 1 FROM nc_erased_records e WHERE e.record_id IN (r.id,r.invoice_id,r.customer_id))
    ${customer ? 'AND r.customer_id=?' : ''} ORDER BY r.prepared_at DESC,r.id`, ...(customer ? [customer] : []))
}
