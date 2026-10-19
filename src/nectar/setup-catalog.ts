import { serviceEndSql } from './renewal-sql'
import type { Bindings } from '../auth.server'
import { all, insist, newId, one, parseJson, type Row } from './core'
import { canonicalDecimal, micros } from './decimal'
import { Input } from './input'
import { readQuantityPrice, storedQuantityPrice } from './price-model'
import { fields, flag, object, quoted, rows } from './setup-source'

/** Pure preparation: catalog identities and immutable versions are not written. */
export async function setupCatalog(env: Bindings, payload: Row, source: Row, prior: Row, basis: Row, quotes: Row[]) {
  const products: Row[] = [], prices: Row[] = [], meters: Row[] = []
  const entries = rows(payload.catalog, 'catalog', 120)
  insist(entries.length > 0, 'setup_catalog_required')
  for (const entry of entries) {
    fields(entry, ['key', 'existing', 'product', 'new_product', 'kind', 'unit_amount', 'meter', 'taxable', 'nickname', 'pricing_model', 'tiers', 'package_size', 'dimensions', 'quote'])
    quoted(source, entry, `catalog.${entry.key}`, quotes)
    const input = Input.of(entry), key = input.text('key', { max: 100 })
    insist(!prices.some(p => p.key === key), 'duplicate_catalog_key')
    insist([entry.existing, entry.product, entry.new_product].filter(Boolean).length === 1, 'choose_catalog_identity')
    let product: Row, price: Row
    if (entry.existing) {
      fields(entry, ['key', 'existing', 'quote'])
      const found = await one(env, 'SELECT * FROM nc_prices WHERE id=?', input.text('existing', { max: 100 }))
      insist(found && found.status === 'active', 'price_not_found', 404)
      product = (await one(env, 'SELECT * FROM nc_products WHERE id=?', found.product_id))!
      insist(product && product.status === 'active', 'product_archived', 409)
      basis.prices.push(found)
      price = { id: found.id, key, create: false, product: product.id, version: found.version, kind: found.kind, amount: found.unit_amount, meterId: found.meter_id, taxable: !!found.taxable, nickname: found.nickname, pricing: storedQuantityPrice(found as any) ?? null, dimensions: parseJson(found.dimensions_json, {}) }
    } else {
      if (entry.new_product) {
        const proposed = object(entry.new_product, 'new_product'); fields(proposed, ['code', 'name'])
        const p = Input.of(proposed), code = p.text('code', { max: 60 }).toLowerCase(), name = p.text('name', { max: 120 })
        insist(/^[a-z0-9][a-z0-9_.-]{0,59}$/.test(code), 'invalid_code')
        const priorProduct = products.find(p => p.code === code)
        insist(!priorProduct || priorProduct.create && priorProduct.name === name, 'duplicate_product_code')
        insist(!await one(env, 'SELECT 1 FROM nc_products WHERE code=?', code), 'code_in_use', 409)
        product = priorProduct ?? { id: prior.products?.find((p: Row) => p.code === code)?.id ?? newId(), code, name, create: true }
        basis.newProducts.push({ code, absent: true })
      } else {
        const found = await one(env, 'SELECT * FROM nc_products WHERE id=?', input.text('product', { max: 100 }))
        insist(found && found.status === 'active', 'product_not_found', 404)
        product = found
      }
      const kind = input.text('kind', { max: 10 })
      insist(['flat', 'seat', 'unit'].includes(kind), 'invalid_kind')
      const pricing = readQuantityPrice(input, kind) ?? null
      const amount = pricing ? '0.00' : canonicalDecimal(input.text('unit_amount', { max: 24 }), 'unit_amount')
      insist(micros(amount) <= 1000000n * 1000000n, 'invalid_unit_amount')
      const maxVersion = product.create ? 0 : (await one(env, 'SELECT COALESCE(MAX(version),0) AS v FROM nc_prices WHERE product_id=?', product.id))!.v
      if (!product.create && !basis.productVersions.some((p: Row) => p.product === product.id)) basis.productVersions.push({ product: product.id, version: maxVersion })
      let meterId: string | null = null, dimensions: Row = {}
      if (kind === 'unit') {
        const name = input.text('meter', { max: 100 })
        const meter = await one(env, 'SELECT * FROM nc_meters WHERE id=? OR code=?', name, name)
        insist(meter, 'meter_not_found', 404); meterId = meter.id
        if (meter.metric_plan_json) {
          const plan = parseJson<Row>(meter.metric_plan_json, {})
          dimensions = object(entry.dimensions, 'metric_dimensions')
          insist(Object.keys(dimensions).length === plan.groupBy.length && plan.groupBy.every((k: string) => Object.hasOwn(dimensions, k)), 'invalid_metric_dimensions')
          for (const v of Object.values(dimensions)) insist(v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isSafeInteger(v), 'invalid_metric_dimensions')
        } else insist(entry.dimensions === undefined, 'unexpected_dimensions')
      } else insist(entry.meter === undefined && entry.dimensions === undefined, 'unexpected_meter')
      price = { id: prior.prices?.find((p: Row) => p.key === key)?.id ?? newId(), key, create: true, product: product.id, version: maxVersion + prices.filter(p => p.create && p.product === product.id).length + 1, kind, amount, meterId, taxable: flag(entry, 'taxable', true), nickname: input.text('nickname', { max: 80, optional: true }), pricing, dimensions }
    }
    if (!products.some(p => p.id === product.id)) {
      products.push({ id: product.id, code: product.code, name: product.name, create: !!product.create })
      if (!product.create) basis.products.push(product)
    }
    if (price.meterId && !meters.some(m => m.id === price.meterId)) {
      const meter = await one(env, 'SELECT * FROM nc_meters WHERE id=?', price.meterId)
      insist(meter, 'meter_not_found', 404); meters.push(meter)
      if (meter.source_meter_id) {
        const sourceMeter = await one(env, 'SELECT * FROM nc_meters WHERE id=?', meter.source_meter_id)
        insist(sourceMeter, 'meter_not_found', 404)
        if (!basis.meters.some((m: Row) => m.id === sourceMeter.id)) basis.meters.push(sourceMeter)
      }
      if (!basis.meters.some((m: Row) => m.id === meter.id)) basis.meters.push(meter)
    }
    prices.push(price)
  }
  return { products, prices, meters }
}

