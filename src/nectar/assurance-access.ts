// A recorded cancellation compared with the features the customer still holds.
// A detector only reads: ending the other subscription is the ordinary human-approved cancel door.
import type { Bindings } from '../auth.server'
import type { Actor } from './actor'
import { all, fingerprint, type Row } from './core'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { today } from './dates'
import { explainEntitlement } from './entitlements'

export const ACCESS_KIND = 'cancellation_access'
const reader: Actor = { id: 'system:assurance', kind: 'agent', name: 'Assurance reader', email: '', role: null, sessionId: null, capabilities: new Set(['read']) }

/** One evidence record per cancelled subscription whose product features another subscription still grants. */
export async function accessEvidence(env: Bindings) {
  const day = today((await requireBusiness(env)).timezone, clockInstant(env))
  const cancelled = await all(env, `SELECT s.id,s.customer_id,s.end_date FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id
    WHERE c.erased_at IS NULL AND s.end_date IS NOT NULL AND s.end_date<=? AND EXISTS(SELECT 1 FROM nc_subscription_lifecycle l WHERE l.subscription_id=s.id AND l.kind='cancel'
      AND NOT EXISTS(SELECT 1 FROM nc_subscription_lifecycle r WHERE r.related_id=l.id)) ORDER BY s.id`, day)
  const found: Row[] = []
  for (const sub of cancelled) {
    const features = (await all(env, `SELECT DISTINCT f.feature FROM nc_items i JOIN nc_prices p ON p.id=i.price_id JOIN nc_features f ON f.product_id=p.product_id
      WHERE i.subscription_id=? ORDER BY f.feature`, sub.id)).map(r => r.feature as string)
    const held: Row[] = []
    for (const feature of features) {
      const view = await explainEntitlement(env, reader, sub.customer_id, feature, day)
      const by = view.paths.filter((p: Row) => p.granted && p.subscription && p.subscription !== sub.id)
      if (by.length) held.push({ feature, grantedBy: by.map((p: Row) => ({ subscription: p.subscription, lifecycle: p.state?.lifecycle ?? null })) })
    }
    const proof = { kind: ACCESS_KIND, source: `access:${sub.id}`, customer: sub.customer_id, subscription: sub.id, cancelledOn: sub.end_date,
      features, stillGranted: held, mismatch: held.length > 0 }
    found.push({ ...proof, basis: await fingerprint(proof) })
  }
  return found
}
