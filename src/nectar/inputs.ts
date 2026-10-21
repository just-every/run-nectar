import { carriedUsageCredits, usageAdjustments } from './usage-correction-records'
import { invoiceContent } from './invoice-content'
import { RENEWAL_RATING_VERSION } from './renewal-rating'
// Gathers the recorded inputs that rate one subscription for one period, and
// fingerprints them. An approval names this fingerprint: if any input changes
// (a usage event, an amendment, a price, the tax declaration), the approval no
// longer matches and the invoice cannot be finalised until it is prepared again.
import type { Bindings } from '../auth.server'
import type { Business } from './business'
import { all, fingerprint, insist, one, type Row } from './core'
import { creditPolicy } from './credit-policy'
import { certificateBasis } from './certificates'
import { localDate, zonedStart } from './dates'
import { activeSegments, blockedAt } from './lifecycle-math'
import { lifecycleHistory, lifecycleIntervals, LIFECYCLE_RATING_VERSION } from './lifecycle-records'
import { RATING_VERSION, rate, type ItemIn, type PriceIn, type RatingInput } from './rating'
import { CHARGE_RATING_VERSION } from './charge-lines'
import { pendingCharges } from './one-time-charges'
import { PRICE_MODEL_RATING_VERSION, storedQuantityPrice } from './price-model'

import { metricEvents } from './meter-definitions'
import { METRIC_RATING_VERSION } from './metric-rating'
import { parseJson } from './core'
import { contractBasis } from './contract-terms'
import { CONTRACT_RATING_VERSION } from './commitment-rating'

export const priceLabel = (row: Row) => `${row.product_name}${row.nickname ? ` — ${row.nickname}` : ''} (v${row.version})`

export async function pricesById(env: Bindings, ids: string[]): Promise<Record<string, PriceIn>> {
  if (!ids.length) return {}
  const rows = await all(env, `SELECT p.*, pr.name AS product_name, m.unit_label,m.source_meter_id,m.metric_plan_json,m.metric_version,m.code AS meter_code FROM nc_prices p JOIN nc_products pr ON pr.id = p.product_id LEFT JOIN nc_meters m ON m.id = p.meter_id WHERE p.id IN (${ids.map(() => '?').join(',')})`, ...ids)
  return Object.fromEntries(rows.map(row => [row.id, { id: row.id, kind: row.kind, unitAmount: row.unit_amount, meterId: row.meter_id, taxable: !!row.taxable, label: priceLabel(row), unitLabel: row.unit_label ?? '',...(row.metric_plan_json?{metric:{sourceId:row.source_meter_id,plan:parseJson(row.metric_plan_json,null as never),dimensions:parseJson(row.dimensions_json,{}),version:row.metric_version,code:row.meter_code}}:{}), ...(row.pricing_model === 'simple' ? {} : { pricing: storedQuantityPrice(row as any) }) }]))
}

