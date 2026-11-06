import type { Bindings } from '../auth.server'
import { requireRead, type Actor } from './actor'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, insist, parseJson, type Row } from './core'
import { localDate, today, zonedStart } from './dates'
import { attributedCreditTax } from './financial-reports'

export const TAX_SOURCE_DEFINITION = 'Read-only USD source report. Quarter membership uses invoice issue dates and credit issue dates in the business billing timezone. Jurisdiction is the exact frozen declared label, never a customer destination or a validated filing jurisdiction. Bases are original signed invoice lines, before later credit notes. Only explicitly attributed saved credit tax adjusts known tax; credit bases are not spread across taxability classes. Missing jurisdiction and unknown attribution stay visible. This report establishes no provider reconciliation, filing format, registration, remittance or compliance.'
export interface TaxSourceAmounts {
  taxableBaseCents: number
  exemptBaseCents: number
  nonTaxableBaseCents: number
  unknownBaseCents: number
  originalTaxCents: number
  attributedTaxAdjustmentCents: number
  knownTaxCents: number
  attributedCreditSubtotalCents: number
  unattributedCreditCents: number
}
export interface TaxSourceEntry extends TaxSourceAmounts {
  id: string
  kind: 'invoice' | 'credit_note'
  number: string
  invoiceId: string
  invoiceNumber: string
  customerId: string
  customerName: string
  date: string
  jurisdiction: string | null
  baseState: 'frozen_lines' | 'unknown' | 'credit_not_allocated'
  taxState: 'original' | 'attributed_credit' | 'unknown_credit'
  amountCents: number
  href: string
}
const amounts = (): TaxSourceAmounts => ({ taxableBaseCents: 0, exemptBaseCents: 0, nonTaxableBaseCents: 0, unknownBaseCents: 0, originalTaxCents: 0, attributedTaxAdjustmentCents: 0, knownTaxCents: 0, attributedCreditSubtotalCents: 0, unattributedCreditCents: 0 })
const add = (target: TaxSourceAmounts, source: TaxSourceAmounts) => { for (const key of Object.keys(target) as (keyof TaxSourceAmounts)[]) target[key] += source[key] }

async function selection(env: Bindings, url: URL) {
  for (const key of url.searchParams.keys()) insist(['period', 'customer'].includes(key) && url.searchParams.getAll(key).length === 1, 'invalid_selection')
  const business = await requireBusiness(env), day = today(business.timezone, clockInstant(env))
  const period = url.searchParams.get('period') ?? `${day.slice(0, 4)}-Q${Math.ceil(Number(day.slice(5, 7)) / 3)}`
  insist(/^\d{4}-Q[1-4]$/.test(period), 'invalid_period')
  const year = Number(period.slice(0, 4)), quarter = Number(period.at(-1))
  insist(year >= 1900 && year <= 9998, 'invalid_period')
  const start = `${year}-${String(quarter * 3 - 2).padStart(2, '0')}-01`
  const end = quarter === 4 ? `${year + 1}-01-01` : `${year}-${String(quarter * 3 + 1).padStart(2, '0')}-01`
  const customer = url.searchParams.get('customer')
  insist(customer === null || /^[\w-]{1,100}$/.test(customer), 'invalid_customer')
  return { business, period, start, end, customer }
}

// Only scalar frozen tax facts and line amounts are exposed. Raw calculation
// inputs can contain contact or certificate material and are never returned.
function frozen(invoice: Row, lines: Row[]) {
  const saved = parseJson<Row>(invoice.calculation_json, {}), tax = saved.tax ?? {}, input = saved.inputs?.tax ?? {}
  const jurisdiction = typeof tax.jurisdiction === 'string' && tax.jurisdiction.trim() ? tax.jurisdiction : null
  const taxable = lines.filter(line => line.taxable === 1).reduce((sum, line) => sum + line.amount_cents, 0)
  const known = lines.length > 0 && lines.every(line => Number.isSafeInteger(line.amount_cents) && [0, 1].includes(line.taxable))
    && lines.reduce((sum, line) => sum + line.amount_cents, 0) === invoice.subtotal_cents
    && ['flat_rate', 'no_tax'].includes(tax.mode) && tax.mode === input.mode && tax.jurisdiction === input.jurisdiction
    && typeof input.exempt === 'boolean' && tax.taxableBaseCents === taxable
  const base = amounts()
  if (!known) base.unknownBaseCents = invoice.subtotal_cents
  else {
    // A no-tax declaration alone does not establish an exemption. Taxable
    // marked lines remain taxable base even when their declared rate is zero.
    base[input.exempt ? 'exemptBaseCents' : 'taxableBaseCents'] = taxable
    base.nonTaxableBaseCents = invoice.subtotal_cents - taxable
  }
  return { jurisdiction, known, base, tax: { mode: tax.mode ?? null, rate: input.rate ?? null, exempt: typeof input.exempt === 'boolean' ? input.exempt : null }, fingerprint: invoice.source_fingerprint }
}

