import type { Bindings } from '../auth.server'
import { actorLabel, type Actor } from './actor'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { canonical, commit, fingerprint, guard, insist, newId, one, parseJson, stmt, type Row } from './core'
import { localDate, requireDate } from './dates'
import { setupOwner, setupOwnerFence } from './hosted-setup-basis'
import type { Input } from './input'
import { bindingFence, currentSource, eligibleGuard, partialAuthorityGuard, partialPaymentRow, partialPaymentView, reservationGuard, rowGuard, sourceForPartial } from './invoice-partial-payments'
import { customerText } from './locale'
import { savedCollectionMethod } from './payments/default-method'
import { nativeSourceGuard } from './payments/source'
import { capturedPayment, NativeStripeError, providerReference, readIntent, refusedPayment, stripeForAccount, verifyIntent, type PaymentIdentity, type StripeClient } from './payments/stripe'
import { customerSessionGuard, type CustomerSession } from './portal-session'
import { collectedPaymentStatements } from './receivables'

const quote = (row: Row) => parseJson<Row>(row.basis_json, {})
function dateAllowed(env: Bindings, basis: Row) {
  const date = requireDate(basis.scheduledOn, 'scheduled_on')
  insist(date >= localDate(clockInstant(env), basis.timezone) && date <= basis.dueDate, 'invoice_schedule_date_invalid', 409)
}
async function unchangedMethod(stripe: StripeClient, basis: Row) {
  insist(canonical(await savedCollectionMethod(stripe, basis.customerRef, basis.method.mandateRef)) === canonical(basis.method), 'invoice_schedule_method_changed', 409)
}
export async function prepareInvoiceSchedule(env: Bindings, actor: Actor, input: Input) {
  await setupOwner(env, actor)
  input.only(['invoice','scheduled_on','mandate_ref','returnTo'])
  const source = await sourceForPartial(env, input.text('invoice', { max: 100 })), business = await requireBusiness(env)
  const {stripe, account} = await stripeForAccount(env, source.accountRef)
  const binding = await one(env, 'SELECT * FROM nc_stripe_customer_bindings WHERE customer_id=? AND account_ref=?', source.row.customer_id, account)
  insist(binding, 'native_customer_binding_required', 409)
  const method = await savedCollectionMethod(stripe, binding.stripe_customer_ref, input.text('mandate_ref', { max: 255 }))
  insist(method.kind === 'us_bank_account', 'invoice_schedule_bank_required', 409)
  const basis = { sourceHash: source.sourceHash, invoice: source.row.id, number: source.row.number, customer: source.row.customer_id,
    amountCents: source.row.balance_cents, balanceCents: source.row.balance_cents, account, customerRef: binding.stripe_customer_ref,
    binding: binding.id, bindingRevision: binding.revision, timezone: business.timezone, businessRevision: business.revision,
    scheduledOn: input.text('scheduled_on', { max: 10 }), dueDate: source.row.due_date, method, attempts: 1,
    execution: 'fresh-owner-confirmation-on-exact-date' }
  dateAllowed(env, basis)
  const id = newId(), at = clockInstant(env), hash = await fingerprint(basis), factor = await setupOwner(env, actor)
  await commit(env, [...setupOwnerFence(env, actor), nativeSourceGuard(env, source), eligibleGuard(env, source.row.id),
    bindingFence(env, {binding_id: binding.id, binding_revision: binding.revision, customer_id: source.row.customer_id, account_ref: account, customer_ref: binding.stripe_customer_ref}),
    stmt(env, `INSERT INTO nc_invoice_partial_payments(id,invoice_id,customer_id,status,amount_cents,balance_cents,basis_json,basis_hash,account_ref,customer_ref,binding_id,binding_revision,prepared_by,prepared_at,revision,payment_kind)
      VALUES(?,?,?,'prepared',?,?,?,?,?,?,?,?,?,?,?,'scheduled_ach')`, id, source.row.id, source.row.customer_id, source.row.balance_cents, source.row.balance_cents, canonical(basis), hash, account, binding.stripe_customer_ref, binding.id, binding.revision, actor.id, at, newId()),
    stmt(env, 'INSERT INTO nc_invoice_partial_authority(id,customer_id,owner_session_id,factor_verified_at) VALUES(?,?,?,?)', id, source.row.customer_id, actor.sessionId, factor.verifiedAt)],
  {actor: actorLabel(actor), action: 'invoice.schedule.prepare', subject: id, detail: {invoice: source.row.id, amountCents: basis.amountCents, scheduledOn: basis.scheduledOn, basisHash: hash}})
  return partialPaymentView(await partialPaymentRow(env, id))
}
export async function validateScheduleConfirmation(env: Bindings, row: Row, input: Input) {
  const basis = quote(row)
  insist(input.text('scheduled_on', {max: 10}) === basis.scheduledOn && input.text('payment_method_ref', {max: 255}) === basis.method.paymentMethodRef
    && input.text('mandate_ref', {max: 255}) === basis.method.mandateRef, 'invoice_schedule_confirmation_changed', 409)
  dateAllowed(env, basis)
  await unchangedMethod((await stripeForAccount(env, row.account_ref)).stripe, basis)
}
function businessFence(env: Bindings, row: Row) {
  const basis = quote(row)
  return guard(env, 'invoice_schedule_business_changed', 'EXISTS(SELECT 1 FROM nc_business WHERE singleton=1 AND revision=? AND timezone=?)', basis.businessRevision, basis.timezone)
}
function acceptedFence(env: Bindings, row: Row) {
  // Acceptance is a dated instruction, not an extension of the customer
  // session. Explicit session revocation or archive restoration withdraws it.
  return guard(env, 'invoice_schedule_consent_withdrawn', `EXISTS(SELECT 1 FROM nc_invoice_schedule_authority a
    JOIN nc_portal_sessions p ON p.id=a.portal_session_id AND p.customer_id=a.customer_id
    JOIN nc_portal_policy policy ON policy.singleton=1 AND policy.revision=p.policy_revision
    WHERE a.id=? AND a.customer_id=? AND a.basis_hash=? AND p.revoked_at IS NULL)`, row.id, row.customer_id, row.basis_hash)
}
export async function acceptInvoiceSchedule(env: Bindings, session: CustomerSession, row: Row, input: Input) {
  input.only(['request','basis_hash','accept'])
  insist(session.audience === 'hosted' && session.customer === row.customer_id, 'invoice_partial_not_found', 404)
  insist(row.payment_kind === 'scheduled_ach' && row.status === 'approved' && input.flag('accept') && input.text('basis_hash', {max: 100}) === row.basis_hash,
    'invoice_schedule_acceptance_changed', 409)
  const source = await currentSource(env, row), basis = quote(row), at = clockInstant(env), L = customerText(session.language)
  dateAllowed(env, basis)
  await unchangedMethod((await stripeForAccount(env, row.account_ref)).stripe, basis)
  await commit(env, [customerSessionGuard(env, session), partialAuthorityGuard(env, row), rowGuard(env, row), reservationGuard(env, row),
    nativeSourceGuard(env, source), bindingFence(env, row), eligibleGuard(env, row.invoice_id), businessFence(env, row),
    stmt(env, 'INSERT INTO nc_invoice_schedule_authority(id,customer_id,portal_session_id,basis_hash,accepted_at) VALUES(?,?,?,?,?)', row.id, row.customer_id, session.jti, row.basis_hash, at),
    stmt(env, "UPDATE nc_invoice_partial_payments SET status='open',accepted_at=?,consent_json=?,revision=? WHERE id=?", at,
      canonical({version: 1, wording: L.t('schedule.accept'), language: L.tag, basisHash: row.basis_hash, scheduledOn: basis.scheduledOn,
        invoice: row.invoice_id, customer: row.customer_id, account: row.account_ref, amountCents: row.amount_cents, method: basis.method, acceptedAt: at}), newId(), row.id)],
  {actor: 'customer:invoice-schedule', action: 'invoice.schedule.accept', subject: row.id, detail: {basisHash: row.basis_hash, scheduledOn: basis.scheduledOn, amountCents: row.amount_cents}})
  return partialPaymentRow(env, row.id)
}
export async function withdrawInvoiceSchedule(env: Bindings, session: CustomerSession, row: Row, input: Input) {
  input.only(['request','withdraw'])
  insist(session.audience === 'hosted' && session.customer === row.customer_id, 'invoice_partial_not_found', 404)
  insist(row.payment_kind === 'scheduled_ach' && ['approved','open'].includes(row.status) && !row.claimed_at && input.flag('withdraw'), 'invoice_partial_requires_reconciliation', 409)
  await commit(env, [customerSessionGuard(env, session), rowGuard(env, row),
    stmt(env, 'DELETE FROM nc_invoice_schedule_authority WHERE id=?', row.id), stmt(env, 'DELETE FROM nc_invoice_partial_authority WHERE id=?', row.id),
    stmt(env, 'DELETE FROM nc_invoice_partial_reservations WHERE request_id=?', row.id),
    stmt(env, "UPDATE nc_invoice_partial_payments SET status='revoked',revision=? WHERE id=?", newId(), row.id)],
  {actor: 'customer:invoice-schedule', action: 'invoice.schedule.withdraw', subject: row.id})
  return partialPaymentRow(env, row.id)
}
function identity(row: Row): PaymentIdentity {
  return {accountRef: row.account_ref, customerRef: row.customer_ref, paymentMethodRef: quote(row).method.paymentMethodRef,
    livemode: false, invoiceId: row.invoice_id, requestId: row.id, key: row.basis_hash, amountCents: row.amount_cents, currency: 'USD'}
}
export async function executeInvoiceSchedule(env: Bindings, actor: Actor, input: Input) {
  await setupOwner(env, actor)
  input.only(['request','basis_hash','scheduled_on','amount_cents','payment_method_ref','confirm','returnTo'])
  let row = await partialPaymentRow(env, input.text('request', {max: 100})), basis = quote(row)
  insist(row.payment_kind === 'scheduled_ach' && row.prepared_by === actor.id && row.status === 'open' && !row.claimed_at, 'invoice_schedule_not_executable', 409)
  insist(input.flag('confirm') && input.text('basis_hash', {max: 100}) === row.basis_hash && input.text('scheduled_on', {max: 10}) === basis.scheduledOn
    && input.integer('amount_cents', {min: 50, max: 99999999}) === row.amount_cents && input.text('payment_method_ref', {max: 255}) === basis.method.paymentMethodRef,
    'invoice_schedule_confirmation_changed', 409)
  insist(localDate(clockInstant(env), basis.timezone) === basis.scheduledOn, 'invoice_schedule_not_today', 409)
  const source = await currentSource(env, row), {stripe} = await stripeForAccount(env, row.account_ref)
  await unchangedMethod(stripe, basis)
  // The financial reservation and all existing conflicts are checked in the
  // same transaction as the permanent once-only submission claim.
  await commit(env, [...setupOwnerFence(env, actor), rowGuard(env, row), reservationGuard(env, row), acceptedFence(env, row), businessFence(env, row),
    nativeSourceGuard(env, source), bindingFence(env, row), eligibleGuard(env, row.invoice_id),
    stmt(env, "UPDATE nc_invoice_partial_payments SET status='claimed',claimed_at=?,revision=? WHERE id=?", clockInstant(env), newId(), row.id)],
  {actor: actorLabel(actor), action: 'invoice.schedule.claim', subject: row.id, detail: {invoice: row.invoice_id, scheduledOn: basis.scheduledOn, amountCents: row.amount_cents}})
  row = await partialPaymentRow(env, row.id)
  // A claim survives process death and lost responses. Only reconciliation is
  // available afterward; even an empty provider search permits no second POST.
  try {
    await commit(env, [...setupOwnerFence(env, actor), rowGuard(env, row), reservationGuard(env, row), acceptedFence(env, row), businessFence(env, row), nativeSourceGuard(env, source), bindingFence(env, row), eligibleGuard(env, row.invoice_id)],
      {actor: actorLabel(actor), action: 'invoice.schedule.submit', subject: row.id})
    const fields = new URLSearchParams({amount: String(row.amount_cents), currency: 'usd', customer: row.customer_ref,
      payment_method: basis.method.paymentMethodRef, mandate: basis.method.mandateRef, 'payment_method_types[0]': 'us_bank_account', confirm: 'true', off_session: 'true',
      'metadata[nectar_native_collection_key]': row.basis_hash, 'metadata[nectar_native_collection_request]': row.id, 'metadata[nectar_native_invoice]': row.invoice_id})
    let intent: Row
    try { intent = await stripe('/payment_intents', fields, `nectar-invoice-schedule-${row.id}`) }
    catch (error) {
      if (!(error instanceof NativeStripeError) || !error.intentRef) throw error
      intent = await readIntent(stripe, identity(row), error.intentRef, row.claimed_at, clockInstant(env))
    }
    return partialPaymentView(await settle(env, row, stripe, intent))
  } catch {
    const current = await partialPaymentRow(env, row.id)
    if (['collected','expired'].includes(current.status)) return partialPaymentView(current)
    await commit(env, [rowGuard(env, current), stmt(env, "UPDATE nc_invoice_partial_payments SET status='uncertain',error_code='scheduled_payment_unconfirmed',revision=? WHERE id=?", newId(), row.id)],
    {actor: actorLabel(actor), action: 'invoice.schedule.uncertain', subject: row.id})
    return partialPaymentView(await partialPaymentRow(env, row.id))
  }
}
async function settle(env: Bindings, row: Row, stripe: StripeClient, intent: Row, session?: CustomerSession) {
  const expected = identity(row), intentRef = verifyIntent(intent, expected), basis = quote(row)
  const source = await currentSource(env, row)
  const guards = [rowGuard(env, row), reservationGuard(env, row), nativeSourceGuard(env, source), bindingFence(env, row), ...(session ? [customerSessionGuard(env, session)] : [])]
  const refusal = await refusedPayment(stripe, intent, expected)
  if (intent.status === 'processing') {
    await commit(env, [...guards, stmt(env, "UPDATE nc_invoice_partial_payments SET status='open',payment_intent_ref=?,error_code=NULL,revision=? WHERE id=?", intentRef, newId(), row.id)],
    {actor: 'system:invoice-schedule', action: 'invoice.schedule.pending', subject: row.id})
    return partialPaymentRow(env, row.id)
  }
  let proof: Row | null = null
  if (!refusal) {
    proof = await capturedPayment(stripe, intent, expected, basis.timezone)
    insist(proof.capturedAt >= row.claimed_at - 300000 && proof.capturedAt <= clockInstant(env), 'invoice_partial_capture_date_invalid', 409)
    const charge = await stripe(`/charges/${encodeURIComponent(proof.chargeRef)}`), transactionRef = providerReference(charge.balance_transaction)
    const transaction = await stripe(`/balance_transactions/${encodeURIComponent(transactionRef)}`)
    insist(transaction.object === 'balance_transaction' && transaction.id === transactionRef && transaction.type === 'payment'
      && providerReference(transaction.source) === proof.chargeRef && transaction.amount === row.amount_cents && transaction.currency === 'usd'
      && Number.isSafeInteger(transaction.available_on), 'invoice_schedule_settlement_unconfirmed', 409)
    insist(transaction.status === 'available' && transaction.available_on * 1000 <= clockInstant(env), 'invoice_schedule_settlement_pending', 409)
    proof = {...proof, settledAt: transaction.available_on * 1000}
  }
  const recording: Actor = {kind: 'agent', id: 'invoice-schedule', name: 'invoice-schedule', email: '', role: null, sessionId: null, capabilities: new Set(['receivables'])}
  const financial = proof ? await collectedPaymentStatements(env, recording, {customerId: row.customer_id, invoiceId: row.invoice_id,
    amountCents: row.amount_cents, balanceCents: row.balance_cents, currency: 'USD', method: 'bank_transfer',
    receivedOn: localDate(proof.settledAt, basis.timezone), reference: `stripe:${row.account_ref}:${intentRef}`, evidence: canonical(proof)}) : null
  await commit(env, [...guards, stmt(env, 'DELETE FROM nc_invoice_partial_reservations WHERE request_id=?', row.id), ...(financial?.statements ?? []),
    stmt(env, "UPDATE nc_invoice_partial_payments SET status=?,payment_intent_ref=?,charge_ref=?,payment_id=?,allocation_id=?,proof_json=?,completed_at=?,error_code=?,revision=? WHERE id=?",
      proof ? 'collected' : 'expired', intentRef, proof?.chargeRef ?? null, financial?.paymentId ?? null, financial?.allocationId ?? null, canonical(proof ?? refusal), clockInstant(env), refusal?.errorCode ?? null, newId(), row.id),
    stmt(env, 'DELETE FROM nc_invoice_schedule_authority WHERE id=?', row.id), stmt(env, 'DELETE FROM nc_invoice_partial_authority WHERE id=?', row.id)],
  [...(financial?.audits ?? []), {actor: 'system:invoice-schedule', action: proof ? 'invoice.schedule.collected' : 'invoice.schedule.refused', subject: row.id, detail: {invoice: row.invoice_id, payment: financial?.paymentId ?? null, amountCents: row.amount_cents}}])
  return partialPaymentRow(env, row.id)
}
export async function reconcileScheduledPayment(env: Bindings, row: Row, session?: CustomerSession) {
  if (session) insist(session.customer === row.customer_id && session.audience === 'hosted', 'forbidden', 403)
  if (['collected','expired'].includes(row.status)) return row
  insist(row.claimed_at && ['claimed','open','uncertain'].includes(row.status), 'invoice_schedule_not_claimed', 409)
  const {stripe} = await stripeForAccount(env, row.account_ref)
  return settle(env, row, stripe, await readIntent(stripe, identity(row), row.payment_intent_ref, row.claimed_at, clockInstant(env)), session)
}
