import type { Bindings } from '../../auth.server'
import type { ApprovalSummary, NativeTarget } from '../../modules/agent-door/index.ts'
import { requireCapability, type Actor } from '../actor'
import { assuranceCase, assuranceCases } from '../assurance'
import { RAMP_KIND, rampEvidence } from '../assurance-ramps'
import { TRUEUP_KIND, trueUpEvidence } from '../assurance-commitments'
import { CREDIT_KIND, creditEvidence } from '../assurance-credits'
import { ACCESS_KIND, accessEvidence } from '../assurance-access'
import { PAID_KIND, paidAccessEvidence } from '../assurance-paid-access'
import { billingAnswer } from '../billing-answers'
import { answerInvoice } from '../billing-answer-sources'
import { requireBusiness } from '../business'
import { fingerprint, insist, one, type Row } from '../core'
import { requireCustomer } from '../customers'
import { isMonth, periodStartingIn, requireDate, today, zonedStart } from '../dates'
import { canonicalDecimal } from '../decimal'
import { Input } from '../input'
import { aggregateMetric } from '../metric-aggregate'
import { metricEvents, metricRequests } from '../meter-definitions'
import { controlTotals } from '../reconciliation'
import { requireSubscription } from '../subscriptions'
import { screen, type RawEvent } from '../usage'
import { previewUsageCorrection, replayUsageDisposition } from '../usage-replay'

export interface Evidence {
  content: unknown
  count: number
  summary: ApprovalSummary
  target?: NativeTarget
  revision?: string | null
}
export type EvidenceReader = (env: Bindings, actor: Actor, input: Input) => Promise<Evidence>

export const usageEvidence: EvidenceReader = async (env, actor, input) => {
  requireCapability(actor, 'usage')
  const events = input.json('events')
  insist(Array.isArray(events), 'invalid_events')
  const screened = await screen(env, events as RawEvent[])
  const customers = await Promise.all([...new Set(screened.accepted.map(event => String(event.customerId)))].map(id =>
    one(env, 'SELECT id,name,external_id FROM nc_customers WHERE id=?', id)))
  return { content: { events, report: screened.report }, count: events.length, summary: { items: [
    `${events.length} usage events: ${screened.counts.accepted} accepted, ${screened.counts.duplicates} duplicate, ${screened.counts.rejected} rejected`,
    ...customers.filter((customer): customer is Row => customer !== null).map(customer => `${customer.name} (${customer.external_id})`),
  ] } }
}

// These are the same scoped lookups used by recordControl. A usage sender does
// not acquire permission to list customers or the rest of the catalog.
export const controlEvidence: EvidenceReader = async (env, actor, input) => {
  requireCapability(actor, 'usage')
  const key = input.text('customer', { max: 100 }), meterKey = input.text('meter', { max: 100 })
  const [customer, meter] = await Promise.all([
    one(env, 'SELECT id,name,external_id FROM nc_customers WHERE id=? OR external_id=?', key, key),
    one(env, 'SELECT id,name,code FROM nc_meters WHERE id=? OR code=?', meterKey, meterKey),
  ])
  insist(customer, 'customer_not_found', 404); insist(meter, 'meter_not_found', 404)
  const day = requireDate(input.text('day', { max: 10 }), 'day')
  const count = input.integer('expected_count', { max: Number.MAX_SAFE_INTEGER })!
  const quantity = canonicalDecimal(input.text('expected_quantity', { max: 24 }), 'expected_quantity')
  const prior = await one(env, 'SELECT id,revision FROM nc_usage_controls WHERE customer_id=? AND meter_id=? AND day=?', customer.id, meter.id, day)
  return { content: { customer, meter, day, count, quantity }, count: 1, revision: prior?.revision ?? null,
    target: prior ? { kind: 'usage-control', id: prior.id } : { kind: 'customer', id: customer.id },
    summary: { target: { id: customer.id, name: customer.name }, items: [`1 daily control: ${meter.name} (${meter.code}), ${day}; ${count} events, ${quantity} units`] } }
}

const detectors: Record<string, (env: Bindings) => Promise<Row[]>> = {
  [RAMP_KIND]: rampEvidence, [TRUEUP_KIND]: trueUpEvidence, [CREDIT_KIND]: creditEvidence,
  [ACCESS_KIND]: accessEvidence, [PAID_KIND]: paidAccessEvidence,
}

export const scanEvidence: EvidenceReader = async (env, actor, input) => {
  requireCapability(actor, 'read'); requireCapability(actor, 'propose')
  const period = input.text('period', { max: 7 }), owner = input.text('owner', { max: 100 })
  insist(isMonth(period), 'invalid_period')
  const member = await one(env, "SELECT id,name FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','finance')", owner)
  insist(member, 'assurance_owner_unavailable', 409)
  const [controls, cases, ...detected] = await Promise.all([
    controlTotals(env, actor, period), assuranceCases(env, actor), ...Object.values(detectors).map(detect => detect(env)),
  ])
  const proofs = [...controls, ...detected.flat()]
  return { content: { proofs, cases }, count: proofs.length, summary: {
    target: { id: member.id, name: member.name }, items: [`${proofs.length} source comparisons for ${period}; new cases assigned to ${member.name}`],
  } }
}

