import type { Bindings } from './auth.server'
import { addDays, addMonths, daysBetween } from './nectar/dates'
import { fingerprint, sha256Hex } from './nectar/core'
import { customers, products, insert, finance, pipeline } from './demo/records'
import { seedBilling } from './demo/billing'
import { seedWork } from './demo/work'

/** A real, private customer book; all dates move with the visitor's session. */
export async function seedDemo(env: Bindings, { ownerEmail, now }: { ownerEmail: string; now: Date }) {
  const at = now.getTime(), month = now.toISOString().slice(0, 7) + '-01'
  const start = addMonths(month, -3), actor = ownerEmail.toLowerCase(), hour = 3600000, day = 24 * hour
  const statements = [
    env.DB.prepare("INSERT INTO oa_first_run(singleton, completed_by, completed_at) SELECT 1, id, ? FROM oa_operators WHERE email = ? AND role = 'owner' ON CONFLICT DO NOTHING").bind(at, actor),
    insert(env, 'nc_members', { id: 'demo-owner', email: actor, name: 'Rosa Bennett', role: 'owner', created_at: at, updated_at: at }),
    insert(env, 'nc_members', { id: 'demo-member-finance', email: finance, name: 'Marcus Lee', role: 'finance', created_at: at - 60 * day, updated_at: at - 60 * day }),
    insert(env, 'nc_members', { id: 'demo-member-accountant', email: 'priya@ledgerwise.example', name: 'Priya Shah', role: 'accountant', created_at: at - 45 * day, updated_at: at - 45 * day }),
    // Keys nobody holds: only a hash of fresh random bytes is stored, as issueKey stores it.
    insert(env, 'nc_agent_keys', { id: 'demo-key-agent', name: 'Finance agent', key_hash: await sha256Hex(crypto.randomUUID()), scopes: 'prepare', created_by: actor, created_at: at - 40 * day, last_used_at: at - 2 * hour }),
    insert(env, 'nc_agent_keys', { id: 'demo-key-metering', name: 'Metering pipeline', key_hash: await sha256Hex(crypto.randomUUID()), scopes: 'usage', created_by: actor, created_at: at - 90 * day, last_used_at: at - 20 * 60000 }),
    insert(env, 'nc_business', { singleton: 1, legal_name: 'Riverbend Software Inc', address: '1 River Road, Sacramento, CA', billing_email: 'billing@riverbend.example', timezone: 'UTC', invoice_prefix: 'RB', next_invoice_number: 7, next_credit_number: 2, payment_terms_days: 14, tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: '8.25', tax_note: 'Illustrative policy for this sample business; reviewed by Rosa Bennett.', tax_reviewed_by: actor, tax_reviewed_at: at, updated_at: at }),
    insert(env, 'nc_meters', { id: 'demo-meter', code: 'events', name: 'Processed events', unit_label: 'events', revision: 'demo-v1', created_at: at }),
  ]
  for (const [code, name, kind, amount, description] of products) {
    statements.push(
      insert(env, 'nc_products', { id: `demo-${code}`, code, name, description, revision: 'demo-v1', created_at: at }),
      insert(env, 'nc_prices', { id: `demo-price-${code}`, product_id: `demo-${code}`, version: 1, kind, unit_amount: amount, meter_id: kind === 'unit' ? 'demo-meter' : null, revision: 'demo-v1', created_by: actor, created_at: at }),
      insert(env, 'nc_features', { product_id: `demo-${code}`, feature: code === 'core' ? 'workspace' : code === 'seats' ? 'team_access' : 'api_access', note: description, created_by: actor, created_at: at }),
    )
  }
  for (const [key, external, name, contact, seats] of customers) {
    statements.push(
      insert(env, 'nc_customers', { id: `demo-${key}`, external_id: external, name, billing_email: `billing@${key}.example`, address: `${10 + seats} Market Street, San Francisco, CA`, tax_exempt: key === 'pinecrest' ? 1 : 0, tax_exempt_ref: key === 'pinecrest' ? 'CA-RESALE-PC-2026' : '', revision: 'demo-v1', created_at: at, updated_at: at }),
      insert(env, 'nc_contacts', { id: `demo-contact-${key}`, customer_id: `demo-${key}`, name: contact, email: `accounts@${key}.example`, role: 'Accounts payable', created_by: actor, created_at: at }),
      insert(env, 'nc_subscriptions', { id: `demo-sub-${key}`, customer_id: `demo-${key}`, external_id: `SUB-${external}`, anchor_day: 1, start_date: start, revision: 'demo-v1', created_by: actor, created_at: at, updated_at: at }),
      ...products.map(([code]) => insert(env, 'nc_items', { id: `demo-item-${key}-${code}`, subscription_id: `demo-sub-${key}`, price_id: `demo-price-${code}`, quantity: code === 'seats' ? seats : 1, effective_from: start, created_at: at })),
    )
  }
  statements.push(insert(env, 'nc_amendments', { id: 'demo-northwind-discount', subscription_id: 'demo-sub-northwind', kind: 'discount_percent', value: '10', effective_from: start, note: 'Launch partner discount', clause: '10% discount on platform and seat fees for the contract term.', status: 'approved', created_by: actor, created_at: at, decided_by: actor, decided_at: at }))
  await env.DB.batch(statements)
  // The metering pipeline reports each finished day; the current month runs to yesterday.
  const todayDate = now.toISOString().slice(0, 10)
  for (const offset of [-2, -1, 0]) {
    const period = addMonths(month, offset), next = addMonths(period, 1), batch = `demo-usage-${offset}`
    const days = Array.from({ length: daysBetween(period, next) }, (_, i) => addDays(period, i)).filter(date => date < todayDate)
    if (!days.length) continue
    const rows = [insert(env, 'nc_usage_batches', { id: batch, source: 'api', accepted: customers.length * days.length, duplicates: 0, rejected: 0, report_json: '[]', actor: pipeline, created_at: offset === 0 ? at - 20 * 60000 : Date.parse(next) - 4 * hour })]
    for (const [key, , , , , volume] of customers) {
      for (const [i, date] of days.entries()) {
        // Weekdays carry most traffic; growth of about 6% a month.
        const weekday = new Date(date + 'T00:00:00Z').getUTCDay() % 6 ? 1.15 : 0.6
        const occurred = Date.parse(date + 'T18:00:00Z')
        const event = { event_id: `demo-event-${key}-${offset}-${i}`, customer: `demo-${key}`, meter: 'demo-meter', quantity: String(Math.round(volume * (1 + offset * 0.06) * weekday / 30 / 10) * 10), occurred_at: new Date(occurred).toISOString() }
        rows.push(insert(env, 'nc_usage_events', { id: event.event_id, event_id: event.event_id, customer_id: event.customer, meter_id: event.meter, quantity: event.quantity, occurred_at: occurred, occurred_text: event.occurred_at, received_at: occurred + hour, batch_id: batch, payload_hash: await fingerprint(event) }))
      }
    }
    await env.DB.batch(rows)
  }
  await seedBilling(env, actor, month, at)
  await seedWork(env, actor, month, at)
}
