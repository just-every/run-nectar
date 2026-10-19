// Invoice line evidence comes from the saved calculation, never a rerating or
// mutable event status. Ledger reads only establish the invoice customer scope.
import type { Bindings } from '../auth.server'
import { requireCapability, type Actor } from './actor'
import { all, insist, one, parseJson, type Row } from './core'
import { decimalText, micros } from './decimal'
import type { EventIn } from './rating'

export interface ReportLine {
  invoiceId: string; number: string; customerId: string; line: Row
  calculation: { inputs: Row; fingerprint: string; version: string }
  events: EventIn[]; eventIds: string[]; quantity: string; relatedLines: { lineId: string; label: string; href: string }[]
}

/** A line belongs to this issued invoice, and every event must exist in both saved evidence sets. */
export async function reportLine(env: Bindings, actor: Actor, invoiceId: string, lineId: string): Promise<ReportLine> {
  requireCapability(actor, 'read')
  const invoice = await one(env, "SELECT id, number, customer_id, subscription_id, calculation_json, calc_version, source_fingerprint FROM nc_invoices WHERE id = ? AND status = 'issued'", invoiceId)
  insist(invoice, 'invoice_not_found', 404)
  const [line, metered] = await Promise.all([
    one(env, 'SELECT * FROM nc_invoice_lines WHERE invoice_id = ? AND id = ?', invoiceId, lineId),
    all(env, 'SELECT id, description FROM nc_invoice_lines WHERE invoice_id = ? AND id <> ? AND meter_id IS NOT NULL ORDER BY seq', invoiceId, lineId),
  ])
  insist(line, 'invoice_line_not_found', 404)
  const evidence = parseJson<Row>(line.evidence_json, {})
  const calculation = parseJson<Row>(invoice.calculation_json, {})
  const inputs: Row = calculation.inputs ?? {}
  const eventIds = new Set<string>(Array.isArray(evidence.eventIds) ? evidence.eventIds.filter((id: unknown): id is string => typeof id === 'string') : [])
  const contextIds=Array.isArray(evidence.contextEventIds)?evidence.contextEventIds.filter((v:unknown):v is string=>typeof v==='string'):[]
  contextIds.forEach((id:string)=>eventIds.add(id))
  const sourceMeter=typeof evidence.sourceMeter==='string'?evidence.sourceMeter:line.meter_id
  // Read only this customer's matching ledger records. Snapshots remain the
  // source of quantities/timestamps even if the current ledger event is voided.
  const ledger = line.meter_id && eventIds.size ? await all<{ event_id: string }>(env, `SELECT e.event_id FROM nc_usage_events e
    WHERE e.customer_id = ? AND e.meter_id = ? AND EXISTS (
      SELECT 1 FROM json_each(?) wanted WHERE wanted.value = e.event_id
    )`, invoice.customer_id, sourceMeter, JSON.stringify([...eventIds])) : []
  const scoped = new Set(ledger.map(event => event.event_id))
  const saved: EventIn[] = Array.isArray(inputs.events) ? inputs.events : []
  const events: EventIn[] = saved.filter(event => eventIds.has(event.eventId) && scoped.has(event.eventId) && event.meterId === sourceMeter)
    .map(event => ({ eventId: event.eventId, meterId: event.meterId, quantity: event.quantity, occurredAt: event.occurredAt,...(event.properties?{properties:event.properties}:{}) }))
  const quantity = decimalText(events.reduce((sum, event) => sum + micros(event.quantity, 'quantity'), 0n))
  return {
    invoiceId: invoice.id, number: invoice.number, customerId: invoice.customer_id,
    line: { ...line, evidence, evidence_json: undefined },
    calculation: { inputs, fingerprint: calculation.fingerprint ?? invoice.source_fingerprint,
      version: calculation.version ?? invoice.calc_version },
    events, eventIds: events.map(event => event.eventId), quantity,
    relatedLines: metered.map(row => ({ lineId: row.id, label: row.description,
      href: `/app/invoices/${encodeURIComponent(invoiceId)}/lines/${encodeURIComponent(row.id)}` })),
  }
}
