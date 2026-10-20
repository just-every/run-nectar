// Read-only custody for billing answers. Figures always name an exact public
// record and JSON pointer; calculations retain their individual operands.
import type { Bindings } from '../auth.server'
import { requireCapability, type Actor } from './actor'
import { invoiceDetail } from './billruns'
import { all, insist, one, type Row } from './core'
import { reportLine, customerReportLine, type ReportLine } from './report-lines'

import type { CustomerSession } from './portal-session'
import { customerAnswerInvoice } from './portal-answer-data'

export type AnswerReader = Actor | CustomerSession
export const isCustomerReader = (reader: AnswerReader): reader is CustomerSession => 'jti' in reader
export function requireAnswerRead(reader: AnswerReader) { if (!isCustomerReader(reader)) requireCapability(reader, 'read') }

export interface AnswerFigure {
  label: string
  value: string | number
  unit: string
  source: string
  recordPath: string
}
export interface AnswerCitation { href: string; label: string }
export interface AnswerInvoice { invoice: Row; source: string; href: string }
export const pointer = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1')

/** The explicit customer is the answer's boundary. Recognized named subjects
 * in prose cannot silently redirect the answer to another customer's file. */
export async function checkAnswerSubject(env: Bindings, customer: string, question: string) {
  const normalized = question.toLocaleLowerCase('en-US').replace(/\s+/g, ' ')
  const foreign = await all(env, 'SELECT name,external_id FROM nc_customers WHERE id<>?', customer)
  for (const row of foreign) for (const name of [row.name, row.external_id]) {
    const value = String(name).toLocaleLowerCase('en-US').replace(/\s+/g, ' ')
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const reference = new RegExp(`(?:\\b(?:for|does|about|customer|from)\\s+|["“])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'u')
    insist(!reference.test(normalized), 'answer_subject_not_found', 404)
  }
}

export async function answerInvoice(env: Bindings, actor: AnswerReader, customer: string, id: string): Promise<AnswerInvoice> {
  requireAnswerRead(actor)
  // Check the requested relationship before loading any financial detail.
  const scoped = await one(env, "SELECT id FROM nc_invoices WHERE id=? AND customer_id=? AND status='issued'", id, customer)
  insist(scoped, 'invoice_not_found', 404)
  if (isCustomerReader(actor)) {
    insist(customer === actor.customer, 'invoice_not_found', 404)
    return await customerAnswerInvoice(env, actor, id)
  }
  const invoice = await invoiceDetail(env, actor, id)
  return { invoice, source: `/api/nectar/invoices/${encodeURIComponent(id)}`, href: `/app/invoices/${encodeURIComponent(id)}` }
}

export async function answerComparison(env: Bindings, actor: AnswerReader, current: AnswerInvoice, requested?: string): Promise<AnswerInvoice> {
  const invoice = current.invoice
  insist(invoice.subscription_id, 'comparison_subscription_required', 409)
  const prior = requested || (await one(env, `SELECT id FROM nc_invoices
    WHERE customer_id=? AND subscription_id=? AND status='issued' AND invoice_kind=? AND period_start<?
    ORDER BY period_start DESC,id DESC LIMIT 1`, invoice.customer_id, invoice.subscription_id, invoice.invoice_kind, invoice.period_start))?.id
  insist(prior, 'comparison_invoice_not_found', 404)
  const result = await answerInvoice(env, actor, invoice.customer_id, prior)
  insist(result.invoice.subscription_id === invoice.subscription_id && result.invoice.invoice_kind === invoice.invoice_kind && result.invoice.period_start < invoice.period_start,
    'comparison_invoice_not_found', 404)
  return result
}

export async function answerUsageLines(env: Bindings, actor: AnswerReader, current: AnswerInvoice): Promise<ReportLine[]> {
  const lines = (current.invoice.lines as Row[]).filter(line => line.meter_id)
  return await Promise.all(lines.map(async line => {
    const evidence=isCustomerReader(actor) ? await customerReportLine(env, actor, current.invoice.id, line.id) : await reportLine(env, actor, current.invoice.id, line.id)
    return isCustomerReader(actor) ? {...evidence,events:evidence.events.map(({properties,...event})=>event)} : evidence
  }))
}

export function figure(record: AnswerInvoice, label: string, value: unknown, unit: string, recordPath: string): AnswerFigure {
  insist((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string', 'answer_evidence_missing', 409)
  return { label, value, unit, source: record.source, recordPath }
}

export function lineFigures(record: AnswerInvoice, predicate: (line: Row) => boolean): AnswerFigure[] {
  return (record.invoice.lines as Row[]).flatMap((line, index) => predicate(line)
    ? [figure(record, line.description, line.amount_cents, 'cents', `/lines/${index}/amount_cents`)] : [])
}

/** Price/kind grouping keeps split prorations together without matching prose. */
export function compareLines(current: AnswerInvoice, previous: AnswerInvoice) {
  const groups = new Map<string, { kind: string; priceId: string | null; before: AnswerFigure[]; after: AnswerFigure[] }>()
  for (const [side, record] of [['before', previous], ['after', current]] as const) {
    for (const [index, line] of (record.invoice.lines as Row[]).entries()) {
      const key = JSON.stringify([line.kind, line.price_id ?? null, line.meter_id ?? null])
      const group = groups.get(key) ?? { kind: line.kind, priceId: line.price_id ?? null, before: [] as AnswerFigure[], after: [] as AnswerFigure[] }
      group[side].push(figure(record, line.description, line.amount_cents, 'cents', `/lines/${index}/amount_cents`))
      groups.set(key, group)
    }
  }
  return [...groups.values()].map(group => {
    const beforeCents = group.before.reduce((sum, value) => sum + Number(value.value), 0)
    const afterCents = group.after.reduce((sum, value) => sum + Number(value.value), 0)
    insist(Number.isSafeInteger(beforeCents) && Number.isSafeInteger(afterCents) && Number.isSafeInteger(afterCents - beforeCents), 'answer_amount_out_of_range', 409)
    return { ...group, beforeCents, afterCents, deltaCents: afterCents - beforeCents }
  })
}

/** Recheck saved commitment invoice references before offering their links. */
export async function commitmentCitations(env: Bindings, current: AnswerInvoice): Promise<AnswerCitation[]> {
  const ids = [...new Set((current.invoice.lines as Row[]).flatMap(line => line.kind === 'commitment_trueup'
    ? (line.evidence.priorInvoices ?? []).map((invoice: Row) => String(invoice.id)) : []))] as string[]
  if (!ids.length) return []
  const invoices = await all(env, `SELECT id,number FROM nc_invoices WHERE customer_id=? AND subscription_id=? AND status='issued'
    AND id IN (${ids.map(() => '?').join(',')})`, current.invoice.customer_id, current.invoice.subscription_id, ...ids)
  insist(invoices.length === ids.length, 'answer_evidence_missing', 409)
  return invoices.map(invoice => ({ href: `/app/invoices/${encodeURIComponent(invoice.id)}`, label: `Contributing invoice ${invoice.number}` }))
}
