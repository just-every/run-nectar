// Fixed-origin Stripe transport. Provider bodies/errors never enter storage,
// audit, logs or client errors; only explicitly projected financial facts do.
import type { Bindings } from '../../auth.server'
import { insist, NectarError, type Row } from '../core'
import { localDate } from '../dates'
import { stripeReference } from './history'

export const COLLECTION_STRIPE_VERSION = '2025-03-31.basil'
export class CollectionProviderError extends Error {
  constructor(readonly uncertain: boolean, readonly intentRef: string | null = null) { super('imported_collection_provider_error') }
}
export function collectionStripe(env: Bindings) {
  const secret = (env as Bindings & { STRIPE_BILLING_SECRET?: string }).STRIPE_BILLING_SECRET
  insist(typeof secret === 'string' && secret.trim().length > 0, 'stripe_billing_secret_required', 409)
  return async (path: string, body?: URLSearchParams, key?: string): Promise<Row> => {
    let response: Response
    try {
      response = await fetch(`https://api.stripe.com/v1${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(20000),
        headers: { authorization: `Bearer ${secret}`, 'Stripe-Version': COLLECTION_STRIPE_VERSION,
          ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
        ...(body ? { body } : {}),
      })
    } catch { throw new CollectionProviderError(true) }
    let value: unknown
    try { value = await response.json() } catch { throw new CollectionProviderError(true) }
    if (!response.ok) {
      // An error body is only a reference for a subsequent authenticated read.
      // Never accept its decline text or its embedded intent as payment proof.
      const candidate = value && typeof value === 'object' ? stripeReference((value as Row).error?.payment_intent) : ''
      const intentRef = /^[A-Za-z0-9_-]{1,255}$/.test(candidate) && !/^(sk|rk)_(live|test)_/i.test(candidate) ? candidate : null
      throw new CollectionProviderError(response.status >= 500 || response.status === 409 || response.status === 429,intentRef)
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CollectionProviderError(true)
    return value as Row
  }
}
export type CollectionStripe = ReturnType<typeof collectionStripe>
const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 255
const cents = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export function invoiceFacts(invoice: Row) {
  insist(invoice.object === 'invoice' && text(invoice.id) && text(stripeReference(invoice.customer)) && text(invoice.number)
    && /^[a-z]{3}$/.test(invoice.currency) && cents(invoice.total) && cents(invoice.amount_paid) && cents(invoice.amount_remaining)
    && ['open','paid','void','uncollectible'].includes(invoice.status) && typeof invoice.auto_advance === 'boolean'
    && ['send_invoice','charge_automatically'].includes(invoice.collection_method) && typeof invoice.livemode === 'boolean', 'stripe_invoice_evidence_invalid', 409)
  return { id: invoice.id, customer: stripeReference(invoice.customer), number: invoice.number, currency: invoice.currency,
    total: invoice.total, amount_paid: invoice.amount_paid, amount_remaining: invoice.amount_remaining, status: invoice.status,
    auto_advance: invoice.auto_advance, collection_method: invoice.collection_method, livemode: invoice.livemode,
    attempt_count: invoice.attempt_count ?? null, attempted: invoice.attempted ?? null,
    payment_intent: stripeReference(invoice.payment_intent) || null, charge: stripeReference(invoice.charge) || null,
    default_payment_method: stripeReference(invoice.default_payment_method) || null, default_source: stripeReference(invoice.default_source) || null,
    paid_out_of_band: invoice.paid_out_of_band === true }
}
export async function stripeInvoicePayments(stripe: CollectionStripe, invoice: string) {
  const result = await stripe(`/invoice_payments?${new URLSearchParams({ invoice, limit: '100' })}`)
  insist(result.object === 'list' && result.has_more === false && Array.isArray(result.data), 'stripe_payment_history_incomplete', 409)
  const seen = new Set<string>()
  return (result.data as Row[]).map(row => {
    const type = row.payment?.type, reference = stripeReference(row.payment?.[type])
    insist(row.object === 'invoice_payment' && text(row.id) && !seen.has(row.id) && stripeReference(row.invoice) === invoice
      && ['open','paid','canceled'].includes(row.status) && /^[a-z]{3}$/.test(row.currency)
      && cents(row.amount_requested) && (row.amount_paid === null || cents(row.amount_paid))
      && ['payment_intent','charge','payment_record'].includes(type) && text(reference), 'stripe_invoice_payment_invalid', 409)
    seen.add(row.id)
    return { id: row.id, status: row.status, currency: row.currency, amount_paid: row.amount_paid,
      amount_requested: row.amount_requested, payment_type: type, payment_ref: reference, paid_at: row.status_transitions?.paid_at ?? null }
  }).sort((a, b) => a.id.localeCompare(b.id))
}
export async function stripeCollectionSnapshot(stripe: CollectionStripe, invoice: string) {
  const account = await stripe('/account')
  insist(account.object === 'account' && text(account.id), 'stripe_account_evidence_invalid', 409)
  const source = await stripe(`/invoices/${encodeURIComponent(invoice)}`)
  const facts = invoiceFacts(source)
  insist(facts.id === invoice, 'stripe_invoice_source_changed', 409)
  const customer = await stripe(`/customers/${encodeURIComponent(facts.customer)}`)
  insist(customer.object === 'customer' && customer.id === facts.customer && customer.deleted !== true, 'stripe_customer_evidence_invalid', 409)
  const paymentMethod = facts.default_payment_method || stripeReference(customer.invoice_settings?.default_payment_method)
  insist(paymentMethod, 'stripe_collection_saved_card_required', 409)
  const method = await stripe(`/payment_methods/${encodeURIComponent(paymentMethod)}`)
  insist(method.object === 'payment_method' && method.id === paymentMethod && method.type === 'card'
    && stripeReference(method.customer) === facts.customer, 'stripe_collection_saved_card_required', 409)
  return { account: account.id as string, invoice: facts, paymentMethod, paymentMethodType: 'card', payments: await stripeInvoicePayments(stripe, invoice) }
}
export type CollectionSnapshot = Awaited<ReturnType<typeof stripeCollectionSnapshot>>

export interface CollectionPaymentIdentity { snapshot: CollectionSnapshot; intentKey: string }
export function collectionIntentIdentity(intent: Row, basis: CollectionPaymentIdentity, request: Row) {
  insist(intent.object === 'payment_intent' && text(intent.id) && stripeReference(intent.customer) === basis.snapshot.invoice.customer
    && intent.currency === request.currency && intent.amount === request.amount_cents && intent.livemode === basis.snapshot.invoice.livemode
    && (stripeReference(intent.payment_method) === basis.snapshot.paymentMethod || intent.status === 'requires_payment_method' && !stripeReference(intent.payment_method) && stripeReference(intent.last_payment_error?.payment_method) === basis.snapshot.paymentMethod) && intent.metadata?.nectar_collection_key === basis.intentKey
    && intent.metadata?.nectar_collection_request === request.id && intent.metadata?.nectar_original_invoice === request.invoice_ref,
  'stripe_collection_intent_mismatch', 409)
  return intent.id as string
}
export async function readCollectionIntent(stripe: CollectionStripe, basis: CollectionPaymentIdentity, request: Row) {
  let intent: Row
  if (request.payment_intent_ref) intent = await stripe(`/payment_intents/${encodeURIComponent(request.payment_intent_ref)}`)
  else {
    // Search can lag. Zero results leaves uncertainty intact; no create or
    // confirm request is repeated to compensate for eventual consistency.
    const query = `metadata['nectar_collection_key']:'${basis.intentKey}' AND metadata['nectar_collection_request']:'${request.id}'`
    const found = await stripe(`/payment_intents/search?${new URLSearchParams({ query, limit: '100' })}`)
    insist(found.object === 'search_result' && found.has_more === false && Array.isArray(found.data) && found.data.length === 1, 'stripe_collection_intent_unconfirmed', 409)
    intent = found.data[0]
  }
  collectionIntentIdentity(intent, basis, request)
  return intent
}

/** Native processor collection and source mirroring have separate evidence.
 * An out-of-band invoice mark never substitutes for a real captured charge. */
export async function stripeCollectedEvidence(stripe: CollectionStripe, intent: Row, basis: CollectionPaymentIdentity, request: Row, timezone: string) {
  const intentId = collectionIntentIdentity(intent, basis, request), amount = request.amount_cents
  insist(intent.status === 'succeeded' && intent.amount_received === amount, 'stripe_collection_not_proven', 409)
  const result = await stripe(`/charges?${new URLSearchParams({ payment_intent: intentId, limit: '100' })}`)
  insist(result.object === 'list' && result.has_more === false && Array.isArray(result.data), 'stripe_charge_history_incomplete', 409)
  const charges = (result.data as Row[]).filter(row => row.status === 'succeeded' && row.paid === true && row.captured === true)
  insist(charges.length === 1, 'stripe_collection_charge_required', 409)
  const charge = charges[0]
  insist(charge.object === 'charge' && text(charge.id) && charge.paid === true && charge.captured === true && charge.status === 'succeeded'
    && stripeReference(charge.customer) === basis.snapshot.invoice.customer && charge.currency === basis.snapshot.invoice.currency
    && stripeReference(charge.payment_intent) === intentId && (!intent.latest_charge || stripeReference(intent.latest_charge) === charge.id)
    && charge.amount === amount && charge.amount_captured === amount && charge.livemode === basis.snapshot.invoice.livemode
    && Number.isSafeInteger(charge.created) && charge.created >= 0 && charge.created <= 253402300799, 'stripe_collection_charge_mismatch', 409)
  const collectedOn = localDate(charge.created * 1000, timezone)
  return { chargeRef: charge.id as string, paymentRef: intentId, paymentIntentRef: intentId,
    collectedOn, custody: 'stripe-payment-intent-mirror-pending' }
}

export function collectionProviderRefusal(error: unknown): never {
  if (error instanceof CollectionProviderError) throw new NectarError('stripe_collection_provider_unavailable', 502)
  throw error
}
