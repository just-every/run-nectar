import { intervalRecurringEntries } from './interval-reports'
import { historicalMrrSeries, type HistoricalMrrMonth } from './movein/history-metrics'
import { historicalContributions, historicalReportSource } from './movein/history-reports'
import { financialReport, financialReportSource, type UnbilledReportEvidence } from './financial-reports'
// Issued-invoice and recorded-receipt reports. Every total has the same source contributions and
// signed detail components in the API and the operator pages.
import type { Bindings } from '../auth.server'
import { requireRead, type Actor } from './actor'
import { invoiceRecord } from './billruns'
import { requireBusiness } from './business'
import { all, insist, one, type Row } from './core'
import { daysBetween, isMonth, today } from './dates'
import { openInvoices } from './receivables'

export type ReportMetric = 'mrr' | 'billings' | 'ar' | 'collections' | 'credits' | 'tax' | 'unbilled' | 'credit-balances'
export interface ReportEntry {
  // invoiceId is the report source id; collections use the payment id here
  // for the shared detail route and identify it explicitly with sourceKind.
  sourcePath?: string
  sourceProvider?: string; sourceReference?: string
  invoiceId: string; number: string; customerId: string; customerName: string; amountCents: number; href: string
  sourceKind?: 'invoice' | 'payment' | 'credit_note' | 'subscription_period' | 'prepaid_grant'; paymentId?: string
  prepaid?: import('./financial-prepaid').PrepaidReportBalance
}
export interface Report {
  metric: ReportMetric; title: string; definition: string; period: string; totalCents: number; entries: ReportEntry[]; series?:HistoricalMrrMonth[]
}
export interface ReportComponent { kind: string; label: string; amountCents: number; lineId?: string; href?: string }
export interface ReportPayment {
  id: string; reference: string; number: string; receivedOn: string; method: string; evidence: string
  customerId: string; customerName: string; amountCents: number; recordedAt: number; recordedBy: string
}
export interface ReportInvoice extends ReportEntry {
  historical?: {provider:string;reference:string;href:string;original:Row}
  unbilled?: UnbilledReportEvidence
  credit?: {id:string;number:string;invoiceId:string;amountCents:number;reason:string;issuedAt:number;issuedOn:string;issuedBy:string}
  metric: ReportMetric; title: string; definition: string; period: string; totalCents: number; components: ReportComponent[]
  payment?: ReportPayment
  invoice: {
    id: string; number: string; customerId: string; customerName: string; subscriptionId: string | null
    issueDate: string; dueDate: string; periodStart: string; periodEnd: string; currency: string
    status: string; totalCents: number; taxCents: number
  } | null
}

const RECURRING = new Set(['flat', 'seat', 'usage', 'overage', 'metric_usage', 'discount', 'cancellation_credit'])
const BUCKETS = new Set(['current', '1-30', '31-60', '61-90', '90+', 'overdue'])
const DEFINITIONS: Record<Exclude<ReportMetric,'credits'|'tax'|'unbilled'|'credit-balances'>, { title: string; definition: string }> = {
  mrr: {
    title: 'Billed monthly recurring revenue',
    definition: 'Billed monthly recurring revenue for subscription periods starting in the selected month: issued flat, seat, metered usage, recurring discount and cancellation-credit lines, including actual proration. Excludes late usage, one-time charges, fixed credits, credit notes and tax. Native invoices use the current monthly catalogue; retained Stripe recurring lines contribute over their original service months, including annual fees allocated across twelve months. It is not a normalized current subscription run rate.',
  },
  billings: {
    title: 'Billings',
    definition: 'All original lines and tax on invoices issued in the selected calendar month. Later credit notes and payments do not change billings. Retained Stripe invoices use their original finalized date and source-labelled amounts.',
  },
  ar: {
    title: 'Accounts receivable',
    definition: 'Current positive remaining balances of issued invoices: original lines plus tax, less actual credit notes and payment allocations. Ageing uses the due date and today in the business billing timezone. This is a current balance, not a historical month-end snapshot.',
  },
  collections: {
    title: 'Collections',
    definition: 'Recorded external payments received in the selected month up to today in the business billing timezone, by their received-on date. Includes allocated and unallocated receipts. Allocations show which invoices a receipt pays; Nectar does not collect or send money. Retained successful Stripe charges contribute their original gross received amount; refunds remain separate read-only source records.',
  },
}

function filters(metric: string, url: URL) {
  insist(Object.hasOwn(DEFINITIONS, metric), 'invalid_metric')
  for (const key of ['period', 'customer', 'bucket']) insist(url.searchParams.getAll(key).length <= 1, `invalid_${key}`)
  const period = url.searchParams.get('period'), customer = url.searchParams.get('customer'), bucket = url.searchParams.get('bucket')
  insist(period === null || isMonth(period), 'invalid_period')
  insist(customer === null || /^[\w-]{1,100}$/.test(customer), 'invalid_customer')
  insist(bucket === null || (metric === 'ar' && BUCKETS.has(bucket)), 'invalid_bucket')
  return { metric: metric as ReportMetric, period, customer, bucket }
}

