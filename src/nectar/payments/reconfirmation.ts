// One explicit recovery of a definitive soft refusal. The original invoice
// claim and intent identity survive every preparation, timeout and replay.
import type { Bindings } from '../../auth.server'
import { actorLabel, type Actor } from '../actor'
import { assertMethodUsable, unusableMethodGuard } from '../card-lifecycle'
import { collectionHold } from '../cadence-holds'
import { clockInstant } from '../clock'
import { canonical, commit, fingerprint, guard, insist, newId, one, parseJson, stmt, type Row } from '../core'
import { setupOwner, setupOwnerFence } from '../hosted-setup-basis'
import type { Input } from '../input'
import { today } from '../dates'
import { requireBusiness } from '../business'
import { prepaidFundingForInvoice } from '../prepaid-records'
import { nextRetry, selectedRetryPolicy, DAY } from '../retry-policy'
import { nativeCollectionSource, nativeSourceGuard } from './source'
import { bindingGuard, nativeCollectionView, paymentIdentity, storedNativeCollection, type NativeCollectionBasis } from './state'
import { changeOutcome, recordIntentOutcome } from './collection'
import { NativeStripeError, confirmExistingCardIntent, providerUnavailable, readIntent, refusedPayment, savedCard, stripeForAccount } from './stripe'

async function recoverySource(env: Bindings, actor: Actor, row: Row) {
  insist(row.status === 'declined' && row.payment_intent_ref && !row.payment_id && !row.charge_ref
    && !row.reconfirmation?.claimed_at, 'native_recovery_not_eligible', 409)
  const original = parseJson<NativeCollectionBasis | null>(row.basis_json, null), failure = parseJson<Row>(row.proof_json, {})
  const code = failure.declineCode ?? failure.errorCode
  insist(original && ['insufficient_funds','do_not_honor','processing_error'].includes(code) && !failure.retryProhibited,
    'native_recovery_soft_decline_required', 409)
  const source = await nativeCollectionSource(env, row.invoice_id), hold = await collectionHold(env, row.invoice_id)
  insist(source.row.customer_id === original.customerId && source.payerId === (original.payerCustomerId ?? original.customerId)
    && source.row.balance_cents === row.amount_cents && source.collectibleCents === row.amount_cents && row.amount_cents === original.amountCents
    && row.currency === 'usd' && original.currency === row.currency && (source.accountRef === null || source.accountRef === original.accountRef)
    && !hold.hold && !hold.disputedCents && hold.collectibleCents === row.amount_cents,
  'native_recovery_invoice_changed', 409)
  insist(!await one(env, `SELECT 1 FROM nc_automatic_collections WHERE invoice_id=? AND status NOT IN ('revoked','invalidated')`, row.invoice_id)
    && !await one(env, 'SELECT 1 FROM nc_prepaid_topup_claims WHERE invoice_id=?', row.invoice_id), 'native_recovery_invoice_managed', 409)
  await prepaidFundingForInvoice(env, row.invoice_id)
  const selection = await selectedRetryPolicy(env, source.row), at = clockInstant(env)
  const next = nextRetry(code, 'card', 1, row.reconciled_at, row.reconciled_at, selection.policy)
  insist(next !== null && at >= next && at <= row.reconciled_at + Math.min(selection.policy.windowDays,14)*DAY,
    'native_recovery_attempt_limit', 409)
  const policyGeneration = (await one(env,'SELECT value FROM nc_retry_selection_generation WHERE id=1'))!.value
  const basis: NativeCollectionBasis & {policyGeneration:number} = { ...original, policyGeneration, principal: actor.id, sourceHash: source.sourceHash,
    sourceFingerprint: source.row.source_fingerprint, customerRevision: source.row.customer_revision,
    payerCustomerId: source.payerId, payerRevision: source.payerRevision }
  const binding = await one(env, 'SELECT * FROM nc_stripe_customer_bindings WHERE id=?', basis.bindingId)
  insist(binding && binding.customer_id === source.payerId && binding.account_ref === basis.accountRef
    && binding.stripe_customer_ref === basis.customerRef && binding.revision === basis.bindingRevision,
  'native_collection_binding_changed', 409)
  await assertMethodUsable(env,basis.accountRef,basis.customerRef,basis.paymentMethodRef)
  return { source, hold, selection, basis, failure, code, day: today((await requireBusiness(env)).timezone,at) }
}

