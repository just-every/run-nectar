// ENT-002: an access threshold is independent of the catalog's billing price.
import type { Bindings } from '../auth.server'
import { actorLabel, requireOwner, type Actor } from './actor'
import { all, commit, insist, now, one, parseJson, stmt, type Row } from './core'
import { canonicalDecimal, micros, SCALE } from './decimal'
import { addDays, periodContaining, zonedStart } from './dates'
import type { Input } from './input'
import { aggregateMetric, displayQuantity } from './metric-aggregate'
import { metricEvents } from './meter-definitions'
import { addRational, compareRational, rational, type MetricPlan } from './metric-plan'
import { preparePolicyChange } from './policy-changes'
import { BALANCE_SQL } from './receivables'

export async function configureFeaturePolicy(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  const product = input.text('product', { max: 100 }), feature = input.text('feature', { max: 60 })
  const grant = await one(env, 'SELECT p.name FROM nc_features f JOIN nc_products p ON p.id=f.product_id WHERE f.product_id=? AND f.feature=?', product, feature)
  insist(grant, 'feature_not_found', 404)
  const meterRef = input.text('meter', { max: 100, optional: true })
  const meter = meterRef ? await one(env, 'SELECT * FROM nc_meters WHERE id=? OR code=?', meterRef, meterRef) : null
  insist(!meterRef || meter, 'meter_not_found', 404)
  const quota = meter ? canonicalDecimal(input.text('quota', { max: 30 }), 'quota') : null
  insist(!quota || micros(quota) > 0n, 'invalid_quota')
  const policy = input.text('quota_policy', { max: 20 })
  insist(['soft','hard','overage'].includes(policy), 'invalid_quota_policy')
  const grace = input.integer('grace_days', { min: 0, max: 365, optional: true })
  return await preparePolicyChange(env, actor, 'feature', { product, productName: grant.name, feature, meter: meter?.id ?? null, meterName: meter?.name ?? null, quota, policy, graceDays: grace })
}

export async function featureDecision(env: Bindings, sub: Row, product: string, feature: string, day: string, timezone: string) {
  const policy = await one(env, 'SELECT * FROM nc_feature_policies WHERE product_id=? AND feature=?', product, feature)
  const steps: string[] = [], invoices: Row[] = []
  let quota: Row | null = null, denied = false, warning = false
  if (policy?.meter_id) {
    const meter = await one(env, 'SELECT * FROM nc_meters WHERE id=?', policy.meter_id)
    insist(meter, 'meter_not_found', 404)
    const period = periodContaining(sub.anchor_day, day)
    const from = zonedStart(period.start, timezone), to = zonedStart(period.end, timezone)
    const events = await metricEvents(env, sub.customer_id, meter.source_meter_id ?? meter.id, to)
    let used = rational(0n)
    if (meter.source_meter_id) {
      for (const group of aggregateMetric(parseJson<MetricPlan>(meter.metric_plan_json, null as never), events, { from, to }))
        used = addRational(used, rational(BigInt(group.exact.numerator), BigInt(group.exact.denominator)))
    } else {
      for (const event of events) if (event.occurredAt >= from) used = addRational(used, rational(micros(event.quantity), SCALE))
    }
    const limit = rational(micros(policy.quota), SCALE), exhausted = compareRational(used, limit) >= 0
    const remaining = exhausted ? rational(0n) : addRational(limit, rational(-used.n, used.d))
    denied = exhausted && policy.quota_policy === 'hard'
    warning = exhausted && policy.quota_policy === 'soft'
    quota = { meter: meter.id, used: displayQuantity(used), limit: policy.quota, remaining: displayQuantity(remaining),
      policy: policy.quota_policy, exhausted, period, eventIds: events.filter(e => e.occurredAt >= from).map(e => e.eventId) }
    steps.push(`Usage ${quota.used} / ${quota.limit} ${meter.unit_label} in ${period.start}–${period.end}: ${exhausted ? policy.quota_policy === 'hard' ? 'quota exhausted; denied' : policy.quota_policy === 'soft' ? 'quota exhausted; warning' : 'overage allowed; catalog prices still apply' : 'below quota'}.`)
  }
  if (policy?.grace_days !== null && policy?.grace_days !== undefined) {
    for (const invoice of await all(env, `SELECT i.id,i.number,i.due_date,${BALANCE_SQL} AS balance_cents FROM nc_invoices i
      WHERE i.subscription_id=? AND i.status='issued' AND ${BALANCE_SQL}>0`, sub.id)) {
      if (day >= addDays(invoice.due_date, policy.grace_days)) invoices.push({ id: invoice.id, number: invoice.number, dueDate: invoice.due_date, balanceCents: invoice.balance_cents })
    }
    if (invoices.length) steps.push(`Unpaid after ${policy.grace_days} calendar days from the due date: ${invoices.map(i => i.number).join(', ')}; access restricted until settled.`)
  }
  return { allowed: !denied && invoices.length === 0, warning, quota,
    payment: { restricted: invoices.length > 0, graceDays: policy?.grace_days ?? null, invoices }, steps }
}
