// Sandbox billing uses the installation's held Stripe binding, with a current
// test-mode balance proof before every operation. No caller supplies a key.
import type { Bindings } from '../auth.server'
import { insist, NectarError, type Row } from './core'
import { providerReference } from './payments/stripe'

export async function sandboxStripe(env: Bindings, expectedAccount?: string) {
  const secret = env.STRIPE_BILLING_SECRET
  insist(typeof secret === 'string' && secret.trim(), 'sandbox_test_key_required', 409)
  async function request(path: string, body?: URLSearchParams, key?: string): Promise<Row> {
    let response: Response, value: Row
    try {
      response = await fetch(`https://api.stripe.com/v1${path}`, { method: body ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(20000),
        headers: { authorization: `Bearer ${secret}`, 'Stripe-Version': '2025-03-31.basil', ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body } : {}) })
      value = await response.json() as Row
    } catch { throw new NectarError('sandbox_provider_unconfirmed', 502) }
    if (response.status === 402 && value.error?.payment_intent) return value.error.payment_intent
    insist(response.ok && value && typeof value === 'object' && !Array.isArray(value), 'sandbox_provider_unconfirmed', 502)
    insist(value.livemode !== true, 'sandbox_live_processor_refused', 409)
    return value
  }
  const balance = await request('/balance')
  insist(balance.object === 'balance' && balance.livemode === false, 'sandbox_test_key_required', 409)
  const account = await request('/account'), accountRef = providerReference(account.id)
  insist(account.object === 'account' && (!expectedAccount || expectedAccount === accountRef), 'sandbox_processor_account_changed', 409)
  return { accountRef, request }
}

export async function sandboxProviderCustomer(selected: Awaited<ReturnType<typeof sandboxStripe>>, customerId: string, catalogId: string, remoteId: string) {
  const customer = await selected.request(`/customers/${encodeURIComponent(providerReference(remoteId))}`)
  insist(customer.object === 'customer' && customer.id === remoteId && customer.livemode === false && !customer.deleted
    && customer.metadata?.nectar_sandbox_customer === customerId && customer.metadata?.nectar_sandbox_catalog === catalogId,
  'sandbox_processor_customer_mismatch', 409)
  const methodId = providerReference(customer.invoice_settings?.default_payment_method)
  const method = await selected.request(`/payment_methods/${encodeURIComponent(methodId)}`)
  insist(method.object === 'payment_method' && method.id === methodId && method.type === 'card' && method.livemode === false
    && method.customer === remoteId, 'sandbox_test_card_required', 409)
  return { customer, methodId }
}
