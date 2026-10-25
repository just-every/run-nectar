// Existing-customer capture only. Checkout holds financial input; Nectar keeps
// verified references and a closed display projection, never provider payloads.
import { insist } from '../core'
import { providerReference, type StripeClient } from './stripe'

type Method = 'card' | 'us_bank_account'
interface SetupIdentity { id: string; customerRef: string; method: Method }
export interface HostedSetupMethod {
  methodRef: string; kind: Method; brand: string | null; last4: string
  expMonth: number | null; expYear: number | null; bankName: string | null
  accountType: 'checking' | 'savings' | null
  mandateRef: string | null; mandateText: string | null
}
const mismatch = 'hosted_setup_evidence_mismatch'
const brands = new Set(['amex','cartes_bancaires','diners','discover','eftpos_au','interac','jcb','link','mastercard','unionpay','visa','unknown'])
function identity(value: SetupIdentity) {
  providerReference(value.id); providerReference(value.customerRef)
  insist(value.method === 'card' || value.method === 'us_bank_account', mismatch, 409)
}

export async function createHostedSetup(stripe: StripeClient, input: SetupIdentity & {
  language: string; currency: string; returnUrl: string
}): Promise<{ sessionRef: string; url: string }> {
  identity(input)
  let destination: URL
  try { destination = new URL(input.returnUrl) } catch { insist(false, 'invalid_hosted_setup_return_url', 409) }
  insist(['https:', 'http:'].includes(destination.protocol) && !destination.username && !destination.password && !destination.hash,
    'invalid_hosted_setup_return_url', 409)
  insist(destination.protocol === 'https:' || ['localhost','127.0.0.1','[::1]'].includes(destination.hostname), 'invalid_hosted_setup_return_url', 409)
  insist(/^[A-Za-z]{3}$/.test(input.currency) && (input.method !== 'us_bank_account' || input.currency.toUpperCase() === 'USD'), 'invalid_hosted_setup_currency', 409)
  const body = new URLSearchParams({ mode: 'setup', customer: input.customerRef,
    currency: input.currency.toLowerCase(), 'payment_method_types[0]': input.method,
    locale: input.language === 'es' || input.language.startsWith('es-') ? 'es' : 'en',
    success_url: destination.href, cancel_url: destination.href,
    'metadata[nectar_setup_id]': input.id, 'setup_intent_data[metadata][nectar_setup_id]': input.id })
  if (input.method === 'us_bank_account') {
    body.set('payment_method_options[us_bank_account][financial_connections][permissions][0]', 'payment_method')
    body.set('payment_method_options[us_bank_account][verification_method]', 'automatic')
  }
  const session = await stripe('/checkout/sessions', body, `nectar-hosted-setup-${input.id}`)
  insist(session.object === 'checkout.session' && session.mode === 'setup' && providerReference(session.customer) === input.customerRef
    && session.metadata?.nectar_setup_id === input.id, mismatch, 409)
  let redirect: URL
  try { redirect = new URL(session.url) } catch { insist(false, 'invalid_hosted_setup_redirect', 409) }
  insist(typeof session.url === 'string' && redirect.protocol === 'https:' && redirect.hostname === 'checkout.stripe.com'
    && !redirect.username && !redirect.password && !redirect.port, 'invalid_hosted_setup_redirect', 409)
  return { sessionRef: providerReference(session.id), url: session.url }
}

