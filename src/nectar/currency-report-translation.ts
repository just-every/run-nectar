// Reporting is a projection: native transactions and calculation evidence stay untouched.
import type { Bindings } from '../auth.server'
import { all, insist, type Row } from './core'
import { billingCurrency } from './currency'
import type { usdReportingValue } from './currency-rates'
import { micros, SCALE } from './decimal'

export interface ReportCurrencyEvidence {
  nativeCurrency?: string
  nativeAmountCents?: number
  reporting?: Awaited<ReturnType<typeof usdReportingValue>> & {
    transactionAmountCents: number
    transactionReportingAmountCents: number
  }
}

const safe = (value: bigint) => {
  insist(value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER), 'reporting_amount_overflow', 409)
  return Number(value)
}
export function reportingTotal(rows: { amountCents: number }[]) {
  return safe(rows.reduce((sum, row) => {
    insist(Number.isSafeInteger(row.amountCents), 'invalid_reporting_amount')
    return sum + BigInt(row.amountCents)
  }, 0n))
}

export async function translateReportAmount(env: Bindings, currencyValue: unknown, amountCents: number, date: string): Promise<{ amountCents: number } & ReportCurrencyEvidence> {
  const currency = billingCurrency(currencyValue)
  if (currency === 'USD') return { amountCents }
  const reporting = await (await import('./currency-rates')).usdReportingValue(env, currency, amountCents, date)
  return { amountCents: reporting.amountCents, nativeCurrency: currency, nativeAmountCents: amountCents,
    reporting: { ...reporting, transactionAmountCents: amountCents, transactionReportingAmountCents: reporting.amountCents } }
}

/** Floor exact signed component values, then distribute the whole transaction's
 * rounding remainder by largest fractional remainder, with source order as tie-break.
 * Discounts keep their sign; independently rounded lines never inflate the total. */
export function translateReportComponents<T extends { amountCents: number }>(entry: ReportCurrencyEvidence, components: T[]): (T & ReportCurrencyEvidence)[] {
  if (!entry.reporting) return components
  const { reporting, nativeCurrency } = entry
  insist(reportingTotal(components) === reporting.transactionAmountCents, 'report_source_changed', 409)
  const rate = micros(reporting.rate)
  const parts = components.map((component, index) => {
    const numerator = BigInt(component.amountCents) * rate
    const remainder = (numerator % SCALE + SCALE) % SCALE
    return { index, remainder, amount: (numerator - remainder) / SCALE }
  })
  const remainder = BigInt(reporting.transactionReportingAmountCents) - parts.reduce((sum, part) => sum + part.amount, 0n)
  insist(remainder >= 0n && remainder <= BigInt(parts.length), 'report_source_changed', 409)
  const ordered = [...parts].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)
  for (let index = 0; index < Number(remainder); index++) ordered[index].amount += 1n
  return components.map((component, index) => {
    const amountCents = safe(parts[index].amount)
    return { ...component, amountCents, nativeCurrency, nativeAmountCents: component.amountCents, reporting: { ...reporting, amountCents } }
  })
}

/** Tax is the same allocated component seen in billings, at the invoice issue date. */
export async function invoiceTaxReporting(env: Bindings, invoice: Row) {
  if (billingCurrency(invoice.currency) === 'USD') return { amountCents: invoice.tax_cents }
  const lines = await all(env, 'SELECT amount_cents FROM nc_invoice_lines WHERE invoice_id=? ORDER BY seq', invoice.id)
  const transaction = await translateReportAmount(env, invoice.currency, invoice.total_cents, invoice.issue_date)
  const components = translateReportComponents(transaction, [...lines.map(line => ({ amountCents: line.amount_cents })), { amountCents: invoice.tax_cents }])
  return components[components.length - 1]
}

/** An attributed credit tax reversal shares the once-converted gross credit. */
export async function creditTaxReporting(env: Bindings, credit: Row, issuedOn: string) {
  if (billingCurrency(credit.currency) === 'USD') return { amountCents: -credit.tax_cents }
  const transaction = await translateReportAmount(env, credit.currency, credit.amount_cents, issuedOn)
  const tax = translateReportComponents(transaction, [{ amountCents: credit.amount_cents - credit.tax_cents }, { amountCents: credit.tax_cents }])[1]
  return { ...tax, amountCents: -tax.amountCents, nativeAmountCents: -credit.tax_cents,
    reporting: { ...tax.reporting!, amountCents: -tax.amountCents } }
}
