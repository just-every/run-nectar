// A crossing offers a human a draft. All later authority stays with the normal
// invoice approval, issue, numbering, revenue and collection machinery.
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, type Actor } from './actor'
import { requireBusiness, type Business } from './business'
import { billingAnchor, billingPeriodContaining, MONTHLY_ARREARS, nonMonthlyArrears } from './billing-calendar'
import { clockInstant } from './clock'
import { all, commit, fingerprint, guard, insist, newId, one, parseJson, stmt, type Row } from './core'
import { localDate, requireDate, zonedStart } from './dates'
import { micros } from './decimal'
import type { Input } from './input'
import { ratingInputs } from './inputs'
import { rate, type RatingInput } from './rating'
import { reconciliationFor } from './reconciliation'
import { recognitionForRating } from './revenue-allocation'
import { priorSettlementGuards, type ThresholdInvoiceBasis } from './threshold-invoice-rating'

async function thresholdCalculation(env: Bindings, business: Business, crossingId: string, saved?: ThresholdInvoiceBasis) {
  const crossing = await one(env, `SELECT c.*,t.kind AS definition_kind,t.meter_id,t.contract_id,t.threshold AS current_threshold,t.revision AS threshold_revision,t.enabled
    FROM nc_usage_crossings c JOIN nc_usage_thresholds t ON t.id=c.threshold_id WHERE c.id=?`, crossingId)
  insist(crossing, 'usage_crossing_not_found', 404)
  insist(crossing.kind === 'spend' && crossing.definition_kind === 'spend' && crossing.enabled, 'threshold_invoice_requires_enabled_spend', 409)
  insist(crossing.current_threshold === crossing.threshold, 'threshold_definition_changed', 409)
  insist(crossing.subscription_id && !crossing.meter_id && !crossing.contract_id, 'threshold_invoice_scope_unsupported', 409)
  insist(micros(crossing.value) >= micros(crossing.threshold), 'threshold_not_crossed', 409)
  const sub = await one(env, `SELECT s.*,c.revision AS customer_revision,c.status AS customer_status,c.erased_at
    FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id WHERE s.id=? AND s.customer_id=?`, crossing.subscription_id, crossing.customer_id)
  insist(sub && sub.billing_mode === 'live' && sub.customer_status === 'active' && !sub.erased_at, 'threshold_invoice_requires_live_subscription', 409)
  const period = { start: requireDate(crossing.period_start, 'period_start'), end: requireDate(crossing.period_end, 'period_end') }
  insist(period.start < period.end, 'threshold_window_unsupported', 409)
  const cutoff = crossing.created_at
  insist(Number.isSafeInteger(cutoff) && cutoff <= clockInstant(env) && cutoff >= zonedStart(period.start, business.timezone), 'threshold_cutoff_invalid', 409)
  insist(!saved || cutoff === saved.cutoff, 'source_changed', 409)
  const full = await ratingInputs(env, business, sub.id, period)
  const nominal = billingPeriodContaining(billingAnchor(full), MONTHLY_ARREARS, period.start)
  insist(nominal.start === period.start && nominal.end === period.end
    && sub.start_date <= period.start && (!sub.trial_end || sub.trial_end <= period.start)
    && (!sub.cutover_start || sub.cutover_start <= period.start) && (!sub.end_date || sub.end_date >= period.end)
    && Object.values(full.prices).every(price => !price.billing || !nonMonthlyArrears(price.billing))
    && full.items.every(item => item.from <= period.start && (!item.to || item.to >= period.end)), 'threshold_window_unsupported', 409)
  insist(!full.prepaid && !full.amountCoupons?.length && !full.renewals?.length && !full.lifecycle?.length
    && !full.usageAdjustments?.length && !full.usageCredits?.length && !full.usageCorrectionPending?.length,
  'threshold_invoice_operands_unsupported', 409)
  // Stateful gauges can carry prior context or accrue time beyond the cutoff.
  // Their alerts remain supported; a partial monetary invoice needs a separate
  // exact elapsed-time service window before those operands can be billed.
  insist(Object.values(full.prices).every(price => !price.metric || ['sum', 'count', 'maximum', 'unique'].includes(price.metric.plan.aggregation)),
  'threshold_invoice_metric_unsupported', 409)
  insist(!await one(env, "SELECT 1 FROM nc_invoices WHERE subscription_id=? AND invoice_kind='recurring' AND status='issued' AND period_start<? AND period_end>?", sub.id, period.end, period.start), 'threshold_period_already_billed', 409)
  // Freeze event identity at preparation. A late arrival remains available for
  // the next cumulative draft or final invoice; voiding a frozen event invalidates
  // this draft instead of silently changing its consideration.
  const eligible = new Set((await all(env, `SELECT event_id FROM nc_usage_events WHERE customer_id=? AND status='active'
    AND invoice_id IS NULL AND received_at<=? AND occurred_at>=? AND occurred_at<=? AND occurred_at<?
    AND NOT EXISTS(SELECT 1 FROM nc_usage_voids v WHERE v.event_id=nc_usage_events.event_id)`,
  sub.customer_id, cutoff, zonedStart(period.start, business.timezone), cutoff, zonedStart(period.end, business.timezone))).map(row => row.event_id))
  const frozen = saved ? new Set(saved.eventIds) : null
  const events = full.events.filter(event => eligible.has(event.eventId) && (!frozen || frozen.has(event.eventId)))
  insist(!frozen || events.length === frozen.size, 'threshold_events_changed', 409)
  const basis: ThresholdInvoiceBasis = { crossing: crossing.id, threshold: crossing.threshold_id, thresholdRevision: crossing.threshold_revision,
    cutoff, scope: { customer: sub.customer_id, subscription: sub.id, from: period.start, to: period.end },
    eventIds: events.map(event => event.eventId), subscriptionRevision: sub.revision,
    customerRevision: sub.customer_revision, businessRevision: business.revision }
  const meteredItems = full.items.filter(item => full.prices[item.priceId].kind === 'unit')
  insist(meteredItems.length, 'threshold_invoice_requires_metered_usage', 409)
  const input: RatingInput = { ...full, thresholdInvoice: basis, events,
    // This draft accrues only this crossing's window, unlike an ordinary bill
    // run that also rates earlier unconsumed usage.
    thresholdSettlements: full.thresholdSettlements?.filter(prior => prior.from >= period.start),
    items: meteredItems, charges: [], amendments: full.amendments.filter(amendment => amendment.kind === 'price_override'),
    // Actual usage earns against the minimum. An unused future minimum is not
    // accrued usage and cannot be invoiced at a spend crossing.
    ...(full.contracts ? { contracts: { ...full.contracts, commitments: [] } } : {}) }
  const reconciliation = await reconciliationFor(env, sub.id, period, business.timezone, events)
  const bound = { ...input, reconciliation }
  const rating = rate(input)
  rating.exceptions.push(...reconciliation.filter(row => row.mismatch && !row.acknowledged).map(row => ({
    code: 'usage_reconciliation', message: 'Resolve or acknowledge the usage source reconciliation before issue.', detail: row })))
  // Re-evaluate the spend crossing on the frozen accrued basis, without prior
  // settlement deductions; recorded threshold notifications alone grant no bill.
  const gross = rating.subtotalCents + (input.thresholdSettlements ?? []).reduce((sum, prior) => sum + prior.subtotalCents, 0)
  insist(BigInt(gross) * 10_000n >= micros(crossing.threshold), 'threshold_not_crossed', 409)
  insist(rating.subtotalCents > 0 && rating.totalCents > 0, 'threshold_nothing_to_invoice', 409)
  return { input: bound, rating, fingerprint: await fingerprint(bound) }
}

