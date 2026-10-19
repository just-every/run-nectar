import { pricingSimulationPlan } from './pricing-simulation-plan'
import type { Bindings } from '../auth.server'
import type { Business } from './business'
import { all, fingerprint, insist, one, parseJson, type Row } from './core'
import { canonicalDecimal } from './decimal'
import { isDate, periodContaining } from './dates'
import { pricesById, ratingInputs } from './inputs'
import { PRICE_MODEL_RATING_VERSION } from './price-model'
import { rate, RATING_VERSION, type PriceIn, type RatingInput } from './rating'
import { startsInIssuedPeriod } from './subscriptions'

const total = (input: RatingInput) => {
  const result = rate(input)
  insist(!result.exceptions.some(e=>e.code==='metric_duplicate_selection'),'meter_already_billed',409)
  return { subtotalCents: result.subtotalCents, totalCents: result.totalCents, lines: result.lines.map(line => ({ description: line.description, amountCents: line.amountCents })) }
}

/** Existing catalogue versions and legacy new simple prices share one saved migration plan. */
export async function priceChangePlan(env: Bindings, business: Business, payload: Row, saved = false) {
  if (payload.simulation === true) return await pricingSimulationPlan(env,business,payload)
  const selectedTarget = payload.target_price ? await one(env,'SELECT * FROM nc_prices WHERE id=?',String(payload.target_price)) : null
  insist(!payload.target_price || selectedTarget,'price_not_found',404)
  const product = await one(env, "SELECT * FROM nc_products WHERE id = ? AND status = 'active'", String(payload.product ?? selectedTarget?.product_id ?? ''))
  insist(product, 'product_not_found', 404)
  const reference = String(payload.effective_date ?? '')
  insist(isDate(reference), 'effective_date_required')
  const timing = payload.timing === undefined ? 'date' : payload.timing
  insist(timing === 'date' || timing === 'renewal', 'invalid_timing')
  const ids = Array.isArray(payload.subscriptions) ? payload.subscriptions.map(String) : []
  insist(ids.length > 0 && ids.length <= 200, 'subscriptions_required')
  insist(new Set(ids).size === ids.length, 'duplicate_subscriptions')
  // Only persisted proposal payloads may supply resolved dates. Creation always
  // resolves from the reference and anchor; approval never moves those dates.
  const savedDates = saved ? payload.resolved_dates : undefined
  if (savedDates !== undefined) {
    insist(savedDates && typeof savedDates === 'object' && !Array.isArray(savedDates), 'invalid_resolved_dates')
    insist(Object.keys(savedDates).length === ids.length && ids.every(id => Object.hasOwn(savedDates, id) && isDate(savedDates[id])), 'invalid_resolved_dates')
  }
  const version = ((await one<{ v: number }>(env, 'SELECT COALESCE(MAX(version), 0) AS v FROM nc_prices WHERE product_id = ?', product.id))!.v) + 1
  const targetId = String(payload.target_price ?? '')
  let virtual: PriceIn
  let nickname: string
  if (targetId) {
    const target = await one(env, 'SELECT * FROM nc_prices WHERE id = ?', targetId)
    insist(target, 'price_not_found', 404)
    insist(target.status === 'active', 'price_retired', 409)
    insist(target.product_id === product.id, 'price_product_mismatch')
    virtual = (await pricesById(env, [targetId]))[targetId]
    insist(virtual, 'price_not_found', 404)
    nickname = target.nickname
  } else {
    const kind = String(payload.kind ?? '')
    insist(kind === 'flat' || kind === 'seat' || kind === 'unit', 'invalid_kind')
    const amount = canonicalDecimal(String(payload.unit_amount ?? ''), 'unit_amount')
    const meter = kind === 'unit' ? await one(env, 'SELECT * FROM nc_meters WHERE id = ? OR code = ?', String(payload.meter ?? ''), String(payload.meter ?? '')) : null
    insist(kind !== 'unit' || meter, 'meter_not_found', 404)
    nickname = String(payload.nickname ?? '').slice(0, 80)
    const dimensions=payload.dimensions??{}
    if(meter?.metric_plan_json){const plan=parseJson<Row>(meter.metric_plan_json,{});insist(dimensions&&typeof dimensions==='object'&&!Array.isArray(dimensions)&&Object.keys(dimensions).length===plan.groupBy.length&&plan.groupBy.every((key:string)=>Object.hasOwn(dimensions,key)),'invalid_metric_dimensions')}
    virtual = { ...(meter?.metric_plan_json?{metric:{sourceId:meter.source_meter_id,plan:parseJson(meter.metric_plan_json,null as never),dimensions,version:meter.metric_version,code:meter.code}}:{}), id: 'proposed-price', kind, unitAmount: amount, meterId: meter?.id ?? null, taxable: payload.taxable !== false, label: `${product.name}${nickname ? ` — ${nickname}` : ''} (v${version})`, unitLabel: meter?.unit_label ?? '' }
  }
  const impact = [], resolvedDates: Record<string, string> = {}, basis: Record<string, unknown> = { productVersion: [product.id, version - 1], ratings: {} }
  for (const id of ids) {
    const sub = await one(env, 'SELECT s.*, c.name AS customer_name FROM nc_subscriptions s JOIN nc_customers c ON c.id = s.customer_id WHERE s.id = ?', id)
    insist(sub, 'subscription_not_found', 404)
    const renewalTerm=await one(env,"SELECT * FROM nc_renewal_terms WHERE subscription_id=? AND status='active'",id)
    let date: string
    if (savedDates !== undefined) date = savedDates[id]
    else {
      const period = periodContaining(sub.anchor_day, reference)
      date = timing === 'renewal' && renewalTerm ? renewalTerm.end_date : timing === 'renewal' && period.start !== reference ? period.end : reference
      if(renewalTerm&&timing==='renewal')insist(reference<=renewalTerm.end_date&&renewalTerm.auto_renew&&!renewalTerm.cancelled_at,'term_not_renewing',409)
    }
    resolvedDates[id] = date
    insist(!renewalTerm||date>=renewalTerm.end_date,'signed_term_grandfathered',409)
    insist(!sub.end_date || sub.end_date > date || renewalTerm?.auto_renew&& !renewalTerm.cancelled_at&&date===renewalTerm.end_date, 'subscription_ended', 409)
    const candidates = await all(env, 'SELECT i.*, p.kind AS source_kind, p.meter_id AS source_meter_id FROM nc_items i JOIN nc_prices p ON p.id=i.price_id WHERE i.subscription_id=? AND p.product_id=? AND i.effective_from<=? AND (i.effective_to IS NULL OR i.effective_to>?) ORDER BY i.effective_from,i.id',sub.id,product.id,date,date)
    insist(candidates.length,'subscription_not_on_product',409,{subscription:id})
    const eligible = targetId ? candidates.filter(item=>item.source_kind===virtual.kind && (item.source_meter_id ?? null)===virtual.meterId) : candidates.slice(-1)
    insist(eligible.length,'change_kind_or_meter_separately')
    const sourceItems = eligible.filter(item=>!targetId || item.price_id!==targetId).filter(item=>!payload.source_price || item.price_id===payload.source_price)
    insist(sourceItems.length,'nothing_changes')
    if (virtual.kind==='seat') for(const item of sourceItems) insist(item.quantity >= (virtual.pricing ? 0 : 1) && item.quantity <= (virtual.pricing ? 1_000_000_000 : 1_000_000),'invalid_quantity')
    const item = sourceItems[0]
    insist(!await startsInIssuedPeriod(env, sub.id, date), 'period_already_invoiced', 409, { subscription: id })
    const period = periodContaining(sub.anchor_day, date), next = periodContaining(sub.anchor_day, period.end)
    const periods = [], fingerprints = []
    for (const p of [period, next]) {
      const inputs = await ratingInputs(env, business, sub.id, p)
      if(renewalTerm&&date===renewalTerm.end_date){inputs.subscription.endDate=null;inputs.renewals=[...(inputs.renewals??[]),{id:`term-${renewalTerm.id}`,effectiveDate:date,upliftPercent:renewalTerm.uplift_percent}];inputs.version='nectar-rating-8'}
      fingerprints.push(await fingerprint(inputs))
      const moved = new Set(sourceItems.map(item=>item.id))
      const items = [...inputs.items.filter(row=>!moved.has(row.id) || row.from!==date).map(row=>moved.has(row.id) ? {...row,to:date} : row),
        ...sourceItems.map((item,index)=>({id:`proposed-item-${index}`,priceId:virtual.id,quantity:item.quantity,from:date,to:item.effective_to}))]
      const after = { ...inputs, items, prices: { ...inputs.prices, [virtual.id]: virtual }, version: virtual.pricing && inputs.version === RATING_VERSION ? PRICE_MODEL_RATING_VERSION : inputs.version }
      periods.push({ period: p, before: total(inputs), after: total(after) })
    }
    impact.push({ subscription: sub.id, subscriptionLabel: sub.external_id || sub.id, customer: sub.customer_name, item: item.id, sourceItems: sourceItems.map(i=>({id:i.id,quantity:i.quantity})), quantity: sourceItems.reduce((n,i)=>n+i.quantity,0), effective_date: date, periods })
    ;(basis.ratings as Record<string, string[]>)[sub.id] = fingerprints
    basis[sub.id] = sub.revision
  }
  return { normalized: { ...(virtual.metric?{dimensions:virtual.metric.dimensions}:{}),product: product.id, ...(targetId ? { target_price: targetId } : {}), ...(payload.source_price ? {source_price:String(payload.source_price)} : {}), kind: virtual.kind, unit_amount: virtual.unitAmount, meter: virtual.meterId, nickname, taxable: virtual.taxable, timing, effective_date: reference, subscriptions: ids, resolved_dates: resolvedDates }, impact, basis }
}
