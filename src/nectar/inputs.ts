import { billingCurrency } from './currency'
import { amountCouponInputs } from './promotions'
import { prepaidRefundSpendableBasis } from './prepaid-refund-records'
import { prepaidSnapshot } from './prepaid-records'
import { billingServiceWindows } from './billing-composition'
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
import { INTERVAL_RATING_VERSION, storedBillingTerms, type BillingWindow } from './billing-calendar'

export const priceLabel = (row: Row) => `${row.product_name}${row.nickname ? ` — ${row.nickname}` : ''} (v${row.version})`

export async function pricesById(env: Bindings, ids: string[]): Promise<Record<string, PriceIn>> {
  if (!ids.length) return {}
  const rows = await all(env, `SELECT p.*, b.interval_unit,b.interval_count,b.billing_timing,pr.name AS product_name, m.unit_label,m.source_meter_id,m.metric_plan_json,m.metric_version,m.code AS meter_code FROM nc_prices p JOIN nc_products pr ON pr.id = p.product_id LEFT JOIN nc_price_intervals b ON b.price_id=p.id LEFT JOIN nc_meters m ON m.id = p.meter_id WHERE p.id IN (${ids.map(() => '?').join(',')})`, ...ids)
  return Object.fromEntries(rows.map(row => [row.id, { id: row.id, kind: row.kind, unitAmount: row.unit_amount, meterId: row.meter_id, taxable: !!row.taxable, label: priceLabel(row), unitLabel: row.unit_label ?? '', ...(storedBillingTerms(row) ? { billing: storedBillingTerms(row) } : {}),...(row.metric_plan_json?{metric:{sourceId:row.source_meter_id,plan:parseJson(row.metric_plan_json,null as never),dimensions:parseJson(row.dimensions_json,{}),version:row.metric_version,code:row.meter_code}}:{}), ...(row.pricing_model === 'simple' ? {} : { pricing: storedQuantityPrice(row as any) }) }]))
}

