import type { Row } from './core'
import { customerText } from './locale'
import { pdfDocument } from './pdf-document'

/** Render only the customer receipt projection, never the private payment record. */
export function receiptPdf(data: Row): Uint8Array {
  const receipt = data.receipts[0], L = customerText(data.customer.language)
  const money = (cents: number) => L.money(cents, receipt.currency)
  const rows = [
    L.t('portal.receipts.heading'), receipt.number, data.merchant.legal_name, data.customer.name,
    L.t('portal.receipts.recorded'),
    `${L.t('portal.receipts.received')}: ${L.day(receipt.receivedOn)}`,
    `${L.t('portal.total')}: ${money(receipt.amountCents)}`,
    `${L.t('portal.receipts.allocated')}: ${money(receipt.allocatedCents)}`,
    `${L.t('portal.receipts.returned')}: ${money(receipt.returnedCents)}`,
    `${L.t('portal.receipts.unallocated')}: ${money(receipt.unallocatedCents)}`,
    L.t('portal.receipts.allocations'),
    ...receipt.allocations.map((allocation: Row) =>
      `${allocation.invoiceNumber}: ${money(allocation.amountCents)} (${L.day(allocation.allocatedOn)})`),
    receipt.allocations.length ? '' : L.t('portal.receipts.emptyAllocations'),
  ]
  return pdfDocument(rows, { color: '#000000', logo: '' }, 13)
}
