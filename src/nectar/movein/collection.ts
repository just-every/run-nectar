import { assertMethodUsable, HARD_CARD_DECLINES, recordUnusableMethod, unusableMethodGuard } from '../card-lifecycle'
// Owner-approved, single-attempt collection of an original Stripe invoice.
// The claim commits before provider writes. Claimed/uncertain work never pays
// again: a separate owner action can only read actual settlement evidence.
import type { Bindings } from '../../auth.server'
import { actorLabel, type Actor } from '../actor'
import { requireBusiness } from '../business'
import { clockInstant } from '../clock'
import { all, canonical, commit, fingerprint, guard, insist, newId, stmt, type Row } from '../core'
import { Input } from '../input'
import { bindNativeCollectionCustomer } from '../payments/customer'
import { refusedPaymentEvidence } from '../payments/stripe'
import { CollectionProviderError, collectionIntentIdentity, collectionProviderRefusal, collectionStripe, invoiceFacts, readCollectionIntent,
  stripeCollectedEvidence, stripeCollectionSnapshot, type CollectionStripe } from './collection-provider'
import { collectionAuthority, collectionBasis, collectionOwner, collectionSourceGuard, collectionView,
  currentCollectionBasis, importedCollectionSource, matchOriginalInvoice, storedCollection, type CollectionBasis } from './collection-state'

export async function prepareImportedCollection(env: Bindings, actor: Actor, input: Input) {
  await collectionOwner(env, actor)
  input.only(['invoice','returnTo'])
  const source = await importedCollectionSource(env, input.text('invoice', { max: 100 }))
  insist(!(await all(env, 'SELECT id FROM nc_imported_collections WHERE invoice_id=?', source.row.id)).length, 'imported_collection_already_prepared', 409)
  const stripe = collectionStripe(env)
  const snapshot = await stripeCollectionSnapshot(stripe, source.row.provider_ref).catch(collectionProviderRefusal)
  const basis = await collectionBasis(source, snapshot, actor), hash = await fingerprint(basis), id = newId(), at = clockInstant(env)
  await commit(env, [collectionAuthority(env, actor), collectionSourceGuard(env, source),unusableMethodGuard(env,basis.snapshot.account,basis.snapshot.invoice.customer,basis.snapshot.paymentMethod),
    stmt(env, `INSERT INTO nc_imported_collections(id,customer_id,invoice_id,account_ref,invoice_ref,number,status,basis_json,basis_hash,
      amount_cents,currency,prepared_by,prepared_at,revision) VALUES(?,?,?,?,?,?,'pending',?,?,?,?,?,?,?)`, id, source.row.customer_id,
    source.row.id, snapshot.account, source.row.provider_ref, source.row.number, canonical(basis), hash, source.row.remaining_cents,
    source.row.currency, actor.id, at, newId()),
  ], { actor: actorLabel(actor), action: 'imported.collection.prepare', subject: id,
    detail: { invoice: source.row.id, customer: source.row.customer_id, basisHash: hash, amountCents: source.row.remaining_cents,
      account: snapshot.account, collector: 'owner-approved-original-stripe-invoice' } })
  return collectionView(await storedCollection(env, id))
}

async function collectionChange(env: Bindings, actor: Actor, request: Row, changes: Row, action: string) {
  await collectionOwner(env, actor)
  const { source } = await currentCollectionBasis(env, actor, request)
  const revision = newId(), entries = Object.entries({ ...changes, revision })
  await commit(env, [collectionAuthority(env, actor), collectionSourceGuard(env, source),
    guard(env, 'collection_already_executed', `EXISTS(SELECT 1 FROM nc_imported_collections WHERE id=? AND revision=? AND basis_hash=? AND status IN ('claimed','uncertain'))`, request.id, request.revision, request.basis_hash),
    stmt(env, `UPDATE nc_imported_collections SET ${entries.map(([column]) => `${column}=?`).join(',')} WHERE id=?`, ...entries.map(([, value]) => value), request.id),
    collectionAuthority(env, actor),
  ], { actor: actorLabel(actor), action: `imported.collection.${action}`, subject: request.id,
    detail: { invoice: request.invoice_id, ...changes } })
  return storedCollection(env, request.id)
}

