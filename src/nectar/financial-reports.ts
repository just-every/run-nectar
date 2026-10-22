import { historicalContributions, historicalReportSource } from './movein/history-reports'
// Financial contributions use recorded ledger values or the real invoice engine.
// Unbilled calculations are live read snapshots, never issued-invoice evidence.
import type { Bindings } from '../auth.server'
import { canRead, requireRead, type Actor } from './actor'
import { requireBusiness, type Business } from './business'
import { all, fingerprint, insist, one, parseJson, type Row } from './core'
import { addMonths, isMonth, localDate, periodStartingIn, today, zonedStart } from './dates'
import { ratingInputs } from './inputs'
import { rate, type EventIn, type Exception, type Line, type RatingInput } from './rating'
import { prepaidFinancialSources, type PrepaidReportBalance } from './financial-prepaid'
import { clockInstant } from './clock'
import type { Report, ReportComponent, ReportEntry, ReportInvoice } from './reports'

export type FinancialReportMetric = 'credits' | 'tax' | 'unbilled' | 'credit-balances'
export interface FinancialReportEntry extends Omit<ReportEntry, 'sourceKind'> {
  sourceKind: 'invoice' | 'credit_note' | 'subscription_period' | 'prepaid_grant'
  grantId?: string
  prepaid?: PrepaidReportBalance
  creditId?: string
  subscriptionId?: string
  periodStart?: string
  periodEnd?: string
}
export interface FinancialReport extends Omit<Report, 'metric' | 'entries'> {
  metric: FinancialReportMetric
  entries: FinancialReportEntry[]
}
export interface UnbilledReportLine extends Line {
  lineId: string
  eventIds: string[]
  contextEventIds: string[]
  events: EventIn[]
  href: string
}
export interface UnbilledReportEvidence {
  subscriptionId: string
  subscriptionHref: string
  usageHref: string
  period: { start: string; end: string }
  generatedAt: number
  lines: UnbilledReportLine[]
  events: EventIn[]
  eventIds: string[]
  exceptions: Exception[]
  calculation: { inputs: RatingInput; fingerprint: string; version: string }
}
export interface FinancialReportSource extends Omit<ReportInvoice, 'metric' | 'sourceKind'> {
  metric: FinancialReportMetric
  sourceKind: FinancialReportEntry['sourceKind']
  credit?: { id: string; number: string; invoiceId: string; amountCents: number; reason: string; issuedAt: number; issuedOn: string; issuedBy: string }
  unbilled?: UnbilledReportEvidence
  prepaid?: PrepaidReportBalance
  calculation?: { inputs: Row; fingerprint: string; version: string; tax: unknown }
}

const USAGE = new Set(['usage', 'overage', 'metric_usage', 'late_usage', 'trial_usage', 'paused_usage'])
const DEFINITIONS: Record<FinancialReportMetric, { title: string; definition: string }> = {
  'credit-balances': {title:'Customer credit balances',definition:'Current USD monetary available credits, including purchased and promotional prepaid money, plus unconsumed paid unit consideration and carried numbered correction/cancellation credits less actual applications. Unit quantities remain separately typed by meter and are never added as USD; promotional units carry zero paid liability. Only purchased prepaid value is a contract liability. The snapshot uses the current business date across source issue dates; the selected month labels its export, not historical month-end balances. Expired money is unavailable without mutating its ledger; unpaid expiry liability and pending settlement remain explicit in source evidence. Unallocated payments, generic goodwill and cash refunds are excluded.'},
  credits: {
    title: 'Issued credit notes',
    definition: 'Actual numbered credit notes created in the selected month in the business billing timezone, shown as positive credited amounts against their original invoices. Historical usage notes separately retain applied and carried customer credit and saved tax attribution; other notes reduce only amounts owed and have no tax attribution. These are not cash refunds.',
  },
  tax: {
    title: 'Invoiced tax and attributed corrections',
    definition: 'Original tax amounts on invoices issued in the selected issue-date month, less historical usage credit notes with exact saved tax attribution issued that month. Other credit notes have no tax attribution and do not adjust this total. This is not net tax due, a filing calculation, or evidence of cash collection or tax remittance.',
  },
  unbilled: {
    title: 'Unbilled rated usage',
    definition: 'Usage lines rated by the invoice engine from current recorded inputs for live, unissued service periods starting in the selected month that have begun. Includes late usage, exact metric pricing, included allowances and lifecycle rules. Excludes base and seat charges, discounts, credits, minimum-commitment true-ups, one-time charges and tax. Snapshot metrics carry recorded state across the service period under the billing rule; this is a live calculation, not elapsed-to-now accrual or a forecast of future events. Issued periods, shadow subscriptions and periods owned entirely by the previous biller are excluded.',
  },
}

