import { featureDecision } from './feature-policy'
import { contractBurnDown } from './contract-terms'
import { composeBillingWindows,billingServiceWindows } from './billing-composition'
import { upcomingMeterPeriod } from './upcoming-meter-periods'
// Customer-scoped projections of the ordinary rating engine. Saved inputs,
// exceptions, reconciliation notes and operator read models never leave here.
import type { Bindings } from '../auth.server'
import { requireBusiness } from './business'
import { draftFor } from './billruns'
import { subscriptionCalendar } from './billing-plan'
import { dueBillingWindows, type BillingWindow } from './billing-calendar'
import { clockInstant } from './clock'
import { all, insist, one, parseJson, type Row } from './core'
import { addMonths, isMonth, periodContaining, periodStartingIn, today, zonedStart } from './dates'
import { cents, decimalText, micros } from './decimal'
import { displayQuantity } from './metric-aggregate'
import { addRational, rational, type Rational } from './metric-plan'
import type { CustomerSession } from './portal-session'
import type { RatingInput } from './rating'

export async function portalUpcomingSubscriptions(env: Bindings, session: CustomerSession) {
  return await all(env, `SELECT s.id,s.start_date,s.end_date,s.anchor_day,(SELECT p.name FROM nc_items si JOIN nc_prices price ON price.id=si.price_id JOIN nc_products p ON p.id=price.product_id WHERE si.subscription_id=s.id LIMIT 1) AS label FROM nc_subscriptions s
    JOIN nc_customers c ON c.id=s.customer_id WHERE s.customer_id=? AND c.erased_at IS NULL
    AND s.billing_mode='live' ORDER BY s.start_date,s.id`, session.customer)
}

export async function portalUpcoming(env: Bindings, session: CustomerSession, subscriptionId: string, month?: string | null) {
  const sub = await one(env, `SELECT s.*,c.billing_email FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id
    WHERE s.id=? AND s.customer_id=? AND c.erased_at IS NULL AND s.billing_mode='live'`, subscriptionId, session.customer)
  insist(sub, 'not_found', 404)
  insist(month === undefined || month === null || isMonth(month), 'invalid_period')
  const business = await requireBusiness(env)
  const commitments = (await contractBurnDown(env, sub.id)).map(window => ({
    contract:window.contract,from:window.from,to:window.to,minimumCents:window.minimumCents,nominalMinimumCents:window.nominalMinimumCents,
    earnedCents:window.earnedCents,trueUpCents:window.trueUpCents,billedCents:window.billedCents,remainingCents:window.remainingCents,
    invoices:window.invoices.map(invoice=>({id:invoice.id,number:invoice.number,earnedCents:invoice.earnedCents,trueUpCents:invoice.trueUpCents,
      ...(invoice.originalEarnedCents!==undefined?{originalEarnedCents:invoice.originalEarnedCents,originalTrueUpCents:invoice.originalTrueUpCents,
        replayEarnedCents:invoice.replayEarnedCents,replayTrueUpCents:invoice.replayTrueUpCents}:{}),href:`/portal/invoices/${invoice.id}`})),
  }))
  const quotaDate=today(business.timezone,clockInstant(env))
  const policies=await all(env,`SELECT DISTINCT f.product_id,f.feature FROM nc_features f JOIN nc_feature_policies p ON p.product_id=f.product_id AND p.feature=f.feature
    JOIN nc_prices price ON price.product_id=f.product_id JOIN nc_items item ON item.price_id=price.id
    WHERE item.subscription_id=? AND item.effective_from<=? AND (item.effective_to IS NULL OR item.effective_to>?) AND p.meter_id IS NOT NULL`,sub.id,quotaDate,quotaDate)
  const quotas = (await Promise.all(policies.map(async policy=>{
    const {quota}=await featureDecision(env,sub,policy.product_id,policy.feature,quotaDate,business.timezone)
    return quota ? {feature:policy.feature,meter:quota.meter,used:quota.used,limit:quota.limit,remaining:quota.remaining,period:quota.period} : null
  }))).filter((quota):quota is NonNullable<typeof quota>=>quota!==null)
  const calendar = await subscriptionCalendar(env, sub)
  if (!calendar.enabled) {
    const invoice = await scopedUpcoming(env, session, sub, business, month)
    return { ...invoice, billingMonth: invoice.period.start.slice(0, 7), commitments, quotaDate, quotas, invoices: [invoice] }
  }
  const selected = month ?? today(business.timezone, clockInstant(env)).slice(0, 7)
  const from = `${selected}-01`, windows = composeBillingWindows(dueBillingWindows(calendar.basis, from, addMonths(from, 1)))
  insist(windows.length, 'billing_window_not_due', 409)
  const invoices = await Promise.all(windows.map(window => scopedUpcoming(env, session, sub, business, selected, window)))
  return { ...invoices[0], billingMonth: selected, commitments, quotaDate, quotas, invoices }
}

