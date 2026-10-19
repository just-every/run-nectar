// Flows 4 and 8: subscriptions with an explicit cycle anchor, optional trial
// and contract exceptions that bill only once approved; and scheduled plan or
// quantity changes, prepared with their proration preview and applied only
// when a person approves that preview against the same subscription revision.
import type { Bindings } from '../auth.server'
import { requirePrice } from './catalog'
import { actorLabel, requireCapability, requireMember, type Actor } from './actor'
import { requireBusiness } from './business'
import { all, commit, guard, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import { canonicalDecimal, micros } from './decimal'
import { isDate, periodContaining, requireDate } from './dates'
import { rated } from './inputs'
import { lifecycleHistory, lifecycleIntervals } from './lifecycle-records'
import { lifecyclePolicy } from './lifecycle-policy'
import { sourceMeterIds,uniqueMeterItems } from './metric-ownership'
import { contractsFor, contractBurnDown } from './contract-terms'
import { metadataFor,withMetadata } from './metadata'
import type { Input } from './input'
import type { ItemIn, Line } from './rating'

export async function requireSubscription(env: Bindings, id: string) {
  const sub = await one(env, 'SELECT s.*, c.name AS customer_name, c.external_id AS customer_external_id FROM nc_subscriptions s JOIN nc_customers c ON c.id = s.customer_id WHERE s.id = ?', id)
  insist(sub, 'subscription_not_found', 404)
  return sub
}

export async function subscriptionDetail(env: Bindings, actor: Actor, id: string): Promise<Row> {
  requireCapability(actor, 'read')
  const sub = await requireSubscription(env, id)
  const [items, amendments, changes, invoices] = await Promise.all([
    all(env, 'SELECT i.*, p.kind, p.unit_amount, p.pricing_model, p.version, p.nickname, pr.name AS product_name, m.code AS meter_code FROM nc_items i JOIN nc_prices p ON p.id = i.price_id JOIN nc_products pr ON pr.id = p.product_id LEFT JOIN nc_meters m ON m.id = p.meter_id WHERE i.subscription_id = ? ORDER BY i.effective_from, i.id', id),
    all(env, 'SELECT * FROM nc_amendments WHERE subscription_id = ? ORDER BY created_at', id),
    all(env, 'SELECT * FROM nc_changes WHERE subscription_id = ? ORDER BY created_at DESC', id),
    all(env, "SELECT id, number, status, period_start, period_end, total_cents FROM nc_invoices WHERE subscription_id = ? AND status <> 'discarded' ORDER BY period_start DESC", id),
  ])
  const history = await lifecycleHistory(env, id)
  return { ...sub, contracts:await contractsFor(env,id),burnDown:await contractBurnDown(env,id), lifecyclePolicy: await lifecyclePolicy(env), lifecycle: history, intervals: lifecycleIntervals(history),...await metadataFor(env,'subscription',id), items, amendments, changes: changes.map(change => ({ ...change, preview: parseJson(change.preview_json, {}), preview_json: undefined })), invoices:await withMetadata(env,'invoice',invoices) }
}

// A subscription holds its meters while it is live on or after `from`: no end
// date yet, or one after it. Checked before the write and again inside it.
const CLASH = (count: number) => `SELECT 1 FROM nc_items i JOIN nc_prices p ON p.id = i.price_id LEFT JOIN nc_meters m ON m.id=p.meter_id JOIN nc_subscriptions s ON s.id = i.subscription_id
    WHERE s.customer_id = ? AND s.id <> ? AND (s.end_date IS NULL OR s.end_date > ?) AND (i.effective_to IS NULL OR i.effective_to > ?) AND COALESCE(m.source_meter_id,p.meter_id) IN (${Array(count).fill('?').join(',')})`

async function meterClash(env: Bindings, customerId: string, meterIds: string[], from: string, exceptSubscription = '') {
  if (!meterIds.length) return false
  return !!await one(env, CLASH(meterIds.length), customerId, exceptSubscription, from, from, ...meterIds)
}

/** An exception may not start inside a period already issued: that invoice never changes, so the exception would be lost. */
export const startsInIssuedPeriod = async (env: Bindings, subscriptionId: string, from: string) =>
  !!await one(env, "SELECT 1 FROM nc_invoices WHERE subscription_id = ? AND status = 'issued' AND period_end > ?", subscriptionId, from)
export const notIssuedGuard = (env: Bindings, subscriptionId: string, from: string) =>
  guard(env, 'period_already_invoiced', "NOT EXISTS(SELECT 1 FROM nc_invoices WHERE subscription_id = ? AND status = 'issued' AND period_end > ?)", subscriptionId, from)

function readAmendment(input: Input, prefix = '') {
  const kind = input.text(`${prefix}kind`, { max: 20 })
  insist(['discount_percent', 'fixed_credit', 'price_override'].includes(kind), 'invalid_amendment_kind')
  const value = canonicalDecimal(input.text(`${prefix}value`, { max: 24 }), 'amendment_value')
  if (kind === 'discount_percent') insist(micros(value) > 0n && micros(value) <= 100_000_000n, 'invalid_amendment_value')
  if (kind === 'fixed_credit') insist(micros(value) > 0n && micros(value) % 10_000n === 0n, 'invalid_amendment_value')
  const from = requireDate(input.text(`${prefix}effective_from`, { max: 10 }), 'effective_from')
  const to = input.text(`${prefix}effective_to`, { max: 10, optional: true }) || null
  insist(!to || (isDate(to) && to > from), 'invalid_effective_to')
  return { kind, value, from, to, priceId: kind === 'price_override' ? input.text(`${prefix}price`, { max: 100 }) : null, note: input.text(`${prefix}note`, { max: 200, optional: true }), clause: input.text(`${prefix}clause`, { max: 2000, optional: true }) }
}

export async function createSubscription(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'records')
  await requireBusiness(env)
  const customer = await one(env, "SELECT * FROM nc_customers WHERE id = ? AND status = 'active'", input.text('customer', { max: 100 }))
  insist(customer, 'customer_not_found', 404)
  const start = requireDate(input.text('start_date', { max: 10 }), 'start_date')
  const day = Number(start.slice(8))
  const anchor = input.integer('anchor_day', { min: 1, max: 28, optional: true }) ?? (day <= 28 ? day : null)
  insist(anchor, 'anchor_day_required')
  const trialEnd = input.text('trial_end', { max: 10, optional: true }) || null
  insist(!trialEnd || (isDate(trialEnd) && trialEnd > start), 'invalid_trial_end')
  const externalId = input.text('external_id', { max: 80, optional: true }) || null
  const priceIds = input.list('price', { keepEmpty: true }), quantities = input.list('quantity', { keepEmpty: true })
  const lines = priceIds.map((price, index) => ({ price, quantity: quantities[index] ?? '' })).filter(line => line.price)
  insist(lines.length > 0 && lines.length <= 20, 'items_required')
  const items: Row[] = []
  for (const line of lines) {
    const price = await one(env, "SELECT * FROM nc_prices WHERE id = ? AND status = 'active'", line.price)
    insist(price, 'price_not_found', 404)
    const quantity = price.kind === 'seat' ? Number(line.quantity) : 1
    insist(Number.isSafeInteger(quantity) && quantity >= (price.pricing_model === 'simple' ? 1 : 0) && quantity <= (price.pricing_model === 'simple' ? 1_000_000 : 1_000_000_000), 'invalid_quantity')
    items.push({ id: newId(), price, quantity })
  }
  const meters = [...new Set(await sourceMeterIds(env,items.flatMap(item => item.price.meter_id ? [item.price.meter_id] : [])))]
  await uniqueMeterItems(env,items.map(item=>({id:item.id,priceId:item.price.id,quantity:item.quantity,from:start,to:null})))
  insist(!await meterClash(env, customer.id, meters, start), 'meter_already_billed', 409)
  const id = newId(), at = now(), by = actorLabel(actor)
  const exception = input.has('exception_kind') ? readAmendment(input, 'exception_') : null
  if (exception?.kind === 'price_override') {
    insist(items.some(item => item.price.id === exception.priceId), 'override_price_not_on_subscription')
    insist(items.find(item => item.price.id === exception.priceId)!.price.pricing_model === 'simple', 'override_price_model')
  }
  const statements = [
    ...(meters.length ? [guard(env, 'meter_already_billed', `NOT EXISTS(${CLASH(meters.length)})`, customer.id, id, start, start, ...meters)] : []),
    stmt(env, "INSERT INTO nc_subscriptions (id, customer_id, external_id, anchor_day, start_date, trial_end, billing_mode, origin, revision, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'live', 'native', ?, ?, ?, ?)", id, customer.id, externalId, anchor, start, trialEnd, newId(), by, at, at),
    ...items.map(item => stmt(env, "INSERT INTO nc_items (id, subscription_id, price_id, quantity, effective_from, origin, created_at) VALUES (?, ?, ?, ?, ?, 'native', ?)", item.id, id, item.price.id, item.quantity, start, at)),
    ...(exception ? [stmt(env, "INSERT INTO nc_amendments (id, subscription_id, kind, value, price_id, effective_from, effective_to, note, clause, status, origin, created_by, created_at, prepared_by_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 'native', ?, ?, ?)",
      newId(), id, exception.kind, exception.value, exception.priceId, exception.from, exception.to, exception.note, exception.clause, by, at, actor.id)] : []),
  ]
  await commit(env, statements, { actor: by, action: 'subscription.create', subject: id, detail: { customer: customer.external_id, start, anchor, trialEnd, items: items.map(item => ({ price: item.price.id, quantity: item.quantity })), exception: exception?.kind ?? null } })
  return { id }
}