async function selection(env: Bindings, metric: string, url: URL) {
  insist(Object.hasOwn(DEFINITIONS, metric), 'invalid_metric')
  for (const key of new Set(url.searchParams.keys())) insist(url.searchParams.getAll(key).length <= 1, `invalid_${key}`)
  const period = url.searchParams.get('period'), customer = url.searchParams.get('customer')
  insist(period === null || isMonth(period), 'invalid_period')
  insist(customer === null || /^[\w-]{1,100}$/.test(customer), 'invalid_customer')
  insist(!url.searchParams.has('bucket'), 'invalid_bucket')
  if (customer) insist(await one(env, 'SELECT id FROM nc_customers WHERE id = ?', customer), 'customer_not_found', 404)
  const business = await requireBusiness(env)
  return { metric: metric as FinancialReportMetric, month: period ?? today(business.timezone).slice(0, 7), customer, business }
}

function sourceHref(metric: FinancialReportMetric, id: string, month: string, customer: string | null) {
  const query = new URLSearchParams({ period: month })
  if (customer) query.set('customer', customer)
  return `/app/reports/${metric}/${encodeURIComponent(id)}?${query}`
}

const stringIds = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []

async function unbilledSources(env: Bindings, business: Business, month: string, customer: string | null) {
  const day = today(business.timezone), generatedAt = Date.now()
  const subs = await all(env, `SELECT s.*, c.name AS customer_name FROM nc_subscriptions s
    JOIN nc_customers c ON c.id = s.customer_id WHERE s.billing_mode = 'live'
    ${customer ? 'AND s.customer_id = ?' : ''} ORDER BY c.name, s.created_at, s.id`, ...(customer ? [customer] : []))
  const sources = new Map<string, { entry: FinancialReportEntry; evidence: UnbilledReportEvidence }>()
  for (const sub of subs) {
    const period = periodStartingIn(sub.anchor_day, month)
    if (period.start > day || sub.start_date > day || sub.start_date >= period.end
      || sub.end_date && sub.end_date <= period.start
      || sub.cutover_start && (period.end <= sub.cutover_start || sub.cutover_start > day)) continue
    const issued = () => one(env, "SELECT 1 FROM nc_invoices WHERE subscription_id = ? AND invoice_kind = 'recurring' AND period_start = ? AND status = 'issued'", sub.id, period.start)
    if (await issued()) continue
    const inputs = await ratingInputs(env, business, sub.id, period)
    const result = rate(inputs)
    // Issuance during the input reads must not return a second contribution.
    if (await issued()) continue
    const id = `${sub.id}--${period.start}`, href = sourceHref('unbilled', id, month, customer)
    const lines: UnbilledReportLine[] = result.lines.flatMap((line, index) => {
      if (!USAGE.has(line.kind)) return []
      const eventIds = stringIds(line.evidence.eventIds), contextEventIds = stringIds(line.evidence.contextEventIds)
      const wanted = new Set([...eventIds, ...contextEventIds]), lineId = `usage-${index + 1}`
      return [{ ...line, lineId, eventIds, contextEventIds, events: inputs.events.filter(event => wanted.has(event.eventId)), href: `${href}#${lineId}` }]
    })
    // An unrated/negative metric must remain inspectable rather than silently
    // disappearing as a zero total with no explanation or source evidence.
    if (!lines.length && !result.exceptions.some(error => error.code.startsWith('metric_') || error.code === 'unrated_usage')) continue
    const wanted = new Set(lines.flatMap(line => [...line.eventIds, ...line.contextEventIds]))
    const events = inputs.events.filter(event => wanted.has(event.eventId))
    const entry: FinancialReportEntry = { invoiceId: id, number: `${sub.external_id || sub.id} · ${period.start}`,
      customerId: sub.customer_id, customerName: sub.customer_name, sourceKind: 'subscription_period',
      subscriptionId: sub.id, periodStart: period.start, periodEnd: period.end,
      amountCents: lines.reduce((sum, line) => sum + line.amountCents, 0), href }
    sources.set(id, { entry, evidence: { subscriptionId: sub.id, period, generatedAt, lines, events,
      eventIds: events.map(event => event.eventId), exceptions: result.exceptions,
      subscriptionHref: `/app/subscriptions/${encodeURIComponent(sub.id)}?preview_period=${month}#upcoming`,
      usageHref: `/app/usage?period=${month}`,
      calculation: { inputs, fingerprint: await fingerprint(inputs), version: inputs.version } } })
  }
  return sources
}

