import { invoiceBranding } from './invoice-branding'
// INV-004: presentation and payment terms join the same approved input image
// as financial inputs. Issued invoices always read their saved image.
import type { Bindings } from '../auth.server'
import type { Business } from './business'
import { insist, one, parseJson, type Row } from './core'
import { Input } from './input'
import { billingRoute, requireBillingEntity } from './billing-entities'

export interface InvoiceSettings {
  hideUsageDetail?: boolean
  paymentTermsDays: number | null
  poRequired: boolean
  poNumber: string
  memo: string
  customFields: Record<string, string>
}
export interface InvoiceContent extends Omit<InvoiceSettings, 'paymentTermsDays'> {
  hierarchyPayer?: {parent:string;revision:number;mode:string}
  paymentTermsDays: number
  branding?: import('./invoice-branding').InvoiceBranding
  businessFields: Record<string, string>
  customerFields: Record<string, string>
  billingEntity?: { id: string; revision: string; route: ReturnType<typeof billingRoute> }
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
  insist(Object.keys(row).every(key => ['paymentTermsDays','poRequired','poNumber','memo','customFields','hideUsageDetail'].includes(key)), 'unknown_invoice_setting')
  const terms = row.paymentTermsDays ?? null
  insist(terms === null || [15,30,45,60].includes(terms), 'invalid_customer_payment_terms')
  insist(row.poRequired === undefined || typeof row.poRequired === 'boolean', 'invalid_po_required')
  insist(row.hideUsageDetail === undefined || typeof row.hideUsageDetail === 'boolean', 'invalid_usage_visibility')
  return { ...(row.hideUsageDetail ? { hideUsageDetail: true } : {}), paymentTermsDays: terms, poRequired: row.poRequired ?? false,
    poNumber: input.text('poNumber', { max: 120, optional: true }), memo: input.text('memo', { max: 1000, optional: true }),
    customFields: invoiceFields(row.customFields ?? {}) }
}
export function contentForSettings(business: Business, settings: InvoiceSettings): InvoiceContent {
  const businessFields = invoiceFields(parseJson(business.invoice_fields_json, {}))
  return { ...settings, paymentTermsDays: settings.paymentTermsDays ?? business.payment_terms_days,
    branding: invoiceBranding(parseJson(business.invoice_branding_json, {})), businessFields, customerFields: settings.customFields, customFields: { ...businessFields, ...settings.customFields } }
}
export async function invoiceContent(env: Bindings, business: Business, customer: string): Promise<InvoiceContent> {
  const row = await one(env, `SELECT c.invoice_settings_json,c.billing_entity_id,
    h.parent_id AS hierarchy_parent_id,h.revision AS hierarchy_revision,h.billing_mode AS hierarchy_billing_mode
    FROM nc_customers c LEFT JOIN nc_customer_hierarchies h ON h.customer_id=c.id
    WHERE c.id=? AND c.erased_at IS NULL`, customer)
  insist(row, 'customer_not_found', 404)
  const settings = invoiceSettings(parseJson(row.invoice_settings_json, {}))
  const hierarchy=row.hierarchy_parent_id!==null?{parent_id:row.hierarchy_parent_id,revision:row.hierarchy_revision,billing_mode:row.hierarchy_billing_mode}:null
  const content = {...contentForSettings(business, settings),...(hierarchy?{hierarchyPayer:{parent:hierarchy.parent_id,revision:hierarchy.revision,mode:hierarchy.billing_mode}}:{})}
  if (!row.billing_entity_id) return content
  const entity = await requireBillingEntity(env, row.billing_entity_id)
  return { ...content, paymentTermsDays: settings.paymentTermsDays ?? entity.payment_terms_days,
    billingEntity: { id: entity.id, revision: entity.revision, route: billingRoute(business, entity) } }
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
    hideUsageDetail: input.flag('invoice_hide_usage'), poRequired: input.flag('invoice_po_required'), poNumber: input.text('invoice_po_number', { max: 120, optional: true }),
    memo: input.text('invoice_memo', { max: 1000, optional: true }), customFields: invoiceFieldInput(input) }))
}
