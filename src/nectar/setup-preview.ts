import type { Bindings } from '../auth.server'
import type { Business } from './business'
import { all, fingerprint, insist, parseJson, type Row } from './core'
import { cents, canonicalDecimal } from './decimal'
import { addDays, addMonths, isMonth, zonedStart } from './dates'
import { certificateBasis } from './certificates'
import { CONTRACT_RATING_VERSION, type ContractBasis } from './commitment-rating'
import { pricesById, ratingInputs } from './inputs'
import { metricEvents } from './meter-definitions'
import { METRIC_RATING_VERSION } from './metric-rating'
import { rate, type EventIn, type PriceIn, type RatingInput } from './rating'
import { fields, quoted, rows } from './setup-source'
import { RENEWAL_RATING_VERSION } from './renewal-rating'

/** A full monthly projection carries its own prior calculated invoice evidence. */
export async function setupPreview(env: Bindings, business: Business, plan: Row, payload: Row, basis: Row, quotes: Row[], priorContracts: ContractBasis, ambiguities: Row[]) {
  const prices: Record<string, PriceIn> = await pricesById(env, plan.items.filter((i: Row) => !plan.prices.some((p: Row) => p.id === i.priceId)).map((i: Row) => i.priceId))
  for (const p of plan.prices) {
    const product = plan.products.find((v: Row) => v.id === p.product)!, meter = plan.meters.find((v: Row) => v.id === p.meterId)
    prices[p.id] = { id: p.id, kind: p.kind, unitAmount: p.amount, meterId: p.meterId, taxable: p.taxable, label: `${product.name}${p.nickname ? ` — ${p.nickname}` : ''} (v${p.version})`, unitLabel: meter?.unit_label ?? '', ...(p.pricing ? { pricing: p.pricing } : {}), ...(meter?.metric_plan_json ? { metric: { sourceId: meter.source_meter_id, plan: parseJson(meter.metric_plan_json, null as never), dimensions: p.dimensions, version: meter.metric_version, code: meter.code } } : {}) }
  }
  const assumptions: Row[] = [{ kind: 'usage', label: 'Recorded usage and separately labelled scenarios only; unknown future usage is excluded from calculated amounts, not forecast as zero.' }, { kind: 'execution', label: 'Execution reference is buyer-recorded evidence; no signature or signer authority is verified.' }]
  if (plan.subscription.evergreen) assumptions.push({ kind: 'horizon', label: 'auto-renewal periods beyond 36 months not previewed' })
  const scenario = rows(payload.usage_assumptions, 'usage_assumptions', 360)
  const scenarioEvents: EventIn[] = []
  if (scenario.length) {
    insist(typeof payload.usage_scenario_label === 'string' && payload.usage_scenario_label.trim() && payload.usage_scenario_label.length <= 200, 'usage_scenario_label_required')
    assumptions.push({ kind: 'scenario', label: payload.usage_scenario_label, interpretation: 'Additional hypothetical usage, added to any recorded usage; never ingested.', recorded: false, ingested: false })
    for (const [index, row] of scenario.entries()) {
      fields(row, ['period', 'meter', 'quantity', 'quote'])
      if (row.quote !== undefined) quoted({ text: payload.source.text }, row, `usage_assumptions.${index}`, quotes)
      insist(isMonth(row.period), 'invalid_scenario_period')
      const candidates = Object.values(prices).filter(p => p.meterId && (p.meterId === row.meter || plan.meters.find((m: Row) => m.id === p.meterId)?.code === row.meter))
      insist(candidates.length, 'scenario_meter_not_on_subscription')
      insist(candidates.every(p => !p.metric), 'metric_scenario_requires_source_events')
      const period = `${row.period}-${String(plan.subscription.anchorDay).padStart(2, '0')}`
      insist(period >= plan.subscription.previewStart && period < addMonths(plan.subscription.previewStart, plan.months), 'scenario_period_outside_preview')
      insist(!scenarioEvents.some(e => e.meterId === candidates[0].meterId && e.occurredAt === zonedStart(period < plan.subscription.startDate ? plan.subscription.startDate : period, business.timezone)), 'duplicate_usage_assumption')
      const quantity = canonicalDecimal(String(row.quantity), 'quantity')
      scenarioEvents.push({ eventId: `setup-scenario-${index}`, meterId: candidates[0].meterId!, quantity, occurredAt: zonedStart(period < plan.subscription.startDate ? plan.subscription.startDate : period, business.timezone) })
      assumptions.push({ kind: 'scenario_input', period: row.period, meter: candidates[0].meterId, quantity, label: payload.usage_scenario_label })
    }
  } else insist(payload.usage_scenario_label === undefined, 'scenario_label_without_assumptions')
  let recorded: EventIn[] = []
  const lastEnd = addMonths(plan.subscription.previewStart, plan.months)
  if (!plan.customer.create) {
    const sources = [...new Set(Object.values(prices).flatMap(p => p.metric ? [p.metric.sourceId] : p.meterId ? [p.meterId] : []))]
    if (sources.length) {
      const events = await all(env, `SELECT * FROM nc_usage_events WHERE customer_id=? AND status='active' AND invoice_id IS NULL AND occurred_at<? AND meter_id IN (${sources.map(() => '?').join(',')}) ORDER BY occurred_at,event_id`, plan.customer.id, zonedStart(lastEnd, business.timezone), ...sources)
      basis.events = events
      recorded = events.map(e => ({ eventId: e.event_id, meterId: e.meter_id, quantity: e.quantity, occurredAt: e.occurred_at, properties: parseJson(e.properties_json, {}) }))
      for (const source of [...new Set(Object.values(prices).flatMap(p => p.metric ? [p.metric.sourceId] : []))]) {
        for (const event of await metricEvents(env, plan.customer.id, source, zonedStart(lastEnd, business.timezone))) if (!recorded.some(e => e.eventId === event.eventId)) recorded.push(event)
      }
    }
  }
  const items = plan.items.map((i: Row) => ({ id: i.id, priceId: i.priceId, quantity: i.quantity, from: i.from, to: i.to }))
  const amendments = plan.amendments.map((a: Row) => ({ id: a.id, kind: a.kind, value: a.value, priceId: a.priceId, from: a.from, to: a.to, note: a.note }))
  const renewals: NonNullable<RatingInput['renewals']> = []
  if (plan.renewal?.auto_renew) {
    for (let cycle = 1, date = plan.renewal.end_date; date < plan.subscription.previewEnd; date = addMonths(plan.renewal.start_date, ++cycle * plan.renewal.months)) {
      renewals.push({ id: `setup-renewal-${plan.renewal.id}-${cycle}`, effectiveDate: date, upliftPercent: plan.renewal.uplift_percent })
    }
    assumptions.push({ kind: 'renewal', label: 'Future automatic renewals and quoted uplifts are hypothetical; approval creates the initial term, not future renewal events.', events: renewals, recorded: false })
  }
  const version = plan.renewal ? RENEWAL_RATING_VERSION : Object.values(prices).some(p => p.metric) ? METRIC_RATING_VERSION : CONTRACT_RATING_VERSION
  const additionalContracts: ContractBasis = { commitments: plan.contract.terms.commitments.map((w: Row) => ({ from: w.from, to: w.to, taxable: w.taxable, contract: plan.contract.id, minimumCents: cents(w.minimum) })), included: plan.contract.terms.included.map((w: Row) => ({ ...w, contract: plan.contract.id })), invoices: [] }
  const periods: Row[] = [], consumed = new Map<string, string>(), charged = new Set<string>()
  const projected: ContractBasis['invoices'] = []
  const totals = { subtotalCents: 0, taxCents: 0, totalCents: 0 }, annualTotals: Row[] = []
  basis.ratings = []
  for (let index = 0; index < plan.months; index++) {
    const period = { start: addMonths(plan.subscription.previewStart, index), end: addMonths(plan.subscription.previewStart, index + 1) }
    if (!plan.subscription.evergreen && plan.subscription.endDate && period.start >= plan.subscription.endDate) break
    let input: RatingInput
    if (!plan.subscription.create) input = await ratingInputs(env, business, plan.subscription.id, period, items)
    else {
      const certificate = plan.customer.create ? null : await certificateBasis(env, plan.customer.id, business.tax_jurisdiction, period)
      input = { version, timezone: business.timezone, tax: { mode: business.tax_mode, rate: business.tax_rate, jurisdiction: business.tax_jurisdiction, exempt: certificate?.exempt ?? plan.customer.taxExempt, exemptRef: certificate?.exemptRef ?? plan.customer.taxExemptRef, ...(certificate ? { certificate: certificate.certificate, exception: certificate.exception } : {}) }, subscription: { id: plan.subscription.id, anchorDay: plan.subscription.anchorDay, startDate: plan.subscription.startDate, trialEnd: plan.subscription.trialEnd, endDate: plan.subscription.evergreen ? null : plan.subscription.endDate, billFrom: null }, period, items, prices, amendments: [], events: recorded.filter(e => e.occurredAt < zonedStart(period.end, business.timezone)), contracts: priorContracts }
    }
    const metricSources = new Set(Object.values({ ...input.prices, ...prices }).flatMap(p => p.metric ? [p.metric.sourceId] : []))
    input = { ...input, invoiceContent: plan.invoiceContent, version, ...(plan.renewal ? { renewals } : {}), prices: { ...input.prices, ...prices }, items, amendments: [...input.amendments, ...amendments], events: [...[...input.events, ...recorded.filter(e => !input.events.some(v => v.eventId === e.eventId) && e.occurredAt < zonedStart(period.end, business.timezone))].filter(e => !consumed.has(e.eventId) || !!e.invoiceId || metricSources.has(e.meterId)).map(e => consumed.has(e.eventId) && metricSources.has(e.meterId) ? { ...e, invoiceId: consumed.get(e.eventId)! } : e), ...scenarioEvents.filter(e => e.occurredAt < zonedStart(period.end, business.timezone) && !consumed.has(e.eventId))], charges: (input.charges ?? []).filter(c => !charged.has(c.id)), contracts: { commitments: [...(input.contracts?.commitments ?? []), ...additionalContracts.commitments], included: [...(input.contracts?.included ?? []), ...additionalContracts.included], invoices: [...(input.contracts?.invoices ?? []), ...projected] } }
    const calculation = rate(input), digest = await fingerprint(input)
    periods.push({ period, assumedIssueDate: period.end, dueDate: addDays(period.end, plan.invoiceContent.paymentTermsDays), invoiceContent: plan.invoiceContent, inputs: input, calculation, fingerprint: digest })
    basis.ratings.push(digest)
    for (const e of calculation.consumedEvents) consumed.set(e, `setup-preview-${index}`)
    for (const c of input.charges ?? []) charged.add(c.id)
    projected.push({ id: `setup-preview-${index}`, number: 'Projected invoice', from: period.start, to: period.end, lines: calculation.lines })
    for (const key of ['subtotalCents', 'taxCents', 'totalCents'] as const) totals[key] += calculation[key]
    const yearIndex = Math.floor(index / 12)
    if (!annualTotals[yearIndex]) annualTotals[yearIndex] = { year: yearIndex + 1, from: period.start, to: period.end, subtotalCents: 0, taxCents: 0, totalCents: 0 }
    annualTotals[yearIndex].to = period.end
    for (const key of ['subtotalCents', 'taxCents', 'totalCents'] as const) annualTotals[yearIndex][key] += calculation[key]
    for (const exception of calculation.exceptions) if (!ambiguities.some(a => a.code === exception.code && a.period === period.start)) ambiguities.push({ issue: exception.message, code: exception.code, period: period.start, detail: exception.detail })
  }
  return { periods, totals, annualTotals, previewHorizon: { from: plan.subscription.previewStart, through: plan.subscription.previewEnd, finite: !plan.subscription.evergreen, ...(plan.subscription.evergreen ? { label: 'auto-renewal periods beyond 36 months not previewed' } : {}) }, assumptions, unresolvedAmbiguities: ambiguities, resolvedAmbiguities: rows(payload.ambiguities, 'ambiguities').filter(a => typeof a.resolution === 'string' && a.resolution.trim()), quotes }
}
