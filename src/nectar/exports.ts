// Flow 13: leave with the data. Invoices, usage and subscriptions as CSV, a
// bill run as one auditable JSON document with its calculation evidence and
// approvals, and an explanation for every entitlement decision. The complete
// restore package is the installation archive from `rer export`.
import type { Bindings } from '../auth.server'
import { requireCapability, type Actor } from './actor'
import { requireBusiness } from './business'
import { all, insist, one, parseJson, type Row } from './core'
import { metadataFor,withMetadata } from './metadata'
import { metadataFilter,metadataPredicate } from './metadata-query'
import { customerNotes } from './note-records'
import { plainMoney } from './decimal'
import { isDate, today } from './dates'

const cell = (value: unknown) => {
  const text = value === null || value === undefined ? '' : String(value)
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}
const csv = (header: string[], rows: unknown[][]) => [header, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n'

const file = (body: string, name: string, type: string) => new Response(body, { headers: { 'content-type': type, 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } })

export async function invoicesCsv(env: Bindings, actor: Actor,url?:URL) {
  requireCapability(actor, 'export')
  const filter=metadataPredicate('invoice','i.id',url?metadataFilter(url):null)
  const rows = await all(env, `SELECT i.number, i.status, c.external_id, c.name, i.period_start, i.period_end, i.issue_date, i.due_date, i.subtotal_cents, i.tax_cents, i.total_cents,
    COALESCE((SELECT SUM(amount_cents) FROM nc_credit_notes WHERE invoice_id = i.id), 0) AS credited, COALESCE((SELECT SUM(amount_cents) FROM nc_allocations WHERE invoice_id = i.id), 0) AS paid, i.calc_version, i.approved_fingerprint, i.approved_by, i.issued_by, i.id
    FROM nc_invoices i JOIN nc_customers c ON c.id = i.customer_id WHERE i.status = 'issued' AND ${filter.sql} ORDER BY i.number`,...filter.params)
  const meta=await withMetadata(env,'invoice',rows)
  return file(csv(['number', 'status', 'customer_external_id', 'customer', 'period_start', 'period_end', 'issue_date', 'due_date', 'subtotal', 'tax', 'total', 'credited', 'paid', 'balance', 'calculation_version', 'source_fingerprint', 'approved_by', 'issued_by', 'invoice_id','metadata_json'],
    meta.map(r => [r.number, r.status, r.external_id, r.name, r.period_start, r.period_end, r.issue_date, r.due_date, plainMoney(r.subtotal_cents), plainMoney(r.tax_cents), plainMoney(r.total_cents), plainMoney(r.credited), plainMoney(r.paid), plainMoney(r.total_cents - r.credited - r.paid), r.calc_version, r.approved_fingerprint, r.approved_by, r.issued_by, r.id,JSON.stringify(r.metadata)])), 'nectar-invoices.csv', 'text/csv; charset=utf-8')
}

export async function usageCsv(env: Bindings, actor: Actor) {
  requireCapability(actor, 'export')
  const rows = await all(env, `SELECT e.event_id, c.external_id, m.code, e.quantity, e.occurred_text, e.received_at, e.status, e.void_reason, i.number FROM nc_usage_events e JOIN nc_customers c ON c.id = e.customer_id JOIN nc_meters m ON m.id = e.meter_id LEFT JOIN nc_invoices i ON i.id = e.invoice_id ORDER BY e.occurred_at, e.event_id`)
  return file(csv(['event_id', 'customer_external_id', 'meter', 'quantity', 'occurred_at', 'received_at', 'status', 'void_reason', 'invoice_number'],
    rows.map(r => [r.event_id, r.external_id, r.code, r.quantity, r.occurred_text, new Date(r.received_at).toISOString(), r.status, r.void_reason, r.number])), 'nectar-usage.csv', 'text/csv; charset=utf-8')
}

export async function subscriptionsCsv(env: Bindings, actor: Actor,url?:URL) {
  requireCapability(actor, 'export')
  const filter=metadataPredicate('subscription','s.id',url?metadataFilter(url):null)
  const rows = await all(env, `SELECT s.id, s.external_id, c.external_id AS customer, s.anchor_day, s.start_date, s.trial_end, s.end_date, s.billing_mode, s.cutover_start, s.provider_ref, pr.code AS product, p.version, p.kind, p.unit_amount, i.quantity, i.effective_from, i.effective_to
    FROM nc_subscriptions s JOIN nc_customers c ON c.id = s.customer_id JOIN nc_items i ON i.subscription_id = s.id JOIN nc_prices p ON p.id = i.price_id JOIN nc_products pr ON pr.id = p.product_id WHERE ${filter.sql} ORDER BY c.external_id, s.id, i.effective_from`,...filter.params)
  const meta=await withMetadata(env,'subscription',rows)
  return file(csv(['subscription_id', 'subscription_external_id', 'customer_external_id', 'anchor_day', 'start_date', 'trial_end', 'end_date', 'billing_mode', 'cutover_start', 'provider_ref', 'product', 'price_version', 'price_kind', 'unit_amount', 'quantity', 'item_from', 'item_to','metadata_json'],
    meta.map(r => [r.id, r.external_id, r.customer, r.anchor_day, r.start_date, r.trial_end, r.end_date, r.billing_mode, r.cutover_start, r.provider_ref, r.product, r.version, r.kind, r.unit_amount, r.quantity, r.effective_from, r.effective_to,JSON.stringify(r.metadata)])), 'nectar-subscriptions.csv', 'text/csv; charset=utf-8')
}

/** One bill run with every invoice, line, calculation input, approval and issue event. */
export async function billRunJson(env: Bindings, actor: Actor, id: string) {
  requireCapability(actor, 'export')
  const run = await one(env, 'SELECT * FROM nc_bill_runs WHERE id = ?', id)
  insist(run, 'bill_run_not_found', 404)
  const invoices = await all(env, "SELECT * FROM nc_invoices WHERE bill_run_id = ? AND status <> 'discarded' ORDER BY number, id", id)
  const documents = []
  for (const invoice of invoices) {
    const lines = await all(env, 'SELECT seq, kind, description, quantity, unit_amount, amount_cents, taxable, price_id, meter_id, period_start, period_end, evidence_json FROM nc_invoice_lines WHERE invoice_id = ? ORDER BY seq', invoice.id)
    const audit = await all(env, 'SELECT at, actor, action, detail FROM nc_audit WHERE subject = ? ORDER BY seq', invoice.id)
    documents.push({
      id: invoice.id,...await metadataFor(env,'invoice',invoice.id), number: invoice.number, status: invoice.status, customer: invoice.customer_id, subscription: invoice.subscription_id, period: { start: invoice.period_start, end: invoice.period_end },
      issueDate: invoice.issue_date, dueDate: invoice.due_date, subtotalCents: invoice.subtotal_cents, taxCents: invoice.tax_cents, totalCents: invoice.total_cents,
      calculation: parseJson(invoice.calculation_json, {}), comparison: parseJson(invoice.comparison_json, {}), exceptions: parseJson(invoice.exceptions_json, []),
      approval: { fingerprint: invoice.approved_fingerprint, by: invoice.approved_by, at: invoice.approved_at }, issued: { by: invoice.issued_by, at: invoice.issued_at },
      lines: lines.map(line => ({ ...line, evidence: parseJson(line.evidence_json, {}), evidence_json: undefined })), audit: audit.map(event => ({ ...event, detail: parseJson(event.detail, {}) })),
    })
  }
  const body = JSON.stringify({ format: 'nectar-bill-run-1', run: { ...run, summary: parseJson(run.summary_json, {}), summary_json: undefined }, invoices: documents }, null, 2)
  return file(body, `nectar-bill-run-${run.period}.json`, 'application/json; charset=utf-8')
}

/** Why a customer does or does not have a feature on a date: every subscription's path, step by step. */
export async function explainEntitlement(env: Bindings, actor: Actor, customerId: string, feature: string, date?: string) {
  requireCapability(actor, 'read')
  const business = await requireBusiness(env)
  const day = date && isDate(date) ? date : today(business.timezone)
  const customer = await one(env, 'SELECT id, name, external_id, status FROM nc_customers WHERE id = ? OR external_id = ?', customerId, customerId)
  insist(customer, 'customer_not_found', 404)
  const subs = await all(env, 'SELECT * FROM nc_subscriptions WHERE customer_id = ? ORDER BY created_at', customer.id)
  const paths = []
  for (const sub of subs) {
    const steps: string[] = []
    let granted = false
    if (sub.start_date > day) steps.push(`Subscription starts ${sub.start_date}, after ${day}.`)
    else if (sub.end_date && sub.end_date <= day) steps.push(`Subscription ended ${sub.end_date}.`)
    else {
      steps.push(sub.trial_end && sub.trial_end > day ? `Subscription is in its trial until ${sub.trial_end}; trials carry the plan's features.` : 'Subscription is active.')
      const items = await all(env, `SELECT i.quantity, p.version, pr.id AS product_id, pr.name AS product_name, f.feature FROM nc_items i JOIN nc_prices p ON p.id = i.price_id JOIN nc_products pr ON pr.id = p.product_id
        LEFT JOIN nc_features f ON f.product_id = pr.id AND f.feature = ? WHERE i.subscription_id = ? AND i.effective_from <= ? AND (i.effective_to IS NULL OR i.effective_to > ?)`, feature, sub.id, day, day)
      if (!items.length) steps.push('No plan item is in effect on this date.')
      for (const item of items as Row[]) {
        if (item.feature) { granted = true; steps.push(`${item.product_name} (price v${item.version}) grants "${feature}".`) }
        else steps.push(`${item.product_name} (price v${item.version}) does not grant "${feature}".`)
      }
    }
    paths.push({ subscription: sub.id, granted, steps })
  }
  if (!subs.length) paths.push({ subscription: null, granted: false, steps: ['The customer has no subscriptions.'] })
  return { customer: { id: customer.id, name: customer.name, externalId: customer.external_id }, feature, date: day, allowed: paths.some(path => path.granted), paths }
}

/** Every feature the customer holds today, each with its explanation. */
export async function entitlements(env: Bindings, actor: Actor, customerId: string) {
  requireCapability(actor, 'read')
  const features = await all(env, 'SELECT DISTINCT f.feature FROM nc_features f JOIN nc_prices p ON p.product_id = f.product_id JOIN nc_items i ON i.price_id = p.id JOIN nc_subscriptions s ON s.id = i.subscription_id WHERE s.customer_id = ? ORDER BY f.feature', customerId)
  return await Promise.all(features.map(row => explainEntitlement(env, actor, customerId, row.feature)))
}

/** Customer custody export, including every note and mention delivery outcome. */
export async function customersCsv(env: Bindings, actor: Actor,url?:URL) {
  requireCapability(actor, 'export')
  const filter=metadataPredicate('customer','c.id',url?metadataFilter(url):null)
  const customers = await all(env, `SELECT c.id,c.external_id,c.name,c.billing_email,c.address FROM nc_customers c WHERE ${filter.sql} ORDER BY c.external_id`,...filter.params)
  const rows = await Promise.all(customers.map(async c => [c.id,c.external_id,c.name,c.billing_email,c.address,JSON.stringify(await customerNotes(env,c.id)),JSON.stringify((await metadataFor(env,'customer',c.id)).metadata)]))
  return file(csv(['customer_id','external_id','name','billing_email','address','notes_json','metadata_json'], rows), 'nectar-customers.csv', 'text/csv; charset=utf-8')
}
