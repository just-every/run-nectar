import type { Bindings } from '../auth.server'
import { all, one } from '../nectar/core'
import { insert } from './records'

type Entry = { at: number; actor: string; action: string; subject: string; detail: Record<string, unknown> }

// The audit trail for the sample book, written from the records it audits: each
// entry carries its record's own moment and actor, oldest first, as the app's
// own actions would have written them. A rerun leaves an existing trail alone.
export async function seedHistory(env: Bindings) {
  if ((await one<{ n: number }>(env, 'SELECT COUNT(*) AS n FROM nc_audit'))!.n) return
  const owner = (await one<{ email: string; created_at: number }>(env, "SELECT email, created_at FROM nc_members WHERE role = 'owner' ORDER BY created_at LIMIT 1"))!
  const b = (await one(env, 'SELECT * FROM nc_business WHERE singleton = 1'))!
  const entries: Entry[] = [
    { at: b.updated_at, actor: owner.email, action: 'business.configure', subject: 'business', detail: { legalName: b.legal_name, timezone: b.timezone, prefix: b.invoice_prefix, terms: b.payment_terms_days } },
    { at: b.tax_reviewed_at - 60000, actor: owner.email, action: 'tax.declare', subject: 'business', detail: { jurisdiction: b.tax_jurisdiction, mode: b.tax_mode, rate: b.tax_rate, note: b.tax_note } },
    { at: b.tax_reviewed_at, actor: b.tax_reviewed_by, action: 'tax.review', subject: 'business', detail: { jurisdiction: b.tax_jurisdiction, mode: b.tax_mode, rate: b.tax_rate } },
  ]
  const add = async (sql: string, entry: (row: any) => Entry) => { for (const row of await all(env, sql)) entries.push(entry(row)) }
  await add("SELECT * FROM nc_members WHERE role <> 'owner'", m => ({ at: m.created_at, actor: owner.email, action: 'access.give', subject: m.id, detail: { email: m.email, role: m.role, invited: true } }))
  await add('SELECT * FROM nc_agent_keys', k => ({ at: k.created_at, actor: k.created_by, action: 'credential.issue', subject: k.id, detail: { name: k.name, scopes: k.scopes.split(' ') } }))
  await add('SELECT * FROM nc_meters', m => ({ at: m.created_at, actor: owner.email, action: 'meter.create', subject: m.id, detail: { code: m.code, name: m.name, unit: m.unit_label } }))
  await add('SELECT * FROM nc_products', p => ({ at: p.created_at, actor: owner.email, action: 'product.create', subject: p.id, detail: { code: p.code, name: p.name } }))
  await add('SELECT p.*, pr.code FROM nc_prices p JOIN nc_products pr ON pr.id = p.product_id', p => ({ at: p.created_at, actor: p.created_by, action: 'price.create', subject: p.id, detail: { product: p.code, version: p.version, kind: p.kind, amount: p.unit_amount, meter: p.meter_id } }))
  await add('SELECT * FROM nc_features', f => ({ at: f.created_at, actor: f.created_by, action: 'feature.grant', subject: f.product_id, detail: { feature: f.feature } }))
  await add('SELECT * FROM nc_customers', c => ({ at: c.created_at, actor: owner.email, action: 'customer.create', subject: c.id, detail: { externalId: c.external_id, name: c.name } }))
  await add('SELECT * FROM nc_contacts', c => ({ at: c.created_at, actor: c.created_by, action: 'contact.add', subject: c.customer_id, detail: { contact: c.id, email: c.email, role: c.role } }))
  await add('SELECT s.*, c.external_id AS customer FROM nc_subscriptions s JOIN nc_customers c ON c.id = s.customer_id', s => ({ at: s.created_at, actor: s.created_by, action: 'subscription.create', subject: s.id, detail: { customer: s.customer, start: s.start_date, anchor: s.anchor_day } }))
  await add('SELECT * FROM nc_amendments', a => ({ at: a.created_at, actor: a.created_by, action: 'amendment.propose', subject: a.id, detail: { subscription: a.subscription_id, kind: a.kind, value: a.value } }))
  await add("SELECT * FROM nc_amendments WHERE status = 'approved'", a => ({ at: a.decided_at, actor: a.decided_by, action: 'amendment.approve', subject: a.id, detail: { subscription: a.subscription_id, kind: a.kind, value: a.value } }))
  await add('SELECT * FROM nc_usage_batches', u => ({ at: u.created_at, actor: u.actor, action: 'usage.ingest', subject: u.id, detail: { source: u.source, filename: u.filename || null, accepted: u.accepted, duplicates: u.duplicates, rejected: u.rejected } }))
  await add('SELECT r.*, (SELECT COUNT(*) FROM nc_invoices i WHERE i.bill_run_id = r.id) AS drafts FROM nc_bill_runs r', r => ({ at: r.created_at, actor: r.created_by, action: 'billrun.prepare', subject: r.id, detail: { period: r.period, invoices: r.drafts, replaced: null } }))
  await add("SELECT * FROM nc_invoices WHERE approved_at IS NOT NULL", i => ({ at: i.approved_at, actor: i.approved_by, action: 'invoice.approve', subject: i.id, detail: { run: i.bill_run_id, fingerprint: i.source_fingerprint, acknowledged: [] } }))
  await add("SELECT * FROM nc_invoices WHERE issued_at IS NOT NULL", i => ({ at: i.issued_at, actor: i.issued_by, action: 'invoice.issue', subject: i.id, detail: { number: i.number, total: i.total_cents, fingerprint: i.approved_fingerprint } }))
  await add("SELECT r.*, (SELECT COUNT(*) FROM nc_invoices i WHERE i.bill_run_id = r.id AND i.status = 'issued') AS issued FROM nc_bill_runs r WHERE r.finalised_at IS NOT NULL", r => ({ at: r.finalised_at, actor: r.finalised_by, action: 'billrun.finalise', subject: r.id, detail: { issued: r.issued } }))
  await add('SELECT * FROM nc_payments', p => ({ at: p.recorded_at, actor: p.recorded_by, action: 'payment.record', subject: p.id, detail: { customer: p.customer_id, amount: p.amount_cents, received: p.received_on, method: p.method, reference: p.reference } }))
  await add('SELECT a.*, p.reference, i.number FROM nc_allocations a JOIN nc_payments p ON p.id = a.payment_id JOIN nc_invoices i ON i.id = a.invoice_id', a => ({ at: a.allocated_at, actor: a.allocated_by, action: 'payment.allocate', subject: a.id, detail: { payment: a.reference, invoice: a.number, amount: a.amount_cents } }))
  await add('SELECT c.*, i.number AS invoice FROM nc_credit_notes c JOIN nc_invoices i ON i.id = c.invoice_id', c => ({ at: c.issued_at, actor: c.issued_by, action: 'credit.issue', subject: c.id, detail: { number: c.number, invoice: c.invoice, amount: c.amount_cents, reason: c.reason } }))
  await add('SELECT * FROM nc_tasks', t => ({ at: t.created_at, actor: t.created_by, action: 'task.create', subject: t.id, detail: {} }))
  await add('SELECT * FROM nc_notices', n => ({ at: n.created_at, actor: n.created_by, action: 'reminder.prepare', subject: n.id, detail: { customer: n.customer_id, balance: n.balance_cents } }))
  await add('SELECT * FROM nc_proposals', p => ({ at: p.created_at, actor: p.created_by, action: 'proposal.create', subject: p.id, detail: { kind: p.kind, title: p.title } }))
  entries.sort((a, b) => a.at - b.at)
  await env.DB.batch(entries.map((entry, i) => insert(env, 'nc_audit', { seq: i + 1, at: entry.at, actor: entry.actor, action: entry.action, subject: entry.subject, detail: JSON.stringify(entry.detail) })))
}
