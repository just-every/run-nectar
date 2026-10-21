// Immutable Stripe history validation/normalization. No native financial effects.
import { canonicalJson } from '../../modules/import-kit/src/d1/index'
import { isDate, localDate } from '../dates'
import type { Row } from '../core'

export const HISTORY_FILES = ['payments', 'refunds', 'disputes', 'subscription_events'] as const
export type HistorySourceKind = 'payment' | 'refund' | 'dispute' | 'subscription_event'
export interface HistoryCapture {
  customers: Row[]
  invoices: Row[]
  subscriptions: Row[]
  subscriptionEvents: Row[]
  payments: Row[]
  prices: Row[]
  customerTarget: (sourceId: string) => string | null
  zone: string
}
export interface IncumbentHistoryValue {
  provider: string
  providerRef: string
  kind: 'payment' | 'refund' | 'dispute' | 'subscription-event'
  customerId: string
  occurredOn: string
  amountCents: number | null
  currency: string | null
  status: string
  invoiceRef: string | null
  subscriptionRef: string | null
  payloadJson: string
}
type CaptureResult<T> = { value: T; reason?: never } | { value?: never; reason: string }
class InvalidCapture extends Error {}
const check: (condition: unknown, reason: string) => asserts condition = (condition, reason) => { if (!condition) throw new InvalidCapture(reason) }
const capture = <T>(read: () => T): CaptureResult<T> => {
  try { return { value: read() } } catch (error) {
    if (error instanceof InvalidCapture) return { reason: error.message }
    throw error
  }
}
export const stripeReference = (value: unknown): string => typeof value === 'string' ? value : value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' ? value.id : ''
const cents = (value: unknown, name: string, signed = false): number => {
  check(Number.isSafeInteger(value) && (signed || (value as number) >= 0), `${name} must be integer cents${signed ? '' : ', at least zero'}`)
  return value as number
}
const currency = (value: unknown): string => { check(typeof value === 'string' && /^[a-z]{3}$/.test(value), 'currency must be a lowercase three-letter code'); return value }
export function stripeDate(value: unknown, zone: string): string {
  check(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 253402300799, 'created/date must be a valid Unix timestamp in seconds')
  const date = localDate(value * 1000, zone)
  check(isDate(date), 'date is outside the supported calendar')
  return date
}
const subscriptionReference = (invoice: Row) => stripeReference(invoice.subscription ?? invoice.parent?.subscription_details?.subscription)
const subscriptionStatuses = ['active','trialing','past_due','canceled','unpaid','incomplete','incomplete_expired','paused']

function customer(source: string, context: HistoryCapture): string {
  const captured = context.customers.find(row => row.id === source)
  const target = context.customerTarget(source)
  check(source && target && captured && !captured.deleted, 'history needs a captured, retained customer')
  return target
}
function references(customerRef: string, invoiceRef: string, subscriptionRef: string, context: HistoryCapture, expectedCurrency?: string) {
  let subscription = subscriptionRef
  if (invoiceRef) {
    const invoice = context.invoices.find(row => row.id === invoiceRef)
    check(invoice && ['open','paid','uncollectible','void'].includes(invoice.status) && stripeReference(invoice.customer) === customerRef, 'history invoice must be finalized and belong to the same captured customer')
    if (expectedCurrency) check(invoice.currency === expectedCurrency, 'history currency differs from its invoice')
    const linked = subscriptionReference(invoice)
    check(!subscription || !linked || subscription === linked, 'history subscription differs from its invoice')
    subscription ||= linked
  }
  if (subscription) {
    const source = context.subscriptions.find(row => row.id === subscription) ?? context.subscriptionEvents.map(event => event.data?.object).find(snapshot => snapshot?.object === 'subscription' && snapshot.id === subscription)
    check(source && stripeReference(source.customer) === customerRef, 'history subscription must belong to the same captured customer')
  }
  return { invoiceRef: invoiceRef || null, subscriptionRef: subscription || null }
}

function chargeDetails(charge: Row, context: HistoryCapture) {
  check(charge && charge.object === 'charge' && typeof charge.id === 'string' && charge.id.length > 0, 'payment needs a captured Stripe charge')
  check(['succeeded','pending','failed'].includes(charge.status), 'unsupported charge status')
  const amount = cents(charge.amount, 'payment amount'), code = currency(charge.currency)
  if (charge.amount_refunded !== undefined) check(cents(charge.amount_refunded, 'refunded amount') <= amount, 'refunded amount exceeds the charge')
  stripeDate(charge.created, context.zone)
  const customerRef = stripeReference(charge.customer)
  const customerId = customer(customerRef, context)
  const intent = stripeReference(charge.payment_intent)
  const matching = [...new Map(context.invoices.filter(invoice => stripeReference(invoice.charge) === charge.id || !!intent && stripeReference(invoice.payment_intent) === intent || !!intent && (invoice.payments?.data??[]).some((payment:Row)=>stripeReference(payment.payment?.payment_intent)===intent)).map(invoice => [invoice.id, invoice])).values()]
  check(matching.length <= 1, 'payment matches multiple invoices; capture an explicit invoice reference')
  const explicit = stripeReference(charge.invoice)
  check(!explicit || !matching.length || matching[0].id === explicit, 'payment invoice references disagree')
  return { customerId, customerRef, amount, currency: code, ...references(customerRef, explicit || matching[0]?.id || '', '', context, code) }
}