/** Records a contract exception as proposed; it affects no bill until approved. */
export async function proposeAmendment(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'records')
  const sub = await requireSubscription(env, input.text('subscription', { max: 100 }))
  const amendment = readAmendment(input)
  if (amendment.priceId) insist((await requirePrice(env, amendment.priceId)).pricing_model === 'simple', 'override_price_model')
  if (amendment.priceId) insist(await one(env, 'SELECT 1 FROM nc_items WHERE subscription_id = ? AND price_id = ?', sub.id, amendment.priceId), 'override_price_not_on_subscription')
  insist(!await startsInIssuedPeriod(env, sub.id, amendment.from), 'period_already_invoiced', 409)
  const id = newId()
  await commit(env, [stmt(env, "INSERT INTO nc_amendments (id, subscription_id, kind, value, price_id, effective_from, effective_to, note, clause, status, origin, created_by, created_at, prepared_by_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 'native', ?, ?, ?)",
    id, sub.id, amendment.kind, amendment.value, amendment.priceId, amendment.from, amendment.to, amendment.note, amendment.clause, actorLabel(actor), now(), actor.id)],
  { actor: actorLabel(actor), action: 'amendment.propose', subject: id, detail: { subscription: sub.id, ...amendment } })
  return { id: sub.id, amendment: id }
}

