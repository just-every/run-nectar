import type { Bindings } from '../../auth.server'
import { requireOwner, type Actor } from '../actor'
import { clockInstant } from '../clock'
import { fingerprint, guard, insist, one, parseJson, type Row } from '../core'
import { requireFreshFactor, STEP_UP_MS } from '../mfa'
import type { CollectionSnapshot } from './collection-provider'
import { stripeReference } from './history'

export async function collectionOwner(env: Bindings, actor: Actor) {
  requireOwner(actor)
  insist(actor.sessionId, 'owner_session_required', 403)
  await requireFreshFactor(env, actor)
}
export function collectionAuthority(env: Bindings, actor: Actor) {
  return guard(env, 'authority', `EXISTS(SELECT 1 FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id
    JOIN nc_members m ON m.id=? AND m.email=lower(o.email)
    WHERE s.id=? AND s.revoked_at IS NULL AND s.expires_at>CAST(strftime('%s','now') AS INTEGER)*1000
    AND o.version=s.operator_version AND o.status='active' AND o.role='owner' AND m.status='active' AND m.role='owner'
    AND (NOT EXISTS(SELECT 1 FROM nc_mfa_policy WHERE singleton=1 AND (scope='all' OR (scope='roles' AND instr(' '||roles||' ',' owner ')>0)))
      OR EXISTS(SELECT 1 FROM nc_mfa_sessions WHERE session_id=s.id AND member_id=m.id AND verified_at>=?)))`, actor.id, actor.sessionId, clockInstant(env) - STEP_UP_MS)
}
export async function importedCollectionSource(env: Bindings, id: string) {
  const row = await one(env, `SELECT i.*,c.revision AS customer_revision,c.erased_at,c.status AS customer_status FROM nc_incumbent_invoices i
    JOIN nc_customers c ON c.id=i.customer_id WHERE i.id=?`, id)
  insist(row && row.provider === 'stripe' && row.document_kind === 'invoice' && row.status === 'open' && !row.erased_at && row.customer_status === 'active'
    && !await one(env, 'SELECT 1 FROM nc_erased_records WHERE record_id IN (?,?)', id, row.customer_id), 'imported_open_invoice_required', 409)
  const original = parseJson<Row>(row.source_json, {})
  insist(original.object === 'invoice' && original.id === row.provider_ref && original.status === 'open' && stripeReference(original.customer)
    && original.number === row.number && original.currency === row.currency && original.total === row.total_cents
    && original.amount_paid === row.paid_cents && original.amount_remaining === row.remaining_cents
    && Number.isSafeInteger(row.remaining_cents) && row.remaining_cents > 0, 'imported_invoice_source_incomplete', 409)
  return { row, original }
}
export function matchOriginalInvoice(original: Row, live: CollectionSnapshot['invoice'], paid = false) {
  insist(original.id === live.id && stripeReference(original.customer) === live.customer && original.number === live.number
    && original.currency === live.currency && original.total === live.total && original.livemode === live.livemode
    && (paid || live.status === 'open' && original.amount_paid === live.amount_paid && original.amount_remaining === live.amount_remaining
      && (original.attempt_count === undefined || original.attempt_count === live.attempt_count)
      && (original.attempted === undefined || original.attempted === live.attempted)), 'stripe_invoice_source_changed', 409)
}
export interface CollectionBasis { sourceRevision: string; customerRevision: string; sourceHash: string; principal: string; snapshot: CollectionSnapshot; intentKey: string }
export async function collectionBasis(source: Awaited<ReturnType<typeof importedCollectionSource>>, snapshot: CollectionSnapshot, actor: Actor): Promise<CollectionBasis> {
  matchOriginalInvoice(source.original, snapshot.invoice)
  insist(snapshot.paymentMethod, 'stripe_existing_payment_method_required', 409)
  return { sourceRevision: source.row.revision, customerRevision: source.row.customer_revision,
    sourceHash: await fingerprint(source.original), principal: actor.id, snapshot,
    intentKey: await fingerprint(['nectar-movein-collection-1',snapshot.account,snapshot.invoice.id]) }
}
export function collectionSourceGuard(env: Bindings, source: Awaited<ReturnType<typeof importedCollectionSource>>) {
  const { row } = source
  return guard(env, 'collection_source_changed', `EXISTS(SELECT 1 FROM nc_incumbent_invoices i JOIN nc_customers c ON c.id=i.customer_id
    WHERE i.id=? AND i.customer_id=? AND i.provider='stripe' AND i.document_kind='invoice' AND i.status='open' AND i.revision=? AND i.source_json=?
    AND i.provider_ref=? AND i.number=? AND i.currency=? AND i.total_cents=? AND i.remaining_cents=? AND i.paid_cents=?
    AND c.revision=? AND c.erased_at IS NULL AND c.status='active') AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (?,?))`,
  row.id, row.customer_id, row.revision, row.source_json, row.provider_ref, row.number, row.currency, row.total_cents, row.remaining_cents, row.paid_cents, row.customer_revision, row.id, row.customer_id)
}
export async function storedCollection(env: Bindings, id: string) {
  const row = await one(env, 'SELECT * FROM nc_imported_collections WHERE id=?', id)
  insist(row, 'imported_collection_not_found', 404)
  return row
}
export async function currentCollectionBasis(env: Bindings, actor: Actor, row: Row) {
  const source = await importedCollectionSource(env, row.invoice_id)
  const basis = parseJson<CollectionBasis | null>(row.basis_json, null)
  insist(basis && basis.principal === actor.id && row.prepared_by === actor.id && await fingerprint(basis) === row.basis_hash
    && basis.sourceRevision === source.row.revision && basis.customerRevision === source.row.customer_revision
    && basis.sourceHash === await fingerprint(source.original), 'imported_collection_basis_changed', 409)
  return { source, basis }
}
export function collectionView(row: Row) {
  const { basis_json, ...result } = row
  const review = parseJson<CollectionBasis | null>(basis_json, null), held = typeof review?.sourceHash === 'string' && typeof review?.principal === 'string'
  return { ...result, review, instructions: {
    execute: held && row.status === 'pending' ? { request: row.id, basis_hash: row.basis_hash, confirm: true, disable_auto_advance: true } : null,
    reconcile: held && ['claimed','uncertain'].includes(row.status) ? { request: row.id } : null,
    finalize: held && row.status === 'uncertain' && row.charge_ref && row.payment_intent_ref && row.error_code !== 'stripe_mirror_claimed' ? { request: row.id, confirm: true } : null,
    consequences: 'One processor PaymentIntent collects the original receivable after Stripe automatic advancement is disabled. Its captured charge is saved before the original invoice is marked paid out of band. An uncertain charge is never repeated. Reconciliation only reads Stripe; a separate owner confirmation can finish an unconfirmed out-of-band mark.',
  } }
}
