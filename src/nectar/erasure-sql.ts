// Compact native erasure without weakening the complete-image stale fence.
// All returned statements belong to the same custody/checkpoint transaction.
import { insist, type Row } from './core'
import type { D1Sql } from '../modules/import-kit/src/d1/index'

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`
const encoder = new TextEncoder()

/** Bound each JSON parameter, including rows with file or snapshot content.
 * One larger row remains indivisible and must still fit D1's value ceiling. */
export function* erasureChunks<T>(rows: Iterable<T>): Generator<T[]> {
  let chunk: T[] = [], bytes = 2
  for (const row of rows) {
    const size = encoder.encode(JSON.stringify(row)).length + 1
    insist(size + 2 <= 1_900_000, 'erasure_row_too_large', 409)
    if (chunk.length && bytes + size > 256 * 1024) { yield chunk; chunk = []; bytes = 2 }
    chunk.push(row); bytes += size
  }
  if (chunk.length) yield chunk
}

export interface ErasureMutation { table: string; row: Row; key: Row; updates: Row | null }

/** Group identical column shapes, preserving typed JSON scalar values. The
 * guard compares the same complete json_object image as the per-row planner;
 * missing rows or any changed column abort the entire transaction. */
export function erasureMutationStatements(mutations: ErasureMutation[]): D1Sql[] {
  const groups = new Map<string, ErasureMutation[]>()
  for (const mutation of mutations) {
    const shape = JSON.stringify([mutation.table, Object.keys(mutation.row), Object.keys(mutation.key), mutation.updates && Object.keys(mutation.updates)])
    const group = groups.get(shape)
    if (group) group.push(mutation)
    else groups.set(shape, [mutation])
  }
  const statements: D1Sql[] = []
  for (const group of groups.values()) {
    const { table, row, key, updates } = group[0], keys = Object.keys(key), fields = Object.keys(updates ?? {})
    insist(keys.length > 0, 'erasure_record_key_required', 409)
    const matches = keys.map((column, index) => `target.${quote(column)} IS json_extract(erasure.value,'$[0][${index}]')`).join(' AND ')
    const image = `json_object(${Object.keys(row).flatMap(column => [literal(column), `target.${quote(column)}`]).join(',')})`
    // Keep snapshots out of UPDATE parameters: a large graph carries each full
    // before-image once, rather than again for every changed field.
    const selected = group.map(mutation => [keys.map(column => mutation.key[column]), JSON.stringify(mutation.row)])
    for (const chunk of erasureChunks(selected)) statements.push({
      sql: `INSERT INTO nc_guard(code,ok) SELECT 'stale',CASE WHEN NOT EXISTS(SELECT 1 FROM json_each(?) AS erasure WHERE NOT EXISTS(SELECT 1 FROM ${quote(table)} AS target WHERE ${matches} AND ${image}=json_extract(erasure.value,'$[1]'))) THEN 1 ELSE 0 END`,
      params: [JSON.stringify(chunk)],
    })
    const replacements = group.map(mutation => [keys.map(column => mutation.key[column]), fields.map(column => mutation.updates![column])])
    for (const chunk of erasureChunks(replacements)) statements.push({
      sql: updates === null
        ? `DELETE FROM ${quote(table)} AS target WHERE EXISTS(SELECT 1 FROM json_each(?) AS erasure WHERE ${matches})`
        : `UPDATE ${quote(table)} AS target SET ${fields.map((column, index) => `${quote(column)}=json_extract(erasure.value,'$[1][${index}]')`).join(',')} FROM json_each(?) AS erasure WHERE ${matches}`,
      params: [JSON.stringify(chunk)],
    })
  }
  return statements
}

/** Financial exceptions and opaque tombstones use the same bounded JSON
 * transport, with one INSERT SELECT per chunk rather than per record. */
export function erasureInsertStatements(table: string, columns: string[], rows: Iterable<unknown[]>, ignore = false): D1Sql[] {
  return [...erasureChunks(rows)].map(chunk => ({
    sql: `INSERT ${ignore ? 'OR IGNORE ' : ''}INTO ${quote(table)}(${columns.map(quote).join(',')}) SELECT ${columns.map((_, index) => `json_extract(erasure.value,'$[${index}]')`).join(',')} FROM json_each(?) AS erasure`,
    params: [JSON.stringify(chunk)],
  }))
}