export function amendmentStatements(env: Bindings, actor: Actor, amendment: Row, decision: 'approved' | 'rejected') {
  return [
    stmt(env, "UPDATE nc_amendments SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'proposed'", decision, actorLabel(actor), now(), amendment.id),
    ...(decision === 'approved' ? [stmt(env, 'UPDATE nc_subscriptions SET revision = ?, updated_at = ? WHERE id = ?', newId(), now(), amendment.subscription_id)] : []),
  ]
}

export async function decideAmendment(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const amendment = await one(env, 'SELECT * FROM nc_amendments WHERE id = ?', input.text('amendment', { max: 100 }))
  insist(amendment, 'amendment_not_found', 404)
  insist(amendment.status === 'proposed', 'already_decided', 409)
  const decision = input.text('decision', { max: 10 })
  insist(decision === 'approved' || decision === 'rejected', 'invalid_decision')
  if (decision === 'approved' && amendment.kind === 'price_override') {
    insist(amendment.prepared_by_id, 'price_override_needs_preparation', 409)
    insist(amendment.prepared_by_id !== actor.id, 'second_approver_required', 409)
  }
  if (decision === 'approved' && amendment.price_id) insist((await requirePrice(env, amendment.price_id)).pricing_model === 'simple', 'override_price_model')
  if (decision === 'approved') insist(!await startsInIssuedPeriod(env, amendment.subscription_id, amendment.effective_from), 'period_already_invoiced', 409)
  await commit(env, [guard(env, 'stale', "EXISTS(SELECT 1 FROM nc_amendments WHERE id = ? AND status = 'proposed')", amendment.id), ...(decision === 'approved' ? [notIssuedGuard(env, amendment.subscription_id, amendment.effective_from)] : []), ...amendmentStatements(env, actor, amendment, decision)],
    { actor: actorLabel(actor), action: `amendment.${decision === 'approved' ? 'approve' : 'reject'}`, subject: amendment.id, detail: { subscription: amendment.subscription_id, kind: amendment.kind, value: amendment.value } })
  return { id: amendment.subscription_id, status: decision }
}