type PaymentEvidence = Awaited<ReturnType<typeof stripeCollectedEvidence>>
async function saveOutcome(env: Bindings, actor: Actor, request: Row, status: 'collected' | 'uncertain' | 'failed', evidence: PaymentEvidence | null, code: string | null) {
  const facts = evidence ? { charge_ref: evidence.chargeRef, payment_ref: evidence.paymentRef, payment_intent_ref: evidence.paymentIntentRef,
    collected_on: evidence.collectedOn, custody: evidence.custody } : {}
  // Uncertainty never discards an already saved PaymentIntent or captured charge.
  return collectionChange(env, actor, request, { ...facts, status, error_code: code, reconciled_at: clockInstant(env) }, status)
}
async function saveIntent(env: Bindings, actor: Actor, request: Row, basis: CollectionBasis, intent: Row) {
  const id = collectionIntentIdentity(intent, basis, request)
  insist(!request.payment_intent_ref || request.payment_intent_ref === id, 'stripe_collection_intent_mismatch', 409)
  return collectionChange(env, actor, request, { payment_intent_ref: id }, 'intent.record')
}
// Definitive, identity-matched refusal is permanent evidence, never a reason
// to create another intent. Association uses the same owner-confirmed tuple
// and the ordinary binding door; it supplies no collection authorization.
async function saveRefusal(env: Bindings, actor: Actor, request: Row, basis: CollectionBasis, stripe: CollectionStripe, intent: Row) {
  collectionIntentIdentity(intent,basis,request)
  const refusal = await refusedPaymentEvidence(stripe,intent,basis.snapshot.invoice.customer)
  if (!refusal) return null
  const code = refusal.declineCode ?? refusal.errorCode
  if (HARD_CARD_DECLINES.has(code)) {
    await bindNativeCollectionCustomer(env,actor,Input.of({customer:request.customer_id,account_ref:basis.snapshot.account,
      stripe_customer_ref:basis.snapshot.invoice.customer,confirm:true}))
    await recordUnusableMethod(env,{accountRef:basis.snapshot.account,customerRef:basis.snapshot.invoice.customer,
      paymentMethodRef:basis.snapshot.paymentMethod,requestId:request.id,invoiceId:request.invoice_id,
      key:basis.intentKey,amountCents:request.amount_cents,currency:request.currency,livemode:basis.snapshot.invoice.livemode},code)
  }
  const saved = await saveIntent(env,actor,request,basis,intent)
  return saveOutcome(env,actor,saved,'failed',null,code)
}

async function finishMirror(env: Bindings, actor: Actor, request: Row, stripe: CollectionStripe, basis: CollectionBasis, evidence: PaymentEvidence, replay: boolean) {
  const snapshot = await stripeCollectionSnapshot(stripe, request.invoice_ref)
  insist(snapshot.account === basis.snapshot.account, 'stripe_invoice_source_changed', 409)
  matchOriginalInvoice(basis.snapshot.invoice, snapshot.invoice, true)
  if (snapshot.invoice.status === 'open') {
    matchOriginalInvoice(basis.snapshot.invoice, snapshot.invoice)
    insist(snapshot.invoice.auto_advance === false, 'stripe_automatic_collection_not_disabled', 409)
  } else insist(replay && snapshot.invoice.status === 'paid' && snapshot.invoice.amount_remaining === 0, 'stripe_mirror_unconfirmed', 409)
  const claimed = await collectionChange(env, actor, request, { error_code: 'stripe_mirror_claimed' }, 'mirror.claim')
  try {
    // This request cannot charge: Stripe's explicit out-of-band parameter only
    // mirrors a separately proven processor payment. Its key is source-derived.
    const mirrored = invoiceFacts(await stripe(`/invoices/${encodeURIComponent(request.invoice_ref)}/pay`,
      new URLSearchParams({ paid_out_of_band: 'true' }), `nectar-movein-${basis.intentKey}:mirror`))
    matchOriginalInvoice(basis.snapshot.invoice, mirrored, true)
    insist(mirrored.status === 'paid' && mirrored.amount_remaining === 0 && mirrored.auto_advance === false, 'stripe_mirror_unconfirmed', 409)
    return saveOutcome(env, actor, claimed, 'collected', { ...evidence, custody: 'stripe-payment-intent-and-out-of-band-invoice' }, null)
  } catch {
    return saveOutcome(env, actor, claimed, 'uncertain', evidence, 'stripe_mirror_unconfirmed')
  }
}