export async function ratingInputs(env: Bindings, business: Business, subscriptionId: string, period: { start: string; end: string }, replaceItems?: ItemIn[], billing?: BillingWindow): Promise<RatingInput> {
  // One database snapshot carries independent rows and feature-presence facts.
  // Empty optional domains need no follow-up reads; populated domains retain
  // their existing source readers and exact rating semantics.
  const captured = (await one<Row>(env, `WITH source AS (
    SELECT s.*,c.tax_exempt,c.tax_exempt_ref,c.currency FROM nc_subscriptions s
    JOIN nc_customers c ON c.id=s.customer_id WHERE s.id=?1
  ) SELECT source.*,
    (SELECT json_group_array(json_object('id',id,'price_id',price_id,'quantity',quantity,'effective_from',effective_from,'effective_to',effective_to))
      FROM (SELECT id,price_id,quantity,effective_from,effective_to FROM nc_items WHERE subscription_id=source.id ORDER BY effective_from,id)) AS item_rows,
    (SELECT json_group_array(json_object('id',id,'kind',kind,'value',value,'price_id',price_id,'scope_price_id',scope_price_id,'effective_from',effective_from,'effective_to',effective_to,'note',note))
      FROM (SELECT a.*,(SELECT scope.price_id FROM nc_amendment_scopes scope WHERE scope.amendment_id=a.id) AS scope_price_id FROM nc_amendments a WHERE a.subscription_id=source.id AND a.status='approved'
        ${billing ? "AND (kind<>'fixed_credit' OR NOT EXISTS(SELECT 1 FROM nc_invoice_lines l JOIN nc_invoices i ON i.id=l.invoice_id WHERE i.subscription_id=a.subscription_id AND i.status='issued' AND l.kind='credit' AND json_extract(l.evidence_json,'$.amendment')=a.id))" : ''} ORDER BY effective_from,id)) AS amendment_rows,
    (SELECT json_group_array(json_object('id',id,'effective_date',effective_date,'uplift_percent',uplift_percent))
      FROM (SELECT id,effective_date,uplift_percent FROM nc_renewal_events WHERE subscription_id=source.id AND kind='renew' ORDER BY effective_date,id)) AS renewal_rows,
    (SELECT json_group_array(json_object('id',id,'period_start',period_start,'period_end',period_end,'timezone',timezone,'source_meter',source_meter))
      FROM (SELECT DISTINCT i.id,l.period_start,l.period_end,json_extract(i.calculation_json,'$.inputs.timezone') AS timezone,
        COALESCE(json_extract(i.calculation_json,'$.inputs.prices.' || json_quote(l.price_id) || '.metric.sourceId'),l.meter_id) AS source_meter
        FROM nc_invoices i JOIN nc_invoice_lines l ON l.invoice_id=i.id
        WHERE i.subscription_id=source.id AND i.invoice_kind='recurring' AND i.status='issued' AND l.period_start<?2
          AND l.meter_id IS NOT NULL AND l.price_id IS NOT NULL ORDER BY l.period_start,i.id)) AS prior_issued_rows,
    (SELECT json_group_array(json_object('id',id)) FROM nc_usage_corrections WHERE subscription_id=source.id AND status='pending') AS pending_rows,
    EXISTS(SELECT 1 FROM nc_contracts WHERE subscription_id=source.id AND status='approved') AS has_approved_contracts,
    EXISTS(SELECT 1 FROM nc_exemption_claims WHERE customer_id=source.customer_id) AS has_exemption_claims,
    EXISTS(SELECT 1 FROM nc_prepaid_accounts WHERE subscription_id=source.id) AS has_prepaid_account,
    (EXISTS(SELECT 1 FROM nc_usage_adjustments WHERE subscription_id=source.id AND invoice_id IS NULL AND target_invoice_id IS NULL)
      OR EXISTS(SELECT 1 FROM nc_plan_change_adjustments WHERE subscription_id=source.id AND invoice_id IS NULL)) AS has_adjustments,
    EXISTS(SELECT 1 FROM nc_subscription_lifecycle WHERE subscription_id=source.id) AS has_lifecycle,
    EXISTS(SELECT 1 FROM nc_charges WHERE subscription_id=source.id AND invoice_id IS NULL) AS has_pending_charges,
    EXISTS(SELECT 1 FROM nc_credit_notes WHERE customer_id=source.customer_id) AS has_carried_credits,
    EXISTS(SELECT 1 FROM nc_coupon_amount_terms WHERE subscription_id=source.id) AS has_amount_coupons,
    EXISTS(SELECT 1 FROM nc_renewal_terms WHERE subscription_id=source.id) AS has_renewal_terms FROM source`,subscriptionId,period.start))
  insist(captured, 'subscription_not_found', 404)
  const sub=captured
  const [itemRows,amendmentRows,renewalRows,priorIssuedRows,pendingRows] =
    ['item_rows','amendment_rows','renewal_rows','prior_issued_rows','pending_rows'].map(key=>({results:JSON.parse(captured[key]) as Row[]}))
  const items: ItemIn[] = replaceItems ?? itemRows.results.map(row => ({ id: row.id, priceId: row.price_id, quantity: row.quantity, from: row.effective_from, to: row.effective_to }))
  const amendments = amendmentRows.results.map(row => ({ id: row.id, kind: row.kind, value: row.value, priceId: row.scope_price_id ?? row.price_id, from: row.effective_from, to: row.effective_to, note: row.note }))
  const prices = await pricesById(env, [...new Set([...items.map(item => item.priceId), ...amendments.flatMap(a => a.priceId ? [a.priceId] : [])])])
  const selectedMeterIds = billing ? new Set(items.filter(item => billing.components.some(component => component.itemId === item.id)).map(item => prices[item.priceId]).filter(price => price.kind === 'unit').map(price => price.meterId)) : null
  const eventPrices = Object.values(prices).filter(price => !selectedMeterIds || selectedMeterIds.has(price.meterId))
  const meters = [...new Set(eventPrices.flatMap(price => price.meterId ? [price.meterId] : []))]
  let events:RatingInput['events'] = meters.length ? (await all(env, `SELECT event_id, meter_id, quantity, occurred_at,properties_json,invoice_id FROM nc_usage_events WHERE customer_id = ? AND status = 'active' AND invoice_id IS NULL AND NOT EXISTS(SELECT 1 FROM nc_usage_voids v WHERE v.event_id=nc_usage_events.event_id) AND occurred_at < ? AND meter_id IN (${meters.map(() => '?').join(',')}) ORDER BY occurred_at, event_id`,
    sub.customer_id, zonedStart(period.end, business.timezone), ...meters)).map(row => ({ eventId: row.event_id, meterId: row.meter_id, quantity: row.quantity, occurredAt: row.occurred_at,...(Object.keys(parseJson(row.properties_json,{})).length?{properties:parseJson(row.properties_json,{})}:{}) })) : []
  const metricSources=[...new Set(eventPrices.flatMap(p=>p.metric?[p.metric.sourceId]:[]))]
  for(const source of metricSources){const rows=await metricEvents(env,sub.customer_id,source,zonedStart(period.end,business.timezone));for(const event of rows)if(!events.some(e=>e.eventId===event.eventId))events.push(event)}
  events.sort((a,b)=>a.occurredAt-b.occurredAt||a.eventId.localeCompare(b.eventId))
  const contracts=captured.has_approved_contracts?await contractBasis(env,sub.id):{commitments:[],included:[],invoices:[]}
  const hasContracts=contracts.commitments.length>0||contracts.included.length>0||!billing&&!!captured.has_approved_contracts
  const certificate = captured.has_exemption_claims?await certificateBasis(env, sub.customer_id, business.tax_jurisdiction, period):null
  const intervals = lifecycleIntervals(captured.has_lifecycle?await lifecycleHistory(env, sub.id):[])
  const billableEvents = activeSegments(period.start,period.end,intervals).length ? events : events.filter(e=>blockedAt(localDate(e.occurredAt,business.timezone),intervals).length > 0)
  const creditGovernance = intervals.length ? await creditPolicy(env) : null
  const charges = (captured.has_pending_charges?await pendingCharges(env, sub.id, period.end):[]).filter(charge => activeSegments(period.start,period.end,intervals).length > 0 && !intervals.some(i => i.from <= charge.date && (i.to ?? '9999') > charge.date && (i.to ?? '9999') >= period.end))
  const renewals=renewalRows.results.map(r=>({id:r.id,effectiveDate:r.effective_date,upliftPercent:r.uplift_percent}))
  // Every late event touching an issued service window must be resolved
  // against that saved window. Even sums can have nonlinear prices or a
  // different historical tax basis; a fresh late aggregate cannot issue.
  const priorIssued=priorIssuedRows.results
  const unresolvedHistoricalUsage=billableEvents.flatMap(event=>{
    if(event.invoiceId)return []
    const original=priorIssued.find(i=>i.source_meter===event.meterId&&event.occurredAt>=zonedStart(i.period_start,i.timezone??business.timezone)&&event.occurredAt<zonedStart(i.period_end,i.timezone??business.timezone))
    return original?[{eventId:event.eventId,invoice:original.id,from:original.period_start,to:original.period_end}]:[]
  })
  const pendingAdjustments=captured.has_adjustments?await usageAdjustments(env,sub.id):[]
  const adjustments=billing&&!billingServiceWindows(billing).some(window=>window.terms.timing==='arrears')?pendingAdjustments.filter(a=>a.source==='plan-change'):pendingAdjustments,credits=captured.has_carried_credits?await carriedUsageCredits(env,sub.customer_id):[]
  const pending=pendingRows.results.map(row=>row.id)
  const term = billing && captured.has_renewal_terms ? await one(env, "SELECT end_date,auto_renew,cancelled_at FROM nc_renewal_terms WHERE subscription_id=? AND status='active' ORDER BY created_at DESC LIMIT 1", sub.id) : null
  const renewing = !!term?.auto_renew && !term.cancelled_at
  const recordedPrepaid = captured.has_prepaid_account?await prepaidSnapshot(env, sub.id):undefined
  const currency=billingCurrency(sub.currency)
  const amountCoupons=captured.has_amount_coupons?await amountCouponInputs(env,sub.id):[]
  const prepaid = recordedPrepaid ? await prepaidRefundSpendableBasis(env,recordedPrepaid) : undefined
  return {
    ...(currency==='USD'?{}:{currency}),
    ...(prepaid ? { prepaid } : {}),
    ...(amountCoupons.length?{amountCoupons}:{}),
    ...(billing ? { billing } : {}),
    ...(unresolvedHistoricalUsage.length?{unresolvedHistoricalUsage}:{}),
    ...(adjustments.length?{usageAdjustments:adjustments}:{}),...(credits.length?{usageCredits:credits}:{}),...(pending.length?{usageCorrectionPending:pending}:{}),
    ...(renewals.length?{renewals}:{}),
    ...(hasContracts ? {contracts} : {}),
    ...(charges.length ? { charges } : {}),
    ...(intervals.length ? { lifecycle: intervals, creditGovernance: {thresholdCents:creditGovernance!.two_person_above_cents, revision:creditGovernance!.revision} } : {}),
    version: billing ? INTERVAL_RATING_VERSION : renewals.length ? RENEWAL_RATING_VERSION : metricSources.length ? METRIC_RATING_VERSION : hasContracts ? CONTRACT_RATING_VERSION : intervals.length ? LIFECYCLE_RATING_VERSION : charges.length ? CHARGE_RATING_VERSION : Object.values(prices).some(price => price.pricing) ? PRICE_MODEL_RATING_VERSION : RATING_VERSION,
    invoiceContent: await invoiceContent(env, business, sub.customer_id),
    timezone: business.timezone,
    tax: { mode: business.tax_mode, rate: business.tax_rate, jurisdiction: business.tax_jurisdiction, exempt: certificate?.exempt ?? !!sub.tax_exempt, exemptRef: certificate?.exemptRef ?? sub.tax_exempt_ref, ...(certificate ? { certificate: certificate.certificate, exception: certificate.exception } : {}) },
    subscription: { id: sub.id, anchorDay: sub.anchor_day, startDate: sub.start_date, trialEnd: sub.trial_end, endDate: renewing ? null : sub.end_date, billFrom: sub.cutover_start,
      ...(sub.billing_anchor_date ? { billingAnchorDate: sub.billing_anchor_date } : {}), ...(term?.end_date || sub.contract_end_date ? { contractEndDate: renewing ? null : term?.end_date ?? sub.contract_end_date } : {}) },
    period, items, prices, amendments, events: billableEvents,
  }
}

export async function rated(env: Bindings, business: Business, subscriptionId: string, period: { start: string; end: string }, replaceItems?: ItemIn[], billing?: BillingWindow) {
  const input = await ratingInputs(env, business, subscriptionId, period, replaceItems, billing)
  return { input, rating: rate(input), fingerprint: await fingerprint(input) }
}
