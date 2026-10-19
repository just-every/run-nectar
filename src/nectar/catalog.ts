// Flow 3: products, immutable price versions (flat, per-seat, per-unit) and
// the simple meters per-unit prices rate. A new price is a new version; a
// version a subscription uses is never edited, only retired for new use.
import type { Bindings } from '../auth.server'
import { actorLabel, requireCapability, type Actor } from './actor'
import { all, commit, insist, newId, now, one, stmt } from './core'
import { metadataFilter,metadataPredicate } from './metadata-query'
import { withMetadata } from './metadata'
import type { Input } from './input'
import { priceRequests } from './price-versions'
import { metricRequests } from './meter-definitions'
import { storedQuantityPrice } from './price-model'

const CODE = /^[a-z0-9][a-z0-9_.-]{0,59}$/

export async function catalog(env: Bindings, actor: Actor,url?:URL) {
  requireCapability(actor, 'read')
  const filter=metadataPredicate('price','p.id',url?metadataFilter(url):null)
  const [products, prices, meters, features] = await Promise.all([
    all(env, 'SELECT * FROM nc_products ORDER BY status, name COLLATE NOCASE'),
    all(env, `SELECT p.*, m.code AS meter_code, m.unit_label FROM nc_prices p LEFT JOIN nc_meters m ON m.id = p.meter_id WHERE ${filter.sql} ORDER BY p.product_id, p.version DESC`,...filter.params),
    all(env, 'SELECT * FROM nc_meters ORDER BY code'),
    all(env, 'SELECT * FROM nc_features ORDER BY product_id, feature'),
  ])
  return { products, metricRequests:await metricRequests(env,actor), priceRequests: await priceRequests(env, actor), prices: await withMetadata(env,'price',prices.map(price => ({ ...price, ...(price.pricing_model === 'simple' ? {} : { pricing: storedQuantityPrice(price as any) }) }))), meters, features }
}

export async function requirePrice(env: Bindings, id: string) {
  const price = await one(env, 'SELECT p.*, pr.name AS product_name, pr.code AS product_code, m.code AS meter_code, m.unit_label,m.source_meter_id FROM nc_prices p JOIN nc_products pr ON pr.id = p.product_id LEFT JOIN nc_meters m ON m.id = p.meter_id WHERE p.id = ?', id)
  insist(price, 'price_not_found', 404)
  return price
}

export async function createProduct(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'records')
  const code = input.text('code', { max: 60 }).toLowerCase()
  insist(CODE.test(code), 'invalid_code')
  const name = input.text('name', { max: 120 })
  const description = input.text('description', { max: 500, optional: true })
  insist(!await one(env, 'SELECT 1 FROM nc_products WHERE code = ?', code), 'code_in_use', 409)
  const id = newId()
  await commit(env, [stmt(env, "INSERT INTO nc_products (id, code, name, description, origin, revision, created_at) VALUES (?, ?, ?, ?, 'native', ?, ?)", id, code, name, description, newId(), now())],
    { actor: actorLabel(actor), action: 'product.create', subject: id, detail: { code, name } })
  return { id, code }
}

export async function createMeter(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'records')
  const code = input.text('code', { max: 60 }).toLowerCase()
  insist(CODE.test(code), 'invalid_code')
  const name = input.text('name', { max: 120 })
  const unit = input.text('unit_label', { max: 40 })
  insist(!await one(env, 'SELECT 1 FROM nc_meters WHERE code = ?', code), 'code_in_use', 409)
  const id = newId()
  await commit(env, [stmt(env, "INSERT INTO nc_meters (id, code, name, unit_label, origin, revision, created_at) VALUES (?, ?, ?, ?, 'native', ?, ?)", id, code, name, unit, newId(), now())],
    { actor: actorLabel(actor), action: 'meter.create', subject: id, detail: { code, name, unit } })
  return { id, code }
}

export { createPrice } from './price-versions'

export async function retirePrice(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'records')
  const price = await requirePrice(env, input.text('price', { max: 100 }))
  insist(price.status === 'active', 'already_retired', 409)
  await commit(env, [stmt(env, "UPDATE nc_prices SET status = 'retired' WHERE id = ? AND status = 'active'", price.id)],
    { actor: actorLabel(actor), action: 'price.retire', subject: price.id, detail: { product: price.product_code, version: price.version } })
  return { id: price.id }
}

/** Grants a feature to everyone subscribed to the product. */
export async function grantFeature(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'records')
  const product = await one(env, 'SELECT * FROM nc_products WHERE id = ?', input.text('product', { max: 100 }))
  insist(product, 'product_not_found', 404)
  const feature = input.text('feature', { max: 60 }).toLowerCase()
  insist(CODE.test(feature), 'invalid_feature')
  const note = input.text('note', { max: 200, optional: true })
  insist(!await one(env, 'SELECT 1 FROM nc_features WHERE product_id = ? AND feature = ?', product.id, feature), 'feature_exists', 409)
  await commit(env, [stmt(env, 'INSERT INTO nc_features (product_id, feature, note, created_by, created_at) VALUES (?, ?, ?, ?, ?)', product.id, feature, note, actorLabel(actor), now())],
    { actor: actorLabel(actor), action: 'feature.grant', subject: product.id, detail: { feature } })
  return { id: product.id, feature }
}
