// One-time charge records are immutable. Only invoice issue consumes them.
import type { Bindings } from '../auth.server'
import { actorLabel, requireCapability, type Actor } from './actor'
import { requirePrice } from './catalog'
import { all, commit, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import { canonicalDecimal, cents, lineCents, micros, plainMoney } from './decimal'
import { requireDate } from './dates'
import type { Input } from './input'
import { rateQuantityPrice, storedQuantityPrice } from './price-model'
import type { ChargeIn } from './charge-lines'
import { assertSameCurrency, billingCurrency, customerCurrencyGuard } from './currency'
import { assuranceCharge } from './assurance'

export const chargeInput = (r: Row): ChargeIn => ({ id: r.id, description: r.description, quantity: r.quantity, unitAmount: r.unit_amount, amountCents: r.amount_cents, taxable: !!r.taxable, priceId: r.price_id, date: r.effective_date, evidence: parseJson(r.pricing_evidence_json, {}) })

export async function pendingCharges(env: Bindings, subscription: string, before: string) {
  return (await all(env, 'SELECT * FROM nc_charges WHERE subscription_id=? AND invoice_id IS NULL AND effective_date<? ORDER BY effective_date,id', subscription, before)).map(chargeInput)
}

export async function addCharge(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'records')
  const customer = await one(env, "SELECT * FROM nc_customers WHERE id=? AND status='active'", input.text('customer', { max: 100 }))
  insist(customer, 'customer_not_found', 404)
  const currency = billingCurrency(input.text('currency', { max: 3, optional: true }), billingCurrency(customer.currency))
  assertSameCurrency(currency, customer.currency)
  const subscription = input.text('subscription', { max: 100, optional: true }) || null
  const date = requireDate(input.text('effective_date', { max: 10 }), 'effective_date')
  if (subscription) {
    const sub = await one(env, 'SELECT * FROM nc_subscriptions WHERE id=? AND customer_id=?', subscription, customer.id)
    insist(sub && sub.billing_mode === 'live', 'subscription_not_live', 409)
    insist(date >= (sub.cutover_start || sub.start_date) && (!sub.end_date || date < sub.end_date), 'invalid_effective_date')
  }
  const priceId = input.text('price', { max: 100, optional: true }) || null
  insist(!(priceId && input.has('amount')), 'choose_price_or_custom_amount')
  let description = input.text('description', { max: 300, optional: true }), quantity = '1.00', unit = '', amount: number, taxable: boolean, evidence: Row
  if (priceId) {
    const price = await requirePrice(env, priceId)
    assertSameCurrency(currency, price.currency)
    insist(price.status === 'active', 'price_retired', 409)
    quantity = canonicalDecimal(input.text('quantity', { max: 24, optional: true }) || '1', 'quantity')
    const model = price.pricing_model === 'simple' ? null : rateQuantityPrice(storedQuantityPrice(price as any)!, micros(quantity))
    amount = model?.amountCents ?? Number(lineCents(micros(price.unit_amount), micros(quantity)))
    unit = model ? '' : price.unit_amount
    description ||= `${price.product_name}${price.nickname ? ` — ${price.nickname}` : ''} (v${price.version})`
    taxable = !!price.taxable; evidence = { price: priceId, version: price.version, ...(model?.evidence ?? { unit, quantity }) }
  } else {
    amount = cents(input.text('amount', { max: 20 }))
    insist(description, 'missing_description')
    unit = plainMoney(amount); taxable = input.flag('taxable'); evidence = { customAmountCents: amount, preparedBy: actorLabel(actor), approval: 'requires invoice approval before issue' }
  }
  insist(Number.isSafeInteger(amount) && amount > 0 && amount <= 100_000_000_000, 'invalid_amount')
  const linked = await assuranceCharge(env, actor, input, customer.id, subscription, amount)
  if (linked) { insist(!priceId, 'assurance_fix_custom_amount_only'); Object.assign(evidence, linked.evidence) }
  const id = newId()
  await commit(env, [customerCurrencyGuard(env, customer.id, currency),...(linked?.guards ?? []),stmt(env, 'INSERT INTO nc_charges (id,customer_id,subscription_id,price_id,description,quantity,unit_amount,amount_cents,currency,taxable,effective_date,pricing_evidence_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, customer.id, subscription, priceId, description, quantity, unit, amount, currency, taxable ? 1 : 0, date, JSON.stringify(evidence), actorLabel(actor), now())],
    { actor: actorLabel(actor), action: 'charge.add', subject: id, detail: { customer: customer.id, subscription, price: priceId, amount, currency, date } })
  return { id: customer.id, charge: id }
}
