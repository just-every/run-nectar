// Recognition of externally captured cash only. Never creates a PaymentIntent,
// mandate or debit. Required provider metadata: nectar_native_invoice=<invoice id>.
import type { Bindings } from '../auth.server'
import { actorLabel, requireRead, type Actor } from './actor'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, canonical, commit, fingerprint, guard, insist, newId, one, stmt, type Row } from './core'
import { localDate } from './dates'
import type { Input } from './input'
import { collectionAuthority, collectionOwner } from './movein/collection-state'
import { nativeCollectionSource, nativeSourceGuard } from './payments/source'
import { providerReference, providerUnavailable, stripeForAccount, type StripeClient } from './payments/stripe'
import { collectedPaymentStatements } from './receivables'

const invalid = 'ach_payment_evidence_invalid'
const validId = (value: string) => /^[\w-]{1,100}$/.test(value)
const bankFacts = (bank: Row) => {
  insist(bank && typeof bank.last4 === 'string' && /^\d{4}$/.test(bank.last4)
    && typeof bank.bank_name === 'string' && bank.bank_name.trim().length > 0 && bank.bank_name.length <= 100
    && !/[\u0000-\u001f\u007f]|\d{12}/.test(bank.bank_name), invalid, 409)
  return { last4: bank.last4 as string, bankName: bank.bank_name as string }
}
async function capturedBankPayment(stripe: StripeClient, intentRef: string, customerRef: string, invoice: Row, now: number) {
  const [intent, customer] = await Promise.all([
    stripe(`/payment_intents/${encodeURIComponent(intentRef)}`), stripe(`/customers/${encodeURIComponent(customerRef)}`),
  ])
  const amount = invoice.balance_cents, currency = invoice.currency.toLowerCase()
  insist(customer.object === 'customer' && customer.id === customerRef && customer.deleted !== true && typeof customer.livemode === 'boolean'
    && intent.object === 'payment_intent' && intent.id === intentRef && intent.status === 'succeeded'
    && providerReference(intent.customer) === customerRef && intent.livemode === customer.livemode
    && intent.amount === amount && intent.amount_received === amount && intent.amount_capturable === 0 && intent.currency === currency
    && intent.metadata?.nectar_native_invoice === invoice.id, invalid, 409)
  const chargeRef = providerReference(intent.latest_charge), methodRef = providerReference(intent.payment_method)
  const [charge, method] = await Promise.all([
    stripe(`/charges/${encodeURIComponent(chargeRef)}`), stripe(`/payment_methods/${encodeURIComponent(methodRef)}`),
  ])
  insist(charge.object === 'charge' && charge.id === chargeRef && charge.status === 'succeeded' && charge.paid === true && charge.captured === true
    && providerReference(charge.payment_intent) === intentRef && providerReference(charge.customer) === customerRef && providerReference(charge.payment_method) === methodRef
    && charge.livemode === intent.livemode && charge.amount === amount && charge.amount_captured === amount && charge.currency === currency
    && charge.amount_refunded === 0 && charge.refunded === false && charge.disputed === false
    && Number.isSafeInteger(charge.created) && charge.created > 0 && charge.created * 1000 <= now
    && charge.payment_method_details?.type === 'us_bank_account'
    && method.object === 'payment_method' && method.id === methodRef && method.type === 'us_bank_account'
    && providerReference(method.customer) === customerRef && method.livemode === intent.livemode, invalid, 409)
  const bank = bankFacts(charge.payment_method_details.us_bank_account), currentBank = bankFacts(method.us_bank_account)
  insist(canonical(bank) === canonical(currentBank), invalid, 409)
  // ACH success alone need not mean funds are available. Read the captured
  // charge's settlement transaction and require available funds at this account.
  const settlementRef = providerReference(charge.balance_transaction)
  const settlement = await stripe(`/balance_transactions/${encodeURIComponent(settlementRef)}`)
  insist(settlement.object === 'balance_transaction' && settlement.id === settlementRef && settlement.status === 'available'
    && settlement.type === 'charge' && providerReference(settlement.source) === chargeRef
    && settlement.amount === amount && settlement.currency === currency && Number.isSafeInteger(settlement.available_on)
    && settlement.available_on > 0 && settlement.available_on * 1000 <= now, invalid, 409)
  return { chargeRef, methodRef, settlementRef, capturedAt: charge.created * 1000, settledAt: settlement.available_on * 1000,
    livemode: intent.livemode as boolean, ...bank }
}

