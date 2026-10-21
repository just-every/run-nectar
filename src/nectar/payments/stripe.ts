// Fixed Stripe origin and a closed set of installation-held credentials. Route
// records contain account identifiers, never names of secret bindings.
import type { Bindings } from '../../auth.server'
import { insist, NectarError, type Row } from '../core'
import { localDate } from '../dates'

type StripeBindings = Bindings & { STRIPE_SECONDARY_SECRET_KEY?: string }
export class NativeStripeError extends Error {
  constructor() { super('native_collection_provider_unavailable') }
}
export type StripeClient = (path: string, body?: URLSearchParams, key?: string) => Promise<Row>
const ref = (value: unknown): string => typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as Row).id === 'string' ? (value as Row).id : ''
export function providerReference(value: unknown): string {
  const text = ref(value)
  insist(/^[A-Za-z0-9_-]{1,255}$/.test(text) && !/^(sk|rk)_(live|test)_/i.test(text), 'invalid_processor_reference', 409)
  return text
}
function client(secret: string): StripeClient {
  return async (path, body, key) => {
    let response: Response
    try {
      response = await fetch(`https://api.stripe.com/v1${path}`, { method: body ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(20000),
        headers: { authorization: `Bearer ${secret}`, 'Stripe-Version': '2025-03-31.basil',
          ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body } : {}) })
    } catch { throw new NativeStripeError() }
    if (!response.ok) { await response.body?.cancel(); throw new NativeStripeError() }
    let result: unknown
    try { result = await response.json() } catch { throw new NativeStripeError() }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new NativeStripeError()
    return result as Row
  }
}
export async function stripeForAccount(env: StripeBindings, expectedAccount: string | null) {
  const secrets = [env.STRIPE_BILLING_SECRET, env.STRIPE_SECONDARY_SECRET_KEY]
  insist(typeof secrets[0] === 'string' && secrets[0].trim(), 'stripe_secret_required', 409)
  const configured = expectedAccount ? secrets.filter((secret): secret is string => typeof secret === 'string' && !!secret.trim()) : [secrets[0]!]
  const accounts = await Promise.all(configured.map(async secret => {
    const stripe = client(secret), account = await stripe('/account')
    insist(account.object === 'account', 'stripe_account_evidence_invalid', 409)
    return { stripe, account: providerReference(account.id) }
  }))
  const matches = accounts.filter(account => expectedAccount === null || account.account === expectedAccount)
  insist(matches.length === 1, 'stripe_frozen_account_mismatch', 409)
  return matches[0]
}
export async function savedCard(stripe: StripeClient, customerRef: string) {
  const customer = await stripe(`/customers/${encodeURIComponent(customerRef)}`)
  insist(customer.object === 'customer' && customer.id === customerRef && customer.deleted !== true && typeof customer.livemode === 'boolean', 'stripe_customer_evidence_invalid', 409)
  const methodRef = providerReference(customer.invoice_settings?.default_payment_method)
  const method = await stripe(`/payment_methods/${encodeURIComponent(methodRef)}`)
  insist(method.object === 'payment_method' && method.id === methodRef && method.type === 'card' && ref(method.customer) === customerRef
    && method.livemode === customer.livemode && method.card && /^\d{4}$/.test(method.card.last4) && typeof method.card.brand === 'string'
    && Number.isSafeInteger(method.card.exp_month) && Number.isSafeInteger(method.card.exp_year), 'stripe_saved_card_required', 409)
  return { customerRef, paymentMethodRef: methodRef, livemode: customer.livemode as boolean,
    card: { brand: method.card.brand as string, last4: method.card.last4 as string, expMonth: method.card.exp_month as number, expYear: method.card.exp_year as number } }
}
export interface PaymentIdentity { accountRef: string; customerRef: string; paymentMethodRef: string; livemode: boolean; invoiceId: string; requestId: string; key: string; amountCents: number }
export function verifyIntent(intent: Row, identity: PaymentIdentity) {
  insist(intent.object === 'payment_intent' && ref(intent.customer) === identity.customerRef && ref(intent.payment_method) === identity.paymentMethodRef
    && intent.currency === 'usd' && intent.amount === identity.amountCents && intent.livemode === identity.livemode
    && intent.metadata?.nectar_native_collection_key === identity.key && intent.metadata?.nectar_native_invoice === identity.invoiceId
    && intent.metadata?.nectar_native_collection_request === identity.requestId, 'stripe_native_intent_mismatch', 409)
  return providerReference(intent.id)
}
export async function readIntent(stripe: StripeClient, identity: PaymentIdentity, intentRef: string | null) {
  let intent: Row
  if (intentRef) intent = await stripe(`/payment_intents/${encodeURIComponent(intentRef)}`)
  else {
    const query = `metadata['nectar_native_collection_key']:'${identity.key}' AND metadata['nectar_native_collection_request']:'${identity.requestId}'`
    const result = await stripe(`/payment_intents/search?${new URLSearchParams({ query, limit: '100' })}`)
    insist(result.object === 'search_result' && result.has_more === false && Array.isArray(result.data) && result.data.length === 1, 'stripe_native_intent_unconfirmed', 409)
    intent = result.data[0]
  }
  verifyIntent(intent, identity)
  return intent
}
export async function capturedPayment(stripe: StripeClient, intent: Row, identity: PaymentIdentity, timezone: string) {
  const intentRef = verifyIntent(intent, identity)
  insist(intent.status === 'succeeded' && intent.amount_received === identity.amountCents, 'stripe_native_payment_unconfirmed', 409)
  const result = await stripe(`/charges?${new URLSearchParams({ payment_intent: intentRef, limit: '100' })}`)
  insist(result.object === 'list' && result.has_more === false && Array.isArray(result.data), 'stripe_native_charge_history_incomplete', 409)
  const captured = (result.data as Row[]).filter(charge => charge.status === 'succeeded' && charge.paid === true && charge.captured === true)
  insist(captured.length === 1, 'stripe_native_captured_charge_required', 409)
  const charge = captured[0]
  insist(charge.object === 'charge' && ref(charge.customer) === identity.customerRef && ref(charge.payment_intent) === intentRef
    && ref(charge.payment_method) === identity.paymentMethodRef && ref(intent.latest_charge) === charge.id && charge.currency === 'usd'
    && charge.amount === identity.amountCents && charge.amount_captured === identity.amountCents && charge.amount_refunded === 0 && charge.refunded === false
    && charge.disputed === false && charge.livemode === identity.livemode && Number.isSafeInteger(charge.created) && charge.created > 0 && charge.created <= 253402300799,
  'stripe_native_charge_mismatch', 409)
  return { accountRef: identity.accountRef, customerRef: identity.customerRef, paymentMethodRef: identity.paymentMethodRef,
    paymentIntentRef: intentRef, chargeRef: providerReference(charge.id), amountCents: identity.amountCents, currency: 'usd',
    capturedAt: charge.created * 1000 as number, receivedOn: localDate(charge.created * 1000, timezone), livemode: identity.livemode,
    proof: 'succeeded-payment-intent-and-captured-charge' as const }
}
export function providerUnavailable(error: unknown): never {
  if (error instanceof NativeStripeError) throw new NectarError('native_collection_provider_unavailable', 502)
  throw error
}