function inBucket(due: string, day: string, selected: string | null) {
  const days = daysBetween(due, day)
  const bucket = days <= 0 ? 'current' : days <= 30 ? '1-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+'
  return !selected || (selected === 'overdue' ? days > 0 : bucket === selected)
}

/** Reads contributions without inventing recurring amounts or allocating AR to individual lines. */
export async function report(env: Bindings, actor: Actor, metric: string, url: URL): Promise<Report> {
  requireRead(actor, 'reports')
  if (['credits','tax','unbilled','credit-balances'].includes(metric)) return await financialReport(env,actor,metric,url)
  const selected = filters(metric, url)
  const day = today((await requireBusiness(env)).timezone)
  const month = selected.period ?? day.slice(0, 7)
  let rows: Row[]
  if (selected.metric === 'ar') {
    rows = (await openInvoices(env, selected.customer ?? undefined))
      .filter(row => inBucket(row.due_date, day, selected.bucket))
      .map(row => ({ ...row, amount_cents: row.balance_cents }))
  } else if (selected.metric === 'collections') {
    rows = await all(env, `SELECT p.id, p.reference AS number, p.customer_id, c.name AS customer_name, p.amount_cents
      FROM nc_payments p JOIN nc_customers c ON c.id = p.customer_id
      WHERE substr(p.received_on, 1, 7) = ? AND p.received_on <= ? ${selected.customer ? 'AND p.customer_id = ?' : ''}
      ORDER BY p.received_on, c.name, p.reference`, month, day, ...(selected.customer ? [selected.customer] : []))
  } else {
    const mrr = selected.metric === 'mrr'
    rows = await all(env, `SELECT i.id, i.number, i.customer_id, c.name AS customer_name,
      ${mrr ? 'SUM(l.amount_cents)' : 'COALESCE(SUM(l.amount_cents), 0) + i.tax_cents'} AS amount_cents
      FROM nc_invoices i JOIN nc_customers c ON c.id = i.customer_id
      ${mrr ? 'JOIN' : 'LEFT JOIN'} nc_invoice_lines l ON l.invoice_id = i.id
      ${mrr ? "AND l.kind IN ('flat', 'seat', 'usage', 'overage', 'metric_usage', 'discount', 'cancellation_credit')" : ''}
      WHERE i.status = 'issued' AND substr(i.${mrr ? 'period_start' : 'issue_date'}, 1, 7) = ?
      ${mrr ? "AND i.invoice_kind = 'recurring' AND i.subscription_id IS NOT NULL AND i.billing_key='legacy-monthly-arrears'" : ''}
      ${selected.customer ? 'AND i.customer_id = ?' : ''}
      GROUP BY i.id ORDER BY c.name, i.number`, month, ...(selected.customer ? [selected.customer] : []))
  }
  if(selected.metric==='mrr') {
    const intervals=await intervalRecurringEntries(env,month,selected.customer),grouped=new Map<string,Row>()
    for(const row of intervals){const entry=grouped.get(row.invoice_id)??{id:row.invoice_id,number:row.number,customer_id:row.customer_id,customer_name:row.customer_name,amount_cents:0};entry.amount_cents+=row.amount_cents;grouped.set(row.invoice_id,entry)}
    rows.push(...grouped.values())
  }
  const linkMonth = selected.metric === 'ar' ? day.slice(0, 7) : month
  const query = new URLSearchParams({ period: linkMonth })
  if (selected.customer) query.set('customer', selected.customer)
  if (selected.bucket) query.set('bucket', selected.bucket)
  const entries: ReportEntry[] = rows.map(row => ({
    invoiceId: row.id, number: row.number, customerId: row.customer_id, customerName: row.customer_name,
    amountCents: row.amount_cents, href: `/app/reports/${selected.metric}/${encodeURIComponent(row.id)}?${query}`,
    ...(selected.metric === 'collections' ? { sourceKind: 'payment' as const, paymentId: row.id } : {}),
  }))
  const historical=await historicalContributions(env,selected.metric,month,selected.customer,day,selected.bucket)
  entries.push(...historical.map(source=>source.entry))
  return { metric: selected.metric, ...DEFINITIONS[selected.metric as keyof typeof DEFINITIONS], period: selected.metric === 'ar' ? day : month,
    totalCents: entries.reduce((sum, entry) => sum + entry.amountCents, 0), entries, ...(selected.metric==='mrr'?{series:await historicalMrrSeries(env,month,selected.customer)}:{}) }
}

