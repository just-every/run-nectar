// Agent-prepared work. An agent (or a person) proposes; a person approves.
// Nectar computes every amount itself with the rating engine; a proposal's
// own numbers are never trusted. Each proposal records the source versions it
// was prepared against (`basis`); approval re-reads them and refuses a stale
// proposal. Approving a data correction re-prepares a draft bill run but
// approves no invoice: those still need their own approval.
import type { Bindings } from '../auth.server'
import { actorLabel, requireCapability, requireMember, type Actor } from './actor'
import { requireBusiness, type Business } from './business'
import { all, canonical, commit, guard, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import { canonicalDecimal, micros } from './decimal'
import { addDays, isDate, localDate, periodContaining, periodStartingIn, zonedStart } from './dates'
import { ratingInputs } from './inputs'
import { requirePrice } from './catalog'
import { Input } from './input'
import { rate, type AmendmentIn, type RatingInput } from './rating'
import { basisKey, reminderBasis, reminderDraft } from './collections'
import { ingestStatements, screen, type RawEvent } from './usage'
import { notIssuedGuard, startsInIssuedPeriod } from './subscriptions'
import { prepareRun } from './billruns'

const KINDS = ['amendment', 'price_change', 'usage_correction', 'collection'] as const
type Kind = typeof KINDS[number]

const total = (input: RatingInput) => { const r = rate(input); return { subtotalCents: r.subtotalCents, totalCents: r.totalCents, lines: r.lines.map(line => ({ description: line.description, amountCents: line.amountCents })) } }

async function amendmentPlan(env: Bindings, business: Business, payload: Row) {
  const sub = await one(env, 'SELECT * FROM nc_subscriptions WHERE id = ?', String(payload.subscription ?? ''))
  insist(sub, 'subscription_not_found', 404)
  const kind = String(payload.kind ?? '')
  insist(['discount_percent', 'fixed_credit', 'price_override'].includes(kind), 'invalid_amendment_kind')
  const value = canonicalDecimal(String(payload.value ?? ''), 'amendment_value')
  if (kind === 'discount_percent') insist(micros(value) > 0n && micros(value) <= 100_000_000n, 'invalid_amendment_value')
  insist(micros(value) > 0n, 'invalid_amendment_value')
  insist(isDate(payload.effective_from), 'effective_from_required')
  insist(!payload.effective_to || (isDate(payload.effective_to) && payload.effective_to > payload.effective_from), 'invalid_effective_to')
  const priceId = kind === 'price_override' ? String(payload.price ?? '') : null
  if (priceId) insist((await requirePrice(env, priceId)).pricing_model === 'simple', 'override_price_model')
  if (priceId) insist(await one(env, 'SELECT 1 FROM nc_items WHERE subscription_id = ? AND price_id = ?', sub.id, priceId), 'override_price_not_on_subscription')
  insist(!await startsInIssuedPeriod(env, sub.id, payload.effective_from), 'period_already_invoiced', 409)
  const amendment: AmendmentIn = { id: 'proposed', kind: kind as AmendmentIn['kind'], value, priceId, from: payload.effective_from, to: payload.effective_to || null, note: String(payload.note ?? '').slice(0, 200) }
  const impact = []
  const first = periodContaining(sub.anchor_day, amendment.from)
  for (const period of [first, periodContaining(sub.anchor_day, first.end)]) {
    const inputs = await ratingInputs(env, business, sub.id, period)
    impact.push({ period, before: total(inputs), after: total({ ...inputs, amendments: [...inputs.amendments, amendment] }) })
  }
  return { normalized: { ...payload, subscription: sub.id, kind, value, price: priceId, effective_to: payload.effective_to || null }, impact, basis: { subscription: [sub.id, sub.revision] } }
}

async function priceChangePlan(env: Bindings, business: Business, payload: Row) {
  const product = await one(env, "SELECT * FROM nc_products WHERE id = ? AND status = 'active'", String(payload.product ?? ''))
  insist(product, 'product_not_found', 404)
  const kind = String(payload.kind ?? '')
  insist(kind === 'flat' || kind === 'seat' || kind === 'unit', 'invalid_kind')
  const amount = canonicalDecimal(String(payload.unit_amount ?? ''), 'unit_amount')
  const meter = kind === 'unit' ? await one(env, 'SELECT id, unit_label FROM nc_meters WHERE id = ? OR code = ?', String(payload.meter ?? ''), String(payload.meter ?? '')) : null
  insist(kind !== 'unit' || meter, 'meter_not_found', 404)
  const date = String(payload.effective_date ?? '')
  insist(isDate(date), 'effective_date_required')
  const ids = Array.isArray(payload.subscriptions) ? [...new Set(payload.subscriptions.map(String))] : []
  insist(ids.length > 0 && ids.length <= 200, 'subscriptions_required')
  const version = ((await one<{ v: number }>(env, 'SELECT COALESCE(MAX(version), 0) AS v FROM nc_prices WHERE product_id = ?', product.id))!.v) + 1
  const virtual = { id: 'proposed-price', kind, unitAmount: amount, meterId: meter?.id ?? null, taxable: payload.taxable !== false, label: `${product.name}${payload.nickname ? ` — ${payload.nickname}` : ''} (v${version})`, unitLabel: meter?.unit_label ?? '' } as const
  const impact = [], basis: Record<string, unknown> = { productVersion: [product.id, version - 1] }
  for (const id of ids) {
    const sub = await one(env, 'SELECT s.*, c.name AS customer_name FROM nc_subscriptions s JOIN nc_customers c ON c.id = s.customer_id WHERE s.id = ?', id)
    insist(sub, 'subscription_not_found', 404)
    insist(!sub.end_date || sub.end_date > date, 'subscription_ended', 409)
    const item = await one(env, 'SELECT i.* FROM nc_items i JOIN nc_prices p ON p.id = i.price_id WHERE i.subscription_id = ? AND p.product_id = ? AND i.effective_from < ? AND (i.effective_to IS NULL OR i.effective_to > ?) ORDER BY i.effective_from DESC LIMIT 1', sub.id, product.id, date, date)
    insist(item, 'subscription_not_on_product', 409, { subscription: id })
    insist(!await one(env, "SELECT 1 FROM nc_invoices WHERE subscription_id = ? AND status = 'issued' AND period_end > ?", sub.id, date), 'period_already_invoiced', 409, { subscription: id })
    const period = periodContaining(sub.anchor_day, date), next = periodContaining(sub.anchor_day, period.end)
    const rows = []
    for (const p of [period, next]) {
      const inputs = await ratingInputs(env, business, sub.id, p)
      const items = [...inputs.items.map(row => row.id === item.id ? { ...row, to: date } : row), { id: 'proposed-item', priceId: virtual.id, quantity: item.quantity, from: date, to: item.effective_to }]
      rows.push({ period: p, before: total(inputs), after: total({ ...inputs, items, prices: { ...inputs.prices, [virtual.id]: virtual } }) })
    }
    impact.push({ subscription: sub.id, customer: sub.customer_name, item: item.id, quantity: item.quantity, periods: rows })
    basis[sub.id] = sub.revision
  }
  return { normalized: { product: product.id, kind, unit_amount: amount, meter: meter?.id ?? null, nickname: String(payload.nickname ?? '').slice(0, 80), taxable: payload.taxable !== false, effective_date: date, subscriptions: ids }, impact, basis }
}

/**
 * A usage correction voids recorded events and adds new ones. Additions pass the
 * same checks as any usage import, and every one must be accepted. The effect is
 * each affected subscription's period rated before and after the correction:
 * the draft run's period, or the period of the latest corrected event.
 */
async function correctionPlan(env: Bindings, business: Business, payload: Row) {
  const voids = Array.isArray(payload.void) ? payload.void : [], adds: RawEvent[] = Array.isArray(payload.add) ? payload.add : []
  insist(voids.length + adds.length > 0 && voids.length + adds.length <= 500, 'correction_required')
  const basis: Record<string, unknown> = {}, rows: Row[] = [], touched: { customerId: string; meterId: string; occurredAt: number }[] = []
  for (const entry of voids) {
    const event = await one(env, 'SELECT event_id, customer_id, meter_id, quantity, occurred_at, occurred_text, status, invoice_id FROM nc_usage_events WHERE event_id = ?', String(entry?.event_id ?? ''))
    insist(event, 'event_not_found', 404, { event: entry?.event_id })
    insist(event.status === 'active' && !event.invoice_id, 'already_billed', 409, { event: event.event_id })
    insist(String(entry.reason ?? '').trim(), 'void_reason_required')
    basis[`event:${event.event_id}`] = [event.status, event.invoice_id]
    rows.push({ action: 'void', event: event.event_id, quantity: event.quantity, occurredAt: event.occurred_text, reason: String(entry.reason).slice(0, 300) })
    touched.push({ customerId: event.customer_id, meterId: event.meter_id, occurredAt: event.occurred_at })
  }
  const screened = adds.length ? await screen(env, adds) : null
  if (screened) {
    insist(screened.counts.accepted === adds.length, 'correction_rows_rejected', 400, screened.report)
    for (const event of screened.accepted) {
      basis[`add:${event.eventId}`] = null
      rows.push({ action: 'add', event: event.eventId, quantity: event.quantity, occurredAt: event.occurredText, reason: '' })
      touched.push(event as typeof touched[number])
    }
  }
  const run = payload.run ? await one(env, "SELECT id, period FROM nc_bill_runs WHERE id = ? AND status = 'draft'", String(payload.run)) : null
  if (payload.run) insist(run, 'bill_run_not_found', 404)
  const voided = new Set(rows.filter(row => row.action === 'void').map(row => row.event))
  const invoices: Row[] = []
  for (const sub of await all(env, `SELECT DISTINCT s.id, s.anchor_day, s.customer_id, c.name AS customer_name FROM nc_subscriptions s JOIN nc_customers c ON c.id = s.customer_id JOIN nc_items i ON i.subscription_id = s.id JOIN nc_prices p ON p.id = i.price_id
    WHERE p.meter_id IS NOT NULL ORDER BY c.name, s.id`)) {
    const mine = touched.filter(event => event.customerId === sub.customer_id)
    if (!mine.length) continue
    const latest = localDate(Math.max(...mine.map(event => event.occurredAt)), business.timezone)
    const period = run ? periodStartingIn(sub.anchor_day, run.period) : periodContaining(sub.anchor_day, latest)
    const inputs = await ratingInputs(env, business, sub.id, period)
    const meters = new Set(Object.values(inputs.prices).flatMap(price => price.meterId ? [price.meterId] : []))
    if (!mine.some(event => meters.has(event.meterId))) continue
    const end = zonedStart(period.end, business.timezone)
    const added = (screened?.accepted ?? []).filter(event => event.customerId === sub.customer_id && meters.has(event.meterId) && event.occurredAt < end)
      .map(event => ({ eventId: event.eventId, meterId: event.meterId, quantity: event.quantity, occurredAt: event.occurredAt }))
    invoices.push({ subscription: sub.id, customer: sub.customer_name, period, before: total(inputs), after: total({ ...inputs, events: [...inputs.events.filter(event => !voided.has(event.eventId)), ...added] }) })
  }
  return { normalized: { void: voids.map((entry: Row) => ({ event_id: String(entry.event_id), reason: String(entry.reason).slice(0, 300) })), add: adds, run: run?.id ?? null, period: run?.period ?? null }, impact: { rows, invoices }, basis }
}

async function collectionPlan(env: Bindings, payload: Row) {
  const basis = await reminderBasis(env, String(payload.customer ?? ''))
  insist(basis.overdue.length, 'nothing_overdue', 409)
  const draft = reminderDraft(basis)
  const recipient = String(payload.recipient ?? basis.customer.billing_email ?? '').toLowerCase()
  return {
    normalized: { customer: basis.customer.id, recipient, subject: String(payload.subject || draft.subject).slice(0, 200), body: String(payload.body || draft.body).slice(0, 8000) },
    impact: { overdue: basis.overdue, balanceCents: basis.balanceCents, recentPayments: basis.recentPayments },
    basis: { balances: basisKey(basis) },
  }
}

async function plan(env: Bindings, kind: Kind, payload: Row) {
  const business = await requireBusiness(env)
  if (kind === 'amendment') return await amendmentPlan(env, business, payload)
  if (kind === 'price_change') return await priceChangePlan(env, business, payload)
  if (kind === 'usage_correction') return await correctionPlan(env, business, payload)
  return await collectionPlan(env, payload)
}

/** Reads the current value of everything a proposal was prepared against. */
async function currentBasis(env: Bindings, kind: Kind, payload: Row) {
  return (await plan(env, kind, payload)).basis
}

export async function propose(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'propose')
  const kind = input.text('kind', { max: 20 }) as Kind
  insist(KINDS.includes(kind), 'invalid_kind')
  const title = input.text('title', { max: 200 })
  const payload = input.json('payload') as Row
  insist(payload && typeof payload === 'object' && !Array.isArray(payload), 'invalid_payload')
  const evidence = (input.has('evidence') ? input.json('evidence') : {}) as Row
  insist(evidence && typeof evidence === 'object' && !Array.isArray(evidence), 'invalid_evidence')
  if (kind === 'amendment') {
    const clauses = Array.isArray(evidence.clauses) ? evidence.clauses.filter((c: Row) => typeof c?.quote === 'string' && c.quote.trim()) : []
    insist(clauses.length, 'quoted_clause_required')
  }
  if (kind === 'usage_correction') insist(Array.isArray(evidence.sources) && evidence.sources.length, 'source_reference_required')
  const prepared = await plan(env, kind, payload)
  const id = newId()
  await commit(env, [stmt(env, "INSERT INTO nc_proposals (id, kind, title, payload_json, evidence_json, impact_json, basis_json, status, created_by, created_by_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
    id, kind, title, JSON.stringify(prepared.normalized), JSON.stringify(evidence), JSON.stringify(prepared.impact), JSON.stringify(prepared.basis), actorLabel(actor), actor.kind, now())],
  { actor: actorLabel(actor), action: 'proposal.create', subject: id, detail: { kind, title } })
  return { id, kind, impact: prepared.impact }
}

