// Trial-only scheduled capture. A persisted human authority and an invoice-
// unique native claim precede the sole POST. Unknown results never retry.
import type { Bindings } from '../auth.server'
import { actorLabel } from './actor'
import { issueAuthorizedTrialInvoice } from './billruns'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, canonical, commit, fingerprint, guard, insist, newId, one, stmt, type Row } from './core'
import { today } from './dates'
import { nativeCollectionSource, nativeSourceGuard } from './payments/source'
import { bindingGuard, paymentIdentity, type NativeCollectionBasis } from './payments/state'
import { capturedPayment, NativeStripeError, readIntent, refusedPayment, verifyIntent } from './payments/stripe'
import { collectedPaymentStatements } from './receivables'
import { trialSystem } from './trial-collection-invoice'
import { currentTrialCollection, storedTrialCollection, trialCollectionGuard } from './trial-collection-records'

async function holdOutcome(env: Bindings, row: Row, native: Row, values: Row, status: string, error: string | null) {
  const nativeRevision = newId(), revision = newId(), at = clockInstant(env)
  const entries = Object.entries({ ...values, revision: nativeRevision, reconciled_at: at })
  await commit(env, [
    guard(env, 'trial_collection_state_changed', "EXISTS(SELECT 1 FROM nc_trial_collections WHERE id=? AND revision=? AND native_request_id=? AND status IN ('claimed','uncertain'))", row.id, row.revision, native.id),
    guard(env, 'native_collection_state_changed', "EXISTS(SELECT 1 FROM nc_native_collections WHERE id=? AND revision=? AND status IN ('claimed','uncertain'))", native.id, native.revision),
    stmt(env, `UPDATE nc_native_collections SET ${entries.map(([name])=>`${name}=?`).join(',')} WHERE id=?`, ...entries.map(([,value])=>value), native.id),
    stmt(env, 'UPDATE nc_trial_collections SET status=?,error_code=?,revision=? WHERE id=?', status, error, revision, row.id),
  ], { actor: actorLabel(trialSystem(row.id)), action: `trial.collection.${status}`, subject: row.id,
    detail: { nativeRequest: native.id, invoice: row.invoice_id, errorCode: error } })
  return { row: { ...row, status, error_code: error, revision }, native: { ...native, ...values, revision: nativeRevision } }
}

