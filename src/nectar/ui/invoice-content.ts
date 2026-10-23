import { invoiceBranding } from '../invoice-branding'
import type { Row } from '../core'
import { parseJson } from '../core'
import { invoiceSettings } from '../invoice-content'
import { area, check, field, fileField, h, hidden, select } from './html'

export function invoiceFieldsForm(fields: Record<string, string>) {
  const entries = Object.entries(fields)
  return h`<fieldset class="invoice-fields"><legend>Invoice fields</legend><p class="hint">Use a name and value, such as Vendor ID and V-104. Clear both to remove a field. Up to twenty fields; saving adds two blank rows.</p>
    ${[...entries, ...Array.from({ length: Math.min(2, 20 - entries.length) }, () => ['', ''])].map(([name,value],i) => h`<div class="pair">${field(`Field ${i+1} name`, 'invoice_field_name', { value: name, required: false })}${field(`Field ${i+1} value`, 'invoice_field_value', { value, required: false })}</div>`)}</fieldset>`
}
export function customerInvoiceForm(customer: Row) {
  const settings = invoiceSettings(parseJson(customer.invoice_settings_json, {}))
  return h`<fieldset><legend>Invoice terms</legend>${hidden('invoice_edit','yes')}
    ${select('Customer payment terms', 'invoice_terms_days', [15,30,45,60].map(days => ({ value: String(days), label: `Net ${days}` })), settings.paymentTermsDays === null ? '' : String(settings.paymentTermsDays), { required: false, blank: 'Use business payment terms' })}
    ${check('Require a purchase order number before issuing', 'invoice_po_required', { checked: settings.poRequired })}
    ${field('Purchase order number', 'invoice_po_number', { value: settings.poNumber, required: false })}
    ${check('Hide usage detail on customer invoices', 'invoice_hide_usage', { checked: !!settings.hideUsageDetail })}
    ${area('Invoice memo', 'invoice_memo', settings.memo, false, 3)}
    <p class="hint">Changes apply to new drafts. Prepare again after a change; issued invoices keep their saved terms.</p></fieldset>${invoiceFieldsForm(settings.customFields)}`
}

export function invoiceBrandingForm(saved='{}') {
  const brand=invoiceBranding(parseJson(saved,{}))
  return h`<fieldset><legend>Invoice branding</legend>${hidden('invoice_branding_edit','yes')}
    ${fileField('Invoice logo (JPEG, up to 100 KB)','invoice_logo',{accept:'image/jpeg',hint:brand.logo?'A logo is saved. Upload a replacement or keep it.':'Choose an RGB JPEG logo.'})}
    ${check('Remove saved logo','invoice_logo_remove')}
    ${field('Invoice color','invoice_color',{type:'color',value:brand.color})}
    ${area('Invoice footer','invoice_footer',brand.footer,false,3)}
    ${area('Remit-to details','invoice_remit_to',brand.remitTo,false,3)}
    <p class="hint">Saved on new drafts. Issued invoices retain their branding. Remit-to text is supplied by your business; processor funding instructions are not generated here.</p></fieldset>`
}
