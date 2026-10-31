// Only this customer's persisted sandbox clock advances. Ratings are frozen
// previews, never issued invoices, collection attempts or notification jobs.
import type { Bindings } from '../auth.server'
import { actorLabel, type Actor } from './actor'
import { dueBillingWindows, INTERVAL_RATING_VERSION } from './billing-calendar'
import { all, commit, guard, insist, newId, now, one, stmt } from './core'
import { addDays, addMonthsClamped, localDate, parseInstant, requireDate } from './dates'
import type { Input } from './input'
import { requireFreshFactor } from './mfa'
import { rate, type ItemIn, type RatingInput } from './rating'
import { requireSandbox, sandboxCatalog } from './test-mode'

interface SandboxCustomer {
  id: string; catalog_id: string; label: string; start_date: string; trial_end: string | null
  items_json: string; clock_at: number; revision: number
}

async function customer(env: Bindings, id: string) {
  const found = await one<SandboxCustomer>(env, 'SELECT * FROM nc_sandbox_customers WHERE id=?', id)
  insist(found, 'sandbox_customer_not_found', 404)
  return found
}

async function previews(env: Bindings, c: SandboxCustomer, through: number) {
  const catalog = await sandboxCatalog(env, c.catalog_id), date = localDate(through, catalog.configuration.timezone)
  insist(date <= addMonthsClamped(c.start_date, 120), 'sandbox_clock_range', 409)
  const basis: RatingInput = { version: INTERVAL_RATING_VERSION, timezone: catalog.configuration.timezone, tax: catalog.configuration.tax,
    subscription: { id: c.id, startDate: c.start_date, anchorDay: Number(c.start_date.slice(8)), trialEnd: c.trial_end, endDate: null, billFrom: null, billingAnchorDate: c.start_date },
    period: { start: c.start_date, end: addDays(date, 1) }, items: JSON.parse(c.items_json), prices: Object.fromEntries(catalog.prices.map(p => [p.id, p])), amendments: [], events: [] }
  const windows = dueBillingWindows(basis, c.start_date, addDays(date, 1))
  insist(windows.length <= 120, 'sandbox_advance_too_many_previews', 409)
  return windows.map(window => {
    const inputs = { ...basis, billing: window, period: window.period }
    return { key: window.key, dueDate: window.dueDate, period: window.period, inputs, rating: rate(inputs) }
  })
}

export async function sandboxCustomerView(env: Bindings, actor: Actor, id: string) {
  requireSandbox(actor)
  const c = await customer(env, id)
  return { ...c, items: JSON.parse(c.items_json), items_json: undefined, catalog: await sandboxCatalog(env, c.catalog_id),
    history: await all(env, 'SELECT revision,previous_at,clock_at,created_at FROM nc_sandbox_clock_events WHERE customer_id=? ORDER BY revision', c.id),
    previews: (await all(env, 'SELECT preview_json FROM nc_sandbox_previews WHERE customer_id=? ORDER BY due_date,window_key', c.id)).map(row => JSON.parse(row.preview_json)) }
}

