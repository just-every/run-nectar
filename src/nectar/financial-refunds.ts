// Cash refund contributions are verified processor outflows. Numbered liability
// credits and original gross receipts remain separately typed, never netted.
import type { Bindings } from '../auth.server'
import { canRead, type Actor } from './actor'
import { all, insist, type Row } from './core'
import { localDate } from './dates'
import { prepaidRefundCashFacts } from './prepaid-refund-records'
import type { FinancialReportEntry } from './financial-reports'
import type { ReportComponent } from './reports'

export interface PrepaidReportRefund {
  id: string
  refundedOn: string
  cashAmountCents: number
  subscriptionId: string
  grantId: string
  purchase: { id: string; number: string; lineId: string; amountCents: number }
  receipt: { id: string; reference: string; receivedOn: string; amountCents: number }
  credit: { id: string; number: string; issuedOn: string; amountCents: number; purpose: 'paid-liability-cash-refund' }
  liability: { entryId: string; serviceDate: string; amountN: number; amountCents: number; recognitionCents: number }
}
export async function prepaidRefundFinancialSources(env: Bindings, month: string, customer: string | null, day: string, timezone: string, href: (id: string) => string) {
  const facts = (await prepaidRefundCashFacts(env)).filter(fact => fact.date?.slice(0, 7) === month && fact.date <= day && (!customer || fact.customer === customer))
  const rows = await all(env, `SELECT r.id,r.grant_id,r.purchase_invoice_id,r.payment_id,r.credit_id,r.ledger_id,r.customer_id,r.subscription_id,
    CASE WHEN c.erased_at IS NULL THEN c.name ELSE 'Erased customer' END AS customer_name,c.erased_at,
    i.number AS invoice_number,i.total_cents AS purchase_amount,g.purchase_line_id,
    p.reference AS receipt_reference,p.received_on,p.amount_cents AS receipt_amount,
    n.number AS credit_number,n.amount_cents AS credit_amount,n.issued_at,
    l.amount_n,l.liability_cents,l.recognition_cents,l.service_date,x.purpose
    FROM nc_prepaid_refunds r JOIN nc_customers c ON c.id=r.customer_id
    JOIN nc_prepaid_grants g ON g.id=r.grant_id AND g.customer_id=r.customer_id
    JOIN nc_invoices i ON i.id=r.purchase_invoice_id AND i.customer_id=r.customer_id
    JOIN nc_payments p ON p.id=r.payment_id AND p.customer_id=r.customer_id
    JOIN nc_credit_notes n ON n.id=r.credit_id AND n.customer_id=r.customer_id AND n.invoice_id=r.purchase_invoice_id
    JOIN nc_prepaid_refund_credits x ON x.refund_id=r.id AND x.credit_id=n.id AND x.customer_id=r.customer_id AND x.purchase_invoice_id=r.purchase_invoice_id
    JOIN nc_prepaid_ledger l ON l.id=r.ledger_id AND l.grant_id=r.grant_id AND l.kind='refund' AND l.customer_id=r.customer_id AND l.purchase_invoice_id=r.purchase_invoice_id
    WHERE r.status='refunded' ${customer ? 'AND r.customer_id=?' : ''} ORDER BY r.refunded_on,r.id`, ...(customer ? [customer] : []))
  const sources = new Map<string, { entry: FinancialReportEntry; refund: PrepaidReportRefund; row: Row }>()
  for (const fact of facts) {
    const row = rows.find(row => row.id === fact.id)
    insist(row && row.credit_amount === -fact.amountCents && row.liability_cents === fact.amountCents && row.recognition_cents === 0 && row.purpose === 'paid-liability-cash-refund', 'refund_report_source_changed', 409)
    const refund: PrepaidReportRefund = { id: fact.id, refundedOn: fact.date, cashAmountCents: fact.amountCents,
      subscriptionId: fact.subscription, grantId: row.grant_id,
      purchase: { id: fact.invoice, number: row.invoice_number, lineId: row.purchase_line_id, amountCents: row.purchase_amount },
      receipt: { id: fact.payment, reference: row.receipt_reference, receivedOn: row.received_on, amountCents: row.receipt_amount },
      credit: { id: fact.credit, number: row.credit_number, issuedOn: localDate(row.issued_at, timezone), amountCents: row.credit_amount, purpose: 'paid-liability-cash-refund' },
      liability: { entryId: row.ledger_id, serviceDate: row.service_date, amountN: row.amount_n, amountCents: row.liability_cents, recognitionCents: row.recognition_cents } }
    sources.set(fact.id, { row, refund, entry: { invoiceId: fact.id, number: `Refund ${row.credit_number}`, customerId: fact.customer,
      customerName: row.customer_name, amountCents: fact.amountCents, sourceKind: 'prepaid_refund', sourceProvider: 'nectar', sourceReference: fact.id, href: href(fact.id), refund } })
  }
  return sources
}
export function refundReportComponents(actor: Actor, source: { refund: PrepaidReportRefund; row: Row }): ReportComponent[] {
  const { refund, row } = source
  const invoiceHref = !row.erased_at && canRead(actor, 'invoices') ? `/app/invoices/${encodeURIComponent(refund.purchase.id)}#recv` : undefined
  // The one signed component is cash. The original purchase/receipt, credit and
  // zero-revenue liability reversal are context, not additional cash movements.
  return [{ kind: 'prepaid_cash_refund', label: `Verified cash refund · ${refund.refundedOn} · liability credit ${refund.credit.number}`, amountCents: refund.cashAmountCents, ...(invoiceHref ? { href: invoiceHref } : {}) }]
}
