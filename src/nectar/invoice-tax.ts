// The same exact tax arithmetic for subscription and standalone invoice lines.
import { micros, percentOf } from './decimal'
import type { Exception, Line, RatingInput } from './rating'

export function invoiceTotals(taxInput: RatingInput['tax'], lines: Line[]) {
  const exceptions: Exception[] = []
  const subtotal = lines.reduce((sum, line) => sum + line.amountCents, 0)
  const taxableBase = lines.filter(line => line.taxable).reduce((sum, line) => sum + line.amountCents, 0)
  let taxCents = 0
  const tax: Record<string, unknown> = { mode: taxInput.mode, jurisdiction: taxInput.jurisdiction, taxableBaseCents: taxableBase }
  if (taxInput.exception) exceptions.push(taxInput.exception)
  if (taxInput.certificate) tax.certificate = taxInput.certificate
  if (taxInput.mode === 'undeclared') exceptions.push({ code: 'tax_undeclared', message: 'The business has not declared its tax policy; this invoice cannot be finalized.' })
  else if (taxInput.exempt) Object.assign(tax, { exempt: true, exemptRef: taxInput.exemptRef, rule: 'customer is tax exempt' })
  else if (taxInput.mode === 'flat_rate' && taxableBase > 0) {
    taxCents = Number(percentOf(BigInt(taxableBase), micros(taxInput.rate)))
    Object.assign(tax, { rate: taxInput.rate, rule: 'declared rate × taxable total, rounded half away from zero once' })
  } else Object.assign(tax, { rule: taxInput.mode === 'no_tax' ? 'declared: no sales tax applies' : 'no taxable charges' })
  if (subtotal < 0) exceptions.push({ code: 'negative_total', message: 'Credits exceed the charges for this period; issue a credit note instead of a negative invoice.' })

  return { subtotalCents: subtotal, taxCents, totalCents: subtotal + taxCents, tax, exceptions }
}