export async function proposals(env: Bindings, actor: Actor) {
  requireCapability(actor, 'read')
  return await all(env, 'SELECT id, kind, title, status, created_by, created_by_kind, created_at, decided_by, decided_at FROM nc_proposals ORDER BY status = \'pending\' DESC, created_at DESC LIMIT 200')
}

export async function proposalDetail(env: Bindings, actor: Actor, id: string): Promise<Row> {
  requireCapability(actor, 'read')
  const row = await one(env, 'SELECT * FROM nc_proposals WHERE id = ?', id)
  insist(row, 'proposal_not_found', 404)
  const payload = parseJson<Row>(row.payload_json, {})
  let stale = false
  if (row.status === 'pending') {
    try { stale = canonical(await currentBasis(env, row.kind, payload)) !== canonical(parseJson(row.basis_json, {})) } catch { stale = true }
  }
  return { ...row, payload, evidence: parseJson(row.evidence_json, {}), impact: parseJson(row.impact_json, {}), basis: parseJson(row.basis_json, {}), result: parseJson(row.result_json, null), stale, payload_json: undefined, evidence_json: undefined, impact_json: undefined, basis_json: undefined, result_json: undefined }
}

/** A person approves or rejects. Approval re-reads the basis and applies the typed change through the normal records. */
export async function decide(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const row = await one(env, 'SELECT * FROM nc_proposals WHERE id = ?', input.text('proposal', { max: 100 }))
  insist(row, 'proposal_not_found', 404)
  insist(row.status === 'pending', 'already_decided', 409)
  const decision = input.text('decision', { max: 10 })
  insist(decision === 'approved' || decision === 'rejected', 'invalid_decision')
  const note = input.text('note', { max: 500, optional: true })
  const by = actorLabel(actor), at = now()
  const close = (result: unknown) => [
    guard(env, 'stale', "EXISTS(SELECT 1 FROM nc_proposals WHERE id = ? AND status = 'pending')", row.id),
    stmt(env, 'UPDATE nc_proposals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, result_json = ? WHERE id = ?', decision, by, at, note, JSON.stringify(result ?? null), row.id),
  ]
  if (decision === 'rejected') {
    await commit(env, close(null), { actor: by, action: 'proposal.reject', subject: row.id, detail: { note } })
    return { id: row.id, status: 'rejected' }
  }
  const payload = parseJson<Row>(row.payload_json, {})
  let basis: unknown
  try { basis = await currentBasis(env, row.kind, payload) } catch { basis = null }
  insist(canonical(basis) === canonical(parseJson(row.basis_json, {})), 'proposal_stale', 409)
  const audit = { actor: by, action: 'proposal.approve', subject: row.id, detail: { kind: row.kind, note } }
  const basisGuards = await basisGuardStatements(env, row.kind, parseJson<Row>(row.basis_json, {}))

  if (row.kind === 'amendment') {
    const amendment = newId()
    await commit(env, [...basisGuards, notIssuedGuard(env, payload.subscription, payload.effective_from), ...close({ amendment }),
      stmt(env, "INSERT INTO nc_amendments (id, subscription_id, kind, value, price_id, effective_from, effective_to, note, clause, status, origin, proposal_id, created_by, created_at, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 'proposal', ?, ?, ?, ?, ?)",
        amendment, payload.subscription, payload.kind, payload.value, payload.price, payload.effective_from, payload.effective_to, String(payload.note ?? ''), JSON.stringify(parseJson<Row>(row.evidence_json, {}).clauses ?? []), row.id, row.created_by, row.created_at, by, at),
      stmt(env, 'UPDATE nc_subscriptions SET revision = ?, updated_at = ? WHERE id = ?', newId(), at, payload.subscription)], audit)
    return { id: row.id, status: 'approved', amendment }
  }
  if (row.kind === 'price_change') {
    const priceId = newId(), version = parseJson<Row>(row.basis_json, {}).productVersion[1] + 1
    const statements = [...basisGuards, stmt(env, "INSERT INTO nc_prices (id, product_id, version, kind, unit_amount, meter_id, taxable, nickname, origin, revision, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'native', ?, ?, ?)",
      priceId, payload.product, version, payload.kind, payload.unit_amount, payload.meter, payload.taxable ? 1 : 0, payload.nickname, newId(), by, at)]
    for (const entry of parseJson<Row[]>(row.impact_json, [])) {
      const item = await one(env, 'SELECT * FROM nc_items WHERE id = ?', entry.item)
      statements.push(
        stmt(env, 'UPDATE nc_items SET effective_to = ? WHERE id = ?', payload.effective_date, entry.item),
        stmt(env, "INSERT INTO nc_items (id, subscription_id, price_id, quantity, effective_from, effective_to, change_id, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'native', ?)", newId(), entry.subscription, priceId, entry.quantity, payload.effective_date, item!.effective_to, row.id, at),
        stmt(env, 'UPDATE nc_subscriptions SET revision = ?, updated_at = ? WHERE id = ?', newId(), at, entry.subscription))
    }
    await commit(env, [...statements, ...close({ price: priceId, version })], audit)
    return { id: row.id, status: 'approved', price: priceId }
  }
  if (row.kind === 'usage_correction') {
    // The voids, the additions and the proposal's record land together or not at all.
    const adds = payload.add as RawEvent[]
    const write = adds.length ? ingestStatements(env, actor, await screen(env, adds), { kind: 'correction' }) : null
    const statements = [...basisGuards, ...(payload.void as Row[]).map(entry => stmt(env, "UPDATE nc_usage_events SET status = 'voided', void_reason = ? WHERE event_id = ? AND status = 'active' AND invoice_id IS NULL", `${entry.reason} (proposal ${row.id})`, entry.event_id)), ...(write?.statements ?? [])]
    const result = { voided: (payload.void as Row[]).length, added: adds.length, batch: write?.batch ?? null }
    await commit(env, [...statements, ...close(result)], write ? [audit, write.audit] : audit)
    let rerun = null
    if (payload.run && await one(env, "SELECT 1 FROM nc_bill_runs WHERE id = ? AND status = 'draft'", payload.run)) {
      rerun = await prepareRun(env, actor, Input.of({ period: payload.period }))
    }
    return { id: row.id, status: 'approved', ...result, rerun: rerun?.id ?? null }
  }
  // collection: the person approves the exact recipient and wording.
  const recipient = input.text('recipient', { max: 200, optional: true }) || payload.recipient
  insist(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient), 'invalid_recipient')
  const subject = input.text('subject', { max: 200, optional: true }) || payload.subject
  const body = input.text('body', { max: 8000, optional: true }) || payload.body
  const reminder = await reminderBasis(env, payload.customer)
  const notice = newId()
  await commit(env, [...close({ notice }),
    stmt(env, "INSERT INTO nc_notices (id, customer_id, invoice_ids, balance_cents, recipient, subject, body, basis, status, proposal_id, created_by, created_at, approved_by, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?)",
      notice, payload.customer, JSON.stringify(reminder.overdue.map(r => r.id)), reminder.balanceCents, recipient, subject, body, basisKey(reminder), row.id, row.created_by, row.created_at, by, at),
    stmt(env, "INSERT INTO nc_tasks (id, customer_id, invoice_id, title, due_date, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)", newId(), payload.customer, reminder.overdue[0]?.id ?? null, `Follow up on the reminder to ${recipient}`, addDays(reminder.day, 7), by, at)], audit)
  return { id: row.id, status: 'approved', notice }
}

/** In-batch guards that the recorded basis still holds at commit time. */
async function basisGuardStatements(env: Bindings, kind: Kind, basis: Row) {
  if (kind === 'amendment') return [guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_subscriptions WHERE id = ? AND revision = ?)', basis.subscription[0], basis.subscription[1])]
  if (kind === 'price_change') return [
    guard(env, 'stale', 'COALESCE((SELECT MAX(version) FROM nc_prices WHERE product_id = ?), 0) = ?', basis.productVersion[0], basis.productVersion[1]),
    ...Object.entries(basis).filter(([key]) => key !== 'productVersion').map(([id, revision]) => guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_subscriptions WHERE id = ? AND revision = ?)', id, revision)),
  ]
  if (kind === 'usage_correction') return Object.keys(basis).filter(key => key.startsWith('event:')).map(key => guard(env, 'already_billed', "EXISTS(SELECT 1 FROM nc_usage_events WHERE event_id = ? AND status = 'active' AND invoice_id IS NULL)", key.slice('event:'.length)))
  return []
}