const recurringLines = (lines: Line[]) => lines.filter(line => line.kind === 'flat' || line.kind === 'seat' || line.kind === 'discount')
  .map(line => ({ kind: line.kind, description: line.description, quantity: line.quantity, unitAmount: line.unitAmount, amountCents: line.amountCents, periodStart: line.periodStart, periodEnd: line.periodEnd }))

/** Prepares a plan or quantity change and shows exactly what the affected period would bill, before and after. */
export async function prepareChange(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'records')
  const business = await requireBusiness(env)
  const sub = await requireSubscription(env, input.text('subscription', { max: 100 }))
  const item = await one(env, 'SELECT * FROM nc_items WHERE id = ? AND subscription_id = ?', input.text('item', { max: 100 }), sub.id)
  insist(item, 'item_not_found', 404)
  const date = requireDate(input.text('effective_date', { max: 10 }), 'effective_date')
  insist(date > item.effective_from && (!item.effective_to || date < item.effective_to) && (!sub.end_date || date < sub.end_date), 'invalid_effective_date')
  const period = periodContaining(sub.anchor_day, date)
  insist(!await one(env, "SELECT 1 FROM nc_invoices WHERE subscription_id = ? AND status = 'issued' AND period_end > ?", sub.id, date), 'period_already_invoiced', 409)
  const price = await one(env, "SELECT * FROM nc_prices WHERE id = ? AND status = 'active'", input.has('price') ? input.text('price', { max: 100 }) : item.price_id)
  insist(price, 'price_not_found', 404)
  const old = await one(env, 'SELECT * FROM nc_prices WHERE id = ?', item.price_id)
  insist((price.meter_id ?? '') === (old!.meter_id ?? '') || price.kind !== 'unit', 'change_meter_separately')
  const quantity = price.kind === 'seat' ? input.integer('quantity', { min: price.pricing_model === 'simple' ? 1 : 0, max: price.pricing_model === 'simple' ? 1_000_000 : 1_000_000_000 })! : 1
  insist(price.id !== item.price_id || quantity !== item.quantity, 'nothing_changes')
  const items: ItemIn[] = (await all(env, 'SELECT * FROM nc_items WHERE subscription_id = ? ORDER BY effective_from, id', sub.id)).map(row => ({ id: row.id, priceId: row.price_id, quantity: row.quantity, from: row.effective_from, to: row.effective_to }))
  const changed: ItemIn[] = [...items.map(row => row.id === item.id ? { ...row, to: date } : row), { id: 'change', priceId: price.id, quantity, from: date, to: item.effective_to }]
  await uniqueMeterItems(env,changed)
  const before = (await rated(env, business, sub.id, period, items)).rating
  const after = (await rated(env, business, sub.id, period, changed)).rating
  const next = periodContaining(sub.anchor_day, period.end)
  const nextAfter = (await rated(env, business, sub.id, next, changed)).rating
  const preview = {
    period, effectiveDate: date,
    before: { lines: recurringLines(before.lines), cents: recurringLines(before.lines).reduce((sum, line) => sum + line.amountCents, 0) },
    after: { lines: recurringLines(after.lines), cents: recurringLines(after.lines).reduce((sum, line) => sum + line.amountCents, 0) },
    nextPeriod: { period: next, lines: recurringLines(nextAfter.lines), cents: recurringLines(nextAfter.lines).reduce((sum, line) => sum + line.amountCents, 0) },
  }
  const id = newId()
  await commit(env, [stmt(env, "INSERT INTO nc_changes (id, subscription_id, item_id, new_price_id, new_quantity, effective_date, subscription_revision, preview_json, status, created_by, created_at, prepared_by_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)",
    id, sub.id, item.id, price.id, quantity, date, sub.revision, JSON.stringify(preview), actorLabel(actor), now(), actor.id)],
  { actor: actorLabel(actor), action: 'change.prepare', subject: id, detail: { subscription: sub.id, item: item.id, price: price.id, quantity, date } })
  return { id: sub.id, change: id, preview }
}