function recoveryGuards(env: Bindings, actor: Actor, row: Row, current: Awaited<ReturnType<typeof recoverySource>>) {
  const { source, hold, basis, selection } = current
  return [...setupOwnerFence(env,actor),nativeSourceGuard(env,source),bindingGuard(env,basis),selection.fence,
    unusableMethodGuard(env,basis.accountRef,basis.customerRef,basis.paymentMethodRef),
    guard(env,'native_recovery_state_changed',`EXISTS(SELECT 1 FROM nc_native_collections WHERE id=? AND revision=? AND status='declined' AND payment_intent_ref=?)
      AND NOT EXISTS(SELECT 1 FROM nc_native_reconfirmations WHERE collection_id=? AND claimed_at IS NOT NULL)`,row.id,row.revision,row.payment_intent_ref,row.id),
    guard(env,'native_recovery_held',`NOT EXISTS(SELECT 1 FROM nc_cadence_disputes WHERE invoice_id=? AND resolved_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM nc_processor_objects WHERE invoice_id=? AND kind IN ('dispute','ach_return') AND status IN ('needs_response','under_review','lost','warning_needs_response','warning_under_review'))
      AND NOT EXISTS(SELECT 1 FROM nc_cadence_promises WHERE rowid=(SELECT MAX(rowid) FROM nc_cadence_promises WHERE invoice_id=?) AND pay_date>=?)`,row.invoice_id,row.invoice_id,row.invoice_id,current.day),
    guard(env,'payment_method_removal_claimed',`NOT EXISTS(SELECT 1 FROM nc_portal_method_action_history WHERE account_ref=? AND customer_ref=? AND method_ref=? AND operation='remove' AND status IN ('uncertain','complete'))`,basis.accountRef,basis.customerRef,basis.paymentMethodRef)]
}

async function providerBasis(env: Bindings, row: Row, current: Awaited<ReturnType<typeof recoverySource>>) {
  const { basis, code } = current
  const selected = await stripeForAccount(env,basis.accountRef).catch(providerUnavailable)
  const card = await savedCard(selected.stripe,basis.customerRef).catch(providerUnavailable)
  insist(canonical(card) === canonical({customerRef:basis.customerRef,paymentMethodRef:basis.paymentMethodRef,livemode:basis.livemode,card:basis.card}),
    'native_collection_card_changed',409)
  const identity = paymentIdentity(row,basis)
  const intent = await readIntent(selected.stripe,identity,row.payment_intent_ref,row.claimed_at,clockInstant(env)).catch(providerUnavailable)
  const refusal = await refusedPayment(selected.stripe,intent,identity).catch(providerUnavailable)
  insist(refusal && refusal.paymentIntentRef === row.payment_intent_ref && !refusal.retryProhibited
    && (refusal.declineCode ?? refusal.errorCode) === code && refusal.status === 'declined', 'native_recovery_prior_outcome_changed',409)
  return {...selected,identity}
}

