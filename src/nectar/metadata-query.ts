// Apply this predicate in the underlying list query, before ORDER BY/LIMIT.
import { insist } from './core'
import { metadataKind } from './metadata-records'

export interface MetadataFilter { key: string; value: string }

export function metadataFilter(url: URL): MetadataFilter | null {
  const key = url.searchParams.get('metadata_key'), value = url.searchParams.get('metadata_value')
  insist((key === null) === (value === null), 'metadata_filter_requires_key_and_value')
  return key === null || value === null ? null : { key, value }
}

/** idSql is a trusted column reference from the caller, never request input. */
export function metadataPredicate(kind: string, idSql: string, filter: MetadataFilter | null): { sql: string; params: string[] } {
  metadataKind(kind)
  insist(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(idSql), 'invalid_metadata_id_column')
  if (!filter) return { sql: '1=1', params: [] }
  return {
    sql: `EXISTS(SELECT 1 FROM nc_metadata_revisions metadata_current
      WHERE metadata_current.kind=? AND metadata_current.record_id=${idSql}
      AND metadata_current.revision=(SELECT MAX(metadata_latest.revision) FROM nc_metadata_revisions metadata_latest
        WHERE metadata_latest.kind=metadata_current.kind AND metadata_latest.record_id=metadata_current.record_id)
      AND EXISTS(SELECT 1 FROM json_each(metadata_current.metadata_json) metadata_pair
        WHERE metadata_pair.key=? COLLATE BINARY AND metadata_pair.type='text' AND metadata_pair.value=? COLLATE BINARY))`,
    params: [kind, filter.key, filter.value],
  }
}