async function sources(env: Bindings, url: URL) {
  const { business, period, start, end, customer } = await selection(env, url)
  const invoices = await all(env, `SELECT i.*, c.name AS customer_name, c.erased_at FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id
    WHERE i.status='issued' AND ((i.issue_date>=? AND i.issue_date<?) OR EXISTS(SELECT 1 FROM nc_credit_notes n WHERE n.invoice_id=i.id AND n.issued_at>=? AND n.issued_at<?))
    ${customer ? 'AND i.customer_id=?' : ''} ORDER BY i.issue_date,i.id`, start, end, zonedStart(start, business.timezone), zonedStart(end, business.timezone), ...(customer ? [customer] : []))
  const entries: TaxSourceEntry[] = [], evidence = new Map<string, Row>(), unsupported: { id: string; number: string; currency: string; reason: string }[] = []
  for (const invoice of invoices) {
    const lines = await all(env, 'SELECT id,seq,kind,amount_cents,taxable FROM nc_invoice_lines WHERE invoice_id=? ORDER BY seq', invoice.id)
    const saved = parseJson<Row>(invoice.calculation_json, {})
    if (invoice.currency !== 'USD' || lines.some(line => line.kind === 'prepaid_purchase') || saved.inputs?.prepaidPurchase) {
      unsupported.push({ id: invoice.id, number: invoice.number, currency: invoice.currency, reason: invoice.currency !== 'USD' ? 'unsupported_currency' : 'prepaid_funding' })
      continue
    }
    const basis = frozen(invoice, lines)
    const href = (id: string) => { const query = new URLSearchParams({ period }); if (customer) query.set('customer', customer); return `/app/reports/tax-sources/${id}?${query}` }
    const common = { invoiceId: invoice.id, invoiceNumber: invoice.number, customerId: invoice.customer_id, customerName: invoice.erased_at ? 'Erased customer' : invoice.customer_name, jurisdiction: basis.jurisdiction }
    const original = { invoiceId: invoice.id, number: invoice.number, issueDate: invoice.issue_date, subtotalCents: invoice.subtotal_cents, taxCents: invoice.tax_cents, totalCents: invoice.total_cents, fingerprint: basis.fingerprint, declaredTax: basis.tax, lines }
    if (invoice.issue_date >= start && invoice.issue_date < end) {
      const entry: TaxSourceEntry = { ...basis.base, ...common, id: invoice.id, kind: 'invoice', number: invoice.number, date: invoice.issue_date,
        baseState: basis.known ? 'frozen_lines' : 'unknown', taxState: 'original', originalTaxCents: invoice.tax_cents, knownTaxCents: invoice.tax_cents, amountCents: invoice.total_cents, href: href(invoice.id) }
      entries.push(entry); evidence.set(entry.id, { original })
    }
    const credits = await all(env, 'SELECT * FROM nc_credit_notes WHERE invoice_id=? AND issued_at>=? AND issued_at<? ORDER BY issued_at,id', invoice.id, zonedStart(start, business.timezone), zonedStart(end, business.timezone))
    for (const credit of credits) {
      const tax = attributedCreditTax(credit)
      const entry: TaxSourceEntry = { ...amounts(), ...common, id: credit.id, kind: 'credit_note', number: credit.number, date: localDate(credit.issued_at, business.timezone),
        baseState: 'credit_not_allocated', taxState: tax === null ? 'unknown_credit' : 'attributed_credit', amountCents: credit.amount_cents,
        attributedTaxAdjustmentCents: tax === null ? 0 : -tax, knownTaxCents: tax === null ? 0 : -tax,
        attributedCreditSubtotalCents: tax === null ? 0 : credit.subtotal_cents, unattributedCreditCents: tax === null ? credit.amount_cents : 0, href: href(credit.id) }
      entries.push(entry); evidence.set(entry.id, { original, credit: { id: credit.id, number: credit.number, amountCents: credit.amount_cents, subtotalCents: tax === null ? null : credit.subtotal_cents, taxCents: tax, correctionId: credit.correction_id, cancellationId: credit.cancellation_id, voidReplacementId: credit.void_replacement_id } })
    }
  }
  const totals = amounts(), groups = new Map<string | null, TaxSourceAmounts & { jurisdiction: string | null; sourceIds: string[] }>()
  for (const entry of entries) {
    add(totals, entry)
    let group = groups.get(entry.jurisdiction)
    if (!group) { group = { ...amounts(), jurisdiction: entry.jurisdiction, sourceIds: [] }; groups.set(entry.jurisdiction, group) }
    const values = amounts(); for (const key of Object.keys(values) as (keyof TaxSourceAmounts)[]) values[key] = entry[key]
    // Sum only monetary fields; labels and source identities are not amounts.
    for (const key of Object.keys(values) as (keyof TaxSourceAmounts)[]) group[key] += values[key]
    group.sourceIds.push(entry.id)
  }
  return { report: { metric: 'tax-sources', title: 'Declared tax sources', definition: TAX_SOURCE_DEFINITION, period, start, end, timezone: business.timezone,
    totals, groups: [...groups.values()].sort((a, b) => (a.jurisdiction ?? '').localeCompare(b.jurisdiction ?? '')), entries, unsupported,
    coverage: { providerReconciliation: 'not_covered', filingFormat: 'not_covered', importedHistory: 'not_covered', creditBaseAllocation: 'not_covered' } }, evidence }
}

export async function taxSourceReport(env: Bindings, actor: Actor, url: URL) {
  requireRead(actor, 'reports')
  return (await sources(env, url)).report
}
export async function taxSourceDetail(env: Bindings, actor: Actor, id: string, url: URL) {
  requireRead(actor, 'reports')
  const { report, evidence } = await sources(env, url), entry = report.entries.find(row => row.id === id)
  insist(entry, 'report_source_not_found', 404)
  return { period: report.period, definition: report.definition, entry, evidence: evidence.get(id) }
}
