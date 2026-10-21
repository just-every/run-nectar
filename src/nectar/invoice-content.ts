// INV-004: presentation and payment terms join the same approved input image
// as financial inputs. Issued invoices always read their saved image.
import type { Bindings } from '../auth.server'
import type { Business } from './business'
import { insist, one, parseJson, type Row } from './core'
import { Input } from './input'

export interface InvoiceSettings {
  paymentTermsDays: number | null
  poRequired: boolean
  poNumber: string
  memo: string
  customFields: Record<string, string>
}
export interface InvoiceContent extends Omit<InvoiceSettings, 'paymentTermsDays'> {
  paymentTermsDays: number
  businessFields: Record<string, string>
  customerFields: Record<string, string>
}
export function invoiceFields(value: unknown): Record<string, string> {
  insist(value && typeof value === 'object' && !Array.isArray(value), 'invalid_invoice_fields')
  const entries = Object.entries(value)
  insist(entries.length <= 20, 'too_many_invoice_fields')
  const result: Record<string, string> = Object.create(null)
  for (const [key, text] of entries) {
    insist(key.trim() === key && key.length > 0 && key.length <= 80 && !/[\x00-\x1f]/.test(key), 'invalid_invoice_field_name')
    insist(typeof text === 'string' && text.length <= 500, 'invalid_invoice_field_value')
    result[key] = text
  }
  return result
}
export function invoiceSettings(value: unknown = {}): InvoiceSettings {
  insist(value && typeof value === 'object' && !Array.isArray(value), 'invalid_invoice_settings')
  const row = value as Row, input = Input.of(row)
  insist(Object.keys(row).every(key => ['paymentTermsDays','poRequired','poNumber','memo','customFields'].includes(key)), 'unknown_invoice_setting')
  const terms = row.paymentTermsDays ?? null
  insist(terms === null || [15,30,45,60].includes(terms), 'invalid_customer_payment_terms')
  insist(row.poRequired === undefined || typeof row.poRequired === 'boolean', 'invalid_po_required')
  return { paymentTermsDays: terms, poRequired: row.poRequired ?? false,
    poNumber: input.text('poNumber', { max: 120, optional: true }), memo: input.text('memo', { max: 1000, optional: true }),
    customFields: invoiceFields(row.customFields ?? {}) }
}
export function contentForSettings(business: Business, settings: InvoiceSettings): InvoiceContent {
  const businessFields = invoiceFields(parseJson(business.invoice_fields_json, {}))
  return { ...settings, paymentTermsDays: settings.paymentTermsDays ?? business.payment_terms_days,
    businessFields, customerFields: settings.customFields, customFields: { ...businessFields, ...settings.customFields } }
}
export async function invoiceContent(env: Bindings, business: Business, customer: string): Promise<InvoiceContent> {
  const row = await one(env, 'SELECT invoice_settings_json FROM nc_customers WHERE id=? AND erased_at IS NULL', customer)
  insist(row, 'customer_not_found', 404)
  return contentForSettings(business, invoiceSettings(parseJson(row.invoice_settings_json, {})))
}

/** The same settings accept structured JSON at the API and ordinary form controls. */
export function invoiceFieldInput(input: Input): Record<string, string> {
  const names = input.list('invoice_field_name', { keepEmpty: true }), values = input.list('invoice_field_value', { keepEmpty: true })
  insist(names.length === values.length && names.length <= 20, 'invalid_invoice_fields')
  const result: Record<string, string> = Object.create(null)
  names.forEach((name, i) => {
    if (!name && !values[i]) return
    insist(name && !Object.hasOwn(result, name), 'duplicate_invoice_field')
    result[name] = values[i]
  })
  return invoiceFields(result)
}
export function invoiceSettingsInput(input: Input, saved: string = '{}'): string {
  if (input.has('invoice_settings')) return JSON.stringify(invoiceSettings(input.json('invoice_settings')))
  if (!input.flag('invoice_edit')) return saved
  return JSON.stringify(invoiceSettings({ paymentTermsDays: input.integer('invoice_terms_days', { min: 15, max: 60, optional: true }),
    poRequired: input.flag('invoice_po_required'), poNumber: input.text('invoice_po_number', { max: 120, optional: true }),
    memo: input.text('invoice_memo', { max: 1000, optional: true }), customFields: invoiceFieldInput(input) }))
}
