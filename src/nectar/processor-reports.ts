// Processor balance facts are separate from receipt custody and bank payouts.
import type { Bindings } from '../auth.server'
import { canRead, type Actor } from './actor'
import { all, insist } from './core'
import { addDays, addMonths, localDate, zonedStart } from './dates'
import { reportingTotal, translateReportAmount, translateReportComponents } from './currency-report-translation'
import type { Report, ReportComponent, ReportEntry, ReportInvoice } from './reports'

export interface ProcessorReportEvidence {
  accountRef: string; transactionRef: string; type: string; sourceRef: string
  customerId: string; invoiceId: string | null; paymentId: string | null
  invoiceHref?: string
  transactionHref?: string
  grossCents: number; feeCents: number; netCents: number; currency: string
  status: 'pending' | 'available'; occurredAt: number; availableAt: number; payoutRef: string | null
  basis: 'gross_received' | 'available_net' | 'refund_cash'
}
type ProcessorMetric = 'collections' | 'settlements' | 'refunds'
interface ProcessorEntry extends ReportEntry {
  sourceKind: 'processor_payment' | 'processor_settlement' | 'processor_refund'
  processor: ProcessorReportEvidence
}

/** Match actual source references globally, so differing receipt and refund dates do
 * not introduce a second cash movement in another month's report. */
