// Transaction currencies are fixed facts; reporting conversion never relabels them.
import type { Bindings } from '../auth.server'
import { guard, insist, one } from './core'

export const BILLING_CURRENCIES = ['USD', 'CAD', 'EUR', 'GBP'] as const
export type BillingCurrency = typeof BILLING_CURRENCIES[number]
export function billingCurrency(value: unknown, fallback: BillingCurrency = 'USD'): BillingCurrency {
  const currency = value === undefined || value === null || value === '' ? fallback : String(value).toUpperCase()
  insist(BILLING_CURRENCIES.includes(currency as BillingCurrency), 'unsupported_currency')
  return currency as BillingCurrency
}
export function assertSameCurrency(left: unknown, right: unknown) {
  insist(billingCurrency(left) === billingCurrency(right), 'currency_mismatch', 409)
}
export function customerCurrencyGuard(env: Bindings, id: string, currency: unknown) {
  return guard(env, 'currency_mismatch', 'EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND currency=?)', id, billingCurrency(currency))
}
export function invoiceCurrencyGuard(env: Bindings, id: string, currency: unknown) {
  return guard(env, 'currency_mismatch', 'EXISTS(SELECT 1 FROM nc_invoices WHERE id=? AND currency=?)', id, billingCurrency(currency))
}
/** Use before a path whose amounts still assume USD. Do not silently convert it. */
export async function requireUsdCurrency(env: Bindings, scope: { customerId?: string; invoiceId?: string; subscriptionId?: string }) {
  const row = scope.invoiceId ? await one(env, 'SELECT currency FROM nc_invoices WHERE id=?', scope.invoiceId)
    : scope.subscriptionId ? await one(env, 'SELECT c.currency FROM nc_customers c JOIN nc_subscriptions s ON s.customer_id=c.id WHERE s.id=?', scope.subscriptionId)
    : await one(env, 'SELECT currency FROM nc_customers WHERE id=?', scope.customerId ?? '')
  insist(row && billingCurrency(row.currency) === 'USD', 'currency_path_not_supported', 409)
}
export async function requireUsdReporting(env: Bindings, customer: string | null = null) {
  customer=customer||null
  insist(!await one(env, `SELECT 1 FROM nc_invoices WHERE currency<>'USD' AND status<>'discarded' AND (? IS NULL OR customer_id=?)
    UNION ALL SELECT 1 FROM nc_payments WHERE currency<>'USD' AND (? IS NULL OR customer_id=?)
    UNION ALL SELECT 1 FROM nc_customers c JOIN nc_subscriptions s ON s.customer_id=c.id WHERE c.currency<>'USD' AND (? IS NULL OR c.id=?) LIMIT 1`,customer,customer,customer,customer,customer,customer), 'usd_report_requires_currency_report', 409)
}
