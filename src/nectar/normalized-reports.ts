import type { Bindings } from '../auth.server'
import { requireRead, type Actor } from './actor'
import { requireBusiness } from './business'
import { all, insist, one, parseJson, type Row } from './core'
import { clockInstant } from './clock'
import { addDays, addMonths, isMonth, localDate, today } from './dates'
import { ratingInputs } from './inputs'
import { normalizedSnapshot, NORMALIZED_DEFINITION, NORMALIZED_POLICY, type NormalizedSnapshot } from './normalized-metrics'
import { capturedNormalizedInput, usesCapturedContract } from './movein/normalized-history'
import type { Report, ReportEntry, ReportInvoice } from './reports'

export type NormalizedMetric = 'normalized-mrr' | 'normalized-arr'
export const isNormalizedMetric = (metric: string): metric is NormalizedMetric => metric === 'normalized-mrr' || metric === 'normalized-arr'
const title = (metric: NormalizedMetric) => metric === 'normalized-mrr' ? 'Normalized MRR' : 'Normalized ARR'
const amount = (snapshot: NormalizedSnapshot, metric: NormalizedMetric) => metric === 'normalized-mrr' ? snapshot.mrrCents : snapshot.arrCents
export const monthEnd = (month: string) => addDays(addMonths(`${month}-01`, 1), -1)
interface Source { provider: string; reference: string; href: string; eventCreated?: number; status?: string }
interface Contribution { sub: Row; snapshot: NormalizedSnapshot; source: Source }

async function sources(env: Bindings, through: string, customer: string | null) {
  const business = await requireBusiness(env)
  if (customer) insist(await one(env, 'SELECT id FROM nc_customers WHERE id=? AND erased_at IS NULL', customer), 'customer_not_found', 404)
  const [subs, history] = await Promise.all([
    all(env, `SELECT s.*,c.name AS customer_name,c.currency FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id
      WHERE c.erased_at IS NULL AND s.start_date<? AND (? IS NULL OR s.customer_id=?) ORDER BY s.start_date,s.id`, through, customer, customer),
    all(env, `SELECT h.*,c.name AS customer_name FROM nc_incumbent_history h JOIN nc_customers c ON c.id=h.customer_id
      WHERE h.kind='subscription-event' AND c.erased_at IS NULL AND (? IS NULL OR h.customer_id=?) ORDER BY h.occurred_on,h.id`, customer, customer),
  ])
  // Ended source subscriptions need not appear in the current subscription list.
  // Their retained creation event is a real historical source, never a new
  // billable subscription or an inference from the present catalogue.
  for (const row of history) {
    if (subs.some(sub => sub.customer_id === row.customer_id && sub.provider_ref === row.subscription_ref)) continue
    const event = parseJson<Row>(row.payload_json, {}), source = event.data?.object
    if (event.type !== 'customer.subscription.created' || !Number.isSafeInteger(source?.start_date)) continue
    const start = localDate(source.start_date * 1000, business.timezone)
    subs.push({ id: `history-${row.id}`, customer_id: row.customer_id, customer_name: row.customer_name,
      provider_ref: row.subscription_ref, start_date: start, anchor_day: Number(start.slice(8)), origin: 'import', cutover_start: null, historical_only: true })
  }
  // Read native operands once per subscription, then evaluate all calendar months.
  const native = new Map(await Promise.all(subs.filter(s => s.origin !== 'import' || s.cutover_start).map(async sub =>
    [sub.id, await ratingInputs(env, business, sub.id, { start: addMonths(through, -1), end: through })] as const)))
  return { business, subs, history, native }
}

async function contributions(data: Awaited<ReturnType<typeof sources>>, month: string): Promise<Contribution[]> {
  const asOf = monthEnd(month), through = addDays(asOf, 1), result: Contribution[] = []
  for (const sub of data.subs) {
    if (sub.start_date > asOf) continue
    const useSource = usesCapturedContract(sub, asOf)
    const captured = useSource ? capturedNormalizedInput(sub, data.history, through, data.business.timezone) : null
    const input = captured?.input ?? data.native.get(sub.id)!
    insist(input, 'normalized_contract_evidence_required', 409)
    const snapshot = await normalizedSnapshot(input, asOf)
    insist(snapshot.supported, 'normalized_instrument_unsupported', 409, { subscription: sub.id, exclusions: snapshot.exclusions })
    const source: Source = captured?.source ?? { provider: 'nectar', reference: sub.id, href: `/app/subscriptions/${sub.id}` }
    // Zero-rate trials and cancellations remain drillable, with their operands.
    result.push({ sub, snapshot, source })
  }
  return result
}