/** Applies a prepared change when a person approves its preview and nothing on the subscription moved since. */
export async function decideChange(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const change = await one(env, 'SELECT * FROM nc_changes WHERE id = ?', input.text('change', { max: 100 }))
  insist(change, 'change_not_found', 404)
  insist(change.status === 'draft', 'already_decided', 409)
  const decision = input.text('decision', { max: 10 })
  insist(decision === 'approved' || decision === 'discarded', 'invalid_decision')
  const sub = await requireSubscription(env, change.subscription_id)
  if (decision === 'discarded') {
    await commit(env, [stmt(env, "UPDATE nc_changes SET status = 'discarded', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'draft'", actorLabel(actor), now(), change.id)], { actor: actorLabel(actor), action: 'change.discard', subject: change.id })
    return { id: sub.id, status: 'discarded' }
  }
  insist(sub.revision === change.subscription_revision, 'stale', 409)
  const item = await one(env, 'SELECT * FROM nc_items WHERE id = ?', change.item_id)
  if (item!.price_id !== change.new_price_id) {
    insist(change.prepared_by_id, 'price_switch_needs_preparation', 409)
    insist(change.prepared_by_id !== actor.id, 'second_approver_required', 409)
  }
  const at = now()
  await commit(env, [
    guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_subscriptions WHERE id = ? AND revision = ?)', sub.id, change.subscription_revision),
    guard(env, 'already_billed', "NOT EXISTS(SELECT 1 FROM nc_invoices WHERE subscription_id = ? AND status = 'issued' AND period_end > ?)", sub.id, change.effective_date),
    stmt(env, 'UPDATE nc_items SET effective_to = ? WHERE id = ?', change.effective_date, item!.id),
    stmt(env, "INSERT INTO nc_items (id, subscription_id, price_id, quantity, effective_from, effective_to, change_id, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'native', ?)", newId(), sub.id, change.new_price_id, change.new_quantity, change.effective_date, item!.effective_to, change.id, at),
    stmt(env, 'UPDATE nc_subscriptions SET revision = ?, updated_at = ? WHERE id = ?', newId(), at, sub.id),
    stmt(env, "UPDATE nc_changes SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'draft'", actorLabel(actor), at, change.id),
  ], { actor: actorLabel(actor), action: 'change.approve', subject: change.id, detail: { subscription: sub.id, effective: change.effective_date, preview: parseJson(change.preview_json, {}) } })
  return { id: sub.id, status: 'approved' }
}

/** Existing end-date door retains its date field and now records lifecycle custody. */
export async function endSubscription(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const { cancelSubscription } = await import('./lifecycle-cancel')
  const { Input: LifecycleInput } = await import('./input')
  const sub = await requireSubscription(env, input.text('subscription', {max:100}))
  return await cancelSubscription(env, actor, LifecycleInput.of({subscription:sub.id, revision:sub.revision,
    mode:'immediate', effective_date:input.text('end_date',{max:10}), reason:input.text('reason',{max:500,optional:true}) || 'Scheduled end requested by operator'}))
}
