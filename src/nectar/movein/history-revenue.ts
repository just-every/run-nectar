// Read-only recognition of captured incumbent consideration. This never creates
// native invoices or changes native recognition policy/version evidence.
import type { Bindings } from '../../auth.server'
import { requireBusiness } from '../business'
import { all, fingerprint, insist, newId, parseJson, type Row } from '../core'
import { addDays, daysBetween, isDate, isMonth } from '../dates'
import { roundHalfAway } from '../decimal'
import { addRational, divideRational, multiplyRational, rational } from '../metric-plan'
import type { RevenueInvoiceRecord } from '../revenue-records'
import type { RevenueMonthEntry } from '../revenue-usage'
import type { D1Sql } from '../../modules/import-kit/src/d1/index'
import { erasureInsertStatements } from '../erasure-sql'

export const HISTORY_REVENUE_POLICY = 'nectar-imported-revenue-1'
const retainedKinds = new Set(['imported_recurring', 'imported_discount', 'imported_service'])
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value)
const safe = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
const present = (value: unknown) => value !== undefined && value !== null
const idOf = (value: unknown) => typeof value === 'string' ? value : object(value) && typeof value.id === 'string' ? value.id : null

/** Captured Stripe line amounts exclude discounts; tax-exclusive amounts take
 * precedence over gross amounts. Never distribute invoice tax across lines. */
export function historicalLineAmount(line: Row): number {
  const amount = line.amount_excluding_tax_cents ?? line.amount_excluding_tax ?? line.amount_cents ?? line.amount
  const discounts = line.discount_amount_cents ?? (Array.isArray(line.discount_amounts)
    ? line.discount_amounts.reduce((sum: number, entry: Row) => { insist(safe(entry.amount), 'history_revenue_discount_evidence_required', 409); return sum + entry.amount }, 0) : 0)
  insist(safe(amount) && safe(discounts) && discounts >= 0 && safe(amount - discounts), 'history_revenue_line_amount_required', 409)
  return amount - discounts
}