export async function prepareNativeReconfirmation(env: Bindings, actor: Actor, input: Input) {
  const factor = await setupOwner(env,actor)
  input.only(['request','returnTo'])
  const row = await storedNativeCollection(env,input.text('request',{max:100})), current = await recoverySource(env,actor,row)
  await providerBasis(env,row,current)
  const id = newId(), at = clockInstant(env), basis = {...current.basis, factorReference:factor.reference}, hash = await fingerprint(basis)
  await commit(env,[...recoveryGuards(env,actor,row,current),
    stmt(env,`INSERT INTO nc_native_reconfirmations(id,collection_id,invoice_id,customer_id,original_revision,payment_intent_ref,amount_cents,
      first_failed_at,failure_json,basis_json,basis_hash,hold_basis,policy_json,prepared_by,prepared_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,row.id,row.invoice_id,row.customer_id,row.revision,row.payment_intent_ref,row.amount_cents,row.reconciled_at,canonical(current.failure),canonical(basis),hash,current.hold.basis,canonical(current.selection.policy),actor.id,at),
    stmt(env,'INSERT INTO nc_native_reconfirmation_authority(id,customer_id,session_id,factor_reference) VALUES(?,?,?,?)',id,row.customer_id,actor.sessionId,factor.reference)],
  {actor:actorLabel(actor),action:'collection.recovery.prepare',subject:row.id,detail:{recovery:id,basisHash:hash,paymentIntentRef:row.payment_intent_ref}})
  return nativeCollectionView(await storedNativeCollection(env,row.id))
}

export async function confirmNativeReconfirmation(env: Bindings, actor: Actor, input: Input) {
  const factor = await setupOwner(env,actor)
  input.only(['request','recovery','basis_hash','confirm','amount_cents','account_ref','stripe_customer_ref','payment_method_ref','returnTo'])
  insist(input.flag('confirm'),'native_collection_confirmation_required')
  const row = await storedNativeCollection(env,input.text('request',{max:100})), current = await recoverySource(env,actor,row)
  const proposal = await one(env,`SELECT r.*,a.session_id,a.factor_reference FROM nc_native_reconfirmations r JOIN nc_native_reconfirmation_authority a ON a.id=r.id
    WHERE r.id=? AND r.collection_id=?`,input.text('recovery',{max:100}),row.id)
  insist(proposal && !proposal.claimed_at && proposal.prepared_by === actor.id && proposal.session_id === actor.sessionId
    && proposal.factor_reference === factor.reference && proposal.original_revision === row.revision
    && proposal.basis_hash === input.text('basis_hash',{max:100})
    && proposal.basis_hash === await fingerprint({...current.basis,factorReference:factor.reference})
    && proposal.hold_basis === current.hold.basis && proposal.policy_json === canonical(current.selection.policy), 'native_recovery_basis_changed',409)
  const { basis } = current
  insist(input.integer('amount_cents',{min:50,max:99999999}) === basis.amountCents
    && input.text('account_ref',{max:255}) === basis.accountRef && input.text('stripe_customer_ref',{max:255}) === basis.customerRef
    && input.text('payment_method_ref',{max:255}) === basis.paymentMethodRef,'native_collection_confirmation_changed',409)
  const selected = await providerBasis(env,row,current), at = clockInstant(env), revision = newId()
  await commit(env,[...recoveryGuards(env,actor,row,current),
    guard(env,'native_recovery_basis_changed',`EXISTS(SELECT 1 FROM nc_native_reconfirmations r JOIN nc_native_reconfirmation_authority a ON a.id=r.id
      WHERE r.id=? AND r.claimed_at IS NULL AND r.basis_hash=? AND a.session_id=? AND a.factor_reference=?)`,proposal.id,proposal.basis_hash,actor.sessionId,factor.reference),
    stmt(env,'UPDATE nc_native_reconfirmations SET claimed_at=? WHERE id=?',at,proposal.id),
    stmt(env,"UPDATE nc_native_collections SET status='claimed',revision=? WHERE id=?",revision,row.id)],
  {actor:actorLabel(actor),action:'collection.recovery.claim',subject:row.id,detail:{recovery:proposal.id,paymentIntentRef:row.payment_intent_ref,basisHash:proposal.basis_hash,attempt:2}})
  let claimed = await storedNativeCollection(env,row.id)
  try {
    // Recheck current authority and source after the durable claim, before POST.
    await setupOwner(env,actor)
    const { currentNativeCollection } = await import('./state')
    await currentNativeCollection(env,actor,claimed)
    await prepaidFundingForInvoice(env,row.invoice_id)
    const hold = await collectionHold(env,row.invoice_id)
    insist(!hold.hold && !hold.disputedCents && hold.basis === proposal.hold_basis,'native_recovery_held',409)
    const card = await savedCard(selected.stripe,basis.customerRef)
    insist(card.paymentMethodRef === basis.paymentMethodRef && canonical(card.card) === canonical(basis.card),'native_collection_card_changed',409)
    await assertMethodUsable(env,basis.accountRef,basis.customerRef,basis.paymentMethodRef)
    const intent = await confirmExistingCardIntent(selected.stripe,selected.identity,row.payment_intent_ref,`nectar-native-reconfirm-${proposal.id}`)
    return await recordIntentOutcome(env,actor,claimed,selected.stripe,intent,selected.identity)
  } catch(error) {
    claimed = await storedNativeCollection(env,row.id)
    if(['collected','declined','customer_action_required'].includes(claimed.status)) return nativeCollectionView(claimed)
    if(error instanceof NativeStripeError && error.intentRef) {
      try {
        const intent = await readIntent(selected.stripe,selected.identity,error.intentRef,row.claimed_at,clockInstant(env))
        return await recordIntentOutcome(env,actor,claimed,selected.stripe,intent,selected.identity)
      } catch { claimed = await storedNativeCollection(env,row.id) }
    }
    return nativeCollectionView(await changeOutcome(env,actor,claimed,{status:'uncertain',error_code:'native_payment_unconfirmed'},'uncertain'))
  }
}