export async function setupOwnership(env: Bindings, plan: Row, meters: Row[], basis: Row) {
  const known = [...plan.prices]
  for (const id of new Set<string>(plan.items.map((i: Row) => i.priceId))) if (!known.some(p => p.id === id)) {
    const p = (await one(env, 'SELECT * FROM nc_prices WHERE id=?', id))!
    insist(p, 'price_not_found', 404)
    known.push({ id: p.id, meterId: p.meter_id, dimensions: parseJson(p.dimensions_json, {}) })
    if (p.meter_id && !meters.some(m => m.id === p.meter_id)) { const m = await one(env, 'SELECT * FROM nc_meters WHERE id=?', p.meter_id); insist(m, 'meter_not_found', 404); meters.push(m) }
  }
  for (const [index, item] of plan.items.entries()) {
    const price = known.find((p: Row) => p.id === item.priceId)!
    for (const other of plan.items.slice(0, index)) {
      const p = known.find((p: Row) => p.id === other.priceId)!
      if (price.meterId && price.meterId === p.meterId && JSON.stringify(Object.entries(price.dimensions).sort()) === JSON.stringify(Object.entries(p.dimensions).sort())) insist(item.from >= (other.to ?? '9999-12-31') || other.from >= (item.to ?? '9999-12-31'), 'meter_already_billed', 409)
    }
    if (!price.meterId || plan.customer.create) continue
    const meter = meters.find(m => m.id === price.meterId)!, source = meter.source_meter_id ?? meter.id
    const clashes = await all(env, `SELECT s.id,s.revision,i.id AS item_id,i.effective_from,i.effective_to FROM nc_items i JOIN nc_prices p ON p.id=i.price_id LEFT JOIN nc_meters m ON m.id=p.meter_id JOIN nc_subscriptions s ON s.id=i.subscription_id WHERE s.customer_id=? AND s.id<>? AND COALESCE(m.source_meter_id,p.meter_id)=? AND MAX(s.start_date,i.effective_from,?)<MIN(${serviceEndSql()},COALESCE(i.effective_to,'9999-12-31'),?)`, plan.customer.id, plan.subscription.id, source, item.from, item.to ?? (plan.renewal?.auto_renew?null:plan.subscription.endDate) ?? '9999-12-31')
    insist(!clashes.length, 'meter_already_billed', 409)
    basis.ownership.push({ source, from: item.from, to: item.to, clashes })
  }
}