function nextMonth(date: string, count: number) {
  const [year, month, day] = date.split('-').map(Number), index = year * 12 + month - 1 + count
  const y = Math.floor(index / 12), m = index % 12 + 1
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`
}

/** Shared historical revenue/MRR allocation. Month/year recurring service uses
 * equal anchored service months, split into calendar months by service days.
 * Other service spans use saved calendar days. Cumulative rounding conserves
 * the exact captured net cents, including signed prorations and discounts. */
export function historicalLineEntries(line: Row, invoiceIssueDate: string): RevenueMonthEntry[] {
  const start = line.period_start, suppliedEnd = line.period_end
  insist(isDate(invoiceIssueDate) && isDate(start) && isDate(suppliedEnd) && suppliedEnd >= start, 'history_revenue_service_evidence_required', 409)
  const end = suppliedEnd === start ? addDays(start, 1) : suppliedEnd
  const amount = historicalLineAmount(line), price = line.price_source ?? line.price ?? line.plan ?? line.pricing?.price_details?.price
  const recurring = object(price?.recurring) ? price.recurring : object(line.recurring) ? line.recurring : object(price) && price.interval ? price : null
  const unit = line.interval_unit ?? recurring?.interval
  const count = line.interval_count ?? recurring?.interval_count ?? 1
  insist(!(line.recurring === true || recurring) || present(unit), 'history_revenue_interval_evidence_required', 409)
  if (present(unit)) insist(typeof unit === 'string' && ['day', 'week', 'month', 'year'].includes(unit) && safe(count) && count > 0, 'history_revenue_interval_evidence_required', 409)
  const monthly = (line.recurring === true || !!recurring) && ['month', 'year'].includes(String(unit))
  const pieces: { period: string; from: string; to: string; weight: ReturnType<typeof rational> }[] = []
  for (let index = 0, from = start; from < end; index++) {
    const nominalEnd = monthly ? nextMonth(start, index + 1) : end
    const stop = nominalEnd < end ? nominalEnd : end
    insist(stop > from, 'history_revenue_service_evidence_required', 409)
    for (let point = from; point < stop;) {
      const calendarEnd = nextMonth(`${point.slice(0, 7)}-01`, 1), to = calendarEnd < stop ? calendarEnd : stop
      pieces.push({ period: point.slice(0, 7), from: point, to,
        weight: rational(BigInt(daysBetween(point, to)), BigInt(monthly ? daysBetween(from, nominalEnd) : 1)) })
      point = to
    }
    from = stop
  }
  const total = pieces.reduce((sum, piece) => addRational(sum, piece.weight), rational(0n))
  const months = new Map<string, RevenueMonthEntry>()
  let elapsed = rational(0n), previous = 0n
  for (const piece of pieces) {
    elapsed = addRational(elapsed, piece.weight)
    const fraction = multiplyRational(rational(BigInt(amount)), divideRational(elapsed, total))
    const cumulative = roundHalfAway(fraction.n, fraction.d), cents = Number(cumulative - previous)
    const entry = months.get(piece.period) ?? { period: piece.period, amountCents: 0,
      basis: { method: monthly ? 'captured-equal-service-months' : 'captured-calendar-service-days', pieces: [] } }
    entry.amountCents += cents
    entry.basis.pieces.push({ from: piece.from, to: piece.to, amountCents: cents, weight: { numerator: String(piece.weight.n), denominator: String(piece.weight.d) } })
    months.set(piece.period, entry); previous = cumulative
  }
  insist(previous === BigInt(amount), 'history_revenue_line_mismatch', 409)
  return [...months.values()]
}

function capturedLines(invoice: Row, raw: Row): Row[] {
  const normalized = parseJson<Row[]>(invoice.lines_json, [])
  insist(Array.isArray(normalized), 'history_revenue_lines_required', 409)
  const originals: Row[] = Array.isArray(raw.lines?.data) ? raw.lines.data : []
  const real = normalized.filter(line => !(line.kind === 'discount' && !line.source_id && !line.id))
  const result: Row[] = real.map((line, index) => {
    const sourceId = line.source_id ?? line.id
    const original = sourceId ? originals.find(row => row.id === sourceId) : originals[index]
    const source = object(original) ? original : {}
    const expanded = [line.price_source, source.price, source.plan, source.pricing?.price_details?.price].find(object)
    const recurring = expanded?.recurring ?? (expanded?.interval ? expanded : null)
    const amount = line.amount_excluding_tax_cents ?? source.amount_excluding_tax
    // A taxable line with no tax-exclusive consideration is ambiguous; zero-tax
    // captures retain their exact amount without needing an inferred tax rate.
    insist(present(amount) || invoice.tax_cents === 0 || expanded?.tax_behavior === 'exclusive', 'history_revenue_tax_evidence_required', 409, { invoice: invoice.id, line: sourceId ?? index })
    return { ...source, ...line, source_id: sourceId ?? source.id ?? `line-${index + 1}`,
      ...(present(amount) ? { amount_excluding_tax_cents: amount } : {}),
      discount_amount_cents: line.discount_amount_cents ?? (Array.isArray(source.discount_amounts) ? source.discount_amounts.reduce((sum: number, d: Row) => { insist(safe(d.amount), 'history_revenue_discount_evidence_required', 409); return sum + d.amount }, 0) : 0),
      price_source: expanded ?? null, recurring: line.recurring ?? !!recurring,
      interval_unit: line.interval_unit ?? recurring?.interval,
      interval_count: line.interval_count ?? recurring?.interval_count,
      price_ref: line.price_ref ?? idOf(source.price ?? source.pricing?.price_details?.price) }
  })
  // Legacy captures can store invoice discounts as a separate, explicitly dated
  // line. Keep that original evidence only when line attribution is unavailable.
  const capturedDiscount = result.reduce((sum, line) => sum + line.discount_amount_cents, 0)
  const synthetic = normalized.filter(line => line.kind === 'discount' && !line.source_id && !line.id)
  if (capturedDiscount) insist(synthetic.length === 0 || synthetic.reduce((sum, line) => sum + historicalLineAmount(line), 0) === -capturedDiscount, 'history_revenue_discount_mismatch', 409)
  else result.push(...synthetic.map((line, index) => ({ ...line, source_id: `discount-${index + 1}`, discount_amount_cents: 0 })))
  insist(new Set(result.map(line => line.source_id)).size === result.length, 'history_revenue_duplicate_line', 409)
  return result
}

export async function historicalRevenueRecord(invoice: Row, timezone: string): Promise<RevenueInvoiceRecord> {
  insist(invoice.currency?.toLowerCase() === 'usd' && isDate(invoice.issue_date), 'history_revenue_invoice_evidence_required', 409, { invoice: invoice.id })
  const raw = parseJson<Row>(invoice.source_json, {})
  insist(object(raw), 'history_revenue_invoice_evidence_required', 409, { invoice: invoice.id })
  const lines = capturedLines(invoice, raw), subtotal = invoice.total_cents - invoice.tax_cents
  insist(safe(invoice.total_cents) && safe(invoice.tax_cents) && safe(subtotal) && lines.reduce((sum, line) => sum + BigInt(historicalLineAmount(line)), 0n) === BigInt(subtotal), 'history_revenue_invoice_mismatch', 409, { invoice: invoice.id })
  const sourceFingerprint = await fingerprint({ provider: invoice.provider, providerRef: invoice.provider_ref, source: invoice.source_json, lines: invoice.lines_json, issueDate: invoice.issue_date, total: invoice.total_cents, tax: invoice.tax_cents })
  const source = { kind: 'imported' as const, provider: invoice.provider, providerRef: invoice.provider_ref,
    href: `/app/customers/${invoice.customer_id}#history-${invoice.id}`, policyVersion: HISTORY_REVENUE_POLICY }
  return { invoice: { ...invoice, subtotal_cents: subtotal, source_fingerprint: sourceFingerprint }, custody: 'derived-imported-originals', source, credits: [],
    schedules: lines.map(line => ({ lineId: line.source_id, kind: line.recurring ? 'imported_recurring' : line.kind === 'discount' ? 'imported_discount' : 'imported_service',
      amountCents: historicalLineAmount(line), serviceStart: line.period_start, serviceEnd: line.period_end === line.period_start ? addDays(line.period_start, 1) : line.period_end,
      policy: HISTORY_REVENUE_POLICY, entries: historicalLineEntries(line, invoice.issue_date),
      basis: { version: HISTORY_REVENUE_POLICY, timezone, source, sourceFingerprint, sourceLineId: line.source_id, priceRef: line.price_ref, capturedLine: line } })) }
}

