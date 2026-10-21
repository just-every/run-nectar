// Only documented fixed-origin, read-only Stripe calls. No response body or
// credential is copied into an error, log or capture.
import type { Bindings } from '../auth.server'
import { insist, NectarError, type Row } from './core'

export const NUMBERING_STRIPE_VERSION = '2025-03-31.basil'
export function numberingStripe(env: Bindings) {
  const secret = (env as Bindings & { STRIPE_BILLING_SECRET?: string }).STRIPE_BILLING_SECRET
  insist(typeof secret === 'string' && secret.trim(), 'stripe_billing_secret_required', 409)
  return async (path: string): Promise<Row> => {
    insist(/^\/(?:account|customers\/[A-Za-z0-9_-]+|invoices\/[A-Za-z0-9_-]+)$/.test(path), 'invalid_stripe_numbering_resource')
    let response: Response
    try { response = await fetch(`https://api.stripe.com/v1${path}`, {
      headers: { authorization: `Bearer ${secret}`, 'Stripe-Version': NUMBERING_STRIPE_VERSION },
      redirect: 'manual', signal: AbortSignal.timeout(20000),
    }) } catch { throw new NectarError('stripe_numbering_provider_unavailable', 502) }
    if (!response.ok) { await response.body?.cancel(); throw new NectarError('stripe_numbering_provider_refused', 502) }
    let value: unknown
    try { value = await response.json() } catch { throw new NectarError('stripe_numbering_response_invalid', 502) }
    insist(value && typeof value === 'object' && !Array.isArray(value), 'stripe_numbering_response_invalid', 502)
    return value as Row
  }
}