async function contributions(env: Bindings, metric: string, url: URL) {
  const selected = await selection(env, metric, url)
  const { month, customer, business } = selected
  const unbilled = selected.metric === 'unbilled' ? await unbilledSources(env, business, month, customer) : null
  const prepaid = selected.metric === 'credit-balances' ? await prepaidFinancialSources(env, today(business.timezone, clockInstant(env)), customer, id => sourceHref(selected.metric, id, month, customer)) : null
  let entries: FinancialReportEntry[]
  if (unbilled) entries = [...unbilled.values()].map(source => source.entry)
  else if(selected.metric==='credit-balances'){
    const rows=await all(env,`SELECT n.*,c.name AS customer_name,n.amount_cents-n.applied_cents-COALESCE((SELECT SUM(amount_cents) FROM nc_usage_credit_applications a WHERE a.credit_id=n.id),0) AS available
      FROM nc_credit_notes n JOIN nc_customers c ON c.id=n.customer_id WHERE (n.correction_id IS NOT NULL OR n.cancellation_id IS NOT NULL) ${customer?'AND n.customer_id=?':''} ORDER BY n.issued_at,n.id`,...(customer?[customer]:[]))
    entries=rows.filter(row=>row.available>0).map(row=>({invoiceId:row.id,creditId:row.id,number:row.number,customerId:row.customer_id,customerName:row.customer_name,amountCents:row.available,sourceKind:'credit_note',href:sourceHref(selected.metric,row.id,month,customer)}))
    entries.push(...[...prepaid!.values()].map(source => source.entry))
  }
  else {
    const credits = selected.metric === 'credits'
    const rows = credits
      ? await all(env, `SELECT n.id, n.number, n.customer_id, n.amount_cents, c.name AS customer_name
          FROM nc_credit_notes n JOIN nc_customers c ON c.id = n.customer_id
          JOIN nc_invoices i ON i.id = n.invoice_id AND i.status = 'issued'
          WHERE n.issued_at >= ? AND n.issued_at < ? ${customer ? 'AND n.customer_id = ?' : ''}
          ORDER BY n.issued_at, c.name, n.number`, zonedStart(`${month}-01`, business.timezone), zonedStart(addMonths(`${month}-01`, 1), business.timezone), ...(customer ? [customer] : []))
      : await all(env, `SELECT i.id, i.number, i.customer_id, i.tax_cents AS amount_cents, c.name AS customer_name
          FROM nc_invoices i JOIN nc_customers c ON c.id = i.customer_id
          WHERE i.status = 'issued' AND substr(i.issue_date, 1, 7) = ? ${customer ? 'AND i.customer_id = ?' : ''}
          ORDER BY c.name, i.number`, month, ...(customer ? [customer] : []))
    if(selected.metric==='tax')rows.push(...(await all(env,`SELECT n.id,n.number,n.customer_id,-n.tax_cents AS amount_cents,c.name AS customer_name FROM nc_credit_notes n JOIN nc_customers c ON c.id=n.customer_id WHERE (n.correction_id IS NOT NULL OR n.cancellation_id IS NOT NULL) AND n.tax_cents<>0 AND n.issued_at>=? AND n.issued_at<? ${customer?'AND n.customer_id=?':''} ORDER BY n.issued_at,n.id`,zonedStart(`${month}-01`,business.timezone),zonedStart(addMonths(`${month}-01`,1),business.timezone),...(customer?[customer]:[]))).map(r=>({...r,attributedCredit:true})))
    entries = rows.map(row => ({ invoiceId: row.id, number: row.number, customerId: row.customer_id,
      customerName: row.customer_name, amountCents: row.amount_cents,
      href: sourceHref(selected.metric, row.id, month, customer), sourceKind: credits||row.attributedCredit ? 'credit_note' : 'invoice',
      ...(credits||row.attributedCredit ? { creditId: row.id } : {}) }))
  }
  const historical=await historicalContributions(env,selected.metric,month,customer,today(business.timezone))
  entries.push(...historical.map(source=>source.entry as FinancialReportEntry))
  const report: FinancialReport = { metric: selected.metric, ...DEFINITIONS[selected.metric], period: month,
    totalCents: entries.reduce((sum, entry) => sum + entry.amountCents, 0), entries }
  return { report, unbilled, prepaid, business }
}