/** After withdrawal, only the separately retained numeric projection is read.
 * Extra captured fields can never leak through this explicit financial shape. */
function retainedRevenueRecord(invoice: Row): RevenueInvoiceRecord {
  insist(invoice.retained_policy_version === HISTORY_REVENUE_POLICY && isDate(invoice.issue_date), 'history_revenue_retention_evidence_required', 409)
  const savedSchedules = parseJson<Row[]>(invoice.retained_schedules_json, []), savedCredits = parseJson<Row[]>(invoice.retained_credits_json, [])
  insist(Array.isArray(savedSchedules) && Array.isArray(savedCredits), 'history_revenue_retention_evidence_required', 409)
  const opaque = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  const schedules = savedSchedules.map(schedule => {
    insist(opaque(schedule.lineId) && retainedKinds.has(schedule.kind) && safe(schedule.amountCents) && isDate(schedule.serviceStart) && isDate(schedule.serviceEnd) && schedule.serviceStart < schedule.serviceEnd && Array.isArray(schedule.entries), 'history_revenue_retention_evidence_required', 409)
    const entries: RevenueMonthEntry[] = schedule.entries.map((entry: Row) => {
      insist(isMonth(entry.period) && safe(entry.amountCents), 'history_revenue_retention_evidence_required', 409)
      return { period: entry.period, amountCents: entry.amountCents, basis: {} }
    })
    insist(entries.length && new Set(entries.map(entry => entry.period)).size === entries.length && entries.reduce((sum, entry) => sum + BigInt(entry.amountCents), 0n) === BigInt(schedule.amountCents), 'history_revenue_retention_mismatch', 409)
    return { lineId: schedule.lineId, kind: schedule.kind, amountCents: schedule.amountCents, serviceStart: schedule.serviceStart,
      serviceEnd: schedule.serviceEnd, policy: HISTORY_REVENUE_POLICY, entries, basis: {} }
  })
  const credits = savedCredits.map(credit => {
    insist(opaque(credit.id) && typeof credit.number === 'string' && isMonth(credit.period) && safe(credit.amountCents) && credit.amountCents <= 0, 'history_revenue_retention_evidence_required', 409)
    return { id: credit.id, number: credit.number, period: credit.period, amountCents: credit.amountCents, basis: {} }
  })
  const subtotal = invoice.total_cents - invoice.tax_cents
  insist(safe(subtotal) && schedules.reduce((sum, schedule) => sum + BigInt(schedule.amountCents), 0n) === BigInt(subtotal) && new Set(schedules.map(schedule => schedule.lineId)).size === schedules.length && new Set(credits.map(credit => credit.id)).size === credits.length, 'history_revenue_retention_mismatch', 409)
  return { invoice: { id: invoice.id, customer_id: invoice.customer_id, customer_name: invoice.customer_name, number: invoice.number,
    issue_date: invoice.issue_date, subtotal_cents: subtotal, tax_cents: invoice.tax_cents, total_cents: invoice.total_cents,
    source_fingerprint: invoice.retained_source_fingerprint }, schedules, credits, custody: 'derived-imported-originals',
    source: { kind: 'imported', provider: 'retained', providerRef: '', href: `/app/customers/${invoice.customer_id}#history-${invoice.id}`, policyVersion: HISTORY_REVENUE_POLICY } }
}

