import { recognizedPrepaidPurchase } from './prepaid-revenue'
// Schedules are written only alongside invoice/credit issue. Older invoices
// project this version from immutable originals; reads never initialize rows.
import type { Bindings } from '../auth.server'
import { requireBusiness } from './business'
import { all, guard, insist, one, parseJson, stmt, type Row } from './core'
import { isDate, localDate } from './dates'
import { REVENUE_POLICY_VERSION, recognitionForSavedInvoice, type RevenueSchedule } from './revenue-allocation'
import { historicalRevenueInvoices } from './movein/history-revenue'

export interface RevenueInvoiceRecord {
  invoice: Row
  schedules: RevenueSchedule[]
  credits: { id: string; number: string; period: string; amountCents: number; recognitionCents?: number; basis: Row }[]
  custody: 'issue-snapshot' | 'derived-saved-originals' | 'derived-imported-originals'
  source?: { kind: 'imported'; provider: string; providerRef: string; href: string; policyVersion: string }
}

export interface RevenueEntity {
  id: string | null
  name: string | null
  custody: 'issued-entity' | 'installation-business' | 'imported-unassigned'
}

/** Imported customer assignment does not identify the original invoice issuer.
 * Native attribution uses only immutable issue columns, including after erasure
 * withdraws the saved legal label. Current customer/entity settings never enter. */
export function revenueEntity(record: RevenueInvoiceRecord): RevenueEntity {
  if (record.source) return { id: null, name: null, custody: 'imported-unassigned' }
  const id = record.invoice.billing_entity_id ?? null
  const route = parseJson<Row>(record.invoice.billing_route_json, {})
  insist(!route.entityId || route.entityId === id, 'revenue_entity_snapshot_mismatch', 409)
  return { id, name: typeof route.legalName === 'string' ? route.legalName : null,
    custody: id ? 'issued-entity' : 'installation-business' }
}

