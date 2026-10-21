import type { Bindings } from '../auth.server'
import { requireRead, requireCapability, type Actor } from './actor'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { insist } from './core'
import { isMonth, localDate } from './dates'
import { plainMoney } from './decimal'
import { REVENUE_POLICY_VERSION } from './revenue-allocation'
import { revenueInvoice, revenueInvoices, type RevenueInvoiceRecord } from './revenue-records'
import { csvResponse } from './report-csv'

export const REVENUE_DEFINITION = 'Revenue excludes tax. Service fees, signed discounts and fixed service credits follow business-local service days; usage follows recorded consumption; one-time fees follow their service date; unused commitments follow settlement or expiry. Actual credit notes are invoice-level contra-revenue in their issue month without changing original tax or line schedules. Signed position equals cumulative net billings minus cumulative recognition: a negative balance is an accrued contract asset; a positive balance is deferred revenue. Opposite invoice positions are shown separately before netting. Native historical schedules are read-only policy-v1 projections from saved originals when no issue-time snapshot exists. Retained Stripe schedules use captured tax-exclusive service consideration: recurring month/year fees allocate equally over anchored service months, with calendar-day splits for partial months; other lines follow saved service days. Imported annual advance invoices therefore carry their original deferred revenue across cutover. Native interval invoices retain their exact service-month schedules. Prepaid-credit liabilities, closing revenue periods and posting to an external ledger remain unavailable.'

export interface RevenueContribution {
  period: string
  kind: 'billing' | 'recognition' | 'credit-billing' | 'credit-recognition'
  invoiceId: string
  number: string
  customerId: string
  customerName: string
  lineId: string | null
  creditId: string | null
  amountCents: number
  policy: string
  custody: string
  href: string
  source?: RevenueInvoiceRecord['source']
}
export interface RevenueMonth {
  period: string
  openingCents: number
  openingAccruedContractAssetCents: number
  openingDeferredLiabilityCents: number
  billingsCents: number
  creditsCents: number
  netBillingsCents: number
  recognizedCents: number
  closingCents: number
  accruedContractAssetCents: number
  deferredLiabilityCents: number
}
export interface RevenueReport {
  policyVersion: string
  historicalPolicyVersion?: string
  definition: string
  from: string
  to: string
  customerId: string | null
  months: RevenueMonth[]
  contributions: RevenueContribution[]
  openingCents: number
  netBillingsCents: number
  recognizedCents: number
  closingCents: number
  accruedContractAssetCents: number
  deferredLiabilityCents: number
}

const monthIndex = (period: string) => { const [year, month] = period.split('-').map(Number); return year * 12 + month - 1 }
const monthAt = (index: number) => `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`

function filters(url: URL, current: string) {
  for (const key of ['period', 'from', 'to', 'customer']) insist(url.searchParams.getAll(key).length <= 1, `invalid_${key}`)
  const period = url.searchParams.get('period'), explicitFrom = url.searchParams.get('from'), explicitTo = url.searchParams.get('to')
  insist(period === null || isMonth(period), 'invalid_period')
  insist(!(period && (explicitFrom || explicitTo)), 'choose_period_or_range')
  const from = explicitFrom ?? period ?? current, to = explicitTo ?? period ?? from
  insist(isMonth(from) && isMonth(to) && from <= to, 'invalid_revenue_range')
  insist(monthIndex(to) - monthIndex(from) < 120, 'revenue_range_exceeds_120_months')
  const customer = url.searchParams.get('customer')
  insist(customer === null || /^[\w-]{1,100}$/.test(customer), 'invalid_customer')
  return { from, to, customer }
}

function sourceContributions(record: RevenueInvoiceRecord): RevenueContribution[] {
  const { invoice, schedules, credits, custody } = record
  const common = { invoiceId: invoice.id, number: invoice.number, customerId: invoice.customer_id, customerName: invoice.customer_name, custody, ...(record.source ? { source: record.source } : {}) }
  const rows: RevenueContribution[] = []
  for (const schedule of schedules) {
    const source = { ...common, lineId: schedule.lineId, creditId: null, policy: schedule.policy, href: `/app/revenue/${encodeURIComponent(invoice.id)}#line-${encodeURIComponent(schedule.lineId)}` }
    rows.push({ ...source, period: invoice.issue_date.slice(0, 7), kind: 'billing', amountCents: schedule.amountCents })
    rows.push(...schedule.entries.map(entry => ({ ...source, period: entry.period, kind: 'recognition' as const, amountCents: entry.amountCents })))
  }
  for (const credit of credits) {
    const source = { ...common, custody: credit.basis.custody ?? common.custody, number: credit.number, lineId: null, creditId: credit.id, period: credit.period, amountCents: credit.amountCents, policy: 'invoice-level-contra-revenue', href: `/app/revenue/${invoice.id}#credit-${credit.id}` }
    rows.push({ ...source, kind: 'credit-billing' }, { ...source, kind: 'credit-recognition' })
  }
  return rows
}
const isBilling = (row: RevenueContribution) => row.kind === 'billing' || row.kind === 'credit-billing'
const total = (rows: RevenueContribution[], predicate: (row: RevenueContribution) => boolean) => {
  const value = rows.filter(predicate).reduce((sum, row) => sum + BigInt(row.amountCents), 0n)
  insist(value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER), 'revenue_total_out_of_range', 409)
  return Number(value)
}
function position(rows: RevenueContribution[], before: string) {
  const balances = new Map<string, bigint>()
  for (const row of rows) if (monthIndex(row.period) < monthIndex(before)) balances.set(row.invoiceId, (balances.get(row.invoiceId) ?? 0n) + BigInt(row.amountCents) * (isBilling(row) ? 1n : -1n))
  let accrued = 0n, deferred = 0n
  for (const amount of balances.values()) if (amount < 0n) accrued -= amount; else deferred += amount
  insist(accrued <= BigInt(Number.MAX_SAFE_INTEGER) && deferred <= BigInt(Number.MAX_SAFE_INTEGER), 'revenue_total_out_of_range', 409)
  return { accruedContractAssetCents: Number(accrued), deferredLiabilityCents: Number(deferred), signedCents: Number(deferred - accrued) }
}

