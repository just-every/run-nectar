// Explicit manual collection only. A durable invoice claim precedes the one
// off-session confirmation; all recovery reads Stripe without another POST.
import type { Bindings } from '../../auth.server'
import { actorLabel, type Actor } from '../actor'
import { requireBusiness } from '../business'
import { clockInstant } from '../clock'
import { canonical, commit, fingerprint, guard, insist, newId, one, stmt, type Row } from '../core'
import type { Input } from '../input'
import { collectionAuthority, collectionOwner } from '../movein/collection-state'
import { collectedPaymentStatements } from '../receivables'
import { prepaidFundingForInvoice } from '../prepaid-records'
import { prepaidFundingStatements } from '../prepaid-funding'
import { nativeCollectionSource, nativeSourceGuard } from './source'
import { bindingGuard, currentNativeCollection, nativeCollectionRows, nativeCollectionView, paymentIdentity, storedNativeCollection, type NativeCollectionBasis } from './state'
import { capturedPayment, providerUnavailable, readIntent, savedCard, stripeForAccount, verifyIntent } from './stripe'

export { bindNativeCollectionCustomer } from './customer'

export async function prepareNativeCollection(env: Bindings, actor: Actor, input: Input) {
  await collectionOwner(env, actor)
  input.only(['invoice', 'returnTo'])
  const source = await nativeCollectionSource(env, input.text('invoice', { max: 100 }))
  await prepaidFundingForInvoice(env, source.row.id)
  insist(!await one(env, 'SELECT 1 FROM nc_native_collection_claims WHERE invoice_id=?', source.row.id), 'native_collection_already_claimed', 409)
  const selected = await stripeForAccount(env, source.accountRef).catch(providerUnavailable)
  const binding = await one(env, 'SELECT * FROM nc_stripe_customer_bindings WHERE customer_id=? AND account_ref=?', source.row.customer_id, selected.account)
  insist(binding, 'native_customer_binding_required', 409)
  const card = await savedCard(selected.stripe, binding.stripe_customer_ref).catch(providerUnavailable)
  const basis: NativeCollectionBasis = { principal: actor.id, sourceHash: source.sourceHash, sourceFingerprint: source.row.source_fingerprint,
    customerRevision: source.row.customer_revision, bindingId: binding.id, bindingRevision: binding.revision,
    invoiceId: source.row.id, invoiceNumber: source.row.number, customerId: source.row.customer_id, entityId: source.row.billing_entity_id,
    route: source.route, accountRef: selected.account, customerRef: card.customerRef, paymentMethodRef: card.paymentMethodRef,
    amountCents: source.row.balance_cents, currency: 'usd', livemode: card.livemode, card: card.card,
    key: await fingerprint(['nectar-native-collection-1', selected.account, source.row.id]) }
  const id = newId(), hash = await fingerprint(basis), at = clockInstant(env)
  await commit(env, [collectionAuthority(env, actor), nativeSourceGuard(env, source), bindingGuard(env, basis),
    guard(env, 'native_collection_already_claimed', 'NOT EXISTS(SELECT 1 FROM nc_native_collection_claims WHERE invoice_id=?)', source.row.id),
    stmt(env, `INSERT INTO nc_native_collections(id,invoice_id,customer_id,account_ref,stripe_customer_ref,payment_method_ref,status,basis_json,basis_hash,amount_cents,currency,prepared_by,prepared_at,revision)
      VALUES(?,?,?,?,?,?,'pending',?,?,?,'usd',?,?,?)`, id, source.row.id, source.row.customer_id, selected.account, card.customerRef, card.paymentMethodRef, canonical(basis), hash, basis.amountCents, actor.id, at, newId()),
  ], { actor: actorLabel(actor), action: 'collection.prepare', subject: id, detail: { invoice: source.row.id, amountCents: basis.amountCents, accountRef: basis.accountRef, basisHash: hash } })
  return nativeCollectionView(await storedNativeCollection(env, id))
}

async function changeOutcome(env: Bindings, actor: Actor, row: Row, values: Row, action: string) {
  const entries = Object.entries({ ...values, revision: newId(), reconciled_at: clockInstant(env) })
  await commit(env, [collectionAuthority(env, actor),
    guard(env, 'native_collection_state_changed', "EXISTS(SELECT 1 FROM nc_native_collections WHERE id=? AND revision=? AND status IN ('claimed','uncertain'))", row.id, row.revision),
    stmt(env, `UPDATE nc_native_collections SET ${entries.map(([name]) => `${name}=?`).join(',')} WHERE id=?`, ...entries.map(([, value]) => value), row.id),
  ], { actor: actorLabel(actor), action: `collection.${action}`, subject: row.id, detail: { invoice: row.invoice_id, status: values.status ?? row.status, errorCode: values.error_code ?? null } })
  return storedNativeCollection(env, row.id)
}

