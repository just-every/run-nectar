import type { Bindings } from '../auth.server'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { approvedPortalTermsSQL } from './contract-terms'
import { all, commit, fingerprint, guard, insist, NectarError, newId, one, stmt, type Row } from './core'
import { today } from './dates'
import { micros } from './decimal'
import type { Input } from './input'
import { portalChangePolicy } from './portal-change-policy'
import type { CustomerSession } from './portal-session'

// The same complete source image is read for the page and compared inside the
// request transaction. It includes approved terms and every scheduled item.
const SOURCE = `SELECT json_object('revision',s.revision,'customerRevision',c.revision,'mode',s.billing_mode,
  'start',s.start_date,'end',s.end_date,'contractEnd',s.contract_end_date,
  'items',json((SELECT json_group_array(json_object('id',id,'price',price_id,'quantity',quantity,'from',effective_from,'to',effective_to)) FROM (SELECT * FROM nc_items WHERE subscription_id=s.id ORDER BY id))),
  'contracts',json(${approvedPortalTermsSQL}),
  'amendments',json((SELECT json_group_array(json_object('id',id,'kind',kind,'value',value,'price',price_id,'from',effective_from,'to',effective_to)) FROM (SELECT * FROM nc_amendments WHERE subscription_id=s.id AND status='approved' ORDER BY id))),
  'lifecycle',json((SELECT json_group_array(json_object('id',id,'kind',kind,'date',effective_date,'until',until_date,'access',access)) FROM (SELECT * FROM nc_subscription_lifecycle WHERE subscription_id=s.id ORDER BY id))),
  'renewals',json((SELECT json_group_array(json_object('id',id,'status',status,'start',start_date,'end',end_date,'auto',auto_renew,'revision',revision)) FROM (SELECT * FROM nc_renewal_terms WHERE subscription_id=s.id ORDER BY id)))) AS source
  FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id WHERE s.id=? AND s.customer_id=? AND s.billing_mode='live' AND c.erased_at IS NULL`

const pricesSQL = `SELECT p.id,p.product_id,p.kind,p.unit_amount,p.currency,p.nickname,pr.name AS product_name FROM nc_prices p JOIN nc_products pr ON pr.id=p.product_id LEFT JOIN nc_price_intervals b ON b.price_id=p.id
  WHERE p.status='active' AND p.kind IN ('flat','seat') AND p.pricing_model='simple'
  AND COALESCE(b.interval_unit,'month')='month' AND COALESCE(b.interval_count,1)=1 AND COALESCE(b.billing_timing,'arrears')='arrears' ORDER BY p.id`

async function changeBasis(env: Bindings, session: CustomerSession, subscription: string) {
  const row = await one(env, SOURCE, subscription, session.customer)
  insist(row, 'not_found', 404)
  const source = JSON.parse(row.source), business = await requireBusiness(env), day = today(business.timezone, clockInstant(env))
  insist(source.start <= day && (!source.end || source.end > day), 'subscription_not_active', 409)
  const active = source.items.filter((i: Row) => i.from <= day && (!i.to || i.to > day))
  insist(active.length === 1, 'portal_change_requires_review', 409)
  const prices = await all(env, pricesSQL), current = prices.find(p => p.id === active[0].price)
  insist(current, 'portal_change_requires_review', 409)
  const policy = await portalChangePolicy(env)
  const targets = prices.filter(p => policy.prices.includes(p.id) && p.product_id === current.product_id && p.kind === current.kind && p.currency === current.currency && micros(p.unit_amount) <= micros(current.unit_amount))
  const basis = await fingerprint({ source: row.source, day, current, targets, policy })
  return { subscription, source: row.source as string, sourceData: source, day, item: active[0], current, targets, policy, basis }
}

const projection = (row: Row) => ({ id: row.id, subscription: row.subscription_id, item: row.item_id, targetPrice: row.target_price_id, quantity: row.quantity, targetName: row.target_label, unitAmount: row.unit_amount, currency: row.currency, status: 'pending', requestedOn: row.requested_on, belowContractMinimum: !!row.below_minimum })

export async function portalChangeOptions(env: Bindings, session: CustomerSession, subscription: string) {
  const data = await changeBasis(env, session, subscription)
  return { subscription, item: data.item.id as string, quantity: data.item.quantity as number, current: data.current, targets: data.targets,
    policy: { revision: data.policy.revision, minimumSeats: data.policy.minimumSeats, pauseAllowed: data.policy.pauseAllowed }, basis: data.basis, day: data.day,
    requests: (await all(env, 'SELECT * FROM nc_portal_change_requests WHERE customer_id=? AND subscription_id=? ORDER BY requested_at,id', session.customer, subscription)).map(row => ({ ...projection(row), current: row.basis_hash === data.basis })) }
}

