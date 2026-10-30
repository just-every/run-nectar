// Observations explain an invoice; they grant no contact or payment authority.
import type { Bindings } from '../auth.server'
import { clockInstant } from './clock'
import { all, canonical, fingerprint, guard, insist, one, parseJson, type Row } from './core'
import { bindingValidPaymentMethods } from './customer-payment-methods'
import { memberCapabilities } from './actor'

const MAX_OBSERVATION_AGE = 15 * 60 * 1000
const definitive = 'requires-payment-method-with-error-and-no-succeeded-charge'

/** Fail closed: a card's date alone, a provider error string, and uncertain
 * attempts cannot establish why this particular invoice remains unpaid. */
export async function collectionDiagnosis(env: Bindings, customer: string, invoices: Row[]) {
  const instant = clockInstant(env)
  const snapshots = await bindingValidPaymentMethods(env, customer)
  return Promise.all(invoices.map(async invoice => {
    const attempts = await all(env, `SELECT * FROM nc_native_collections WHERE customer_id=? AND invoice_id=? AND claimed_at IS NOT NULL ORDER BY claimed_at,id`, customer, invoice.id)
    const evidence = attempts.map(row => ({ request: row.id, status: row.status, revision: row.revision, intent: row.payment_intent_ref,
      account: row.account_ref, customer: row.stripe_customer_ref, method: row.payment_method_ref, observedAt: row.reconciled_at,
      basisHash: row.basis_hash, proof: parseJson<Row>(row.proof_json, {}) }))
    const providerFailures = await all(env, 'SELECT account_ref,intent_ref,amount_cents,decline_code,attempted_at FROM nc_processor_failures WHERE customer_id=? AND invoice_id=? ORDER BY attempted_at,id', customer, invoice.id)
    const sources = snapshots.map(snapshot => ({ ...snapshot }))
    const result = (cause: 'expired_card' | 'unknown', reason: string, citations: Row[] = [], card: Row | null = null) =>
      ({ invoice: invoice.id, number: invoice.number, cause, reason, card, citations, evidence, providerFailures, observations: sources })
    if (attempts.length !== 1) return result('unknown', attempts.length ? 'conflicting_payment_evidence' : 'no_definitive_invoice_failure')
    const row = attempts[0], proof = parseJson<Row>(row.proof_json, {}), basis = parseJson<Row>(row.basis_json, {})
    if (row.status !== 'declined' || proof.proof !== definitive || proof.providerStatus !== 'requires_payment_method'
      || proof.paymentIntentRef !== row.payment_intent_ref || !proof.paymentIntentRef
      || basis.invoiceId !== invoice.id || basis.customerId !== customer || basis.payerCustomerId && basis.payerCustomerId !== customer
      || basis.sourceFingerprint !== invoice.sourceFingerprint || basis.accountRef !== row.account_ref
      || basis.customerRef !== row.stripe_customer_ref || basis.paymentMethodRef !== row.payment_method_ref
      || basis.amountCents !== invoice.invoiceBalanceCents || await fingerprint(basis) !== row.basis_hash)
      return result('unknown', 'incomplete_or_conflicting_invoice_failure')
    if (providerFailures.some(failure => failure.account_ref !== row.account_ref || failure.intent_ref !== row.payment_intent_ref
      || failure.decline_code !== 'expired_card' || failure.amount_cents !== row.amount_cents)) return result('unknown', 'conflicting_provider_failure')
    if (![proof.errorCode, proof.declineCode].includes('expired_card')) return result('unknown', 'failure_does_not_establish_expiry')
    const matches = snapshots.filter(snapshot => snapshot.accountRef === row.account_ref && snapshot.customerRef === row.stripe_customer_ref
      && snapshot.binding === basis.bindingId && snapshot.bindingRevision === basis.bindingRevision)
    if (matches.length !== 1) return result('unknown', 'payment_method_binding_unavailable')
    const snapshot = matches[0], method = snapshot.methods.find(method => method.methodRef === row.payment_method_ref)
    if (!Number.isSafeInteger(row.reconciled_at) || row.reconciled_at > instant || instant - row.reconciled_at > MAX_OBSERVATION_AGE
      || snapshot.fetchedAt < row.reconciled_at || snapshot.fetchedAt > instant || instant - snapshot.fetchedAt > MAX_OBSERVATION_AGE)
      return result('unknown', 'payment_evidence_stale')
    if (!method || method.type !== 'card') return result('unknown', 'failed_method_not_observed')
    const card = { brand: method.brand, last4: method.last4, expMonth: method.expMonth, expYear: method.expYear }
    const month = new Date(instant).toISOString().slice(0, 7)
    const expiryMonth = `${method.expYear}-${String(method.expMonth).padStart(2, '0')}`
    const newer = await one(env, `SELECT 1 FROM nc_card_lifecycle WHERE customer_id=? AND account_ref=? AND stripe_customer_ref=? AND payment_method_ref=? AND observed_at>?`,
      customer, row.account_ref, row.stripe_customer_ref, row.payment_method_ref, snapshot.fetchedAt)
    if (newer || canonical(card) !== canonical(basis.card) || expiryMonth >= month) return result('unknown', 'payment_method_evidence_conflicts')
    return result('expired_card', 'matched_definitive_failure_and_expired_observation', [
      { kind: 'invoice', record: invoice.id, source: `/app/invoices/${invoice.id}`, number: invoice.number, fingerprint: invoice.sourceFingerprint },
      { kind: 'payment_failure', record: row.id, source: `/app/invoices/${invoice.id}`, intent: row.payment_intent_ref, code: 'expired_card', observedAt: row.reconciled_at },
      { kind: 'payment_method', record: snapshot.snapshot, source: `/app/customers/${customer}`, method: method.methodRef, bindingRevision: snapshot.bindingRevision, observedAt: snapshot.fetchedAt },
    ], card)
  }))
}

/** The original preparer's authority must still exist when a human approves
 * or downloads a proposal. Restored or revoked credentials confer no authority. */
export async function collectionProposerGuards(env: Bindings, proposal: Row) {
  if (proposal.created_by_kind === 'agent') {
    const key = await one(env, 'SELECT * FROM nc_agent_keys WHERE id=? AND revoked_at IS NULL', proposal.prepared_by_id)
    insist(key && String(key.scopes).split(' ').includes('prepare'), 'collection_proposer_unavailable', 409)
    return [guard(env, 'collection_proposer_unavailable', `EXISTS(SELECT 1 FROM nc_agent_keys WHERE id=? AND revoked_at IS NULL AND scopes=?)`, key.id, key.scopes)]
  }
  const member = await one(env, `SELECT m.*,r.capabilities AS custom_capabilities FROM nc_members m LEFT JOIN nc_roles r ON r.id=m.custom_role_id WHERE m.id=? AND m.status='active'`, proposal.prepared_by_id)
  const capabilities = member ? memberCapabilities(member.role, member.custom_capabilities) : new Set()
  insist(member && capabilities.has('read') && capabilities.has('propose'), 'collection_proposer_unavailable', 409)
  return [guard(env, 'collection_proposer_unavailable', `EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role=? AND updated_at=?)`, member.id, member.role, member.updated_at)]
}