export async function readHostedSetup(stripe: StripeClient, input: SetupIdentity & {
  sessionRef: string; livemode: boolean
}): Promise<HostedSetupMethod> {
  identity(input)
  const sessionRef = providerReference(input.sessionRef)
  const session = await stripe(`/checkout/sessions/${encodeURIComponent(sessionRef)}`)
  insist(session.object === 'checkout.session' && session.id === sessionRef && session.mode === 'setup'
    && providerReference(session.customer) === input.customerRef && session.livemode === input.livemode
    && session.metadata?.nectar_setup_id === input.id && Array.isArray(session.payment_method_types)
    && session.payment_method_types.length === 1 && session.payment_method_types[0] === input.method, mismatch, 409)
  insist(session.status === 'complete', 'hosted_setup_pending', 409)
  const setupRef = providerReference(session.setup_intent)
  const setup = await stripe(`/setup_intents/${encodeURIComponent(setupRef)}`)
  insist(setup.object === 'setup_intent' && setup.id === setupRef && providerReference(setup.customer) === input.customerRef
    && setup.livemode === input.livemode && setup.metadata?.nectar_setup_id === input.id
    && Array.isArray(setup.payment_method_types) && setup.payment_method_types.length === 1 && setup.payment_method_types[0] === input.method, mismatch, 409)
  insist(setup.status === 'succeeded', 'hosted_setup_pending', 409)
  const methodRef = providerReference(setup.payment_method)
  const method = await stripe(`/payment_methods/${encodeURIComponent(methodRef)}`)
  insist(method.object === 'payment_method' && method.id === methodRef && method.type === input.method
    && providerReference(method.customer) === input.customerRef && method.livemode === input.livemode, mismatch, 409)
  const details = method[input.method]
  insist(details && typeof details.last4 === 'string' && /^\d{4}$/.test(details.last4), mismatch, 409)
  if (input.method === 'card') {
    insist(brands.has(details.brand) && Number.isSafeInteger(details.exp_month) && details.exp_month >= 1 && details.exp_month <= 12
      && Number.isSafeInteger(details.exp_year) && details.exp_year >= 2000 && details.exp_year <= 9999, mismatch, 409)
    return { methodRef, kind: 'card', brand: details.brand, last4: details.last4, expMonth: details.exp_month,
      expYear: details.exp_year, bankName: null, accountType: null, mandateRef: null, mandateText: null }
  }
  insist(typeof details.bank_name === 'string' && details.bank_name.trim().length > 0 && details.bank_name.length <= 100
    && !/[\u0000-\u001f\u007f]|\d{12}/.test(details.bank_name) && ['checking','savings'].includes(details.account_type), mismatch, 409)
  const mandateRef = providerReference(setup.mandate)
  const mandate = await stripe(`/mandates/${encodeURIComponent(mandateRef)}`)
  insist(mandate.object === 'mandate' && mandate.id === mandateRef && mandate.livemode === input.livemode
    && providerReference(mandate.payment_method) === methodRef && mandate.type === 'multi_use'
    && mandate.payment_method_details?.type === 'us_bank_account' && mandate.customer_acceptance?.type === 'online'
    && Number.isSafeInteger(mandate.customer_acceptance.accepted_at) && mandate.customer_acceptance.accepted_at > 0
    && mandate.customer_acceptance.online && typeof mandate.customer_acceptance.online.ip_address === 'string'
    && typeof mandate.customer_acceptance.online.user_agent === 'string', mismatch, 409)
  insist(mandate.status === 'active', 'hosted_setup_pending', 409)
  // Stripe's Mandate object exposes acceptance evidence, not authorization copy.
  // Null means unavailable; a mandate reference must never stand in for text.
  return { methodRef, kind: 'us_bank_account', brand: null, last4: details.last4, expMonth: null, expYear: null,
    bankName: details.bank_name, accountType: details.account_type, mandateRef, mandateText: null }
}

export async function setHostedDefault(stripe: StripeClient, customerRef: string, methodRef: string, id: string): Promise<void> {
  providerReference(customerRef); providerReference(methodRef); providerReference(id)
  const customer = await stripe(`/customers/${encodeURIComponent(customerRef)}`,
    new URLSearchParams({ 'invoice_settings[default_payment_method]': methodRef }), `nectar-hosted-default-${id}`)
  insist(customer.object === 'customer' && customer.id === customerRef && customer.deleted !== true
    && providerReference(customer.invoice_settings?.default_payment_method) === methodRef, mismatch, 409)
}