/** Original line and settlement components tie exactly to the selected invoice contribution. */
export async function reportInvoice(env: Bindings, actor: Actor, metric: string, invoiceId: string, url: URL): Promise<ReportInvoice> {
  requireRead(actor, 'reports')
  if (['credits','tax','unbilled','credit-balances'].includes(metric)) return await financialReportSource(env,actor,metric,invoiceId,url)
  const view = await report(env, actor, metric, url)
  const entry = view.entries.find(row => row.invoiceId === invoiceId)
  insist(entry, 'report_invoice_not_found', 404)
  const historical=await historicalReportSource(env,view,invoiceId,url,today((await requireBusiness(env)).timezone))
  if(historical)return historical
  if (view.metric === 'collections') {
    const [payment, allocations] = await Promise.all([
      one(env, 'SELECT * FROM nc_payments WHERE id = ? AND customer_id = ?', invoiceId, entry.customerId),
      all(env, `SELECT a.id, a.invoice_id, a.amount_cents, i.number FROM nc_allocations a
        JOIN nc_invoices i ON i.id = a.invoice_id WHERE a.payment_id = ? ORDER BY a.allocated_at, a.id`, invoiceId),
    ])
    insist(payment, 'payment_not_found', 404)
    const components: ReportComponent[] = allocations.map(allocation => ({
      kind: 'allocation', label: `Allocated to invoice ${allocation.number}`, amountCents: allocation.amount_cents,
      href: `/app/invoices/${encodeURIComponent(allocation.invoice_id)}#recv`,
    }))
    const unallocated = payment.amount_cents - components.reduce((sum, component) => sum + component.amountCents, 0)
    if (unallocated > 0) components.push({ kind: 'unallocated', label: 'Unallocated receipt', amountCents: unallocated,
      href: `${entry.href}#payment-evidence` })
    return { ...entry, metric: view.metric, title: view.title, definition: view.definition, period: view.period,
      totalCents: components.reduce((sum, component) => sum + component.amountCents, 0), components, invoice: null,
      payment: { id: payment.id, reference: payment.reference, number: payment.reference, receivedOn: payment.received_on,
        method: payment.method, evidence: payment.evidence, customerId: payment.customer_id, customerName: entry.customerName,
        amountCents: payment.amount_cents, recordedAt: payment.recorded_at, recordedBy: payment.recorded_by } }
  }
  const invoice = await invoiceRecord(env, actor, invoiceId)
  const intervalLines=metric==='mrr'&&invoice.billing_key!=='legacy-monthly-arrears'?await intervalRecurringEntries(env,view.period.slice(0,7),invoice.customer_id,invoiceId):null
  const components: ReportComponent[] = (intervalLines?intervalLines.map((row):Row=>({...row,id:row.line_id})):invoice.lines as Row[])
    .filter(line => metric !== 'mrr' || RECURRING.has(line.kind))
    .map(line => ({ kind: line.kind, label: line.description, amountCents: line.amount_cents,
      lineId: line.id, href: `/app/invoices/${encodeURIComponent(invoiceId)}/lines/${encodeURIComponent(line.id)}` }))
  const sourceHref = `/app/invoices/${encodeURIComponent(invoiceId)}`
  if (metric !== 'mrr') components.push({ kind: 'tax', label: 'Invoice tax', amountCents: invoice.tax_cents, href: `${sourceHref}#lines` })
  if (metric === 'ar') {
    for (const credit of invoice.credits as Row[]) components.push({ kind: 'credit_note', label: `${credit.number}: ${credit.reason}`, amountCents: -(credit.applied_cents??credit.amount_cents), href: `${sourceHref}#recv` })
    for (const application of invoice.carriedApplications as Row[]) components.push({kind:'credit_application',label:`Carried credit ${application.number}`,amountCents:-application.amount_cents,href:`${sourceHref}#recv`})
    for (const allocation of invoice.allocations as Row[]) components.push({ kind: 'allocation', label: `Payment ${allocation.reference} received ${allocation.received_on}`, amountCents: -allocation.amount_cents, href: `${sourceHref}#recv` })
  }
  const totalCents = components.reduce((sum, component) => sum + component.amountCents, 0)
  // A payment may have settled this invoice after the report membership read.
  insist(metric !== 'ar' || totalCents > 0, 'report_invoice_not_found', 404)
  return { ...entry, amountCents: totalCents, metric: view.metric, title: view.title, definition: view.definition, period: view.period,
    totalCents, components,
    invoice: { id: invoice.id, number: invoice.number, customerId: invoice.customer_id, customerName: invoice.customer_name,
      subscriptionId: invoice.subscription_id, issueDate: invoice.issue_date, dueDate: invoice.due_date,
      periodStart: invoice.period_start, periodEnd: invoice.period_end, currency: invoice.currency,
      status: invoice.status, totalCents: invoice.total_cents, taxCents: invoice.tax_cents } }
}
