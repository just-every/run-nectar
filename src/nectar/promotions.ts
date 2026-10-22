// CAT-005: reusable coupons and promotion codes. A coupon is percentage or
// amount, once, for N months or forever, optionally restricted to products. A
// promotion code carries a redemption limit, an expiry date and a
// first-time-customer rule. Redemption (at subscription creation, the checkout
// door) materializes approved contract amendments scoped to the covered prices,
// so rating, revenue and erasure treat them exactly like contract discounts.
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, requireRead, type Actor } from './actor'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, commit, guard, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import { addMonthsClamped, today } from './dates'
import { canonicalDecimal, micros } from './decimal'
import type { Input } from './input'

const CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/

export async function createCoupon(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const name = input.text('name', { max: 80 })
  const kind = input.text('kind', { max: 10 })
  insist(kind === 'percent' || kind === 'amount', 'invalid_coupon_kind')
  const value = canonicalDecimal(input.text('value', { max: 24 }), 'coupon_value')
  insist(micros(value) > 0n && (kind === 'amount' ? micros(value) % 10_000n === 0n : micros(value) <= 100_000_000n), 'invalid_coupon_value')
  const duration = input.text('duration', { max: 10 })
  insist(['once', 'repeating', 'forever'].includes(duration), 'invalid_coupon_duration')
  const months = duration === 'repeating' ? input.integer('months', { min: 1, max: 36 })! : null
  const products = input.list('products', { keepEmpty: false })
  for (const product of products) insist(await one(env, 'SELECT 1 FROM nc_products WHERE id=?', product), 'product_not_found', 404)
  // An amount coupon is a run of one-time contract credits, which are not product-scoped and cannot run forever.
  insist(kind === 'percent' || (!products.length && duration !== 'forever'), 'amount_coupon_unsupported', 409)
  insist(!await one(env, 'SELECT 1 FROM nc_coupons WHERE name=?', name), 'coupon_name_in_use', 409)
  const id = newId()
  await commit(env, [stmt(env, "INSERT INTO nc_coupons(id,name,kind,value,duration,months,products_json,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,'active',?,?)", id, name, kind, value, duration, months, JSON.stringify([...new Set(products)].sort()), actorLabel(actor), now())],
    { actor: actorLabel(actor), action: 'coupon.create', subject: id, detail: { name, kind, value, duration, months, products } })
  return { id }
}

export async function createPromotionCode(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const code = input.text('code', { max: 40 })
  insist(CODE.test(code), 'invalid_promotion_code')
  const coupon = await one(env, "SELECT * FROM nc_coupons WHERE id=? AND status='active'", input.text('coupon', { max: 100 }))
  insist(coupon, 'coupon_not_found', 404)
  const max = input.integer('max_redemptions', { min: 1, max: 1_000_000, optional: true }) ?? null
  const expires = input.text('expires_on', { max: 10, optional: true }) || null
  insist(!expires || /^\d{4}-\d{2}-\d{2}$/.test(expires), 'invalid_expires_on')
  insist(!await one(env, 'SELECT 1 FROM nc_promotion_codes WHERE code=?', code), 'promotion_code_in_use', 409)
  const id = newId()
  await commit(env, [stmt(env, "INSERT INTO nc_promotion_codes(id,code,coupon_id,max_redemptions,expires_on,first_time_only,status,created_by,created_at) VALUES(?,?,?,?,?,?,'active',?,?)", id, code.toUpperCase(), coupon.id, max, expires, input.flag('first_time_only') ? 1 : 0, actorLabel(actor), now())],
    { actor: actorLabel(actor), action: 'promotion.create', subject: id, detail: { code: code.toUpperCase(), coupon: coupon.name, max, expires, firstTimeOnly: input.flag('first_time_only') } })
  return { id, code: code.toUpperCase() }
}

export async function promotionsView(env: Bindings, actor: Actor) {
  requireRead(actor, 'catalog')
  const coupons = (await all(env, 'SELECT * FROM nc_coupons ORDER BY created_at,id')).map((row): Row => ({ ...row, products: parseJson<string[]>(row.products_json, []), products_json: undefined }))
  const business = await requireBusiness(env), day = today(business.timezone, clockInstant(env))
  const codes = (await all(env, `SELECT c.*,(SELECT COUNT(*) FROM nc_promotion_redemptions r WHERE r.code_id=c.id) AS redemptions FROM nc_promotion_codes c ORDER BY c.created_at,c.id`))
    .map((row): Row => ({ ...row, expired: !!row.expires_on && row.expires_on < day, exhausted: row.max_redemptions !== null && row.redemptions >= row.max_redemptions }))
  return { coupons, codes }
}