export async function createSandboxCustomer(env: Bindings, actor: Actor, input: Input) {
  requireSandbox(actor)
  await requireFreshFactor(env, actor)
  input.only(['catalog', 'label', 'clock', 'trial_end', 'price', 'quantity', 'returnTo'])
  const catalog = await sandboxCatalog(env, input.text('catalog', { max: 100 }))
  const clock = parseInstant(input.text('clock', { max: 50 }), 'clock'), start = localDate(clock, catalog.configuration.timezone)
  insist(start >= '2000-01-01' && start < '9990-01-01', 'sandbox_clock_range')
  const trial = input.text('trial_end', { optional: true, max: 10 })
  if (trial) insist(requireDate(trial, 'trial_end') > start && trial <= addMonthsClamped(start, 12), 'invalid_trial_end')
  const ids = input.list('price'), quantities = input.list('quantity')
  insist(ids.length > 0 && ids.length <= 20 && new Set(ids).size === ids.length && quantities.length === ids.length, 'sandbox_invalid_items')
  const items: ItemIn[] = ids.map((id, index) => {
    const price = catalog.prices.find(p => p.id === id)
    insist(price, 'sandbox_price_not_found', 404)
    const quantity = Number(quantities[index])
    insist(/^\d+$/.test(quantities[index]) && Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 1_000_000 && (price.kind !== 'flat' || quantity === 1), 'invalid_quantity')
    return { id: `sandbox_item_${newId()}`, priceId: id, quantity, from: start, to: null }
  })
  const c: SandboxCustomer = { id: `sandbox_customer_${newId()}`, catalog_id: catalog.id, label: input.text('label', { max: 120 }), start_date: start, trial_end: trial || null, items_json: JSON.stringify(items), clock_at: clock, revision: 1 }
  const initial = await previews(env, c, clock)
  await commit(env, [stmt(env, 'INSERT INTO nc_sandbox_customers(id,catalog_id,label,start_date,trial_end,items_json,clock_at,revision,created_at) VALUES(?,?,?,?,?,?,?,?,?)', c.id, c.catalog_id, c.label, c.start_date, c.trial_end, c.items_json, c.clock_at, 1, now()),
    stmt(env, 'INSERT INTO nc_sandbox_clock_events(customer_id,revision,previous_at,clock_at,created_at) VALUES(?,1,NULL,?,?)', c.id, clock, now()),
    ...previewStatements(env, c.id, initial),
  ], { actor: actorLabel(actor), action: 'sandbox.customer.create', subject: c.id, detail: { catalog: c.catalog_id, clockAt: clock, previews: initial.length } })
  return { id: c.id, revision: 1, clock_at: clock }
}

function previewStatements(env: Bindings, id: string, rows: Awaited<ReturnType<typeof previews>>) {
  return rows.map(p => stmt(env, 'INSERT INTO nc_sandbox_previews(customer_id,window_key,due_date,preview_json) VALUES(?,?,?,?)', id, p.key, p.dueDate, JSON.stringify(p)))
}

export async function advanceSandboxClock(env: Bindings, actor: Actor, input: Input) {
  requireSandbox(actor)
  await requireFreshFactor(env, actor)
  input.only(['customer', 'revision', 'clock', 'confirm', 'returnTo'])
  insist(input.flag('confirm'), 'sandbox_confirmation_required')
  const c = await customer(env, input.text('customer', { max: 100 })), revision = input.integer('revision', { min: 1, max: Number.MAX_SAFE_INTEGER - 1 })
  insist(revision === c.revision, 'sandbox_clock_stale', 409)
  const clock = parseInstant(input.text('clock', { max: 50 }), 'clock')
  insist(clock > c.clock_at, 'sandbox_clock_must_advance', 409)
  const existing = new Set((await all(env, 'SELECT window_key FROM nc_sandbox_previews WHERE customer_id=?', c.id)).map(row => row.window_key))
  const next = (await previews(env, c, clock)).filter(p => !existing.has(p.key))
  insist(next.length <= 120, 'sandbox_advance_too_many_previews', 409)
  await commit(env, [guard(env, 'sandbox_clock_stale', 'EXISTS(SELECT 1 FROM nc_sandbox_customers WHERE id=? AND revision=? AND clock_at=?)', c.id, revision, c.clock_at),
    stmt(env, 'UPDATE nc_sandbox_customers SET clock_at=?,revision=revision+1 WHERE id=?', clock, c.id),
    stmt(env, 'INSERT INTO nc_sandbox_clock_events(customer_id,revision,previous_at,clock_at,created_at) VALUES(?,?,?,?,?)', c.id, c.revision + 1, c.clock_at, clock, now()),
    ...previewStatements(env, c.id, next),
  ], { actor: actorLabel(actor), action: 'sandbox.clock.advance', subject: c.id, detail: { from: c.clock_at, to: clock, revision: c.revision + 1, previews: next.length } })
  return { id: c.id, revision: c.revision + 1, clock_at: clock, addedPreviews: next.length }
}