export async function processorReportSources(env: Bindings, metric: ProcessorMetric, month: string, customer: string | null, day: string, timezone: string) {
  const settlement = metric === 'settlements', refund = metric === 'refunds'
  const dateColumn = settlement ? 'available_at' : 'occurred_at'
  const start = zonedStart(`${month}-01`, timezone)
  const end = Math.min(zonedStart(addMonths(`${month}-01`, 1), timezone), zonedStart(addDays(day, 1), timezone))
  const rows = await all(env, `SELECT t.*,c.name AS customer_name,c.erased_at,p.id AS recorded_payment,
    (SELECT a.invoice_id FROM nc_processor_cash_imported_applications a WHERE a.account_ref=t.account_ref AND a.charge_ref=t.source_ref AND a.status='collected') AS imported_invoice,
    EXISTS(SELECT 1 FROM nc_processor_objects o WHERE o.account_ref=t.account_ref AND o.object_ref=t.source_ref AND o.kind='charge' AND o.status='succeeded') AS source_succeeded,
    EXISTS(SELECT 1 FROM nc_incumbent_history h WHERE h.provider='stripe' AND h.kind='payment' AND h.status='succeeded' AND h.provider_ref=t.source_ref)
      OR EXISTS(SELECT 1 FROM nc_imported_collections h WHERE h.charge_ref=t.source_ref AND h.collected_on IS NOT NULL)
      OR EXISTS(SELECT 1 FROM nc_processor_cash_imported_applications h WHERE h.account_ref=t.account_ref AND h.charge_ref=t.source_ref AND h.status='collected') AS imported_payment,
    (SELECT r.id FROM nc_invoice_refunds r WHERE r.refund_ref=t.source_ref AND r.status='completed' AND r.destination='original' ORDER BY r.completed_at,r.id LIMIT 1) AS invoice_refund,
    (SELECT r.id FROM nc_prepaid_refunds r WHERE r.refund_ref=t.source_ref AND r.status='refunded' LIMIT 1) AS prepaid_refund
    FROM nc_processor_transactions t JOIN nc_customers c ON c.id=t.customer_id
    LEFT JOIN nc_payments p ON p.id=t.payment_id AND p.customer_id=t.customer_id
    WHERE (t.type='refund' OR t.invoice_id IS NOT NULL OR EXISTS(SELECT 1 FROM nc_processor_cash_imported_applications a WHERE a.account_ref=t.account_ref AND a.charge_ref=t.source_ref AND a.status='collected')) AND t.${dateColumn}>=? AND t.${dateColumn}<?
      AND ${refund ? "t.type='refund' AND t.amount_cents<0" : "t.type IN ('charge','payment') AND t.amount_cents>0"}
      ${settlement ? "AND t.status='available'" : ''}
      ${customer ? 'AND t.customer_id=?' : ''}
    ORDER BY t.${dateColumn},t.transaction_ref,t.id`, start, end, ...(customer ? [customer] : []))
  const entries: ProcessorEntry[] = [], receipts = new Map<string, ProcessorReportEvidence>(), refunds = new Map<string, ProcessorReportEvidence>()
  for (const row of rows) {
    insist(row.net_cents === row.amount_cents - row.fee_cents, 'processor_report_does_not_reconcile', 409)
    const invoiceId = row.invoice_id ?? row.imported_invoice ?? null
    const processor: ProcessorReportEvidence = {
      accountRef: row.account_ref, transactionRef: row.transaction_ref, type: row.type, sourceRef: row.source_ref,
      customerId: row.customer_id, invoiceId, paymentId: row.payment_id,
      ...(!row.erased_at ? {
        transactionHref: `/app/processor-events?customer=${encodeURIComponent(row.customer_id)}#transaction-${encodeURIComponent(row.id)}`,
        ...(invoiceId ? { invoiceHref: row.imported_invoice
          ? `/app/customers/${encodeURIComponent(row.customer_id)}#history-${encodeURIComponent(invoiceId)}`
          : `/app/invoices/${encodeURIComponent(invoiceId)}#recv` } : {}),
      } : {}),
      grossCents: row.amount_cents, feeCents: row.fee_cents, netCents: row.net_cents, currency: row.currency,
      status: row.status, occurredAt: row.occurred_at, availableAt: row.available_at, payoutRef: row.payout_ref,
      basis: settlement ? 'available_net' : refund ? 'refund_cash' : 'gross_received',
    }
    if (refund && (row.prepaid_refund || row.invoice_refund)) {
      refunds.set(row.prepaid_refund || row.invoice_refund, processor)
      continue
    }
    if (metric === 'collections' && row.recorded_payment) {
      receipts.set(row.recorded_payment, processor)
      continue
    }
    if (metric === 'collections' && (row.imported_payment || !row.source_succeeded)) continue
    const query = new URLSearchParams({ period: month })
    if (customer) query.set('customer', customer)
    entries.push({ invoiceId: row.id, number: row.transaction_ref, customerId: row.customer_id,
      customerName: row.erased_at ? 'Erased customer' : row.customer_name,
      ...await translateReportAmount(env, row.currency, settlement ? row.net_cents : row.amount_cents, localDate(row[dateColumn], timezone)),
      sourceKind: settlement ? 'processor_settlement' : refund ? 'processor_refund' : 'processor_payment',
      sourceProvider: 'stripe', sourceReference: row.transaction_ref, processor,
      href: `/app/reports/${metric}/${encodeURIComponent(row.id)}?${query}` })
  }
  return { entries, receipts, refunds }
}

export function processorReportSource(view: Report, entry: ReportEntry, actor: Actor): ReportInvoice {
  const processor = entry.processor!
  const href = canRead(actor, 'invoices') ? processor.invoiceHref ?? (canRead(actor, 'payments') ? processor.transactionHref : undefined) : undefined
  const components: ReportComponent[] = processor.basis === 'available_net'
    ? [{ kind: 'processor_gross', label: 'Processor gross payment', amountCents: processor.grossCents, href },
      { kind: 'processor_fee', label: 'Processor fee', amountCents: -processor.feeCents }]
    : [{ kind: processor.basis === 'refund_cash' ? 'processor_cash_refund' : 'processor_gross',
      label: processor.basis === 'refund_cash' ? 'Successful processor cash refund' : 'Processor gross received payment', amountCents: processor.grossCents, href }]
  const translated = translateReportComponents(entry, components)
  insist(reportingTotal(translated) === entry.amountCents, 'processor_report_source_changed', 409)
  return { ...entry, metric: view.metric, title: view.title, definition: view.definition, period: view.period,
    totalCents: entry.amountCents, components: translated, invoice: null }
}
