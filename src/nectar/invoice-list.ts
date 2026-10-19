// DEV-002: keyset pagination over the immutable issuance journal, not offsets.
// A draft issued between requests has a later journal sequence even if it was
// created earlier or backdated to the same invoice date.
import type { Bindings } from '../auth.server'
import { requireCapability, type Actor } from './actor'
import { withMetadata } from './metadata'
import { all, insist, one } from './core'

interface Cursor { v: 1; snapshot: number; after: number; customer: string; limit: number }

function decode(text: string): Cursor {
  insist(text.length <= 1000, 'invalid_cursor')
  let value: unknown
  try { value = JSON.parse(atob(text)) } catch { insist(false, 'invalid_cursor') }
  const c = value as Cursor | null
  insist(c && c.v === 1 && Number.isSafeInteger(c.snapshot) && c.snapshot >= 0 &&
    Number.isSafeInteger(c.after) && c.after >= 0 && c.after <= c.snapshot &&
    typeof c.customer === 'string' && c.customer.length <= 100 && Number.isSafeInteger(c.limit), 'invalid_cursor')
  return c
}

export async function invoiceList(env: Bindings, actor: Actor, url: URL) {
  requireCapability(actor, 'read')
  const raw = url.searchParams.get('limit') ?? '100'
  insist(/^\d+$/.test(raw), 'invalid_limit')
  const limit = Number(raw)
  insist(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'invalid_limit')
  const customer = url.searchParams.get('customer') ?? ''
  insist(customer.length <= 100, 'invalid_customer')
  const encoded = url.searchParams.get('cursor')
  const cursor = encoded === null ? null : decode(encoded)
  insist(!cursor || (cursor.customer === customer && cursor.limit === limit), 'cursor_query_mismatch')
  const snapshot = cursor?.snapshot ?? (await one<{ seq: number }>(env, "SELECT COALESCE(MAX(seq),0) AS seq FROM nc_audit WHERE action='invoice.issue'"))!.seq
  const after = cursor?.after ?? 0
  const rows = await all(env, `SELECT i.id,i.number,i.customer_id,i.subscription_id,i.invoice_kind,i.period_start,i.period_end,
    i.issue_date,i.due_date,i.status,i.currency,i.subtotal_cents,i.tax_cents,i.total_cents,a.seq AS issue_sequence
    FROM nc_audit a JOIN nc_invoices i ON i.id=a.subject
    WHERE a.action='invoice.issue' AND i.status='issued' AND a.seq>? AND a.seq<=?
      ${customer ? 'AND i.customer_id=?' : ''}
    ORDER BY a.seq LIMIT ?`, after,snapshot,...(customer ? [customer] : []),limit+1)
  const more = rows.length > limit
  const page = rows.slice(0,limit)
  const next: Cursor | null = more ? { v:1,snapshot,after:page[page.length-1].issue_sequence,customer,limit } : null
  return { data: await withMetadata(env,'invoice',page.map(({issue_sequence: _sequence,...invoice}) => invoice)), nextCursor:next ? btoa(JSON.stringify(next)) : null }
}