export async function portalChangeSubscriptions(env: Bindings, session: CustomerSession) {
  return await all(env, `SELECT s.id,EXISTS(SELECT 1 FROM nc_renewal_terms t WHERE t.subscription_id=s.id AND t.status='active') AS has_term,EXISTS(SELECT 1 FROM nc_retention_offers o WHERE o.subscription_id=s.id AND o.kind='winback' AND o.status='offered' AND o.token_hash IS NOT NULL) AS has_return FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id WHERE s.customer_id=? AND s.billing_mode='live' AND c.erased_at IS NULL ORDER BY s.created_at,s.id`, session.customer)
}

export async function portalChangeData(env: Bindings, session: CustomerSession, subscription?: string) {
  return subscription ? portalChangeOptions(env, session, subscription) : { subscriptions: await portalChangeSubscriptions(env, session), requests: (await all(env, 'SELECT * FROM nc_portal_change_requests WHERE customer_id=? ORDER BY requested_at,id', session.customer)).map(projection) }
}

export async function requestPortalChange(env: Bindings, request: Request, session: CustomerSession, input: Input) {
  insist(request.headers.get('origin') === session.origin, 'forbidden', 403)
  input.only(['subscription','item','target_price','quantity','basis','policy_revision','confirm'])
  insist(input.flag('confirm'), 'confirmation_required')
  const subscription = input.text('subscription', { max: 100 }), data = await changeBasis(env, session, subscription)
  insist(input.text('basis', { max: 64 }) === data.basis && input.integer('policy_revision') === data.policy.revision, 'portal_change_stale', 409)
  insist(input.text('item', { max: 100 }) === data.item.id, 'not_found', 404)
  const target = data.targets.find(p => p.id === input.text('target_price', { max: 100 }))
  insist(target, 'plan_not_allowed', 409)
  const quantity = input.integer('quantity', { min: 1, max: 1_000_000 })!
  insist(target.kind === 'seat' ? quantity >= data.policy.minimumSeats : quantity === 1, 'seat_minimum', 409)
  insist(micros(target.unit_amount) * BigInt(quantity) < micros(data.current.unit_amount) * BigInt(data.item.quantity), 'downgrade_required', 409)
  const contracts = data.sourceData.contracts.flatMap((c: Row) => JSON.parse(c.terms).commitments)
  const belowMinimum = contracts.some((w: Row) => {
    if (w.from > data.day || w.to <= data.day) return false
    const months = (Number(w.to.slice(0,4)) - Number(w.from.slice(0,4))) * 12 + Number(w.to.slice(5,7)) - Number(w.from.slice(5,7))
    return micros(target.unit_amount) * BigInt(quantity) * BigInt(months) < micros(w.minimum)
  })
  const key = await fingerprint({ customer: session.customer, subscription, item: data.item.id, target: target.id, quantity, basis: data.basis })
  const existing = () => one(env, 'SELECT * FROM nc_portal_change_requests WHERE request_key=? AND customer_id=?', key, session.customer)
  const saved = await existing()
  if (saved) return projection(saved)
  const id = newId(), at = clockInstant(env)
  try {
    await commit(env, [
      guard(env, 'invalid_customer_session', `EXISTS(SELECT 1 FROM nc_portal_sessions s JOIN nc_portal_policy p ON p.singleton=1 AND p.revision=s.policy_revision JOIN nc_customers c ON c.id=s.customer_id WHERE s.id=? AND s.customer_id=? AND s.revoked_at IS NULL AND s.issued_at<=? AND s.expires_at>? AND c.erased_at IS NULL)`, session.jti, session.customer, at, at),
      guard(env, 'portal_change_stale', `(${SOURCE})=?`, subscription, session.customer, data.source),
      guard(env, 'portal_change_stale', 'EXISTS(SELECT 1 FROM nc_portal_change_policy WHERE singleton=1 AND revision=?)', data.policy.revision),
      // Catalog changes also invalidate an already displayed request.
      guard(env, 'portal_change_stale', 'EXISTS(SELECT 1 FROM nc_prices WHERE id=? AND status=\'active\' AND unit_amount=?) AND EXISTS(SELECT 1 FROM nc_prices WHERE id=? AND status=\'active\' AND unit_amount=?)', data.current.id, data.current.unit_amount, target.id, target.unit_amount),
      stmt(env, `INSERT INTO nc_portal_change_requests(id,request_key,customer_id,subscription_id,item_id,target_price_id,quantity,target_label,unit_amount,currency,status,source_json,basis_hash,policy_revision,requested_at,requested_on,below_minimum) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?)`, id, key, session.customer, subscription, data.item.id, target.id, quantity, target.nickname || target.product_name, target.unit_amount, target.currency, data.source, data.basis, data.policy.revision, at, data.day, belowMinimum ? 1 : 0),
    ], { actor: `customer:portal:${session.customer}`, action: 'portal.change.request', subject: id, detail: { subscription, item: data.item.id, targetPrice: target.id, quantity, policyRevision: data.policy.revision, belowMinimum } })
  } catch (error) {
    if (!(error instanceof NectarError && error.code === 'already_exists') || !await existing()) throw error
  }
  return projection((await existing())!)
}
