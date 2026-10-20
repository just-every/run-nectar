// DEV-002: cursor pagination for every list door other than issued invoices
// (invoice-list.ts keeps its issuance-journal snapshot). A page continues after
// the last returned row (its id, or the audit sequence) in the list's own
// current order; rows placed before that anchor appear only in a fresh listing,
// and an anchor that has left the list makes the cursor stale.
import { insist, type Row } from './core'

interface Cursor { v: 1; path: string; limit: number; after: string }

const anchor = (row: Row) => String(row.id ?? row.seq)

function decode(text: string): Cursor {
  insist(text.length <= 1000, 'invalid_cursor')
  let value: unknown
  try { value = JSON.parse(atob(text)) } catch { insist(false, 'invalid_cursor') }
  const c = value as Cursor | null
  insist(c && c.v === 1 && typeof c.path === 'string' && typeof c.after === 'string' && Number.isSafeInteger(c.limit), 'invalid_cursor')
  return c
}

/** Pages a list view's rows (an array, or `{ data }`) when the request asks for `limit` or `cursor`; otherwise the whole list. */
export function paged(list: unknown, url: URL, path: string) {
  const raw = url.searchParams.get('limit'), encoded = url.searchParams.get('cursor')
  if (raw === null && encoded === null) return list
  const wrapped = !Array.isArray(list) && !!list && typeof list === 'object' && Array.isArray((list as Row).data)
  const rows = wrapped ? (list as Row).data as unknown[] : list
  insist(Array.isArray(rows), 'not_a_list')
  insist(rows.every(row => !!row && typeof row === 'object' && ((row as Row).id != null || (row as Row).seq != null)), 'not_a_list')
  const limit = Number(raw ?? '100')
  insist(/^\d+$/.test(raw ?? '100') && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'invalid_limit')
  const cursor = encoded === null ? null : decode(encoded)
  insist(!cursor || (cursor.path === path && cursor.limit === limit), 'cursor_query_mismatch')
  const start = cursor ? rows.findIndex(row => anchor(row as Row) === cursor.after) + 1 : 0
  insist(start > 0 || !cursor, 'cursor_stale', 409)
  const page = rows.slice(start, start + limit)
  const more = start + limit < rows.length
  const next_cursor = more ? btoa(JSON.stringify({ v: 1, path, limit, after: anchor(page[page.length - 1] as Row) } satisfies Cursor)) : null
  return { ...(wrapped ? list as Row : {}), data: page, next_cursor }
}