export function stripeHistoryValue(kind: HistorySourceKind, source: Row, context: HistoryCapture): CaptureResult<IncumbentHistoryValue> {
  return capture<IncumbentHistoryValue>(() => {
    const common = { provider: 'stripe', providerRef: source.id, occurredOn: stripeDate(source.created, context.zone), payloadJson: JSON.stringify(source) }
    if (kind === 'subscription_event') {
      const snapshot = source.data?.object
      check(source.object === 'event' && typeof source.type === 'string' && /^customer\.subscription\.[a-z_]+$/.test(source.type) && snapshot?.object === 'subscription', 'subscription history needs a customer.subscription event with its subscription snapshot')
      check(subscriptionStatuses.includes(snapshot.status), 'unsupported subscription snapshot status')
      const customerRef = stripeReference(snapshot.customer), customerId = customer(customerRef, context)
      check(typeof snapshot.id === 'string' && snapshot.id.length > 0, 'subscription event has no subscription id')
      const current = context.subscriptions.find(row => row.id === snapshot.id)
      check(!current || stripeReference(current.customer) === customerRef, 'subscription event differs from its captured subscription customer')
      const invoiceRef = stripeReference(snapshot.latest_invoice)
      // A historical event snapshot can outlive the current subscription list.
      // Its own complete subscription object is retained, never made billable.
      if (invoiceRef) references(customerRef, invoiceRef, '', context, snapshot.currency ? currency(snapshot.currency) : undefined)
      return { ...common, kind: 'subscription-event', customerId, status: snapshot.status, amountCents: null, currency: snapshot.currency ? currency(snapshot.currency) : null, invoiceRef: invoiceRef || null, subscriptionRef: snapshot.id }
    }
    if (kind === 'payment') {
      const details = chargeDetails(source, context)
      return { ...common, kind, customerId: details.customerId, status: source.status, amountCents: details.amount, currency: details.currency, invoiceRef: details.invoiceRef, subscriptionRef: details.subscriptionRef }
    }
    check(source.object === kind, `expected a Stripe ${kind} object`)
    const chargeRef = stripeReference(source.charge)
    const charge = context.payments.find(row => row.id === chargeRef) ?? (source.charge && typeof source.charge === 'object' ? source.charge : null)
    check(charge && chargeRef, `${kind} needs its captured charge in payments.json or expanded charge`)
    const details = chargeDetails(charge, context), amount = cents(source.amount, `${kind} amount`), code = currency(source.currency)
    check(source.created >= charge.created, `${kind} date precedes its charge`)
    check(code === details.currency && amount <= details.amount, `${kind} amount or currency differs from its charge`)
    if (source.customer) check(stripeReference(source.customer) === details.customerRef, `${kind} customer differs from its charge`)
    if (source.payment_intent && charge.payment_intent) check(stripeReference(source.payment_intent) === stripeReference(charge.payment_intent), `${kind} payment intent differs from its charge`)
    const statuses = kind === 'refund' ? ['pending','requires_action','succeeded','failed','canceled'] : ['warning_needs_response','warning_under_review','warning_closed','needs_response','under_review','won','lost','prevented']
    check(statuses.includes(source.status), `unsupported ${kind} status`)
    return { ...common, kind, customerId: details.customerId, status: source.status, amountCents: amount, currency: code, invoiceRef: details.invoiceRef, subscriptionRef: details.subscriptionRef }
  })
}