export const recheckEvidence: EvidenceReader = async (env, actor, input) => {
  requireCapability(actor, 'propose')
  const row = await assuranceCase(env, actor, input.text('case', { max: 100 }))
  const detect = detectors[row.kind]
  let proof: unknown
  if (detect) proof = (await detect(env)).find(item => item.source === row.source_id)
  else {
    const control = await one(env, 'SELECT day FROM nc_usage_controls WHERE id=?', row.source_id)
    insist(control, 'assurance_source_unavailable', 409)
    proof = (await controlTotals(env, actor, control.day.slice(0, 7))).find(item => item.id === row.source_id)
  }
  insist(proof, 'assurance_source_unavailable', 409)
  const customer = await requireCustomer(env, row.customer_id)
  return { content: { row, proof }, count: 1, revision: row.basis_hash, target: { kind: 'assurance-case', id: row.id },
    summary: { target: { id: row.id, name: `${customer.name}: ${row.kind}` }, items: [`1 case recheck; source ${row.source_id}`] } }
}

export function answerEvidence(propose: boolean): EvidenceReader {
  return async (env, actor, input) => {
    if (propose) requireCapability(actor, 'propose')
    const answer = await billingAnswer(env, actor, input)
    if (propose) insist(answer.proposalDraft, 'credit_request_required')
    const record = await answerInvoice(env, actor, answer.customerId, answer.invoiceId)
    const customer = await one(env, 'SELECT id,name FROM nc_customers WHERE id=?', answer.customerId)
    insist(customer, 'customer_not_found', 404)
    return { content: { answer, invoice: record.invoice }, count: 1, revision: record.invoice.source_fingerprint,
      target: { kind: 'invoice', id: record.invoice.id }, summary: {
        target: { id: record.invoice.id, name: `${customer.name}: invoice ${record.invoice.number}` },
        items: [`1 ${propose ? 'pending credit proposal' : 'billing answer'}; ${answer.topic}`],
      } }
  }
}

export function correctionEvidence(prepare: boolean): EvidenceReader {
  return async (env, actor, input) => {
    if (prepare) requireCapability(actor, 'propose')
    const replay = await (prepare ? replayUsageDisposition : previewUsageCorrection)(env, actor, input)
    const sub = await requireSubscription(env, replay.subscription)
    const content = prepare ? { replay, customer: await requireCustomer(env, sub.customer_id),
      reason: input.text('reason', { max: 500 }), explanation: input.text('explanation', { max: 8000 }) } : replay
    return { content, count: replay.periods.length, revision: replay.fingerprint, target: { kind: 'subscription', id: sub.id },
      summary: { target: { id: sub.id, name: `${sub.customer_name} (${sub.customer_external_id})` },
        items: [`${replay.periods.length} issued periods: ${replay.fromPeriod} through ${replay.throughPeriod}`,
          `${replay.voidEventIds.length} events to void; ${replay.addEventIds.length} events to add; preview delta ${replay.delta.totalCents} cents`] } }
  }
}

export const meterPreviewEvidence: EvidenceReader = async (env, actor, input) => {
  requireCapability(actor, 'read')
  const request = (await metricRequests(env, actor)).find(row => row.id === input.text('request', { max: 100 }))
  insist(request, 'metric_request_not_found', 404)
  const key = input.text('customer', { max: 100 }), month = input.text('period', { max: 7 })
  insist(isMonth(month), 'invalid_period')
  const business = await requireBusiness(env), period = periodStartingIn(1, month)
  insist(period.end <= today(business.timezone), 'metric_preview_must_be_past')
  const customer = await one(env, 'SELECT id,name,external_id FROM nc_customers WHERE id=? OR external_id=?', key, key)
  insist(customer, 'customer_not_found', 404)
  const from = zonedStart(period.start, business.timezone), to = zonedStart(period.end, business.timezone)
  const events = await metricEvents(env, customer.id, request.source_meter_id, to)
  const basis = { customer: customer.id, source: request.source_meter_id, plan: request.plan, period,
    timezone: business.timezone, events: events.map(({ invoiceId: _invoice, ...event }) => event) }
  const results = aggregateMetric(request.plan, events, { from, to })
  return { content: { plan: request.plan, sql: request.sql_text, events, results }, count: events.length,
    revision: await fingerprint(basis), target: { kind: 'metric-request', id: request.id }, summary: {
      target: { id: request.id, name: `${request.name} v${request.version}: ${customer.name}` },
      items: [`1 saved metric preview for ${month}; ${events.length} source events; ${results.length} result groups`],
    } }
}