export async function revenueIssueStatements(env: Bindings, invoice: Row): Promise<D1PreparedStatement[]> {
  insist(typeof invoice.id === 'string' && isDate(invoice.issue_date), 'revenue_issue_date_required', 409)
  const business = await requireBusiness(env)
  const lines = await all(env, 'SELECT * FROM nc_invoice_lines WHERE invoice_id=? ORDER BY seq', invoice.id)
  const schedules = recognitionForSavedInvoice({ ...invoice, status: 'issued' }, lines, business.timezone)
  const statements = [guard(env, 'revenue_source_changed', `EXISTS(SELECT 1 FROM nc_invoices WHERE id=? AND customer_id=? AND status='issued' AND issue_date=? AND subtotal_cents=? AND source_fingerprint=? AND calculation_json=?)`, invoice.id, invoice.customer_id, invoice.issue_date, invoice.subtotal_cents, invoice.source_fingerprint, invoice.calculation_json)]
  for (const schedule of schedules) {
    statements.push(stmt(env, `INSERT INTO nc_revenue_schedules(id,line_id,invoice_id,customer_id,policy_version,policy,kind,amount_cents,service_start,service_end,source_fingerprint,basis_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, schedule.lineId, schedule.lineId, invoice.id, invoice.customer_id, REVENUE_POLICY_VERSION, schedule.policy, schedule.kind, schedule.amountCents, schedule.serviceStart, schedule.serviceEnd, invoice.source_fingerprint, JSON.stringify(schedule.basis)))
    for (const entry of schedule.entries) statements.push(stmt(env, `INSERT INTO nc_revenue_entries(id,schedule_id,line_id,invoice_id,customer_id,recognition_date,amount_cents,basis_json) VALUES(?,?,?,?,?,?,?,?)`,
      `${schedule.lineId}:${entry.period}`, schedule.lineId, schedule.lineId, invoice.id, invoice.customer_id, `${entry.period}-01`, entry.amountCents, JSON.stringify(entry.basis)))
  }
  return statements
}

export interface RevenueCreditIssue { id: string; invoice: string; customer: string; amountCents: number; issuedAt: number }
export async function revenueCreditStatements(env: Bindings, credit: RevenueCreditIssue): Promise<D1PreparedStatement[]> {
  insist(Number.isSafeInteger(credit.amountCents) && credit.amountCents > 0 && Number.isSafeInteger(credit.issuedAt), 'revenue_invalid_credit', 409)
  const business = await requireBusiness(env)
  const period = localDate(credit.issuedAt, business.timezone).slice(0, 7)
  const prepaid = !!await one(env,"SELECT 1 FROM nc_invoice_lines WHERE invoice_id=? AND kind='prepaid_purchase'",credit.invoice)
  return [
    guard(env, 'revenue_credit_changed', `EXISTS(SELECT 1 FROM nc_credit_notes n JOIN nc_invoices i ON i.id=n.invoice_id WHERE n.id=? AND n.invoice_id=? AND n.customer_id=? AND n.amount_cents=? AND n.issued_at=? AND i.status='issued' AND i.customer_id=n.customer_id)`, credit.id, credit.invoice, credit.customer, credit.amountCents, credit.issuedAt),
    stmt(env, `INSERT INTO nc_revenue_credits(id,credit_id,invoice_id,customer_id,recognition_date,amount_cents,policy_version,basis_json) VALUES(?,?,?,?,?,?,?,?)`, credit.id, credit.id, credit.invoice, credit.customer, `${period}-01`, -credit.amountCents, REVENUE_POLICY_VERSION,
      JSON.stringify({ method: prepaid ? 'unfunded-prepaid-liability-reversal' : 'invoice-level-contra-revenue', ...(prepaid?{recognitionCents:0}:{}), creditId: credit.id, invoiceId: credit.invoice, issuedAt: credit.issuedAt, timezone: business.timezone, originalTaxUnchanged: true, lineAllocation: 'No attribution to original lines or tax is inferred.' })),
  ]
}

/** One invoice's persisted schedules or explicit historical read projection.
 * No catalogue, current usage or changed customer identity enters recognition. */
function projectInvoice(invoice: Row, stored: Row[], entries: Row[], lines: Row[], creditNotes: Row[], creditRows: Row[], prepaidRows: Row[], timezone: string): RevenueInvoiceRecord {
  const id = invoice.id
  let custody: RevenueInvoiceRecord['custody'] = 'issue-snapshot'
  let schedules: RevenueSchedule[]
  if (stored.length) {
    insist(stored.length === lines.length && stored.every(row => (invoice.erased_at || row.policy_version === REVENUE_POLICY_VERSION) && lines.some(line => line.id === row.line_id)), 'revenue_snapshot_incomplete', 409)
    schedules = stored.map(row => ({ lineId: row.line_id, kind: row.kind, amountCents: row.amount_cents, serviceStart: row.service_start, serviceEnd: row.service_end, policy: row.policy || 'withdrawn-after-erasure',
      basis: parseJson<Row>(row.basis_json, {}), entries: entries.filter(entry => entry.schedule_id === row.id).map(entry => ({ period: entry.recognition_date.slice(0, 7), amountCents: entry.amount_cents, basis: parseJson<Row>(entry.basis_json, {}) })) }))
    schedules = schedules.map(schedule => recognizedPrepaidPurchase(schedule, prepaidRows))
    insist(schedules.every(schedule => schedule.kind === 'prepaid_purchase' || schedule.entries.length && schedule.entries.reduce((sum, entry) => sum + BigInt(entry.amountCents), 0n) === BigInt(schedule.amountCents)), 'revenue_snapshot_incomplete', 409)
    insist(schedules.reduce((sum, schedule) => sum + BigInt(schedule.amountCents), 0n) === BigInt(invoice.subtotal_cents), 'revenue_snapshot_incomplete', 409)
  } else {
    insist(!invoice.erased_at, 'revenue_originals_unavailable_after_erasure', 409, { invoice: id })
    custody = 'derived-saved-originals'
    schedules = recognitionForSavedInvoice(invoice, lines, timezone).map(schedule => recognizedPrepaidPurchase(schedule, prepaidRows))
  }
  const credits = creditNotes.map(note => {
    const saved = creditRows.find(row => row.credit_id === note.id)
    if (saved) insist(saved.amount_cents === -(note.subtotal_cents??note.amount_cents) && (invoice.erased_at || saved.policy_version === REVENUE_POLICY_VERSION), 'revenue_credit_snapshot_mismatch', 409)
    const creditBasis=saved?parseJson<Row>(saved.basis_json,{}):{}
    const prepaid=lines.some(line=>line.kind==='prepaid_purchase')
    insist(invoice.erased_at || !prepaid || !saved || creditBasis.recognitionCents===0,'revenue_prepaid_credit_basis_required',409)
    return { id: note.id, number: note.number, ...(prepaid?{recognitionCents:0}:{}), period: saved?.recognition_date.slice(0, 7) ?? localDate(note.issued_at, timezone).slice(0, 7), amountCents: -(note.subtotal_cents??note.amount_cents),
      basis: saved ? parseJson<Row>(saved.basis_json, {}) : { version: REVENUE_POLICY_VERSION, method: 'invoice-level-contra-revenue', creditId: note.id, invoiceId: id, issuedAt: note.issued_at, timezone, custody: 'derived-saved-originals', originalTaxUnchanged: true } }
  })
  return { invoice, schedules, credits, custody }
}

async function loadRevenueInvoices(env: Bindings, invoice: string | null, customer: string | null, entity: string | null = null): Promise<RevenueInvoiceRecord[]> {
  const business = await requireBusiness(env)
  const condition = "i.status='issued' AND (? IS NULL OR i.id=?) AND (? IS NULL OR i.customer_id=?) AND (? IS NULL OR (?='business' AND i.billing_entity_id IS NULL) OR i.billing_entity_id=?)"
  const params = [invoice, invoice, customer, customer, entity, entity, entity]
  // One read batch binds invoices, lines, credit notes and snapshots to one
  // database view, with a fixed query count for a whole-company report.
  const results = await env.DB.batch<Row>([
    stmt(env, `SELECT i.*,c.name AS customer_name,c.erased_at FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id WHERE ${condition} ORDER BY i.issue_date,i.id`, ...params),
    ...[
      ['nc_revenue_schedules', 'r.line_id'], ['nc_revenue_entries', 'r.recognition_date,r.id'],
      ['nc_invoice_lines', 'r.seq'], ['nc_credit_notes', 'r.issued_at,r.number,r.id'], ['nc_revenue_credits', 'r.id'],
    ].map(([table, order]) => stmt(env, `SELECT r.* FROM ${table} r JOIN nc_invoices i ON i.id=r.invoice_id WHERE ${condition} ORDER BY ${order}`, ...params)),
    stmt(env, `SELECT r.id,r.kind,r.correction_kind,r.grant_id,r.subscription_id,r.service_date,r.recognition_cents,r.invoice_id AS service_invoice_id,r.purchase_line_id,r.purchase_invoice_id AS invoice_id FROM nc_prepaid_ledger r JOIN nc_invoices i ON i.id=r.purchase_invoice_id WHERE ${condition} AND r.recognition_cents<>0 ORDER BY r.service_date,r.id`, ...params),
  ])
  const [invoices, stored, entries, lines, creditNotes, creditRows, prepaidRows] = results.map(result => result.results)
  const grouped = [stored, entries, lines, creditNotes, creditRows, prepaidRows].map(rows => {
    const map = new Map<string, Row[]>()
    for (const row of rows) { const group = map.get(row.invoice_id) ?? []; group.push(row); map.set(row.invoice_id, group) }
    return map
  })
  return invoices.map(row => projectInvoice(row, grouped[0].get(row.id) ?? [], grouped[1].get(row.id) ?? [], grouped[2].get(row.id) ?? [], grouped[3].get(row.id) ?? [], grouped[4].get(row.id) ?? [], grouped[5].get(row.id) ?? [], business.timezone))
}

export async function revenueInvoice(env: Bindings, id: string): Promise<RevenueInvoiceRecord> {
  const rows = [...await loadRevenueInvoices(env, id, null), ...await historicalRevenueInvoices(env, id, null)]
  insist(rows.length === 1, 'revenue_invoice_not_found', 404)
  return rows[0]
}
export async function revenueInvoices(env: Bindings, customer: string | null = null, entity: string | null = null): Promise<RevenueInvoiceRecord[]> {
  const rows = [...(entity === 'imported' ? [] : await loadRevenueInvoices(env, null, customer, entity)),
    ...(entity === null || entity === 'imported' ? await historicalRevenueInvoices(env, null, customer) : [])]
  insist(new Set(rows.map(row => row.invoice.id)).size === rows.length, 'history_revenue_duplicate_invoice', 409)
  return rows
}