export async function executeImportedCollection(env: Bindings, actor: Actor, input: Input) {
  await collectionOwner(env, actor)
  input.only(['request','basis_hash','confirm','disable_auto_advance','returnTo'])
  insist(input.flag('confirm') && input.flag('disable_auto_advance'), 'imported_collection_confirmation_required')
  const request = await storedCollection(env, input.text('request', { max: 100 }))
  insist(request.status === 'pending', 'collection_already_executed', 409)
  insist(input.text('basis_hash', { max: 100 }) === request.basis_hash, 'imported_collection_basis_changed', 409)
  const { source, basis } = await currentCollectionBasis(env, actor, request), stripe = collectionStripe(env)
  const current = await stripeCollectionSnapshot(stripe, request.invoice_ref).catch(collectionProviderRefusal)
  insist(await fingerprint(await collectionBasis(source, current, actor)) === request.basis_hash, 'stripe_invoice_source_changed', 409)
  const claimed = clockInstant(env), revision = newId()
  await commit(env, [collectionAuthority(env, actor), collectionSourceGuard(env, source),unusableMethodGuard(env,basis.snapshot.account,basis.snapshot.invoice.customer,basis.snapshot.paymentMethod),
    guard(env, 'collection_already_executed', "EXISTS(SELECT 1 FROM nc_imported_collections WHERE id=? AND status='pending' AND revision=? AND basis_hash=?)", request.id, request.revision, request.basis_hash),
    stmt(env, "UPDATE nc_imported_collections SET status='claimed',approved_by=?,approved_at=?,claimed_at=?,revision=? WHERE id=?", actor.id, claimed, claimed, revision, request.id),
  ], { actor: actorLabel(actor), action: 'imported.collection.claim', subject: request.id,
    detail: { invoice: request.invoice_id, basisHash: request.basis_hash, disableAutomaticAdvancement: true, onePaymentAttempt: true } })
  let liveRequest: Row = { ...request, status: 'claimed', revision }
  let paymentAttempted = false
  try {
    const disabled = invoiceFacts(await stripe(`/invoices/${encodeURIComponent(request.invoice_ref)}`, new URLSearchParams({ auto_advance: 'false' }), `${request.id}:disable-auto-advance`))
    matchOriginalInvoice(source.original, disabled)
    insist(disabled.auto_advance === false, 'stripe_automatic_collection_not_disabled', 409)
    // Recheck both owner authority and customer/source after the first network
    // mutation. Revocation/erasure must prevent the subsequent payment call.
    await collectionOwner(env, actor)
    const { source: stillCurrent } = await currentCollectionBasis(env, actor, liveRequest)
    liveRequest = await collectionChange(env, actor, liveRequest, { disabled_at: clockInstant(env) }, 'automatic.stop')
    // Read the original again immediately before the single processor attempt.
    const beforePayment = await stripeCollectionSnapshot(stripe, request.invoice_ref)
    matchOriginalInvoice(stillCurrent.original, beforePayment.invoice)
    insist(beforePayment.account === basis.snapshot.account && beforePayment.paymentMethod === basis.snapshot.paymentMethod
      && beforePayment.invoice.auto_advance === false, 'stripe_invoice_source_changed', 409)
    liveRequest = await collectionChange(env, actor, liveRequest, { error_code: 'stripe_payment_attempt_claimed' }, 'payment.attempt')
    await assertMethodUsable(env,basis.snapshot.account,basis.snapshot.invoice.customer,basis.snapshot.paymentMethod)
    paymentAttempted = true
    const intent = await stripe('/payment_intents', new URLSearchParams({ amount: String(request.amount_cents), currency: request.currency,
      customer: basis.snapshot.invoice.customer, payment_method: basis.snapshot.paymentMethod, confirm: 'true', off_session: 'true', error_on_requires_action: 'true',
      'payment_method_types[0]': basis.snapshot.paymentMethodType,
      'metadata[nectar_collection_key]': basis.intentKey, 'metadata[nectar_collection_request]': request.id,
      'metadata[nectar_original_invoice]': request.invoice_ref }), `nectar-movein-${basis.intentKey}`)
    const refusal = await saveRefusal(env,actor,liveRequest,basis,stripe,intent)
    if (refusal) return collectionView(refusal)
    liveRequest = await saveIntent(env, actor, liveRequest, basis, intent)
    const evidence = await stripeCollectedEvidence(stripe, intent, basis, request, (await requireBusiness(env)).timezone)
    liveRequest = await saveOutcome(env, actor, liveRequest, 'uncertain', evidence, 'stripe_mirror_unconfirmed')
    return collectionView(liveRequest)
  } catch (error) {
    if (paymentAttempted && error instanceof CollectionProviderError && error.intentRef) {
      try {
        // Read only: the current account response must match the original
        // customer, method, amount, currency, mode and collection metadata.
        const intent = await stripe(`/payment_intents/${encodeURIComponent(error.intentRef)}`)
        const refusal = await saveRefusal(env,actor,liveRequest,basis,stripe,intent)
        if (refusal) return collectionView(refusal)
      } catch { /* Incomplete or mismatched evidence remains uncertain. */ }
    }
    const failed = error instanceof CollectionProviderError && !error.uncertain
    return collectionView(await saveOutcome(env, actor, liveRequest, failed && !paymentAttempted ? 'failed' : 'uncertain', null,
      failed && !paymentAttempted ? 'stripe_request_refused' : liveRequest.charge_ref ? 'stripe_mirror_unconfirmed' : 'stripe_payment_not_confirmed'))
  }
}

