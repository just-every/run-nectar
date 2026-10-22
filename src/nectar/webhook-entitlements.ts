// DEV-001 entitlement events. Triggers mark a customer whose grants may have
// changed (subscription, item, lifecycle or product-feature writes); the daily
// tick marks every subscribed customer for date-, usage- and payment-driven
// changes. Each marked customer's features granted today are recomputed with the
// NEC-13/ENT-002 explanation, and an `entitlements.updated` event is stored only
// when that set differs from the last one sent.
import type { Bindings } from '../auth.server'
import type { Actor } from './actor'
import { requireBusiness } from './business'
import { NectarError, all, canonical, commit, guard, newId, one, stmt } from './core'
import { today } from './dates'
import { explainEntitlement } from './entitlements'

// The explanation reads records on the system's behalf; nothing here is shown to a member.
const SYSTEM: Actor = { id: 'system:webhooks', kind: 'agent', name: 'webhooks', email: '', role: null, sessionId: null, capabilities: new Set(['read']) }
const listening = async (env: Bindings) => !!await one(env, "SELECT 1 FROM nc_webhook_endpoints WHERE status='active' LIMIT 1")

/** The daily tick re-reads every customer with a subscription. */
export async function markEntitlementsDue(env: Bindings, at: number) {
  if (!await listening(env)) return
  await env.DB.prepare('INSERT OR IGNORE INTO nc_entitlement_dirty(customer_id,marked_at) SELECT DISTINCT s.customer_id,? FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id WHERE c.erased_at IS NULL').bind(at).run()
}

async function grantedFeatures(env: Bindings, customer: string, day: string) {
  const features = await all<{ feature: string }>(env, `SELECT DISTINCT f.feature FROM nc_features f JOIN nc_prices p ON p.product_id=f.product_id JOIN nc_items i ON i.price_id=p.id
    JOIN nc_subscriptions s ON s.id=i.subscription_id WHERE s.customer_id=? ORDER BY f.feature`, customer)
  const granted = []
  for (const { feature } of features) {
    const decision = await explainEntitlement(env, SYSTEM, customer, feature, day)
    if (decision.allowed) granted.push({ feature, subscriptions: decision.paths.filter(path => path.granted).map(path => path.subscription) })
  }
  return granted
}

export async function syncEntitlements(env: Bindings, at: number, limit = 25) {
  const marked = await all<{ customer_id: string; marked_at: number }>(env, 'SELECT customer_id,marked_at FROM nc_entitlement_dirty ORDER BY marked_at,customer_id LIMIT ?', limit)
  if (!marked.length) return 0
  const zone = (await requireBusiness(env)).timezone, day = today(zone, at)
  for (const row of marked) {
    const clear = stmt(env, 'DELETE FROM nc_entitlement_dirty WHERE customer_id=? AND marked_at=?', row.customer_id, row.marked_at)
    const customer = await one(env, 'SELECT id,erased_at FROM nc_customers WHERE id=?', row.customer_id)
    if (!customer || customer.erased_at || !await listening(env)) { await clear.run(); continue }
    const features = await grantedFeatures(env, row.customer_id, day)
    const last = await one<{ summary_json: string }>(env, 'SELECT summary_json FROM nc_entitlement_summaries WHERE customer_id=?', row.customer_id)
    const previous = last ? (JSON.parse(last.summary_json) as { features: { feature: string }[] }).features : []
    if (canonical(previous) === canonical(features)) { await clear.run(); continue }
    const id = `evt_${newId().replaceAll('-', '').slice(0, 24)}`, ms = Date.now()
    const metadata = await one<{ metadata_json: string }>(env, "SELECT metadata_json FROM nc_metadata_revisions WHERE kind='customer' AND record_id=? ORDER BY revision DESC LIMIT 1", row.customer_id)
    const payload = JSON.stringify({ id, object: 'event', type: 'entitlements.updated', created: Math.floor(ms / 1000), data: {
      object: { object: 'entitlement_summary', customer_id: row.customer_id, date: day, features, previous_features: previous },
      metadata: { customer: metadata ? JSON.parse(metadata.metadata_json) : {} } } })
    // The summary moves only if the customer was not marked again while this one was read.
    try {
      await commit(env, [
        guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_entitlement_dirty WHERE customer_id=? AND marked_at=?)', row.customer_id, row.marked_at),
        stmt(env, "INSERT INTO nc_webhook_events(id,kind,customer_id,record_id,payload_json,created_at) VALUES(?,'entitlements.updated',?,?,?,?)", id, row.customer_id, row.customer_id, payload, ms),
        stmt(env, `INSERT INTO nc_entitlement_summaries(customer_id,summary_json,event_id,updated_at) VALUES(?,?,?,?)
          ON CONFLICT(customer_id) DO UPDATE SET summary_json=excluded.summary_json,event_id=excluded.event_id,updated_at=excluded.updated_at`, row.customer_id, JSON.stringify({ date: day, features }), id, ms),
        clear,
      ], { actor: 'system:webhooks', action: 'entitlements.summary', subject: row.customer_id, detail: { event: id, features: features.map(f => f.feature) } })
    } catch (error) { if (!(error instanceof NectarError && error.code === 'stale')) throw error }
  }
  return marked.length
}