export async function revenueReport(env: Bindings, actor: Actor, url: URL): Promise<RevenueReport> {
  requireRead(actor, 'reports')
  const business = await requireBusiness(env)
  const { from, to, customer } = filters(url, localDate(clockInstant(env), business.timezone).slice(0, 7))
  const rows: RevenueContribution[] = []
  const records = await revenueInvoices(env, customer)
  for (const record of records) rows.push(...sourceContributions(record))
  const months: RevenueMonth[] = []
  for (let index = monthIndex(from); index <= monthIndex(to); index++) {
    const period = monthAt(index), before = position(rows, period), after = position(rows, monthAt(index + 1))
    const billings = total(rows, row => row.period === period && row.kind === 'billing')
    const credits = total(rows, row => row.period === period && row.kind === 'credit-billing')
    const recognized = total(rows, row => row.period === period && !isBilling(row))
    insist(BigInt(before.signedCents) + BigInt(billings) + BigInt(credits) - BigInt(recognized) === BigInt(after.signedCents), 'revenue_rollforward_mismatch', 409)
    months.push({ period, openingCents: before.signedCents, openingAccruedContractAssetCents: before.accruedContractAssetCents, openingDeferredLiabilityCents: before.deferredLiabilityCents, billingsCents: billings, creditsCents: credits, netBillingsCents: billings + credits, recognizedCents: recognized, closingCents: after.signedCents, accruedContractAssetCents: after.accruedContractAssetCents, deferredLiabilityCents: after.deferredLiabilityCents })
  }
  const contributions = rows.filter(row => row.period >= from && row.period <= to).sort((a, b) => a.period.localeCompare(b.period) || a.invoiceId.localeCompare(b.invoiceId) || a.kind.localeCompare(b.kind) || (a.lineId ?? a.creditId ?? '').localeCompare(b.lineId ?? b.creditId ?? ''))
  const historicalPolicyVersion = records.find(record => record.source)?.source?.policyVersion
  return { policyVersion: REVENUE_POLICY_VERSION, ...(historicalPolicyVersion ? { historicalPolicyVersion } : {}), definition: REVENUE_DEFINITION, from, to, customerId: customer, months, contributions,
    openingCents: months[0].openingCents, netBillingsCents: total(contributions, isBilling), recognizedCents: total(contributions, row => !isBilling(row)),
    closingCents: months.at(-1)!.closingCents, accruedContractAssetCents: months.at(-1)!.accruedContractAssetCents, deferredLiabilityCents: months.at(-1)!.deferredLiabilityCents }
}

export async function revenueSource(env: Bindings, actor: Actor, invoiceId: string, url: URL) {
  requireRead(actor, 'reports')
  const record = await revenueInvoice(env, invoiceId)
  const { customer } = filters(url, record.invoice.issue_date.slice(0, 7))
  insist(!customer || customer === record.invoice.customer_id, 'revenue_invoice_not_found', 404)
  return { policyVersion: record.source?.policyVersion ?? REVENUE_POLICY_VERSION, definition: REVENUE_DEFINITION, custody: record.custody,
    ...(record.source ? { source: record.source } : {}),
    invoice: { id: record.invoice.id, number: record.invoice.number, customerId: record.invoice.customer_id, customerName: record.invoice.customer_name, issueDate: record.invoice.issue_date, subtotalCents: record.invoice.subtotal_cents, taxCents: record.invoice.tax_cents, totalCents: record.invoice.total_cents, sourceFingerprint: record.invoice.source_fingerprint },
    schedules: record.schedules, credits: record.credits, contributions: sourceContributions(record) }
}

const csvCell = (value: unknown) => {
  const text = String(value ?? ''), safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}
export async function revenueCsv(env: Bindings, actor: Actor, url: URL) {
  requireCapability(actor, 'export')
  requireRead(actor, 'reports')
  const report = await revenueReport(env, actor, url)
  const rows: unknown[][] = [['row_kind', 'period', 'invoice', 'customer', 'line_id', 'credit_id', 'policy', 'custody', 'opening', 'net_billings', 'recognized', 'closing', 'accrued_contract_assets', 'deferred_liabilities', 'signed_contribution', 'source_path','source_provider','source_reference']]
  for (const month of report.months) rows.push(['rollforward', month.period, '', '', '', '', REVENUE_POLICY_VERSION, '', ...[month.openingCents, month.netBillingsCents, month.recognizedCents, month.closingCents, month.accruedContractAssetCents, month.deferredLiabilityCents].map(plainMoney), '', '', '', ''])
  for (const row of report.contributions) rows.push([row.kind, row.period, row.number, row.customerName, row.lineId, row.creditId, row.policy, row.custody, '', '', '', '', '', '', plainMoney(row.amountCents), row.href,row.source?.provider??'nectar',row.source?.providerRef??row.invoiceId])
  return csvResponse(rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n', 'nectar-revenue')
}