export async function reconcileImportedCollection(env: Bindings, actor: Actor, input: Input) {
  await collectionOwner(env, actor)
  input.only(['request','returnTo'])
  const request = await storedCollection(env, input.text('request', { max: 100 }))
  if (['collected','failed'].includes(request.status)) return collectionView(request)
  insist(['claimed','uncertain'].includes(request.status), 'imported_collection_not_reconcilable', 409)
  const { source, basis } = await currentCollectionBasis(env, actor, request), stripe = collectionStripe(env)
  let current = request
  try {
    const snapshot = await stripeCollectionSnapshot(stripe, request.invoice_ref)
    insist(snapshot.account === basis.snapshot.account, 'stripe_invoice_source_changed', 409)
    matchOriginalInvoice(source.original, snapshot.invoice, true)
    const intent = await readCollectionIntent(stripe, basis, current)
    const refusal = await saveRefusal(env,actor,current,basis,stripe,intent)
    if (refusal) return collectionView(refusal)
    current = await saveIntent(env, actor, current, basis, intent)
    const evidence = await stripeCollectedEvidence(stripe, intent, basis, current, (await requireBusiness(env)).timezone)
    const mirrored = snapshot.invoice.status === 'paid' && snapshot.invoice.amount_remaining === 0 && snapshot.invoice.paid_out_of_band
    return collectionView(await saveOutcome(env, actor, current, mirrored ? 'collected' : 'uncertain',
      { ...evidence, custody: mirrored ? 'stripe-payment-intent-and-out-of-band-invoice' : evidence.custody }, mirrored ? null : 'stripe_mirror_unconfirmed'))
  } catch {
    return collectionView(await saveOutcome(env, actor, current, 'uncertain', null, current.charge_ref ? 'stripe_mirror_unconfirmed' : 'stripe_payment_not_confirmed'))
  }
}

/** Explicit mirror-only recovery. Never create, confirm or retry a charge. */
export async function finalizeImportedCollection(env: Bindings, actor: Actor, input: Input) {
  await collectionOwner(env, actor)
  input.only(['request','confirm','returnTo'])
  insist(input.flag('confirm'), 'imported_collection_confirmation_required')
  const request = await storedCollection(env, input.text('request', { max: 100 }))
  const { basis } = await currentCollectionBasis(env, actor, request)
  if (request.status === 'collected') return collectionView(request)
  insist(request.status === 'uncertain' && request.error_code !== 'stripe_mirror_claimed' && request.charge_ref
    && request.payment_intent_ref && request.payment_ref && request.collected_on, 'imported_collection_not_finalizable', 409)
  const stripe = collectionStripe(env)
  const intent = await readCollectionIntent(stripe, basis, request).catch(collectionProviderRefusal)
  const evidence = await stripeCollectedEvidence(stripe, intent, basis, request, (await requireBusiness(env)).timezone).catch(collectionProviderRefusal)
  return collectionView(await finishMirror(env, actor, request, stripe, basis, evidence, true))
}

export async function readImportedCollections(env: Bindings, actor: Actor, customer?: string) {
  await collectionOwner(env, actor)
  insist(customer === undefined || /^[\w-]{1,100}$/.test(customer), 'invalid_customer')
  return (await all(env, `SELECT * FROM nc_imported_collections ${customer ? 'WHERE customer_id=?' : ''} ORDER BY prepared_at DESC,id`, ...(customer ? [customer] : []))).map(collectionView)
}