async function collectTrial(env: Bindings, authorization: string) {
  await issueAuthorizedTrialInvoice(env, authorization)
  let row = await storedTrialCollection(env, authorization)
  insist(row.status === 'active' && row.invoice_id, 'trial_collection_inactive', 409)
  const { q, selected } = await currentTrialCollection(env, row, true)
  const source = await nativeCollectionSource(env, row.invoice_id)
  insist(source.row.balance_cents === q.amountCents && source.payerId === q.customer
    && (!source.accountRef || source.accountRef === q.accountRef), 'trial_collection_terms_changed', 409)
  const request = newId(), key = await fingerprint(['nectar-native-collection-1', q.accountRef, row.invoice_id]), at = clockInstant(env)
  const basis: NativeCollectionBasis = { principal: q.owner, sourceHash: source.sourceHash, sourceFingerprint: source.row.source_fingerprint,
    customerRevision: source.row.customer_revision, bindingId: q.bindingId, bindingRevision: q.bindingRevision,
    payerCustomerId: source.payerId, payerRevision: source.payerRevision, invoiceId: source.row.id, invoiceNumber: source.row.number,
    customerId: q.customer, entityId: source.row.billing_entity_id, route: source.route, accountRef: q.accountRef,
    customerRef: q.customerRef, paymentMethodRef: q.paymentMethodRef, amountCents: q.amountCents, currency: 'usd', livemode: q.livemode, card: q.card, key }
  let native: Row = { id: request, invoice_id: row.invoice_id, customer_id: q.customer, amount_cents: q.amountCents,
    status: 'claimed', revision: newId(), basis_json: canonical(basis) }
  const revision = newId()
  await commit(env, [trialCollectionGuard(env, row), nativeSourceGuard(env, source), bindingGuard(env, basis),
    guard(env, 'native_collection_already_claimed', 'NOT EXISTS(SELECT 1 FROM nc_native_collection_claims WHERE invoice_id=?)', row.invoice_id),
    stmt(env, `INSERT INTO nc_native_collections(id,invoice_id,customer_id,account_ref,stripe_customer_ref,payment_method_ref,status,basis_json,basis_hash,amount_cents,currency,prepared_by,prepared_at,revision)
      VALUES(?,?,?,?,?,?,'pending',?,?,?,'usd',?,?,?)`, request, row.invoice_id, q.customer, q.accountRef, q.customerRef, q.paymentMethodRef, canonical(basis), await fingerprint(basis), q.amountCents, q.owner, at, native.revision),
    stmt(env, 'INSERT INTO nc_native_collection_claims(invoice_id,request_id,customer_id,account_ref,intent_key,claimed_by,claimed_at) VALUES(?,?,?,?,?,?,?)', row.invoice_id, request, q.customer, q.accountRef, key, `trial-policy:${row.id}`, at),
    stmt(env, "UPDATE nc_native_collections SET status='claimed',claimed_by=?,claimed_at=? WHERE id=?", `trial-policy:${row.id}`, at, request),
    stmt(env, "UPDATE nc_trial_collections SET status='claimed',native_request_id=?,revision=? WHERE id=?", request, revision, row.id),
  ], { actor: actorLabel(trialSystem(row.id)), action: 'trial.collection.claim', subject: row.id,
    detail: { basis: row.basis_hash, nativeRequest: request, invoice: row.invoice_id, owner: q.owner, approver: row.approved_by, amountCents: q.amountCents, chargeDate: q.chargeDate, onePaymentAttempt: true } })
  row = { ...row, status: 'claimed', native_request_id: request, revision }
  const identity = paymentIdentity(native, basis)
  try {
    // Recheck saved card, current authority, terms and date immediately before
    // the single charge. The DB guard uses the same durable revision.
    await currentTrialCollection(env, row, true)
    await commit(env, [trialCollectionGuard(env, row), nativeSourceGuard(env, source), bindingGuard(env, basis)], [])
    let intent: Row
    try {
      intent = await selected.stripe('/payment_intents', new URLSearchParams({ amount: String(q.amountCents), currency: 'usd', customer: q.customerRef,
        payment_method: q.paymentMethodRef, 'payment_method_types[0]': 'card', confirm: 'true', off_session: 'true', error_on_requires_action: 'true',
        'metadata[nectar_native_collection_key]': key, 'metadata[nectar_native_collection_request]': request, 'metadata[nectar_native_invoice]': row.invoice_id }), `nectar-native-${key}`)
    } catch (error) {
      if (!(error instanceof NativeStripeError) || !error.intentRef) throw error
      intent = await readIntent(selected.stripe, identity, error.intentRef, at, clockInstant(env))
    }
    verifyIntent(intent, identity)
    if (intent.status !== 'succeeded') intent = await readIntent(selected.stripe, identity, verifyIntent(intent, identity), at, clockInstant(env))
    const refusal = await refusedPayment(selected.stripe, intent, identity)
    if (refusal) {
      await holdOutcome(env, row, native, { status: refusal.status, payment_intent_ref: refusal.paymentIntentRef, proof_json: canonical(refusal), error_code: refusal.errorCode }, refusal.status, refusal.errorCode)
      return
    }
    const proof = await capturedPayment(selected.stripe, intent, identity, q.timezone)
    const held = await holdOutcome(env, row, native, { status: 'uncertain', payment_intent_ref: proof.paymentIntentRef,
      charge_ref: proof.chargeRef, proof_json: canonical(proof), error_code: 'native_payment_record_pending' }, 'uncertain', 'native_payment_record_pending')
    row = held.row; native = held.native
    insist(proof.receivedOn === q.chargeDate, 'trial_collection_capture_date_changed', 409)
    const financial = await collectedPaymentStatements(env, trialSystem(row.id), { customerId: q.customer, invoiceId: row.invoice_id,
      amountCents: q.amountCents, receivedOn: proof.receivedOn, reference: `stripe:${q.accountRef}:${proof.paymentIntentRef}`,
      evidence: canonical({ accountRef: q.accountRef, paymentIntentRef: proof.paymentIntentRef, chargeRef: proof.chargeRef,
        amountCents: q.amountCents, currency: 'usd', capturedAt: proof.capturedAt, proof: proof.proof }) })
    await commit(env, [trialCollectionGuard(env, row), nativeSourceGuard(env, source), bindingGuard(env, basis),
      guard(env, 'native_collection_state_changed', "EXISTS(SELECT 1 FROM nc_native_collections WHERE id=? AND revision=? AND status='uncertain')", request, native.revision),
      ...financial.statements,
      stmt(env, "UPDATE nc_native_collections SET status='collected',payment_id=?,allocation_id=?,error_code=NULL,reconciled_at=?,revision=? WHERE id=?", financial.paymentId, financial.allocationId, clockInstant(env), newId(), request),
      stmt(env, "UPDATE nc_trial_collections SET status='collected',error_code=NULL,ended_at=?,revision=? WHERE id=?", clockInstant(env), newId(), row.id),
    ], [...financial.audits, { actor: actorLabel(trialSystem(row.id)), action: 'trial.collection.collected', subject: row.id,
      detail: { invoice: row.invoice_id, nativeRequest: request, payment: financial.paymentId, amountCents: q.amountCents, chargeDate: q.chargeDate, paymentIntentRef: proof.paymentIntentRef, chargeRef: proof.chargeRef } }])
  } catch {
    const current = await one(env, 'SELECT * FROM nc_native_collections WHERE id=?', request)
    if (current && ['claimed','uncertain'].includes(current.status)) {
      const held = await storedTrialCollection(env, authorization)
      await holdOutcome(env, held, current, { status: 'uncertain', error_code: current.charge_ref ? 'native_payment_record_pending' : 'native_payment_unconfirmed' }, 'uncertain', current.charge_ref ? 'native_payment_record_pending' : 'native_payment_unconfirmed')
    }
  }
}