type CapturedProof = Awaited<ReturnType<typeof capturedPayment>>
async function recordCaptured(env: Bindings, actor: Actor, row: Row, proof: CapturedProof) {
  // Save exact captured evidence before the financial batch. A concurrent
  // balance change remains visible and never becomes permission to charge again.
  const held = await changeOutcome(env, actor, row, { status: 'uncertain', payment_intent_ref: proof.paymentIntentRef,
    charge_ref: proof.chargeRef, proof_json: canonical(proof), error_code: 'native_payment_record_pending' }, 'capture.record')
  const { source, basis } = await currentNativeCollection(env, actor, held)
  const financial = await collectedPaymentStatements(env, actor, { customerId: held.customer_id, invoiceId: held.invoice_id,
    amountCents: held.amount_cents, receivedOn: proof.receivedOn, reference: `stripe:${proof.accountRef}:${proof.paymentIntentRef}`,
    evidence: canonical({ accountRef: proof.accountRef, paymentIntentRef: proof.paymentIntentRef, chargeRef: proof.chargeRef,
      amountCents: proof.amountCents, currency: proof.currency, capturedAt: proof.capturedAt, proof: proof.proof }) })
  const funding = await prepaidFundingForInvoice(env, held.invoice_id)
  const fundingStatements = funding ? await prepaidFundingStatements(env, funding.id, { paymentId: financial.paymentId,
    invoiceId: held.invoice_id, amountCents: held.amount_cents, providerRef: proof.paymentIntentRef }) : []
  await commit(env, [collectionAuthority(env, actor), nativeSourceGuard(env, source), bindingGuard(env, basis),
    guard(env, 'native_collection_state_changed', "EXISTS(SELECT 1 FROM nc_native_collections WHERE id=? AND revision=? AND status='uncertain') AND EXISTS(SELECT 1 FROM nc_native_collection_claims WHERE invoice_id=? AND request_id=?)", held.id, held.revision, held.invoice_id, held.id),
    ...financial.statements,
    ...fundingStatements,
    stmt(env, "UPDATE nc_native_collections SET status='collected',payment_id=?,allocation_id=?,error_code=NULL,reconciled_at=?,revision=? WHERE id=?", financial.paymentId, financial.allocationId, clockInstant(env), newId(), held.id),
  ], [...financial.audits, { actor: actorLabel(actor), action: 'collection.collected', subject: held.id,
    detail: { invoice: held.invoice_id, payment: financial.paymentId, allocation: financial.allocationId, amountCents: held.amount_cents, accountRef: proof.accountRef, paymentIntentRef: proof.paymentIntentRef, chargeRef: proof.chargeRef } }])
  return nativeCollectionView(await storedNativeCollection(env, held.id))
}

