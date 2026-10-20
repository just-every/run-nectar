// Customer-scoped projections of the ordinary rating engine. Saved inputs,
// exceptions, reconciliation notes and operator read models never leave here.
import type { Bindings } from '../auth.server'
import { requireBusiness } from './business'
import { draftFor } from './billruns'
import { all, insist, one, parseJson, type Row } from './core'
import { isMonth, periodContaining, periodStartingIn, today, zonedStart } from './dates'
import { cents, decimalText, micros } from './decimal'
import { displayQuantity } from './metric-aggregate'
import { addRational, rational, type Rational } from './metric-plan'
import type { CustomerSession } from './portal-session'
import type { RatingInput } from './rating'

export async function portalUpcomingSubscriptions(env: Bindings, session: CustomerSession) {
  return await all(env, `SELECT s.id,s.start_date,s.end_date,s.anchor_day FROM nc_subscriptions s
    JOIN nc_customers c ON c.id=s.customer_id WHERE s.customer_id=? AND c.erased_at IS NULL
    AND s.billing_mode='live' ORDER BY s.start_date,s.id`, session.customer)
}

export async function portalUpcoming(env: Bindings, session: CustomerSession, subscriptionId: string, month?: string | null) {
  const sub = await one(env, `SELECT s.*,c.billing_email FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id
    WHERE s.id=? AND s.customer_id=? AND c.erased_at IS NULL AND s.billing_mode='live'`, subscriptionId, session.customer)
  insist(sub, 'not_found', 404)
  insist(month === undefined || month === null || isMonth(month), 'invalid_period')
  const business = await requireBusiness(env)
  const period = month ? periodStartingIn(sub.anchor_day, month) : periodContaining(sub.anchor_day, today(business.timezone))
  insist(sub.start_date < period.end && (!sub.end_date || sub.end_date > period.start), 'subscription_not_in_period', 409)
  insist(!sub.cutover_start || period.end > sub.cutover_start, 'previous_biller_period', 409)
  const issued = await one(env, `SELECT id,calculation_json,source_fingerprint,calc_version,subtotal_cents,tax_cents,total_cents
    FROM nc_invoices WHERE subscription_id=? AND customer_id=? AND invoice_kind='recurring'
    AND period_start=? AND status='issued'`, sub.id, session.customer, period.start)
  let input: RatingInput, lines: Row[], calculation: Row
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
    const draft = await draftFor(env, business, sub, period)
    input = draft.input as RatingInput
    lines = draft.rating.lines
    calculation = { fingerprint: draft.fingerprint, version: input.version,
      subtotalCents: draft.rating.subtotalCents, taxCents: draft.rating.taxCents, totalCents: draft.rating.totalCents }
  }
  const from = zonedStart(period.start, business.timezone), to = zonedStart(period.end, business.timezone)
  const meters: Row[] = []
  for (const id of [...new Set(Object.values(input.prices).flatMap(price => price.meterId ? [price.meterId] : []))]) {
    const meter = await one(env, 'SELECT id,code,name,unit_label FROM nc_meters WHERE id=?', id)
    const metrics = Object.values(input.prices).filter(price => price.meterId === id && price.metric)
    if (metrics.length) {
      for (const price of metrics) {
        const own = lines.filter(line => line.priceId === price.id && line.kind === 'metric_usage')
        const current = own.filter(line => line.periodStart === period.start), late = own.filter(line => line.periodStart < period.start)
        const quantity = (values: Row[]) => displayQuantity(values.reduce<Rational>((sum, line) => {
          const exact = line.evidence.rawExactQuantity
          return addRational(sum, rational(BigInt(exact.numerator), BigInt(exact.denominator)))
        }, rational(0n)))
        const eventIds = [...new Set(current.flatMap(line => line.evidence.eventIds as string[]))]
        meters.push({ ...meter, quantity: quantity(current), events: eventIds.length, eventIds,
          lateQuantity: quantity(late), lateEventIds: [...new Set(late.flatMap(line => line.evidence.eventIds as string[]))] })
      }
    } else {
      const current = input.events.filter(event => event.meterId === id && event.occurredAt >= from && event.occurredAt < to)
      const late = input.events.filter(event => event.meterId === id && event.occurredAt < from)
      const quantity = (events: typeof current) => decimalText(events.reduce((sum, event) => sum + micros(event.quantity, 'quantity'), 0n))
      meters.push({ ...meter, quantity: quantity(current), events: current.length, eventIds: current.map(event => event.eventId),
        lateQuantity: quantity(late), lateEventIds: late.map(event => event.eventId) })
    }
  }
  const credits = await all(env, `SELECT a.id,a.value,a.effective_from,a.effective_to FROM nc_amendments a
    WHERE a.subscription_id=? AND a.status='approved' AND a.kind='fixed_credit'
    AND NOT EXISTS(SELECT 1 FROM nc_invoice_lines l JOIN nc_invoices i ON i.id=l.invoice_id
      WHERE i.subscription_id=a.subscription_id AND i.status='issued' AND l.kind='credit' AND json_extract(l.evidence_json,'$.amendment')=a.id)
    ORDER BY a.effective_from,a.id`, sub.id)
  return { subscription: sub.id, period, timezone: business.timezone, state: issued ? 'issued' : 'preview', invoiceId: issued?.id ?? null,
    meters, credits: credits.map(credit => ({ id: credit.id, amountCents: cents(credit.value), effective_from: credit.effective_from,
      effective_to: credit.effective_to, appliesThisPeriod: credit.effective_from >= period.start && credit.effective_from < period.end })),
    remainingContractCreditCents: credits.reduce((sum, credit) => sum + cents(credit.value), 0),
    calculation: { ...calculation, lines: lines.map(line => ({ kind: line.kind, description: line.description, quantity: line.quantity,
      unitAmount: line.unitAmount, amountCents: line.amountCents, taxable: line.taxable, priceId: line.priceId, meterId: line.meterId,
      periodStart: line.periodStart, periodEnd: line.periodEnd, eventIds: line.evidence?.eventIds ?? [] })) } }
}