/** The redemption statements for a subscription being created, after refusing an unusable code. */
export async function promotionRedemption(env: Bindings, actor: Actor, request: { text: string; customer: Row; subscription: string; start: string; trialEnd: string | null; items: Row[] }) {
  const code = await one(env, "SELECT c.*,k.name AS coupon_name,k.kind,k.value,k.duration,k.months,k.products_json,k.status AS coupon_status FROM nc_promotion_codes c JOIN nc_coupons k ON k.id=c.coupon_id WHERE c.code=?", request.text.trim())
  insist(code && code.status === 'active' && code.coupon_status === 'active', 'promotion_code_not_found', 404)
  const business = await requireBusiness(env), day = today(business.timezone, clockInstant(env))
  insist(!code.expires_on || code.expires_on >= day, 'promotion_expired', 409)
  const redeemed = (await one<{ n: number }>(env, 'SELECT COUNT(*) AS n FROM nc_promotion_redemptions WHERE code_id=?', code.id))!.n
  insist(code.max_redemptions === null || redeemed < code.max_redemptions, 'promotion_exhausted', 409)
  const paid = `EXISTS(SELECT 1 FROM nc_invoices i WHERE i.customer_id=? AND i.status='issued' AND i.total_cents>0 AND EXISTS(SELECT 1 FROM nc_allocations a WHERE a.invoice_id=i.id))`
  insist(!code.first_time_only || !await one(env, `SELECT 1 WHERE ${paid}`, request.customer.id), 'promotion_first_time_only', 409)
  const products = parseJson<string[]>(code.products_json, [])
  const covered = request.items.filter(item => ['flat', 'seat'].includes(item.price.kind) && (!products.length || products.includes(item.price.product_id)))
  insist(code.kind === 'amount' ? request.items.length : covered.length, 'promotion_not_applicable', 409)
  const base = request.trialEnd ?? request.start, label = `Promotion ${code.code}`
  const id = newId(), at = now(), by = `promotion:${code.code}`, ids: string[] = []
  const amendment = (kind: string, value: string, from: string, to: string | null, scope: string | null) => {
    const amendmentId = newId(); ids.push(amendmentId)
    return [stmt(env, "INSERT INTO nc_amendments(id,subscription_id,kind,value,price_id,effective_from,effective_to,note,clause,status,origin,created_by,created_at,decided_by,decided_at) VALUES(?,?,?,?,NULL,?,?,?,?,'approved','native',?,?,?,?)",
      amendmentId, request.subscription, kind, value, from, to, label, `Coupon ${code.coupon_name}, redemption ${id}`, by, at, by, at),
      ...(scope ? [stmt(env, 'INSERT INTO nc_amendment_scopes(amendment_id,customer_id,subscription_id,price_id) VALUES(?,?,?,?)', amendmentId, request.customer.id, request.subscription, scope)] : [])]
  }
  const statements: D1PreparedStatement[] = []
  if (code.kind === 'percent') {
    const to = code.duration === 'forever' ? null : addMonthsClamped(base, code.duration === 'once' ? 1 : code.months)
    if (products.length) for (const item of covered) statements.push(...amendment('discount_percent', code.value, base, to, item.price.id))
    else statements.push(...amendment('discount_percent', code.value, base, to, null))
  } else for (let month = 0; month < (code.duration === 'once' ? 1 : code.months); month++) statements.push(...amendment('fixed_credit', code.value, addMonthsClamped(base, month), null, null))
  return { id, code, statements: [
    guard(env, 'promotion_exhausted', 'COALESCE((SELECT max_redemptions FROM nc_promotion_codes WHERE id=?),1000000000)>(SELECT COUNT(*) FROM nc_promotion_redemptions WHERE code_id=?)', code.id, code.id),
    ...(code.first_time_only ? [guard(env, 'promotion_first_time_only', `NOT ${paid}`, request.customer.id)] : []),
    ...statements,
    stmt(env, 'INSERT INTO nc_promotion_redemptions(id,code_id,coupon_id,customer_id,subscription_id,redeemed_by,redeemed_at,amendments_json) VALUES(?,?,?,?,?,?,?,?)', id, code.id, code.coupon_id, request.customer.id, request.subscription, actorLabel(actor), at, JSON.stringify(ids)),
  ], detail: { code: code.code, coupon: code.coupon_name, redemption: id, amendments: ids.length } }
}
