import { customerLineFacts } from './customer-invoice'
import type { Row } from './core'
import { customerText } from './locale'
import { pdfDocument } from './pdf-document'

export function invoicePdf(data: Row): Uint8Array {
  const row=data.invoices[0], content=data.content, brand=content.branding,L=customerText(data.customer.language)
  const money=(cents:number)=>L.money(cents,row.currency??'USD')
  const rows=[row.number,data.merchant.legal_name,data.customer.name,
    `${L.t('portal.issued')}: ${L.day(row.issue_date)}`,`${L.t('portal.due')}: ${L.day(row.due_date)}`,
    content.paymentTermsDays?`${L.t('invoice.terms')}: Net ${content.paymentTermsDays}`:'',
    content.poNumber?`${L.t('invoice.po')}: ${content.poNumber}`:'',content.memo,
    ...Object.entries(content.customFields).map(([key,value])=>`${key}: ${value}`),brand.remitTo,
    L.t('portal.lines'),...data.lines.flatMap((line:Row)=>[`${line.description}: ${money(line.amount_cents)}`,...customerLineFacts(line,L,row.currency)]),
    `${L.t('portal.subtotal')}: ${money(row.subtotal_cents)}`,`${L.t('portal.tax')}: ${money(row.tax_cents)}`,`${L.t('portal.total')}: ${money(row.total_cents)}`,
    ...data.credits.map((credit:Row)=>`${credit.number}: ${money(credit.amount_cents)}`),
    ...data.payments.map((payment:Row)=>`${L.t('portal.payment')} ${L.day(payment.received_on)}: ${money(payment.amount_cents)}`),
    `${L.t('portal.credited')}: ${money(row.credited_cents)}`,`${L.t('portal.paid')}: ${money(row.paid_cents)}`,`${L.t('portal.owed')}: ${money(row.balance_cents)}`,brand.footer]
  return pdfDocument(rows, brand)
}