function entry(record: Contribution, metric: NormalizedMetric, month: string, customer: string | null): ReportEntry {
  const query = new URLSearchParams({ period: month }); if (customer) query.set('customer', customer)
  return { invoiceId: record.sub.id, number: record.sub.external_id ?? record.sub.provider_ref ?? record.sub.id,
    customerId: record.sub.customer_id, customerName: record.sub.customer_name, amountCents: amount(record.snapshot, metric),
    href: `/app/reports/${metric}/${record.sub.id}?${query}`, sourceKind: 'subscription_period',
    sourceProvider: record.source.provider, sourceReference: record.source.reference }
}
function selection(url: URL, current: string) {
  for (const key of ['period', 'customer']) insist(url.searchParams.getAll(key).length <= 1, `invalid_${key}`)
  const month = url.searchParams.get('period') ?? current, customer = url.searchParams.get('customer')
  insist(isMonth(month) && month >= '0001-01' && month <= '9999-11', 'invalid_period')
  insist(!customer || /^[\w-]{1,100}$/.test(customer), 'invalid_customer')
  insist(!url.searchParams.has('bucket'), 'invalid_bucket')
  return { month, customer }
}

export async function normalizedReport(env: Bindings, actor: Actor, metric: NormalizedMetric, url: URL): Promise<Report> {
  requireRead(actor, 'reports')
  const business = await requireBusiness(env)
  const { month, customer } = selection(url, today(business.timezone, clockInstant(env)).slice(0, 7))
  const data = await sources(env, addMonths(`${month}-01`, 1), customer)
  const current = await contributions(data, month)
  const first = data.subs.map(sub => sub.start_date.slice(0, 7)).sort()[0]
  const series: NonNullable<Report['series']> = []
  if (first) for (let period = first; period <= month; period = addMonths(`${period}-01`, 1).slice(0, 7)) {
    const rows = period === month ? current : await contributions(data, period)
    const amountCents = rows.reduce((sum, row) => sum + amount(row.snapshot, metric), 0)
    insist(Number.isSafeInteger(amountCents), 'normalized_amount_out_of_range', 409)
    series.push({ period, amountCents, sourceCount: rows.length })
  }
  const entries = current.map(row => entry(row, metric, month, customer)), totalCents = entries.reduce((sum, row) => sum + row.amountCents, 0)
  insist(Number.isSafeInteger(totalCents), 'normalized_amount_out_of_range', 409)
  return { metric, title: title(metric), definition: NORMALIZED_DEFINITION, period: month, totalCents, entries, series }
}

export async function normalizedReportSource(env: Bindings, actor: Actor, metric: NormalizedMetric, id: string, url: URL): Promise<ReportInvoice> {
  requireRead(actor, 'reports')
  const business = await requireBusiness(env), { month, customer } = selection(url, today(business.timezone, clockInstant(env)).slice(0, 7))
  const data = await sources(env, addMonths(`${month}-01`, 1), customer)
  const record = (await contributions(data, month)).find(row => row.sub.id === id)
  insist(record, 'report_invoice_not_found', 404)
  const snapshot = record.snapshot
  return { ...entry(record, metric, month, customer), metric, title: title(metric), definition: NORMALIZED_DEFINITION, period: month,
    totalCents: amount(snapshot, metric), invoice: null,
    components: snapshot.components.map(component => ({ kind: 'normalized_contract_item', label: `${component.priceId} × ${component.quantity}; ${component.interval.count} ${component.interval.unit}`,
      amountCents: metric === 'normalized-mrr' ? component.mrrCents : component.arrCents, href: record.source.href })),
    normalized: { policyVersion: NORMALIZED_POLICY, snapshot, source: record.source,
      subscriptionHref: record.sub.historical_only ? record.source.href : `/app/subscriptions/${record.sub.id}` } }
}
