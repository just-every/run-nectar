import type { PortalReceiptData } from './portal-receipt-data'
import { customerText } from './locale'
import { h } from './ui/html'

export function portalReceiptsPage(data: PortalReceiptData, link: (path: string) => string, detail: boolean) {
  const L = customerText(data.customer.language, data.customer.currency)
  return h`<header><h1>${L.t('portal.receipts.heading')}</h1><p>${data.customer.name}</p>
    <p>${L.t('portal.receipts.recorded')}</p><a href="${link('/portal')}">${L.t('portal.back')}</a>
    ${detail ? h` · <a href="${link('/portal/receipts')}">${L.t('portal.receipts.heading')}</a>` : ''}</header>
    ${data.receipts.length ? data.receipts.map(receipt => h`<section class="card"><h2>${detail ? receipt.number : h`<a href="${link(`/portal/receipts/${receipt.id}`)}">${receipt.number}</a>`}</h2>
      <dl><dt>${L.t('portal.receipts.received')}</dt><dd>${L.day(receipt.receivedOn)}</dd>
      <dt>${L.t('portal.total')}</dt><dd>${L.money(receipt.amountCents, receipt.currency)}</dd>
      <dt>${L.t('portal.receipts.allocated')}</dt><dd>${L.money(receipt.allocatedCents, receipt.currency)}</dd>
      <dt>${L.t('portal.receipts.returned')}</dt><dd>${L.money(receipt.returnedCents, receipt.currency)}</dd>
      <dt>${L.t('portal.receipts.unallocated')}</dt><dd>${L.money(receipt.unallocatedCents, receipt.currency)}</dd></dl>
      ${detail ? h`<h3>${L.t('portal.receipts.allocations')}</h3>${receipt.allocations.length ? receipt.allocations.map(a => h`<p><a href="${link(`/portal/invoices/${a.invoice}`)}">${a.invoiceNumber}</a> · ${L.money(a.amountCents,a.currency)} · ${L.day(a.allocatedOn)}</p>`) : h`<p>${L.t('portal.receipts.emptyAllocations')}</p>`}` : ''}
      <a href="${link(`/portal/receipts/${receipt.id}`)}&format=pdf">${L.t('portal.receipts.download')}</a></section>`) : h`<p>${L.t('portal.receipts.empty')}</p>`}`
}
