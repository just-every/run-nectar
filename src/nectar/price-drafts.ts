import { readBillingTerms } from './billing-calendar'
import { billingTermsStatements } from './billing-components'
import type { Bindings } from '../auth.server'
import { actorLabel, type Actor } from './actor'
import { guard, insist, newId, now, one, stmt, canonical, parseJson, type Row } from './core'
import { canonicalDecimal, micros } from './decimal'
import type { Input } from './input'
import { readQuantityPrice } from './price-model'
import { billingCurrency } from './currency'

export async function readPriceDraft(env: Bindings, input: Input) {
  const product = await one(env, 'SELECT * FROM nc_products WHERE id = ?', input.text('product', { max: 100 }))
  insist(product, 'product_not_found', 404)
  insist(product.status === 'active', 'product_archived', 409)
  const kind = input.text('kind', { max: 10 })
  insist(kind === 'flat' || kind === 'seat' || kind === 'unit', 'invalid_kind')
  const pricing = readQuantityPrice(input, kind)
  const amount = pricing ? '0.00' : canonicalDecimal(input.text('unit_amount', { max: 24 }), 'unit_amount')
  insist(micros(amount) <= 1_000_000n * 1_000_000n, 'invalid_unit_amount')
  let meterId: string | null = null,dimensions:Record<string,unknown>={}
  if (kind === 'unit') {
    const meter = await one(env, 'SELECT * FROM nc_meters WHERE id = ? OR code = ?', input.text('meter', { max: 100 }), input.text('meter', { max: 100 }))
    insist(meter, 'meter_not_found', 404)
    meterId = meter.id
    if(meter.metric_plan_json){const plan=parseJson<Row>(meter.metric_plan_json,{});dimensions=input.has('dimensions')?input.json('dimensions') as Record<string,unknown>:Object.fromEntries(input.list('dimension_property',{keepEmpty:true}).flatMap((key,i)=>key?[[key,input.list('dimension_value',{keepEmpty:true})[i]??'']]:[]));insist(dimensions&&typeof dimensions==='object'&&!Array.isArray(dimensions)&&Object.keys(dimensions).length===plan.groupBy.length&&plan.groupBy.every((key:string)=>Object.hasOwn(dimensions,key)),'invalid_metric_dimensions');for(const v of Object.values(dimensions))insist(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isSafeInteger(v),'invalid_metric_dimensions')}else insist(!input.has('dimensions'),'unexpected_dimensions')
  }
  const taxable = input.has('taxable') ? input.flag('taxable') : true
  const nickname = input.text('nickname', { max: 80, optional: true })
  const version = ((await one<{ v: number }>(env, 'SELECT COALESCE(MAX(version),0) AS v FROM nc_prices WHERE product_id=?', product.id))!.v) + 1
  return { currency: billingCurrency(input.text('currency', { max: 3, optional: true })), product: product.id, productCode: product.code, version, kind, amount, meterId, taxable, nickname, pricing: pricing ?? null,dimensions,billing:readBillingTerms(input,kind) }
}

export function priceStatements(env: Bindings, actor: Actor, draft: Row, id: string) {
  return [
    guard(env, 'price_request_stale', 'COALESCE((SELECT MAX(version) FROM nc_prices WHERE product_id=?),0)=?', draft.product, draft.version - 1),
    guard(env, 'product_archived', "EXISTS(SELECT 1 FROM nc_products WHERE id=? AND status='active')", draft.product),
    stmt(env, "INSERT INTO nc_prices (id,product_id,version,currency,kind,unit_amount,meter_id,taxable,nickname,origin,revision,created_by,created_at,pricing_model,tiers_json,package_size,dimensions_json) VALUES (?,?,?,?,?,?,?,?,?,'native',?,?,?,?,?,?,?)",
      id, draft.product, draft.version, billingCurrency(draft.currency), draft.kind, draft.amount, draft.meterId, draft.taxable ? 1 : 0, draft.nickname, newId(), actorLabel(actor), now(), draft.pricing?.model ?? 'simple', draft.pricing ? JSON.stringify(draft.pricing.tiers) : null, draft.pricing?.packageSize ?? null,canonical(draft.dimensions??{})),
    ...billingTermsStatements(env,id,draft.billing??{unit:'month',count:1,timing:'arrears'}),
  ]
}