// Only called after the session-owned subscription query above. The same engine
// may read its inputs, but only the existing customer projection leaves here.
async function scopedUpcoming(env: Bindings, session: CustomerSession, sub: Row,
  business: Awaited<ReturnType<typeof requireBusiness>>, month?: string | null, window?: BillingWindow) {
  const period = window?.period ?? (month ? periodStartingIn(sub.anchor_day, month) : periodContaining(sub.anchor_day, today(business.timezone, clockInstant(env))))
  insist(sub.start_date < period.end && (!sub.end_date || sub.end_date > period.start), 'subscription_not_in_period', 409)
  insist(!sub.cutover_start || period.end > sub.cutover_start, 'previous_biller_period', 409)
  const issued = await one(env, `SELECT id,calculation_json,source_fingerprint,calc_version,subtotal_cents,tax_cents,total_cents
    FROM nc_invoices WHERE subscription_id=? AND customer_id=? AND invoice_kind='recurring'
    AND period_start=? AND billing_key=? AND status='issued'`, sub.id, session.customer, period.start, window?.key ?? 'legacy-monthly-arrears')
  let input: RatingInput, lines: Row[], calculation: { fingerprint: string; version: string; subtotalCents: number; taxCents: number; totalCents: number }
  if (issued) {
    const saved = parseJson<Row>(issued.calculation_json, {})
    input = saved.inputs as RatingInput
    lines = (await all(env, 'SELECT * FROM nc_invoice_lines WHERE invoice_id=? ORDER BY seq', issued.id)).map(line => ({
      kind: line.kind, description: line.description, quantity: line.quantity, unitAmount: line.unit_amount,
      amountCents: line.amount_cents, taxable: !!line.taxable, priceId: line.price_id, meterId: line.meter_id,
      periodStart: line.period_start, periodEnd: line.period_end, evidence: parseJson<Row>(line.evidence_json, {}),
    }))
    calculation = { fingerprint: issued.source_fingerprint, version: issued.calc_version,
      subtotalCents: issued.subtotal_cents, taxCents: issued.tax_cents, totalCents: issued.total_cents }
  } else {
    const draft = await draftFor(env, business, sub, period, window)
    input = draft.input as RatingInput
    lines = draft.rating.lines
    calculation = { fingerprint: draft.fingerprint, version: input.version,
      subtotalCents: draft.rating.subtotalCents, taxCents: draft.rating.taxCents, totalCents: draft.rating.totalCents }
  }
  const meters: Row[] = []
  // Saved inputs retain every subscription price. Usage belongs only to the
  // components selected for this invoice, including when reading issued data.
  const selectedPrices = input.billing ? new Set(input.items.filter(item => input.billing!.components.some(component => component.itemId === item.id)).map(item => item.priceId)) : null
  const usagePrices = Object.values(input.prices).filter(price => !selectedPrices || selectedPrices.has(price.id))
  for (const id of [...new Set(usagePrices.flatMap(price => price.meterId ? [price.meterId] : []))]) {
    const service=upcomingMeterPeriod(input,id);if(!service)continue
    const from=zonedStart(service.start,business.timezone),to=zonedStart(service.end,business.timezone)
    const meter = await one(env, 'SELECT id,code,name,unit_label FROM nc_meters WHERE id=?', id)
    const metrics = usagePrices.filter(price => price.meterId === id && price.metric)
    if (metrics.length) {
      for (const price of metrics) {
        const own = lines.filter(line => line.priceId === price.id && line.kind === 'metric_usage')
        const current = own.filter(line => line.periodStart === service.start), late = own.filter(line => line.periodStart < service.start)
        const quantity = (values: Row[]) => displayQuantity(values.reduce<Rational>((sum, line) => {
          const exact = line.evidence.rawExactQuantity
          return addRational(sum, rational(BigInt(exact.numerator), BigInt(exact.denominator)))
        }, rational(0n)))
        const eventIds = [...new Set(current.flatMap(line => line.evidence.eventIds as string[]))]
        meters.push({ ...meter, periodStart:service.start,periodEnd:service.end, quantity: quantity(current), events: eventIds.length, eventIds,
          lateQuantity: quantity(late), lateEventIds: [...new Set(late.flatMap(line => line.evidence.eventIds as string[]))] })
      }
    } else {
      const current = input.events.filter(event => event.meterId === id && event.occurredAt >= from && event.occurredAt < to)
      const late = input.events.filter(event => event.meterId === id && event.occurredAt < from)
      const quantity = (events: typeof current) => decimalText(events.reduce((sum, event) => sum + micros(event.quantity, 'quantity'), 0n))
      meters.push({ ...meter, periodStart:service.start,periodEnd:service.end, quantity: quantity(current), events: current.length, eventIds: current.map(event => event.eventId),
        lateQuantity: quantity(late), lateEventIds: late.map(event => event.eventId) })
    }
  }
  const credits = await all(env, `SELECT a.id,a.value,a.effective_from,a.effective_to FROM nc_amendments a
    WHERE a.subscription_id=? AND a.status='approved' AND a.kind='fixed_credit'
    AND NOT EXISTS(SELECT 1 FROM nc_invoice_lines l JOIN nc_invoices i ON i.id=l.invoice_id
      WHERE i.subscription_id=a.subscription_id AND i.status='issued' AND l.kind='credit' AND json_extract(l.evidence_json,'$.amendment')=a.id)
    ORDER BY a.effective_from,a.id`, sub.id)
  return { subscription: sub.id, currency: session.currency, period, timezone: business.timezone, state: issued ? 'issued' : 'preview', invoiceId: issued?.id ?? null,
    billingDueDate: window?.dueDate ?? period.end, billingTerms: window?.mixed ? null : window?.terms ?? null,
    servicePeriods: window ? billingServiceWindows(window).map(part=>({period:part.period,terms:part.terms})) : [{period,terms:null}],
    meters, credits: credits.map(credit => ({ id: credit.id, amountCents: cents(credit.value), effective_from: credit.effective_from,
      effective_to: credit.effective_to, appliesThisPeriod: credit.effective_from >= period.start && credit.effective_from < period.end })),
    remainingContractCreditCents: credits.reduce((sum, credit) => sum + cents(credit.value), 0),
    calculation: { ...calculation, lines: lines.map(line => ({ kind: line.kind, description: line.description, quantity: line.quantity,
      unitAmount: line.unitAmount, amountCents: line.amountCents, taxable: line.taxable, priceId: line.priceId, meterId: line.meterId,
      periodStart: line.periodStart, periodEnd: line.periodEnd, eventIds: line.evidence?.eventIds ?? [] })) } }
}
