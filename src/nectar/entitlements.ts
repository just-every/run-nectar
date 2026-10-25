// ENT-002: feature decisions use current recorded usage and unpaid balances.
import type { Bindings } from '../auth.server'
import { canRead, requireRead, type Actor } from './actor'
import { requireBusiness } from './business'
import { all, insist, one, type Row } from './core'
import { isDate, today } from './dates'
import { clockInstant } from './clock'
import { entitlementState } from './entitlement-state'
import { featureDecision } from './feature-policy'

/** Why a customer does or does not have a feature on a date: every subscription's path, step by step. */
export async function explainEntitlement(env: Bindings, actor: Actor, customerId: string, feature: string, date?: string) {
  requireRead(actor, 'customers')
  const business = await requireBusiness(env)
  const day = date && isDate(date) ? date : today(business.timezone, clockInstant(env))
  const customer = await one(env, 'SELECT id, name, external_id, status FROM nc_customers WHERE id = ? OR external_id = ?', customerId, customerId)
  insist(customer, 'customer_not_found', 404)
  const subs = await all(env, 'SELECT * FROM nc_subscriptions WHERE customer_id = ? ORDER BY created_at', customer.id)
  const paths = []
  for (const sub of subs) {
    const steps: string[] = []
    const decisions: Row[] = []
    let granted = false
    const state = await entitlementState(env, sub, day)
    const visibleState = !canRead(actor, 'payments') || !canRead(actor, 'invoices') ? { lifecycle: state.lifecycle, suspended: state.suspended }
      : actor.kind === 'member' && actor.role === 'owner' ? state
      : { ...state, payment: { status: state.payment.status } }
    if (sub.start_date > day) steps.push(`Subscription starts ${sub.start_date}, after ${day}.`)
    else if (sub.end_date && sub.end_date <= day) steps.push(`Subscription ended ${sub.end_date}.`)
    else if (state.suspended) steps.push('Subscription access is suspended by its recorded lifecycle policy.')
    else {
      steps.push(sub.trial_end && sub.trial_end > day ? `Subscription is in its trial until ${sub.trial_end}; trials carry the plan's features.` : 'Subscription is active.')
      const items = await all(env, `SELECT i.quantity, p.id AS price_id, p.version, pr.id AS product_id, pr.name AS product_name, f.feature FROM nc_items i JOIN nc_prices p ON p.id = i.price_id JOIN nc_products pr ON pr.id = p.product_id
        LEFT JOIN nc_features f ON f.product_id = pr.id AND f.feature = ? WHERE i.subscription_id = ? AND i.effective_from <= ? AND (i.effective_to IS NULL OR i.effective_to > ?)`, feature, sub.id, day, day)
      if (!items.length) steps.push('No plan item is in effect on this date.')
      for (const item of items as Row[]) {
        if (item.feature && !decisions.some(d => d.product === item.product_id)) { const decision = await featureDecision(env, sub, item.product_id, feature, day, business.timezone); decisions.push({ ...decision, product: item.product_id }); granted ||= decision.allowed; steps.push(...decision.steps); steps.push(`${item.product_name} (price v${item.version}, ${item.price_id}) grants "${feature}".`) }
        else if (!item.feature) steps.push(`${item.product_name} (price v${item.version}, ${item.price_id}) does not grant "${feature}".`)
      }
    }
    paths.push({ subscription: sub.id, state: visibleState, granted, steps, decisions, ...(decisions.length === 1 ? { numericLimit: granted ? decisions[0].numericLimit : null, quota: decisions[0].quota, payment: decisions[0].payment, warning: decisions[0].warning } : {}) })
  }
  if (!subs.length) paths.push({ subscription: null, granted: false, steps: ['The customer has no subscriptions.'] })
  return { customer: { id: customer.id, name: customer.name, externalId: customer.external_id }, feature, date: day, allowed: paths.some(path => path.granted), paths }
}

/** Every feature the customer holds today, each with its explanation. */
export async function entitlements(env: Bindings, actor: Actor, customerId: string) {
  requireRead(actor, 'customers')
  const features = await all(env, 'SELECT DISTINCT f.feature FROM nc_features f JOIN nc_prices p ON p.product_id = f.product_id JOIN nc_items i ON i.price_id = p.id JOIN nc_subscriptions s ON s.id = i.subscription_id WHERE s.customer_id = (SELECT id FROM nc_customers WHERE id=? OR external_id=?) ORDER BY f.feature', customerId, customerId)
  return await Promise.all(features.map(row => explainEntitlement(env, actor, customerId, row.feature)))
}

