import type { Bindings } from '../auth.server'
import { actorLabel, type Actor } from './actor'
import { guard, insist, newId, now, one, stmt, type Row } from './core'
import { canonicalDecimal, micros } from './decimal'
import type { Input } from './input'
import { readQuantityPrice } from './price-model'

export async function readPriceDraft(env: Bindings, input: Input) {
  const product = await one(env, 'SELECT * FROM nc_products WHERE id = ?', input.text('product', { max: 100 }))
  insist(product, 'product_not_found', 404)
  insist(product.status === 'active', 'product_archived', 409)
  const kind = input.text('kind', { max: 10 })
  insist(kind === 'flat' || kind === 'seat' || kind === 'unit', 'invalid_kind')
  const pricing = readQuantityPrice(input, kind)
  const amount = pricing ? '0.00' : canonicalDecimal(input.text('unit_amount', { max: 24 }), 'unit_amount')
  insist(micros(amount) <= 1_000_000n * 1_000_000n, 'invalid_unit_amount')
  let meterId: string | null = null
  if (kind === 'unit') {
    const meter = await one(env, 'SELECT id FROM nc_meters WHERE id = ? OR code = ?', input.text('meter', { max: 100 }), input.text('meter', { max: 100 }))
    insist(meter, 'meter_not_found', 404)
    meterId = meter.id
  }
  const taxable = input.has('taxable') ? input.flag('taxable') : true
  const nickname = input.text('nickname', { max: 80, optional: true })
  const version = ((await one<{ v: number }>(env, 'SELECT COALESCE(MAX(version),0) AS v FROM nc_prices WHERE product_id=?', product.id))!.v) + 1
  return { product: product.id, productCode: product.code, version, kind, amount, meterId, taxable, nickname, pricing: pricing ?? null }
}

export function priceStatements(env: Bindings, actor: Actor, draft: Row, id: string) {
  return [
    guard(env, 'price_request_stale', 'COALESCE((SELECT MAX(version) FROM nc_prices WHERE product_id=?),0)=?', draft.product, draft.version - 1),
    guard(env, 'product_archived', "EXISTS(SELECT 1 FROM nc_products WHERE id=? AND status='active')", draft.product),
    stmt(env, "INSERT INTO nc_prices (id,product_id,version,kind,unit_amount,meter_id,taxable,nickname,origin,revision,created_by,created_at,pricing_model,tiers_json,package_size) VALUES (?,?,?,?,?,?,?,?,'native',?,?,?,?,?,?)",
      id, draft.product, draft.version, draft.kind, draft.amount, draft.meterId, draft.taxable ? 1 : 0, draft.nickname, newId(), actorLabel(actor), now(), draft.pricing?.model ?? 'simple', draft.pricing ? JSON.stringify(draft.pricing.tiers) : null, draft.pricing?.packageSize ?? null),
  ]
}