export async function confirmNativeCollection(env: Bindings, actor: Actor, input: Input) {
  await collectionOwner(env, actor)
  input.only(['request', 'basis_hash', 'confirm', 'amount_cents', 'account_ref', 'stripe_customer_ref', 'payment_method_ref', 'returnTo'])
  insist(input.flag('confirm'), 'native_collection_confirmation_required')
  const row = await storedNativeCollection(env, input.text('request', { max: 100 }))
  insist(row.status === 'pending', 'native_collection_already_claimed', 409)
  const { source, basis } = await currentNativeCollection(env, actor, row)
  await prepaidFundingForInvoice(env, row.invoice_id)
  insist(input.text('basis_hash', { max: 100 }) === row.basis_hash && input.integer('amount_cents', { min: 50, max: 99999999 }) === basis.amountCents
    && input.text('account_ref', { max: 255 }) === basis.accountRef && input.text('stripe_customer_ref', { max: 255 }) === basis.customerRef
    && input.text('payment_method_ref', { max: 255 }) === basis.paymentMethodRef, 'native_collection_confirmation_changed', 409)
  const selected = await stripeForAccount(env, basis.accountRef).catch(providerUnavailable)
  insist(canonical(await savedCard(selected.stripe, basis.customerRef).catch(providerUnavailable)) === canonical({ customerRef: basis.customerRef, paymentMethodRef: basis.paymentMethodRef, livemode: basis.livemode, card: basis.card }), 'native_collection_card_changed', 409)
  const revision = newId(), at = clockInstant(env)
  await commit(env, [collectionAuthority(env, actor), nativeSourceGuard(env, source), bindingGuard(env, basis),
    guard(env, 'native_collection_already_claimed', "EXISTS(SELECT 1 FROM nc_native_collections WHERE id=? AND status='pending' AND revision=? AND basis_hash=?) AND NOT EXISTS(SELECT 1 FROM nc_native_collection_claims WHERE invoice_id=?)", row.id, row.revision, row.basis_hash, row.invoice_id),
    stmt(env, 'INSERT INTO nc_native_collection_claims(invoice_id,request_id,customer_id,account_ref,intent_key,claimed_by,claimed_at) VALUES(?,?,?,?,?,?,?)', row.invoice_id, row.id, row.customer_id, basis.accountRef, basis.key, actor.id, at),
    stmt(env, "UPDATE nc_native_collections SET status='claimed',claimed_by=?,claimed_at=?,revision=? WHERE id=?", actor.id, at, revision, row.id),
  ], { actor: actorLabel(actor), action: 'collection.claim', subject: row.id, detail: { invoice: row.invoice_id, basisHash: row.basis_hash, amountCents: row.amount_cents, accountRef: basis.accountRef, onePaymentAttempt: true } })
  let current: Row = { ...row, status: 'claimed', revision }
  try {
    await collectionOwner(env, actor)
    await currentNativeCollection(env, actor, current)
    await prepaidFundingForInvoice(env, row.invoice_id)
    const identity = paymentIdentity(current, basis)
    const intent = await selected.stripe('/payment_intents', new URLSearchParams({ amount: String(basis.amountCents), currency: 'usd', customer: basis.customerRef,
      payment_method: basis.paymentMethodRef, 'payment_method_types[0]': 'card', confirm: 'true', off_session: 'true', error_on_requires_action: 'true',
      'metadata[nectar_native_collection_key]': basis.key, 'metadata[nectar_native_collection_request]': row.id,
      'metadata[nectar_native_invoice]': row.invoice_id }), `nectar-native-${basis.key}`)
    const intentRef = verifyIntent(intent, identity)
    current = await changeOutcome(env, actor, current, { payment_intent_ref: intentRef }, 'intent.record')
    const proof = await capturedPayment(selected.stripe, intent, identity, (await requireBusiness(env)).timezone)
    return await recordCaptured(env, actor, current, proof)
  } catch {
    // No response/body is logged or retried. Even a definitive provider refusal
    // cannot release the unique invoice claim for another confirm request.
    current = await storedNativeCollection(env, row.id)
    if (current.status === 'collected') return nativeCollectionView(current)
    return nativeCollectionView(await changeOutcome(env, actor, current, { status: 'uncertain', error_code: current.charge_ref ? 'native_payment_record_pending' : 'native_payment_unconfirmed' }, 'uncertain'))
  }
}

export async function reconcileNativeCollection(env: Bindings, actor: Actor, input: Input) {
  await collectionOwner(env, actor)
  input.only(['request', 'returnTo'])
  let row = await storedNativeCollection(env, input.text('request', { max: 100 }))
  if (row.status === 'collected') return nativeCollectionView(row)
  insist(['claimed', 'uncertain'].includes(row.status), 'native_collection_not_reconcilable', 409)
  const { basis } = await currentNativeCollection(env, actor, row)
  try {
    const selected = await stripeForAccount(env, basis.accountRef)
    const identity = paymentIdentity(row, basis), intent = await readIntent(selected.stripe, identity, row.payment_intent_ref)
    const intentRef = verifyIntent(intent, identity)
    row = await changeOutcome(env, actor, row, { payment_intent_ref: intentRef }, 'intent.read')
    return await recordCaptured(env, actor, row, await capturedPayment(selected.stripe, intent, identity, (await requireBusiness(env)).timezone))
  } catch {
    row = await storedNativeCollection(env, row.id)
    if (row.status === 'collected') return nativeCollectionView(row)
    return nativeCollectionView(await changeOutcome(env, actor, row, { status: 'uncertain', error_code: row.charge_ref ? 'native_payment_record_pending' : 'native_payment_unconfirmed' }, 'uncertain'))
  }
}

export async function readNativeCollections(env: Bindings, actor: Actor, customer?: string) {
  await collectionOwner(env, actor)
  insist(customer === undefined || /^[\w-]{1,100}$/.test(customer), 'invalid_customer')
  return (await nativeCollectionRows(env, customer)).map(nativeCollectionView)
}
