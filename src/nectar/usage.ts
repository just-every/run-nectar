// Flows 5 and 6: usage arrives as events with stable ids, by file or through
// the usage API. A repeated event id with the same values is a duplicate and
// changes nothing; reused with different values it is rejected. Inspection
// shows, before rating, each subscription's exact period totals, days with no
// usage, late events and events no price rates.
import type { Bindings } from '../auth.server'
import { actorLabel, requireCapability, type Actor } from './actor'
import { requireBusiness } from './business'
import { NectarError, all, canonical, commit, insist, newId, now, one, sha256Hex, stmt, type Row } from './core'
import { decimalText, micros } from './decimal'
import { addDays, daysBetween, isMonth, localDate, parseInstant, periodStartingIn, today, zonedStart } from './dates'
import { controlTotals } from './reconciliation'
import { rated } from './inputs'
import { eventProperties } from './meter-definitions'
import { canonical as canonicalJson } from './core'
import type { Input } from './input'

export interface RawEvent { event_id: string; customer: string; meter: string; quantity: string; occurred_at: string; properties?: Record<string,unknown> }
interface Outcome { row: number; eventId: string; status: 'accepted' | 'duplicate' | 'rejected'; reason?: string }

const MAX_EVENTS = 5000

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows.filter(cells => cells.some(value => value.trim()))
}

const HEADERS: Record<Exclude<keyof RawEvent,'properties'>, string[]> = {
  event_id: ['event_id', 'id', 'idempotency_key'], customer: ['customer', 'customer_external_id', 'customer_id', 'external_id'],
  meter: ['meter', 'meter_code', 'event_name'], quantity: ['quantity', 'value', 'units'], occurred_at: ['occurred_at', 'timestamp', 'time'],
}

function csvProperties(text:string){try{return JSON.parse(text)}catch{throw new NectarError('invalid_properties_json',400)}}

export function eventsFromCsv(text: string): RawEvent[] {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ''))
  insist(header, 'empty_file')
  const columns = header.map(name => name.trim().toLowerCase())
  const index = Object.fromEntries(Object.entries(HEADERS).map(([field, names]) => [field, columns.findIndex(column => names.includes(column))])) as Record<Exclude<keyof RawEvent,'properties'>, number>
  const missing = Object.entries(index).filter(([, at]) => at < 0).map(([field]) => field)
  insist(!missing.length, 'missing_columns', 400, missing)
  return rows.map(cells => ({...Object.fromEntries(Object.entries(index).map(([field, at]) => [field, (cells[at] ?? '').trim()])),...(columns.includes('properties_json')?{properties:csvProperties(cells[columns.indexOf('properties_json')]||'{}')}:{})}) as unknown as RawEvent)
}

/** Checks every event against the meters, customers and recorded ids, row by row; writes nothing. */
export async function screen(env: Bindings, events: RawEvent[]) {
  insist(events.length > 0 && events.length <= MAX_EVENTS, 'invalid_event_count')
  const meters = new Map((await all(env, 'SELECT id, code FROM nc_meters WHERE source_meter_id IS NULL')).map(row => [row.code, row.id]))
  const customerIds = [...new Set(events.map(event => String(event.customer ?? '').trim()))]
  const customers = new Map<string, string>()
  for (let i = 0; i < customerIds.length; i += 90) {
    const slice = customerIds.slice(i, i + 90)
    for (const row of await all(env, `SELECT id, external_id FROM nc_customers WHERE external_id IN (${slice.map(() => '?').join(',')})`, ...slice)) customers.set(row.external_id, row.id)
  }
  const outcomes: Outcome[] = [], accepted: Row[] = [], seen = new Map<string, string>()
  for (const [index, event] of events.entries()) {
    const row = index + 1, eventId = String(event.event_id ?? '').trim()
    const reject = (reason: string) => { outcomes.push({ row, eventId, status: 'rejected', reason }) }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(eventId)) { reject('missing or invalid event id'); continue }
    const meterId = meters.get(String(event.meter ?? '').trim().toLowerCase())
    if (!meterId) { reject(`unknown meter "${event.meter}"`); continue }
    const customerId = customers.get(String(event.customer ?? '').trim())
    if (!customerId) { reject(`unknown customer "${event.customer}"`); continue }
    let quantity: string, occurredAt: number
    try { const q = micros(String(event.quantity ?? ''), 'quantity'); quantity = decimalText(q) } catch { reject(`invalid quantity "${event.quantity}"`); continue }
    try { occurredAt = parseInstant(String(event.occurred_at ?? '')) } catch { reject(`invalid occurred_at "${event.occurred_at}" (use ISO 8601 with an offset, e.g. 2026-09-30T23:30:00-07:00)`); continue }
    let properties:ReturnType<typeof eventProperties>
    try{properties=eventProperties(event.properties)}catch{reject('invalid event properties');continue}
    const hash = await sha256Hex(canonical({ eventId, meterId, customerId, quantity, occurredAt, ...(Object.keys(properties).length?{properties}:{}) }))
    if (seen.has(eventId)) { seen.get(eventId) === hash ? outcomes.push({ row, eventId, status: 'duplicate', reason: 'repeated in this batch' }) : reject('event id repeated in this batch with different values'); continue }
    seen.set(eventId, hash)
    const existing = await one(env, 'SELECT payload_hash FROM nc_usage_events WHERE event_id = ?', eventId)
    if (existing) { existing.payload_hash === hash ? outcomes.push({ row, eventId, status: 'duplicate', reason: 'already recorded' }) : reject('event id already recorded with different values'); continue }
    accepted.push({ eventId, meterId, customerId, quantity, occurredAt, occurredText: String(event.occurred_at).trim(), hash,properties })
    outcomes.push({ row, eventId, status: 'accepted' })
  }
  const counts = { accepted: accepted.length, duplicates: outcomes.filter(o => o.status === 'duplicate').length, rejected: outcomes.filter(o => o.status === 'rejected').length }
  return { accepted, counts, report: outcomes.filter(o => o.status !== 'accepted') }
}