export async function ratingInputs(env: Bindings, business: Business, subscriptionId: string, period: { start: string; end: string }, replaceItems?: ItemIn[]): Promise<RatingInput> {
  const sub = await one(env, 'SELECT s.*, c.tax_exempt, c.tax_exempt_ref FROM nc_subscriptions s JOIN nc_customers c ON c.id = s.customer_id WHERE s.id = ?', subscriptionId)
  insist(sub, 'subscription_not_found', 404)
  const items: ItemIn[] = replaceItems ?? (await all(env, 'SELECT id, price_id, quantity, effective_from, effective_to FROM nc_items WHERE subscription_id = ? ORDER BY effective_from, id', sub.id))
    .map(row => ({ id: row.id, priceId: row.price_id, quantity: row.quantity, from: row.effective_from, to: row.effective_to }))
  const amendments = (await all(env, "SELECT * FROM nc_amendments WHERE subscription_id = ? AND status = 'approved' ORDER BY effective_from, id", sub.id))
    .map(row => ({ id: row.id, kind: row.kind, value: row.value, priceId: row.price_id, from: row.effective_from, to: row.effective_to, note: row.note }))
  const prices = await pricesById(env, [...new Set([...items.map(item => item.priceId), ...amendments.flatMap(a => a.priceId ? [a.priceId] : [])])])
  const meters = [...new Set(Object.values(prices).flatMap(price => price.meterId ? [price.meterId] : []))]
  let events:RatingInput['events'] = meters.length ? (await all(env, `SELECT event_id, meter_id, quantity, occurred_at,properties_json,invoice_id FROM nc_usage_events WHERE customer_id = ? AND status = 'active' AND invoice_id IS NULL AND NOT EXISTS(SELECT 1 FROM nc_usage_voids v WHERE v.event_id=nc_usage_events.event_id) AND occurred_at < ? AND meter_id IN (${meters.map(() => '?').join(',')}) ORDER BY occurred_at, event_id`,
    sub.customer_id, zonedStart(period.end, business.timezone), ...meters)).map(row => ({ eventId: row.event_id, meterId: row.meter_id, quantity: row.quantity, occurredAt: row.occurred_at,...(Object.keys(parseJson(row.properties_json,{})).length?{properties:parseJson(row.properties_json,{})}:{}) })) : []
  const metricSources=[...new Set(Object.values(prices).flatMap(p=>p.metric?[p.metric.sourceId]:[]))]
  for(const source of metricSources){const rows=await metricEvents(env,sub.customer_id,source,zonedStart(period.end,business.timezone));for(const event of rows)if(!events.some(e=>e.eventId===event.eventId))events.push(event)}
  events.sort((a,b)=>a.occurredAt-b.occurredAt||a.eventId.localeCompare(b.eventId))
  const contracts=await contractBasis(env,sub.id)
  const hasContracts=contracts.commitments.length>0||contracts.included.length>0||(await all(env,"SELECT 1 FROM nc_contracts WHERE subscription_id=? AND status='approved' LIMIT 1",sub.id)).length>0
  const certificate = await certificateBasis(env, sub.customer_id, business.tax_jurisdiction, period)
  const intervals = lifecycleIntervals(await lifecycleHistory(env, sub.id))
  const billableEvents = activeSegments(period.start,period.end,intervals).length ? events : events.filter(e=>blockedAt(localDate(e.occurredAt,business.timezone),intervals).length > 0)
  const creditGovernance = intervals.length ? await creditPolicy(env) : null
  const charges = (await pendingCharges(env, sub.id, period.end)).filter(charge => activeSegments(period.start,period.end,intervals).length > 0 && !intervals.some(i => i.from <= charge.date && (i.to ?? '9999') > charge.date && (i.to ?? '9999') >= period.end))
  const renewals=(await all(env,"SELECT id,effective_date,uplift_percent FROM nc_renewal_events WHERE subscription_id=? AND kind='renew' ORDER BY effective_date,id",sub.id)).map(r=>({id:r.id,effectiveDate:r.effective_date,upliftPercent:r.uplift_percent}))
  // Every late event touching an issued service window must be resolved
  // against that saved window. Even sums can have nonlinear prices or a
  // different historical tax basis; a fresh late aggregate cannot issue.
  const priorIssued=await all(env,"SELECT id,period_start,period_end,json_extract(calculation_json,'$.inputs.timezone') AS timezone FROM nc_invoices WHERE subscription_id=? AND invoice_kind='recurring' AND status='issued' AND period_start<? ORDER BY period_start",sub.id,period.start)
  const unresolvedHistoricalUsage=billableEvents.flatMap(event=>{
    if(event.invoiceId)return []
    const original=priorIssued.find(i=>event.occurredAt>=zonedStart(i.period_start,i.timezone??business.timezone)&&event.occurredAt<zonedStart(i.period_end,i.timezone??business.timezone))
    return original?[{eventId:event.eventId,invoice:original.id,from:original.period_start,to:original.period_end}]:[]
  })
  const adjustments=await usageAdjustments(env,sub.id),credits=await carriedUsageCredits(env,sub.customer_id)
  const pending=(await all(env,"SELECT id FROM nc_usage_corrections WHERE subscription_id=? AND status='pending'",sub.id)).map(row=>row.id)
  return {
    ...(unresolvedHistoricalUsage.length?{unresolvedHistoricalUsage}:{}),
    ...(adjustments.length?{usageAdjustments:adjustments}:{}),...(credits.length?{usageCredits:credits}:{}),...(pending.length?{usageCorrectionPending:pending}:{}),
    ...(renewals.length?{renewals}:{}),
    ...(hasContracts ? {contracts} : {}),
    ...(charges.length ? { charges } : {}),
    ...(intervals.length ? { lifecycle: intervals, creditGovernance: {thresholdCents:creditGovernance!.two_person_above_cents, revision:creditGovernance!.revision} } : {}),
    version: renewals.length ? RENEWAL_RATING_VERSION : metricSources.length ? METRIC_RATING_VERSION : hasContracts ? CONTRACT_RATING_VERSION : intervals.length ? LIFECYCLE_RATING_VERSION : charges.length ? CHARGE_RATING_VERSION : Object.values(prices).some(price => price.pricing) ? PRICE_MODEL_RATING_VERSION : RATING_VERSION,
    invoiceContent: await invoiceContent(env, business, sub.customer_id),
    timezone: business.timezone,
    tax: { mode: business.tax_mode, rate: business.tax_rate, jurisdiction: business.tax_jurisdiction, exempt: certificate?.exempt ?? !!sub.tax_exempt, exemptRef: certificate?.exemptRef ?? sub.tax_exempt_ref, ...(certificate ? { certificate: certificate.certificate, exception: certificate.exception } : {}) },
    subscription: { id: sub.id, anchorDay: sub.anchor_day, startDate: sub.start_date, trialEnd: sub.trial_end, endDate: sub.end_date, billFrom: sub.cutover_start },
    period, items, prices, amendments, events: billableEvents,
  }
}

export async function rated(env: Bindings, business: Business, subscriptionId: string, period: { start: string; end: string }, replaceItems?: ItemIn[]) {
  const input = await ratingInputs(env, business, subscriptionId, period, replaceItems)
  return { input, rating: rate(input), fingerprint: await fingerprint(input) }
}