/** Public records door: prepares only. A member must separately approve and issue. */
export async function prepareThresholdInvoice(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'records')
  const crossingId = input.text('crossing', { max: 100 })
  const existing = await one(env, `SELECT i.id,i.bill_run_id AS run,i.status FROM nc_usage_crossings c
    JOIN nc_invoices i ON i.id=c.invoice_id WHERE c.id=? AND i.status<>'discarded'`, crossingId)
  if (existing) return existing
  const business = await requireBusiness(env), calculation = await thresholdCalculation(env, business, crossingId)
  const { rating, input: basis, fingerprint: source } = calculation
  const invoice = newId(), run = newId(), at = clockInstant(env), scope = basis.thresholdInvoice!.scope
  await commit(env, [
    ...thresholdSourceGuards(env, basis),
    guard(env, 'source_changed', `EXISTS(SELECT 1 FROM nc_usage_crossings c LEFT JOIN nc_invoices i ON i.id=c.invoice_id
      WHERE c.id=? AND (c.invoice_id IS NULL OR i.status='discarded'))`, crossingId),
    stmt(env, `INSERT INTO nc_bill_runs(id,period,cutoff_at,calc_version,status,summary_json,created_by,created_at,kind)
      VALUES(?,?,?,?,'draft',?,?,?,'manual')`, run, scope.from.slice(0, 7), basis.thresholdInvoice!.cutoff, basis.version,
    JSON.stringify({ invoices: 1, manual: true, threshold: crossingId, totals: { subtotal: rating.subtotalCents, tax: rating.taxCents, total: rating.totalCents } }), actorLabel(actor), at),
    stmt(env, `INSERT INTO nc_invoices(id,bill_run_id,customer_id,subscription_id,invoice_kind,period_start,period_end,status,
      subtotal_cents,tax_cents,total_cents,currency,calc_version,source_fingerprint,calculation_json,comparison_json,exceptions_json,created_at)
      VALUES(?,?,?,?,'manual',?,?,'draft',?,?,?,?,?,?,?,'{}',?,?)`, invoice, run, scope.customer, scope.subscription, scope.from, scope.to,
    rating.subtotalCents, rating.taxCents, rating.totalCents, basis.currency ?? 'USD', basis.version, source,
    JSON.stringify({ version: basis.version, fingerprint: source, tax: rating.tax, consumedEvents: [], inputs: basis }), JSON.stringify(rating.exceptions), at),
    ...rating.lines.map((line, index) => stmt(env, `INSERT INTO nc_invoice_lines(id,invoice_id,seq,kind,description,quantity,unit_amount,amount_cents,taxable,price_id,meter_id,period_start,period_end,evidence_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, newId(), invoice, index + 1, line.kind, line.description, line.quantity, line.unitAmount,
    line.amountCents, line.taxable ? 1 : 0, line.priceId, line.meterId, line.periodStart, line.periodEnd,
    JSON.stringify({ ...line.evidence, thresholdAccrual: { crossing: crossingId, cutoff: basis.thresholdInvoice!.cutoff, eventIds: basis.thresholdInvoice!.eventIds } }))),
    stmt(env, 'UPDATE nc_usage_crossings SET invoice_id=? WHERE id=?', invoice, crossingId),
  ], { actor: actorLabel(actor), action: 'usage.threshold.invoice', subject: invoice, detail: { crossing: crossingId, fingerprint: source, cutoff: basis.thresholdInvoice!.cutoff } })
  return { id: invoice, run, status: 'draft' }
}

export async function thresholdInvoiceFingerprint(env: Bindings, business: Business, invoice: Row) {
  const saved = parseJson<{ inputs?: RatingInput }>(invoice.calculation_json, {}).inputs?.thresholdInvoice
  insist(saved, 'threshold_invoice_source_missing', 409)
  const crossing = await one(env, 'SELECT invoice_id FROM nc_usage_crossings WHERE id=?', saved.crossing)
  insist(crossing?.invoice_id === invoice.id, 'source_changed', 409)
  return (await thresholdCalculation(env, business, saved.crossing, saved)).fingerprint
}

function thresholdSourceGuards(env: Bindings, input: RatingInput) {
  const basis = input.thresholdInvoice!, scope = basis.scope
  return [
    guard(env, 'source_changed', `EXISTS(SELECT 1 FROM nc_business WHERE singleton=1 AND revision=?)
      AND EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND revision=? AND status='active' AND erased_at IS NULL)
      AND EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND revision=? AND billing_mode='live')
      AND EXISTS(SELECT 1 FROM nc_usage_thresholds WHERE id=? AND revision=? AND enabled=1)`,
    basis.businessRevision, scope.customer, basis.customerRevision, scope.subscription, basis.subscriptionRevision, basis.threshold, basis.thresholdRevision),
    guard(env, 'source_changed', "NOT EXISTS(SELECT 1 FROM nc_invoices WHERE subscription_id=? AND invoice_kind='recurring' AND status='issued' AND period_start<? AND period_end>?)", scope.subscription, scope.to, scope.from),
    ...priorSettlementGuards(env, scope.subscription, input.period, input.thresholdSettlements ?? [], true),
    ...Array.from({ length: Math.ceil(input.events.length / 90) }, (_, index) => input.events.slice(index * 90, (index + 1) * 90))
      .map(events => guard(env, 'source_changed', `(SELECT COUNT(*) FROM nc_usage_events e WHERE e.event_id IN (${events.map(() => '?').join(',')})
        AND e.customer_id=? AND e.status='active' AND e.invoice_id IS NULL AND NOT EXISTS(SELECT 1 FROM nc_usage_voids v WHERE v.event_id=e.event_id))=?`,
      ...events.map(event => event.eventId), scope.customer, events.length)),
  ]
}

/** All statements execute after ordinary invoice issue in that same transaction. */
export async function thresholdIssueStatements(env: Bindings, invoice: Row, input: RatingInput): Promise<D1PreparedStatement[]> {
  if (input.thresholdInvoice) {
    const basis = input.thresholdInvoice, lines = (await all(env, 'SELECT * FROM nc_invoice_lines WHERE invoice_id=? ORDER BY seq', invoice.id))
      .map(row => ({ kind: row.kind, description: row.description, quantity: row.quantity, unitAmount: row.unit_amount,
        amountCents: row.amount_cents, taxable: !!row.taxable, priceId: row.price_id, meterId: row.meter_id,
        periodStart: row.period_start, periodEnd: row.period_end, evidence: parseJson<Row>(row.evidence_json, {}) }))
    const schedules = recognitionForRating(input, { lines, subtotalCents: invoice.subtotal_cents })
    insist(invoice.issue_date >= localDate(basis.cutoff, input.timezone), 'invalid_issue_date', 409)
    const months = new Map<string, { amountCents: number; components: Row[] }>()
    for (const schedule of schedules) for (const entry of schedule.entries) {
      const month = months.get(entry.period) ?? { amountCents: 0, components: [] }
      month.amountCents += entry.amountCents
      insist(Number.isSafeInteger(month.amountCents), 'threshold_amount_out_of_range', 409)
      month.components.push({ line: schedule.lineId, amountCents: entry.amountCents, basis: entry.basis })
      months.set(entry.period, month)
    }
    const revenue = [...months].sort(([a], [b]) => a.localeCompare(b)).map(([period, value]) => ({ period,
      amountCents: value.amountCents, basis: { method: 'issued-threshold-consideration', components: value.components } }))
    return [...thresholdSourceGuards(env, input),
      guard(env, 'source_changed', 'EXISTS(SELECT 1 FROM nc_usage_crossings WHERE id=? AND invoice_id=?)', basis.crossing, invoice.id),
      stmt(env, `INSERT INTO nc_threshold_settlements(invoice_id,crossing_id,customer_id,subscription_id,period_start,period_end,cutoff_at,
        source_fingerprint,subtotal_cents,tax_cents,revenue_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, invoice.id, basis.crossing,
      invoice.customer_id, invoice.subscription_id, basis.scope.from, basis.scope.to, basis.cutoff, invoice.source_fingerprint,
      invoice.subtotal_cents, invoice.tax_cents, JSON.stringify(revenue), clockInstant(env))]
  }
  if (invoice.invoice_kind !== 'recurring' || !invoice.subscription_id) return []
  const saved = input.thresholdSettlements ?? []
  return [...priorSettlementGuards(env, invoice.subscription_id, { start: invoice.period_start, end: invoice.period_end }, saved),
    ...saved.map(prior => stmt(env, 'UPDATE nc_threshold_settlements SET remainder_invoice_id=? WHERE invoice_id=? AND remainder_invoice_id IS NULL', invoice.id, prior.invoice))]
}
