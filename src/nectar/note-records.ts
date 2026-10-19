// Resolve ownership from the recorded object; callers cannot supply a customer.
import type { Bindings } from '../auth.server'
import { all, insist, one, type Row } from './core'

export async function noteRecord(env: Bindings, kind: string, id: string) {
  insist(['customer', 'invoice', 'payment'].includes(kind), 'invalid_note_kind')
  const row = kind === 'customer'
    ? await one(env, 'SELECT id AS customer_id, name AS label FROM nc_customers WHERE id=?', id)
    : kind === 'invoice'
      ? await one(env, "SELECT customer_id, COALESCE(number,'Draft invoice') AS label FROM nc_invoices WHERE id=? AND status<>'discarded'", id)
      : await one(env, 'SELECT customer_id, reference AS label FROM nc_payments WHERE id=?', id)
  insist(row, 'note_record_not_found', 404)
  return { customerId: row.customer_id as string, label: `${kind} ${row.label}`,
    href: kind === 'invoice' ? `/app/invoices/${encodeURIComponent(id)}#notes` : `/app/customers/${encodeURIComponent(row.customer_id)}#notes` }
}

/** Customer projection used by the API, screens and customer CSV. */
export async function customerNotes(env: Bindings, customer: string): Promise<(Row & { mentions: Row[] })[]> {
  const rows = await all(env, 'SELECT * FROM nc_notes WHERE customer_id=? ORDER BY created_at,id', customer)
  const mentions = await all(env, `SELECT m.* FROM nc_note_mentions m JOIN nc_notes n ON n.id=m.note_id WHERE n.customer_id=? ORDER BY m.member_id`, customer)
  return rows.map(row => ({ ...row, mentions: mentions.filter(m => m.note_id === row.id) }))
}