export type Screened = Awaited<ReturnType<typeof screen>>

/** The batch record and its accepted events, for one atomic commit. */
export function ingestStatements(env: Bindings, actor: Actor, screened: Screened, source: { kind: 'file' | 'api' | 'correction'; filename?: string; sha256?: string }) {
  const batchId = newId(), at = now()
  return {
    batch: batchId,
    statements: [
      stmt(env, 'INSERT INTO nc_usage_batches (id, source, filename, sha256, accepted, duplicates, rejected, report_json, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', batchId, source.kind, source.filename ?? '', source.sha256 ?? '', screened.counts.accepted, screened.counts.duplicates, screened.counts.rejected, JSON.stringify(screened.report.slice(0, 500)), actorLabel(actor), at),
      ...screened.accepted.map(event => stmt(env, 'INSERT INTO nc_usage_events (id, event_id, meter_id, customer_id, quantity, occurred_at, occurred_text, received_at, batch_id, payload_hash,properties_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?)',
        newId(), event.eventId, event.meterId, event.customerId, event.quantity, event.occurredAt, event.occurredText, at, batchId, event.hash,canonicalJson(event.properties))),
    ],
    audit: { actor: actorLabel(actor), action: 'usage.ingest', subject: batchId, detail: { source: source.kind, filename: source.filename ?? null, ...screened.counts } },
  }
}

/**
 * Validates and records events atomically: every accepted event lands, or none do.
 * A batch that loses a race to a concurrent one carrying the same event ids is
 * screened again, so its rows are reported as duplicates or conflicts.
 */
export async function ingest(env: Bindings, actor: Actor, events: RawEvent[], source: { kind: 'file' | 'api' | 'correction'; filename?: string; sha256?: string }) {
  requireCapability(actor, 'usage')
  for (let attempt = 1; ; attempt++) {
    const screened = await screen(env, events)
    const write = ingestStatements(env, actor, screened, source)
    try {
      await commit(env, write.statements, write.audit)
      return { batch: write.batch, ...screened.counts, report: screened.report }
    } catch (error) {
      const raced = error instanceof NectarError && error.code === 'already_exists' && /nc_usage_events\.event_id/.test(String(error.detail))
      if (!raced || attempt === 3) throw error
    }
  }
}

export async function submitUsage(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'usage')
  if (input.has('events')) {
    const events = input.json('events')
    insist(Array.isArray(events), 'invalid_events')
    return await ingest(env, actor, events as RawEvent[], { kind: 'api' })
  }
  const file = await input.file('file', { maxBytes: 4_000_000 })
  const text = new TextDecoder('utf-8', { fatal: false }).decode(file!.bytes)
  return await ingest(env, actor, eventsFromCsv(text), { kind: 'file', filename: file!.filename, sha256: await sha256Hex(file!.bytes) })
}

export async function batches(env: Bindings, actor: Actor) {
  requireCapability(actor, 'read')
  return await all(env, 'SELECT id, source, filename, accepted, duplicates, rejected, report_json, actor, created_at FROM nc_usage_batches ORDER BY created_at DESC LIMIT 50')
}