export async function runTrialCollections(env: Bindings) {
  const business = await requireBusiness(env), date = today(business.timezone, clockInstant(env))
  for (const row of await all(env, "SELECT * FROM nc_trial_collections WHERE status IN ('pending_owner','pending_approval','active') AND trial_end<=? ORDER BY trial_end,id", date)) {
    if (row.trial_end < date) {
      await commit(env, [guard(env, 'trial_collection_state_changed', 'EXISTS(SELECT 1 FROM nc_trial_collections WHERE id=? AND revision=?)', row.id, row.revision),
        stmt(env, "UPDATE nc_trial_collections SET status='expired',ended_at=?,revision=? WHERE id=?", clockInstant(env), newId(), row.id)],
      { actor: actorLabel(trialSystem(row.id)), action: 'trial.collection.expired', subject: row.id, detail: { approvedDate: row.trial_end, noCatchUpCharge: true } })
      continue
    }
    if (row.status !== 'active') continue
    try { await collectTrial(env, row.id) } catch (error) {
      // Pre-claim failures invalidate the authority. After a claim the existing
      // native record is the only recovery path, with read-only reconciliation.
      const held = await storedTrialCollection(env, row.id)
      if (held.status !== 'active') continue
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'trial_collection_unavailable'
      await commit(env, [guard(env, 'trial_collection_state_changed', "EXISTS(SELECT 1 FROM nc_trial_collections WHERE id=? AND revision=? AND status='active')", held.id, held.revision),
        stmt(env, "UPDATE nc_trial_collections SET status='invalidated',error_code=?,ended_at=?,revision=? WHERE id=?", code, clockInstant(env), newId(), held.id)],
      { actor: actorLabel(trialSystem(row.id)), action: 'trial.collection.invalidated', subject: held.id, detail: { errorCode: code, noPaymentAttempt: true } })
    }
  }
}