export async function recordAchPaymentEvidence(env: Bindings, actor: Actor, input: Input) {
  await collectionOwner(env, actor)
  input.only(['invoice', 'account_ref', 'payment_intent_ref', 'confirm', 'returnTo'])
  insist(input.flag('confirm'), 'ach_payment_confirmation_required')
  const invoiceId = input.text('invoice', { max: 100 })
  insist(validId(invoiceId), 'invalid_invoice')
  const accountRef = providerReference(input.text('account_ref', { max: 255 })), intentRef = providerReference(input.text('payment_intent_ref', { max: 255 }))
  const source = await nativeCollectionSource(env, invoiceId)
  // Parent-payer cash needs its own supported attribution flow.
  insist(source.payerId === source.row.customer_id, 'ach_invoice_customer_required', 409)
  insist(!await one(env, 'SELECT 1 FROM nc_prepaid_topup_claims WHERE invoice_id=?', invoiceId), 'prepaid_topup_invoice_managed', 409)
  const intentKey=await fingerprint({account:accountRef,paymentIntent:intentRef})
  const noClaim = `NOT EXISTS(SELECT 1 FROM nc_native_collection_claims WHERE invoice_id=?)
    AND NOT EXISTS(SELECT 1 FROM nc_native_collections WHERE account_ref=? AND payment_intent_ref=?)
    AND NOT EXISTS(SELECT 1 FROM nc_ach_payment_evidence WHERE intent_key=?)`
  const claimArgs = [invoiceId, accountRef, intentRef, intentKey]
  insist(await one(env, `SELECT 1 WHERE ${noClaim}`, ...claimArgs), 'ach_payment_already_claimed', 409)
  const binding = await one(env, 'SELECT * FROM nc_stripe_customer_bindings WHERE customer_id=? AND account_ref=?', source.row.customer_id, accountRef)
  insist(binding, 'native_customer_binding_required', 409)
  const customerRef = providerReference(binding.stripe_customer_ref)
  insist(source.accountRef === null || source.accountRef === accountRef, 'stripe_frozen_account_mismatch', 409)
  const selected = await stripeForAccount(env, source.accountRef ?? accountRef).catch(providerUnavailable)
  // Installation-owned invoices must also use the primary installation account.
  if (source.accountRef === null) insist((await stripeForAccount(env, null).catch(providerUnavailable)).account === accountRef, 'stripe_frozen_account_mismatch', 409)
  const now = clockInstant(env), proof = await capturedBankPayment(selected.stripe, intentRef, customerRef, source.row, now).catch(providerUnavailable)
  const chargeKey=await fingerprint({account:accountRef,charge:proof.chargeRef})
  const currency = source.row.currency.toLowerCase(), reference = `stripe:${accountRef}:${intentRef}`
  const financial = await collectedPaymentStatements(env, actor, { customerId: source.row.customer_id, invoiceId, amountCents: source.row.balance_cents,
    currency, receivedOn: localDate(proof.settledAt, (await requireBusiness(env)).timezone), reference, method: 'bank_transfer',
    evidence: canonical({ kind: 'verified_external_ach', accountRef, paymentIntentRef: intentRef, chargeRef: proof.chargeRef, settledAt: proof.settledAt }) })
  const id = newId()
  await commit(env, [collectionAuthority(env, actor), nativeSourceGuard(env, source),
    guard(env, 'ach_payment_already_claimed', `${noClaim} AND NOT EXISTS(SELECT 1 FROM nc_native_collections WHERE account_ref=? AND charge_ref=?)
      AND NOT EXISTS(SELECT 1 FROM nc_ach_payment_evidence WHERE basis_hash=?)`, ...claimArgs, accountRef, proof.chargeRef, chargeKey),
    guard(env, 'prepaid_topup_invoice_managed', 'NOT EXISTS(SELECT 1 FROM nc_prepaid_topup_claims WHERE invoice_id=?)', invoiceId),
    guard(env, 'native_collection_binding_changed', `EXISTS(SELECT 1 FROM nc_stripe_customer_bindings WHERE id=? AND customer_id=? AND account_ref=? AND stripe_customer_ref=? AND revision=?)
      AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=?)`, binding.id, source.row.customer_id, accountRef, customerRef, binding.revision, binding.id),
    ...financial.statements,
    stmt(env, `INSERT INTO nc_ach_payment_evidence(id,customer_id,invoice_id,payment_id,allocation_id,account_ref,intent_key,basis_hash,stripe_customer_ref,payment_intent_ref,charge_ref,payment_method_ref,settlement_ref,
      amount_cents,currency,bank_name,last4,livemode,captured_at,settled_at,verified_at,verified_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, source.row.customer_id, invoiceId, financial.paymentId, financial.allocationId, accountRef, intentKey, chargeKey, customerRef, intentRef, proof.chargeRef, proof.methodRef, proof.settlementRef,
    source.row.balance_cents, currency, proof.bankName, proof.last4, Number(proof.livemode), proof.capturedAt, proof.settledAt, now, actor.id),
  ], [...financial.audits, { actor: actorLabel(actor), action: 'payment.ach_evidence.record', subject: id,
    detail: { invoice: invoiceId, payment: financial.paymentId, allocation: financial.allocationId, accountRef, paymentIntentRef: intentRef, debitAuthority: false } }])
  return (await readAchPaymentEvidence(env, actor, source.row.customer_id)).find(row => row.id === id)!
}

export async function readAchPaymentEvidence(env: Bindings, actor: Actor, customer: string) {
  requireRead(actor, 'payments'); requireRead(actor, 'invoices')
  insist(validId(customer), 'invalid_customer')
  const rows = await all(env, `SELECT e.* FROM nc_ach_payment_evidence e JOIN nc_customers c ON c.id=e.customer_id
    WHERE e.customer_id=? AND c.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM nc_erased_records r WHERE r.record_id IN(e.id,e.customer_id,e.invoice_id))
    ORDER BY e.verified_at,e.id`, customer)
  return rows.map(row => ({ id: row.id, customer: row.customer_id, invoice: row.invoice_id, payment: row.payment_id, allocation: row.allocation_id,
    accountRef: row.account_ref, paymentIntentRef: row.payment_intent_ref, chargeRef: row.charge_ref, amountCents: row.amount_cents, currency: row.currency,
    bankName: row.bank_name, last4: row.last4, livemode: !!row.livemode, capturedAt: row.captured_at, settledAt: row.settled_at, verifiedAt: row.verified_at,
    kind: 'verified_external_ach' as const, historical: true as const, debitAuthority: false as const }))
}
