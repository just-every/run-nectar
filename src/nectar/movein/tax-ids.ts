// A captured tax identifier is a displayed customer fact, never verification
// or permission to exempt tax. Native invoice fields freeze it on issue.
import { insist } from '../core'
import { invoiceSettings } from '../invoice-content'

export function importedTaxFields(customer: any): string | null {
  if (customer.tax_ids == null) return null
  const ids = customer.tax_ids
  const refuse: (ok: unknown) => asserts ok = ok => insist(ok, 'unsupported_imported_tax_id', 400, { customer: customer.id })
  refuse(ids.object === 'list' && ids.has_more === false && Array.isArray(ids.data) && ids.data.length <= 1)
  if (!ids.data.length) return null
  const tax = ids.data[0]
  const owner = typeof tax.customer === 'string' ? tax.customer : tax.customer?.id
  refuse(typeof tax.id === 'string' && tax.id.length > 0 && (!owner || owner === customer.id)
    && tax.type === 'us_ein' && typeof tax.value === 'string' && /^\d{2}-?\d{7}$/.test(tax.value))
  return JSON.stringify(invoiceSettings({ customFields: { 'Imported US tax ID': tax.value } }))
}