/** Every contribution is sourced from actual ledger rows or exact rated usage lines. */
export async function financialReport(env: Bindings, actor: Actor, metric: string, url: URL): Promise<FinancialReport> {
  requireRead(actor, 'reports')
  return (await contributions(env, metric, url)).report
}

/** Source membership and its components are read together; filtered-out sources refuse. */
export async function financialReportSource(env: Bindings, actor: Actor, metric: string, sourceId: string, url: URL): Promise<FinancialReportSource> {
  requireRead(actor, 'reports')
  const { report, unbilled, prepaid, business } = await contributions(env, metric, url)
  const entry = report.entries.find(row => row.invoiceId === sourceId)
  insist(entry, 'report_invoice_not_found', 404)
  const historical=await historicalReportSource(env,report,sourceId,url,today(business.timezone))
  if(historical)return historical as FinancialReportSource
  const base = { ...entry, metric: report.metric, title: report.title, definition: report.definition, period: report.period }
  if (entry.sourceKind === 'prepaid_grant') {
    const source = prepaid!.get(sourceId)!
    const components = source.components.map(component => canRead(actor, 'subscriptions') && canRead(actor, 'invoices') ? component : { ...component, href: undefined })
    return { ...base, totalCents: entry.amountCents, invoice: null, components, prepaid: source.prepaid }
  }
  if (unbilled) {
    const evidence = unbilled.get(sourceId)!.evidence
    const components: ReportComponent[] = evidence.lines.map(line => ({ kind: line.kind, label: line.description,
      amountCents: line.amountCents, lineId: line.lineId, href: line.href }))
    return { ...base, totalCents: entry.amountCents, components, invoice: null, unbilled: evidence }
  }
  const credit = entry.creditId ? await one(env, 'SELECT * FROM nc_credit_notes WHERE id = ? AND customer_id = ?', sourceId, entry.customerId) : null
  insist(!entry.creditId || credit, 'report_invoice_not_found', 404)
  const invoiceId = credit ? credit.invoice_id : sourceId
  const invoice = await one(env, "SELECT * FROM nc_invoices WHERE id = ? AND customer_id = ? AND status = 'issued'", invoiceId, entry.customerId)
  insist(invoice, 'report_invoice_not_found', 404)
  const href = `/app/invoices/${encodeURIComponent(invoice.id)}`
  let components: ReportComponent[] = [{ kind: credit ? 'credit_note' : 'tax',
    label: credit ? `${credit.number}: ${credit.reason}` : `Original tax on invoice ${invoice.number}`,
    amountCents: entry.amountCents, href: `${href}#${credit ? 'recv' : 'lines'}` }]
  if(report.metric==='credit-balances'&&credit){
    components=[{kind:'credit_note',label:`Full credit note ${credit.number}`,amountCents:credit.amount_cents,href:`${href}#credit-${credit.id}`},
      {kind:'original_credit_application',label:'Applied to the original invoice',amountCents:-credit.applied_cents,href:`${href}#recv`},
      ...(await all(env,'SELECT a.*,i.number FROM nc_usage_credit_applications a JOIN nc_invoices i ON i.id=a.invoice_id WHERE a.credit_id=? ORDER BY a.applied_at,a.id',credit.id)).map(a=>({kind:'credit_application',label:`Applied to invoice ${a.number}`,amountCents:-a.amount_cents,href:`/app/invoices/${a.invoice_id}#recv`}))]
    insist(components.reduce((n,c)=>n+c.amountCents,0)===entry.amountCents,'credit_balance_source_changed',409)
  }
  const saved = parseJson<Row>(invoice.calculation_json, {})
  return { ...base, totalCents: entry.amountCents, components,
    invoice: { id: invoice.id, number: invoice.number, customerId: invoice.customer_id, customerName: entry.customerName,
      subscriptionId: invoice.subscription_id, issueDate: invoice.issue_date, dueDate: invoice.due_date,
      periodStart: invoice.period_start, periodEnd: invoice.period_end, currency: invoice.currency,
      status: invoice.status, totalCents: invoice.total_cents, taxCents: invoice.tax_cents },
    ...(credit ? { credit: { id: credit.id, number: credit.number, invoiceId: invoice.id, amountCents: credit.amount_cents,
      reason: credit.reason, issuedAt: credit.issued_at, issuedOn: localDate(credit.issued_at, business.timezone), issuedBy: credit.issued_by } }
      : { calculation: { inputs: saved.inputs, fingerprint: saved.fingerprint ?? invoice.source_fingerprint,
        version: saved.version ?? invoice.calc_version, tax: saved.tax } }) }
}
