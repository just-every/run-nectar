// USE-004: read-only historical correction evidence. Issued inputs always win
// over current catalog, subscription, tax and raw-event records.
import type { Bindings } from '../auth.server'
import { requireCapability, type Actor } from './actor'
import { all, canonical, fingerprint, insist, one, parseJson, type Row } from './core'
import { addMonths, isMonth, periodStartingIn, zonedStart } from './dates'
import type { Input } from './input'
import { rate, type EventIn, type Line, type RatingInput } from './rating'

function eventIds(ids: string[]) {
  insist(ids.length <= 10000 && new Set(ids).size === ids.length && ids.every(id => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)), 'invalid_correction_events')
  return ids
}

export async function previewUsageCorrection(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'read')
  const subscription = input.text('subscription', { max: 100 })
  const from = input.text('from_period', { max: 7 }), through = input.text('through_period', { max: 7 })
  insist(isMonth(from) && isMonth(through) && from <= through, 'invalid_period')
  const sub = await one(env, 'SELECT id,customer_id,anchor_day FROM nc_subscriptions WHERE id=?', subscription)
  insist(sub, 'subscription_not_found', 404)
  insist(!await one(env, 'SELECT 1 FROM nc_erased_records WHERE record_id=?', subscription), 'customer_erased', 410)
  const expected = []
  for (let month = from; month <= through; month = addMonths(`${month}-01`, 1).slice(0, 7)) {
    insist(expected.length < 36, 'correction_range_too_large')
    expected.push(periodStartingIn(sub.anchor_day, month))
  }
  const invoices = await all(env, "SELECT * FROM nc_invoices WHERE subscription_id=? AND status='issued' AND invoice_kind='recurring' AND period_start>=? AND period_start<? ORDER BY period_start,id", subscription, expected[0].start, expected.at(-1)!.end)
  insist(invoices.length === expected.length && expected.every((p, i) => invoices[i].period_start === p.start && invoices[i].period_end === p.end), 'complete_issued_range_required', 409)
  const voids = eventIds(input.list('void_event_ids')), additions = eventIds(input.list('add_event_ids'))
  insist(!voids.some(id => additions.includes(id)), 'correction_event_overlap')
  const added = new Set(additions), selected = [...voids, ...additions], raw: Row[] = []
  for (let i = 0; i < selected.length; i += 90) {
    const ids = selected.slice(i, i + 90)
    raw.push(...await all(env, `SELECT * FROM nc_usage_events WHERE customer_id=? AND status='active' AND event_id IN (${ids.map(() => '?').join(',')})`, sub.customer_id, ...ids))
  }
  insist(raw.length === selected.length, 'correction_event_not_found', 404)
  insist(raw.filter(e => added.has(e.event_id)).every(e => !e.invoice_id), 'correction_addition_already_billed', 409)
  const removed = new Set(voids), found = new Set<string>(), rerated = new Map<string, Line[]>()
  const periods = []
  for (const invoice of invoices) {
    const calculation = parseJson<Row>(invoice.calculation_json, {}), saved = calculation.inputs as RatingInput
    insist(saved && saved.subscription?.id === subscription && saved.period?.start === invoice.period_start && saved.period?.end === invoice.period_end && saved.version === invoice.calc_version, 'historical_invoice_inputs_missing', 409)
    const before = rate(saved)
    const storedLines = await all(env, 'SELECT * FROM nc_invoice_lines WHERE invoice_id=? ORDER BY seq', invoice.id)
    insist(before.subtotalCents === invoice.subtotal_cents && before.taxCents === invoice.tax_cents && before.totalCents === invoice.total_cents && canonical(before.lines.map(l => [l.kind,l.priceId,l.amountCents,l.evidence])) === canonical(storedLines.map(l => [l.kind,l.price_id,l.amount_cents,parseJson(l.evidence_json,{})])), 'historical_replay_mismatch', 409)
    const sources = new Set(Object.values(saved.prices).flatMap(p => p.metric ? [p.metric.sourceId] : p.meterId ? [p.meterId] : []))
    const start = zonedStart(saved.period.start, saved.timezone), end = zonedStart(saved.period.end, saved.timezone)
    for (const event of saved.events) if (removed.has(event.eventId)) found.add(event.eventId)
    const merged = new Map(saved.events.filter(e => !removed.has(e.eventId)).map(e => [e.eventId, e]))
    for (const row of raw.filter(e => added.has(e.event_id) && sources.has(e.meter_id) && e.occurred_at < end)) {
      const metricSource = Object.values(saved.prices).some(p => p.metric?.sourceId === row.meter_id)
      if (row.occurred_at < start && !metricSource) continue
      found.add(row.event_id)
      const event: EventIn = { eventId: row.event_id, meterId: row.meter_id, quantity: row.quantity, occurredAt: row.occurred_at, properties: parseJson(row.properties_json, {}), invoiceId: row.occurred_at < start ? 'historical-context' : null }
      merged.set(event.eventId, event)
    }
    const afterInput: RatingInput = { ...saved, events: [...merged.values()].sort((a,b) => a.occurredAt-b.occurredAt || a.eventId.localeCompare(b.eventId)), ...(saved.contracts ? { contracts: { ...saved.contracts, invoices: saved.contracts.invoices.map(i => ({ ...i, lines: rerated.get(i.id) ?? i.lines })) } } : {}) }
    const after = rate(afterInput)
    rerated.set(invoice.id, after.lines)
    periods.push({ invoice: invoice.id, number: invoice.number, period: saved.period, version: saved.version, source: `/app/invoices/${invoice.id}`, originalFingerprint: invoice.source_fingerprint, before, after, deltaSubtotalCents: after.subtotalCents-before.subtotalCents, deltaTaxCents: after.taxCents-before.taxCents, deltaTotalCents: after.totalCents-before.totalCents, eventIds: [...new Set([...saved.events.map(e => e.eventId), ...afterInput.events.map(e => e.eventId)])], fingerprint: await fingerprint({ original: invoice.source_fingerprint, afterInput }) })
  }
  insist(selected.every(id => found.has(id)), 'correction_event_outside_range', 409)
  const totals = { subtotalCents: 0, taxCents: 0, totalCents: 0 }
  for (const p of periods) {
    totals.subtotalCents += p.deltaSubtotalCents; totals.taxCents += p.deltaTaxCents; totals.totalCents += p.deltaTotalCents
    insist(Object.values(totals).every(Number.isSafeInteger), 'correction_amount_out_of_range')
  }
  return { status: 'unresolved', scope: 'selected-issued-range-only', subscription, fromPeriod: from, throughPeriod: through, voidEventIds: voids, addEventIds: additions, periods, delta: totals, fingerprint: await fingerprint(periods.map(p => p.fingerprint)), warning: 'Preview only. Later periods may also be affected by predecessor changes. No event, invoice, credit, approval or issue block has changed; financial disposition requires a separate governed correction.' }
}