/** Prepare before erasure planning; insert after privacy authorization, before
 * any redaction in the same batch. The generation fence binds this earlier
 * projection to the original source image even if planning reads later. */
export async function historicalRevenueRetention(env: Bindings, customerId: string): Promise<D1Sql[]> {
  const generation = (await all(env, 'SELECT value FROM nc_privacy_generation WHERE id=1'))[0]?.value
  insist(safe(generation), 'history_revenue_retention_fence_required', 409)
  const records = await historicalRevenueInvoices(env, null, customerId)
  if (!records.length) return []
  const rows = records.map(record => {
    const schedules = record.schedules.map(schedule => {
      insist(retainedKinds.has(schedule.kind), 'history_revenue_retention_kind_required', 409)
      return { lineId: newId(), kind: schedule.kind, amountCents: schedule.amountCents, serviceStart: schedule.serviceStart, serviceEnd: schedule.serviceEnd,
        policy: HISTORY_REVENUE_POLICY, entries: schedule.entries.map(entry => ({ period: entry.period, amountCents: entry.amountCents, basis: {} })), basis: {} }
    })
    const credits = record.credits.map(credit => ({ id: newId(), number: credit.number, period: credit.period, amountCents: credit.amountCents, basis: {} }))
    return [record.invoice.id, customerId, JSON.stringify(schedules), JSON.stringify(credits), record.invoice.source_fingerprint, HISTORY_REVENUE_POLICY]
  })
  return [{ sql: "INSERT INTO nc_guard(code,ok) SELECT 'stale',CASE WHEN (SELECT value FROM nc_privacy_generation WHERE id=1)=? THEN 1 ELSE 0 END", params: [generation] },
    ...erasureInsertStatements('nc_incumbent_revenue', ['invoice_id', 'customer_id', 'schedules_json', 'credits_json', 'source_fingerprint', 'policy_version'], rows)]
}