/** Everything a person checks before rating a month: totals, gaps, late and unrated events. */
export async function inspect(env: Bindings, actor: Actor, month: string) {
  requireCapability(actor, 'read')
  const business = await requireBusiness(env)
  insist(isMonth(month), 'invalid_period')
  const zone = business.timezone
  const subs = await all(env, `SELECT DISTINCT s.id, s.anchor_day, s.start_date, s.end_date, s.trial_end, s.cutover_start, s.customer_id, c.name AS customer_name, c.external_id
    FROM nc_subscriptions s JOIN nc_customers c ON c.id = s.customer_id JOIN nc_items i ON i.subscription_id = s.id JOIN nc_prices p ON p.id = i.price_id WHERE p.kind = 'unit' ORDER BY c.name`)
  const subscriptions = []
  for (const sub of subs) {
    const period = periodStartingIn(sub.anchor_day, month)
    if (sub.start_date >= period.end || (sub.end_date && sub.end_date <= period.start)) continue
    const meters = await all(env, "SELECT DISTINCT m.id, m.code, m.unit_label,m.metric_plan_json FROM nc_items i JOIN nc_prices p ON p.id = i.price_id JOIN nc_meters m ON m.id = p.meter_id WHERE i.subscription_id = ? AND i.effective_from < ? AND (i.effective_to IS NULL OR i.effective_to > ?)", sub.id, period.end, period.start)
    const from = zonedStart(period.start, zone), to = zonedStart(period.end, zone)
    const perMeter = []
    const metricLines=meters.some(m=>m.metric_plan_json)?(await rated(env,business,sub.id,period)).rating.lines.filter(l=>l.kind==='metric_usage'):[]
    for (const meter of meters) {
      if(meter.metric_plan_json){for(const line of metricLines.filter(l=>l.meterId===meter.id&&l.periodStart===period.start))perMeter.push({meter:meter.code,unit:meter.unit_label,dimensions:line.evidence.dimensions,total:line.quantity,exact:line.evidence.exactQuantity,events:(line.evidence.eventIds as string[]).length,billed:0,daysWithoutUsage:[],receivedAfterPeriodEnd:[]});continue}
      const events = await all(env, "SELECT event_id, quantity, occurred_at, received_at, invoice_id FROM nc_usage_events WHERE customer_id = ? AND meter_id = ? AND status = 'active' AND NOT EXISTS(SELECT 1 FROM nc_usage_voids v WHERE v.event_id=nc_usage_events.event_id) AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at", sub.customer_id, meter.id, from, to)
      const total = events.reduce((sum, event) => sum + micros(event.quantity, 'quantity'), 0n)
      const days = new Set(events.map(event => localDate(event.occurred_at, zone)))
      const activeFrom = sub.start_date > period.start ? sub.start_date : period.start
      // Only finished days can be quiet: a month in progress stops at today.
      const ends = [period.end, today(zone), ...(sub.end_date ? [sub.end_date] : [])].sort()
      const activeTo = ends[0]
      const gaps = Array.from({ length: Math.max(0, daysBetween(activeFrom, activeTo)) }, (_, i) => addDays(activeFrom, i)).filter(day => !days.has(day))
      const lateReceived = events.filter(event => event.received_at >= to).map(event => event.event_id)
      perMeter.push({ meter: meter.code, unit: meter.unit_label, events: events.length, total: decimalText(total), billed: events.filter(event => event.invoice_id).length, daysWithoutUsage: gaps, receivedAfterPeriodEnd: lateReceived })
    }
    const earlier = await one<{ n: number }>(env, `SELECT COUNT(*) AS n FROM nc_usage_events WHERE customer_id = ? AND status = 'active' AND invoice_id IS NULL AND occurred_at < ? AND meter_id IN (SELECT COALESCE(m.source_meter_id,p.meter_id) FROM nc_items i JOIN nc_prices p ON p.id = i.price_id JOIN nc_meters m ON m.id=p.meter_id WHERE i.subscription_id = ? AND p.meter_id IS NOT NULL)`, sub.customer_id, from, sub.id)
    subscriptions.push({ subscription: sub.id, customer: sub.customer_name, externalId: sub.external_id, period, boundaries: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), timezone: zone }, meters: perMeter, unbilledFromEarlierPeriods: earlier?.n ?? 0 })
  }
  const unattributed = await all(env, `SELECT e.event_id, c.external_id AS customer, m.code AS meter, e.quantity, e.occurred_text FROM nc_usage_events e JOIN nc_customers c ON c.id = e.customer_id JOIN nc_meters m ON m.id = e.meter_id
    WHERE e.status = 'active' AND e.invoice_id IS NULL AND NOT EXISTS (SELECT 1 FROM nc_items i JOIN nc_prices p ON p.id = i.price_id JOIN nc_subscriptions s ON s.id = i.subscription_id WHERE s.customer_id = e.customer_id AND p.meter_id IN (SELECT id FROM nc_meters WHERE id=e.meter_id OR source_meter_id=e.meter_id))
    ORDER BY e.occurred_at LIMIT 200`)
  return { month, timezone: zone, subscriptions, unattributed, controls: await controlTotals(env, actor, month) }
}
