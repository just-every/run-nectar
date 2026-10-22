// DEV-001: the webhook work each write request and each tick finishes. A write
// door starts it after its response is ready; the one-minute tick retries what
// is due; the daily tick also re-reads every subscribed customer's grants.
import type { Bindings } from '../auth.server'
import { clockInstant } from './clock'
import { deliverDueWebhooks } from './webhook-delivery'
import { markEntitlementsDue, syncEntitlements } from './webhook-entitlements'

export async function runWebhooks(env: Bindings, at: number, { daily = false } = {}) {
  if (daily) await markEntitlementsDue(env, at)
  await syncEntitlements(env, at, daily ? 100 : 25)
  await deliverDueWebhooks(env, at, daily ? 200 : 50)
}

/** Delivery trouble never fails or delays the request that wrote. */
export async function deliverAfterWrite(env: Bindings) {
  try { await runWebhooks(env, clockInstant(env)) } catch (error) { console.error('webhook_delivery_error', error instanceof Error ? error.message : error) }
}