/** Read captured documents once. A native charge for the same imported price
 * and service interval is an explicit conflict, never silently counted twice. */
export async function historicalRevenueInvoices(env: Bindings, invoice: string | null, customer: string | null): Promise<RevenueInvoiceRecord[]> {
  const rows = await all(env, `SELECT i.*,c.name AS customer_name,c.erased_at,r.schedules_json AS retained_schedules_json,r.credits_json AS retained_credits_json,
      r.source_fingerprint AS retained_source_fingerprint,r.policy_version AS retained_policy_version
    FROM nc_incumbent_invoices i JOIN nc_customers c ON c.id=i.customer_id LEFT JOIN nc_incumbent_revenue r ON r.invoice_id=i.id AND r.customer_id=i.customer_id
    WHERE ((c.erased_at IS NULL AND i.source_json<>'{}' AND i.issue_date IS NOT NULL) OR (c.erased_at IS NOT NULL AND r.invoice_id IS NOT NULL))
      AND i.document_kind='invoice' AND i.status IN ('paid','open','uncollectible') AND (? IS NULL OR i.id=?) AND (? IS NULL OR i.customer_id=?) ORDER BY i.issue_date,i.id`, invoice, invoice, customer, customer)
  if (!rows.length) return []
  const business = await requireBusiness(env)
  const native = await all(env, `SELECT i.subscription_id,i.customer_id,l.period_start,l.period_end,p.provider_ref FROM nc_invoice_lines l JOIN nc_invoices i ON i.id=l.invoice_id JOIN nc_prices p ON p.id=l.price_id WHERE i.status='issued' AND i.invoice_kind='recurring' AND p.provider_ref IS NOT NULL AND (? IS NULL OR i.customer_id=?)`, customer, customer)
  const credits = await all(env, `SELECT * FROM nc_incumbent_invoices WHERE document_kind='credit-note' AND status='issued' AND (? IS NULL OR customer_id=?) ORDER BY issue_date,id`, customer, customer)
  const records: RevenueInvoiceRecord[] = []
  for (const row of rows) {
    if (row.erased_at) { records.push(retainedRevenueRecord(row)); continue }
    const record = await historicalRevenueRecord(row, business.timezone)
    for (const schedule of record.schedules) insist(!native.some(line => line.customer_id === row.customer_id && schedule.basis.priceRef && line.provider_ref === schedule.basis.priceRef && line.period_start < schedule.serviceEnd && line.period_end > schedule.serviceStart), 'history_revenue_native_overlap', 409, { invoice: row.id, line: schedule.lineId })
    for (const credit of credits) {
      const raw = parseJson<Row>(credit.source_json, {}), legacy = parseJson<Row>(credit.lines_json, {})
      if (credit.customer_id !== row.customer_id || idOf(raw.invoice ?? legacy.invoice) !== row.provider_ref) continue
      const amount = credit.total_cents - credit.tax_cents
      insist(isDate(credit.issue_date) && credit.currency?.toLowerCase() === 'usd' && safe(amount) && amount >= 0, 'history_revenue_credit_evidence_required', 409, { credit: credit.id })
      record.credits.push({ id: credit.id, number: credit.number, period: credit.issue_date.slice(0, 7), amountCents: -amount,
        basis: { version: HISTORY_REVENUE_POLICY, method: 'captured-invoice-level-contra-revenue', custody: 'derived-imported-originals',
          provider: credit.provider, providerRef: credit.provider_ref, invoiceProviderRef: row.provider_ref, originalTaxUnchanged: true,
          sourceFingerprint: await fingerprint({ source: credit.source_json, lines: credit.lines_json, total: credit.total_cents, tax: credit.tax_cents, issueDate: credit.issue_date }),
          href: `/app/customers/${credit.customer_id}#history-${credit.id}` } })
    }
    records.push(record)
  }
  return records
}
