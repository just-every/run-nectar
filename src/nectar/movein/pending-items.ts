// A pending source item becomes an ordinary immutable charge. Its source
// identity survives replay; invoice issue owns the existing once-only claim.
import { insist } from '../core'
import { plainMoney } from '../decimal'
import { localDate, zonedStart } from '../dates'

export function pendingItemValue(item: any, options: {
  subscriptions: any[]; zone: string; customerTarget: (id: string) => string | null
  subscriptionTarget: (id: string) => string; mappedSubscriptions: Set<string>
}) {
  const refuse: (ok: unknown, reason: string) => asserts ok = (ok, reason) =>
    insist(ok, 'unsupported_pending_invoice_item', 400, { item: item.id, reason })
  const idOf = (value: any) => typeof value === 'string' ? value : value?.id
  const sub = options.subscriptions.find(sub => sub.id === idOf(item.subscription))
  refuse(sub && options.mappedSubscriptions.has(sub.id), 'an explicit supported subscription is required')
  const customerId = options.customerTarget(idOf(item.customer))
  refuse(customerId && idOf(sub.customer) === idOf(item.customer), 'customer must match the captured subscription')
  refuse(item.invoice === null && !item.deleted && !item.proration, 'only unbilled non-proration items can move')
  refuse(item.currency === 'usd' && Number.isSafeInteger(item.amount) && item.amount > 0 && item.amount <= 100_000_000_000,
    'one positive exact USD amount is required')
  const quantity = item.quantity ?? 1
  refuse(Number.isSafeInteger(quantity) && quantity > 0 && item.amount % quantity === 0, 'quantity must reconcile to whole cents')
  refuse(item.discountable === false && !item.discounts?.length && !item.discount_amounts?.length,
    'discountable pending items need separate source qualification')
  refuse(Array.isArray(item.tax_rates) && item.tax_rates.length === 0 && !item.tax_amounts?.length
    && !sub.automatic_tax?.enabled && !item.automatic_tax?.enabled && item.tax_behavior !== 'inclusive'
    && item.price?.tax_behavior !== 'inclusive', 'pending items must explicitly have no source tax rates')
  const boundary = sub.current_period_start
  refuse(Number.isSafeInteger(boundary) && boundary > 0, 'the captured current billing period is required')
  const date = localDate(boundary * 1000, options.zone)
  refuse(zonedStart(date, options.zone) === boundary * 1000, 'the billing boundary must be a business-local midnight')
  return {
    customerId, subscriptionId: options.subscriptionTarget(sub.id), description: 'Imported pending invoice item',
    quantity: String(quantity), unitAmount: plainMoney(item.amount / quantity), amountCents: item.amount,
    taxable: 0, effectiveDate: date,
    evidence: JSON.stringify({ provider: 'stripe', invoiceItem: item.id, amountCents: item.amount, quantity,
      periodStart: item.period?.start ?? null, periodEnd: item.period?.end ?? null, discountable: false }),
  }
}