/** Additional evidence never changes the established shadow line amounts. */
export function stripeInvoiceEvidence(invoice: Row, prices: Row[], zone: string): CaptureResult<{ sourceJson: string; issueDate: string | null; dueDate: string | null; currency: string; lines: Row[]; taxCents: number; discountCents: number }> {
  return capture(() => {
    check(['open','paid','uncollectible','void'].includes(invoice.status), 'unsupported invoice status')
    const code = currency(invoice.currency)
    cents(invoice.total, 'invoice total', true)
    for (const field of ['amount_paid','amount_remaining']) cents(invoice[field], `invoice ${field}`)
    const taxes = invoice.total_tax_amounts ?? invoice.total_taxes
    check(taxes === undefined || Array.isArray(taxes), 'invoice tax amounts must be captured as an array')
    const taxTotal = (taxes ?? []).reduce((sum: number, item: Row) => sum + cents(item.amount, 'invoice tax amount', true), 0)
    check(Number.isSafeInteger(taxTotal), 'invoice tax exceeds supported cents')
    const taxCents = invoice.tax === undefined || invoice.tax === null ? taxTotal : cents(invoice.tax, 'invoice tax', true)
    check(taxes === undefined || taxTotal === taxCents, 'invoice tax total differs from its captured breakdown')
    check(invoice.total_discount_amounts === undefined || Array.isArray(invoice.total_discount_amounts), 'invoice discount amounts must be captured as an array')
    const discountCents = (invoice.total_discount_amounts ?? []).reduce((sum: number, item: Row) => sum + cents(item.amount, 'invoice discount'), 0)
    check(Number.isSafeInteger(discountCents), 'invoice discount exceeds supported cents')
    stripeDate(invoice.created, zone)
    const issueDate = invoice.status_transitions?.finalized_at === null || invoice.status_transitions?.finalized_at === undefined ? null : stripeDate(invoice.status_transitions.finalized_at, zone)
    const dueDate = invoice.due_date === null || invoice.due_date === undefined ? null : stripeDate(invoice.due_date, zone)
    check(!dueDate || !issueDate || dueDate >= issueDate, 'invoice due date precedes its issue date')
    check(invoice.lines && Array.isArray(invoice.lines.data) && invoice.lines.has_more !== true, 'invoice needs its complete captured lines')
    const seen = new Set<string>()
    const lines = invoice.lines.data.map((line: Row) => {
      check(line && typeof line.id === 'string' && line.id.length > 0 && !seen.has(line.id), 'invoice line ids must be present and unique')
      seen.add(line.id)
      const amount = cents(line.amount, 'line amount', true)
      const priceRef = stripeReference(line.price ?? line.pricing?.price_details?.price ?? line.plan)
      const expanded = line.price && typeof line.price === 'object' ? line.price : line.pricing?.price_details?.price && typeof line.pricing.price_details.price === 'object' ? line.pricing.price_details.price : null
      const price = expanded && ('recurring' in expanded || 'type' in expanded) ? expanded : prices.find(row => row.id === priceRef) ?? expanded ?? line.plan ?? null
      const recurring = price?.recurring ?? (line.plan?.interval ? line.plan : null)
      const interval = recurring?.interval ?? null
      if (interval) check(['day','week','month','year'].includes(interval) && Number.isSafeInteger(recurring.interval_count ?? 1) && (recurring.interval_count ?? 1) > 0, 'line has invalid recurring interval')
      const start = line.period?.start === undefined ? null : stripeDate(line.period.start, zone)
      const end = line.period?.end === undefined ? null : stripeDate(line.period.end, zone)
      check(!start || !end || end >= start, 'line period ends before it starts')
      check(line.discount_amounts === undefined || Array.isArray(line.discount_amounts), 'line discount amounts must be captured as an array')
      const discounts = line.discount_amounts === undefined ? null : line.discount_amounts.reduce((sum: number, item: Row) => sum + cents(item.amount, 'line discount'), 0)
      check(discounts === null || Number.isSafeInteger(discounts), 'line discount total exceeds supported cents')
      return {
        description: String(line.description ?? '').slice(0, 300), amount_cents: amount, quantity: line.quantity ?? null,
        price_ref: priceRef || null, period_start: start, period_end: end, proration: !!line.proration,
        source_id: line.id, subscription_ref: stripeReference(line.subscription ?? line.parent?.subscription_item_details?.subscription) || subscriptionReference(invoice) || null,
        amount_excluding_tax_cents: line.amount_excluding_tax === null || line.amount_excluding_tax === undefined ? null : cents(line.amount_excluding_tax, 'line amount excluding tax', true),
        discount_amount_cents: discounts,
        recurring: recurring ? true : price?.type === 'one_time' ? false : line.type === 'subscription' || line.parent?.type === 'subscription_item_details' ? true : null,
        interval: interval, interval_unit: interval, interval_count: interval ? recurring.interval_count ?? 1 : null, price_source: price,
      }
    })
    // Both source objects and byte-exact artifacts are kept. The normalized
    // projection does not invent missing tax/discount evidence.
    return { sourceJson: JSON.stringify(invoice), issueDate, dueDate, currency: code, lines, taxCents, discountCents }
  })
}

export function stripeCreditEvidence(source: Row, zone: string): CaptureResult<{ sourceJson: string; issueDate: string; dueDate: null; currency: string; taxCents: number }> {
  return capture(() => {
    const taxes = source.total_tax_amounts ?? source.total_taxes
    check(taxes === undefined || Array.isArray(taxes), 'credit tax amounts must be captured as an array')
    const taxCents = (taxes ?? []).reduce((sum: number, tax: Row) => sum + cents(tax.amount, 'credit tax amount'), 0)
    check(Number.isSafeInteger(taxCents) && taxCents <= cents(source.total, 'credit total'), 'credit tax exceeds its total')
    return { sourceJson: JSON.stringify(source), issueDate: stripeDate(source.created, zone), dueDate: null, currency: currency(source.currency), taxCents }
  })
}

/** Conflicting duplicates cannot influence relationship lookups before planning. */
export function duplicateStripeSource(rows: Row[]): string | null {
  const seen = new Map<string, string>()
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id.trim()) return 'source object has no id'
    const json = canonicalJson(row), previous = seen.get(row.id)
    if (previous !== undefined && previous !== json) return `conflicting duplicate source id ${row.id}`
    seen.set(row.id, json)
  }
  return null
}
