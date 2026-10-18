import type { Bindings } from './auth.server'
import { addDays, addMonths, daysBetween } from './nectar/dates'
import { fingerprint, sha256Hex } from './nectar/core'
import { customers, products, insert, finance, pipeline } from './demo/records'
import { seedBilling } from './demo/billing'
import { seedWork } from './demo/work'
import { seedHistory } from './demo/history'

/** A real, private customer book; all dates move with the visitor's session. */
export async function seedDemo(env: Bindings, { ownerEmail, now }: { ownerEmail: string; now: Date }) {
  const at = now.getTime(), month = now.toISOString().slice(0, 7) + '-01'
  const start = addMonths(month, -3), actor = ownerEmail.toLowerCase(), hour = 3600000, day = 24 * hour
  // The owner set the workspace up the week before the first subscriptions started, mid-morning in Denver.
  const setup = Date.parse(`${addDays(start, -7)}T16:00:00Z`), minute = 60000
  const statements = [
    env.DB.prepare("INSERT INTO oa_first_run(singleton, completed_by, completed_at) SELECT 1, id, ? FROM oa_operators WHERE email = ? AND role = 'owner' ON CONFLICT DO NOTHING").bind(at, actor),
    insert(env, 'nc_members', { id: 'demo-owner', email: actor, name: 'Dana Brooks', role: 'owner', created_at: setup, updated_at: setup }),
    insert(env, 'nc_members', { id: 'demo-member-finance', email: finance, name: 'Marcus Lee', role: 'finance', created_at: at - 60 * day, updated_at: at - 60 * day }),
    insert(env, 'nc_members', { id: 'demo-member-accountant', email: 'leo@ledgerwise.example', name: 'Leo Park', role: 'accountant', created_at: at - 45 * day, updated_at: at - 45 * day }),
    // Keys nobody holds: only a hash of fresh random bytes is stored, as issueKey stores it.
    insert(env, 'nc_agent_keys', { id: 'demo-key-agent', name: 'Finance agent', key_hash: await sha256Hex(crypto.randomUUID()), scopes: 'prepare', created_by: actor, created_at: at - 40 * day, last_used_at: at - 2 * hour }),
    insert(env, 'nc_agent_keys', { id: 'demo-key-metering', name: 'Metering pipeline', key_hash: await sha256Hex(crypto.randomUUID()), scopes: 'usage', created_by: actor, created_at: at - 90 * day, last_used_at: at - 20 * 60000 }),
    insert(env, 'nc_business', { singleton: 1, legal_name: 'Fieldnote Software', address: '1600 Wynkoop St, Denver, CO 80202', billing_email: 'billing@fieldnote.example', timezone: 'America/Denver', invoice_prefix: 'FN', next_invoice_number: 2045, next_credit_number: 2, payment_terms_days: 30, tax_jurisdiction: 'CO', tax_mode: 'no_tax', tax_rate: '0.00', tax_note: 'Illustrative policy for this sample business; reviewed by Dana Brooks.', tax_reviewed_by: actor, tax_reviewed_at: setup + 20 * minute, updated_at: setup }),
    insert(env, 'nc_meters', { id: 'demo-meter', code: 'api_calls', name: 'API calls', unit_label: 'calls', revision: 'demo-v1', created_at: setup + 30 * minute }),
  ]
  for (const [code, name, kind, amount, description] of products) {
    statements.push(
      insert(env, 'nc_products', { id: `demo-${code}`, code, name, description, revision: 'demo-v1', created_at: setup + 35 * minute }),
      insert(env, 'nc_prices', { id: `demo-price-${code}`, product_id: `demo-${code}`, version: 1, kind, unit_amount: amount, meter_id: kind === 'unit' ? 'demo-meter' : null, revision: 'demo-v1', created_by: actor, created_at: setup + 40 * minute }),
      insert(env, 'nc_features', { product_id: `demo-${code}`, feature: code === 'seats' ? 'team_access' : 'api_access', note: description, created_by: actor, created_at: setup + 45 * minute }),
    )
  }
  for (const [i, [key, external, name, contact, seats, , address]] of customers.entries()) {
    const added = setup + (60 + 10 * i) * minute
    statements.push(
      insert(env, 'nc_customers', { id: `demo-${key}`, external_id: external, name, billing_email: `billing@${key}.example`, address, tax_exempt: key === 'lumen' ? 1 : 0, tax_exempt_ref: key === 'lumen' ? 'OR-EXEMPT-LH-2026' : '', revision: 'demo-v1', created_at: added, updated_at: added }),
      insert(env, 'nc_contacts', { id: `demo-contact-${key}`, customer_id: `demo-${key}`, name: contact, email: `ap@${key}.example`, role: 'Accounts payable', created_by: actor, created_at: added + minute }),
      insert(env, 'nc_subscriptions', { id: `demo-sub-${key}`, customer_id: `demo-${key}`, external_id: `SUB-${external}`, anchor_day: 1, start_date: start, revision: 'demo-v1', created_by: actor, created_at: added + 2 * minute, updated_at: added + 2 * minute }),
      ...products.map(([code]) => insert(env, 'nc_items', { id: `demo-item-${key}-${code}`, subscription_id: `demo-sub-${key}`, price_id: `demo-price-${code}`, quantity: code === 'seats' ? seats : 1, effective_from: start, created_at: added + 2 * minute })),
    )
  }
  const discounted = setup + (60 + 10 * customers.length) * minute
  statements.push(insert(env, 'nc_amendments', { id: 'demo-birchwood-discount', subscription_id: 'demo-sub-birchwood', kind: 'discount_percent', value: '10', effective_from: start, note: 'Launch partner discount', clause: '10% discount on seat fees for the contract term.', status: 'approved', created_by: actor, created_at: discounted, decided_by: actor, decided_at: discounted + 5 * minute }))
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
  await seedWork(env, month, at)
  await seedHistory(env)
}
