// Resolve metadata through the same read capability and stored record ownership.
import type { Bindings } from '../auth.server'
import { requireCapability, type Actor } from './actor'
import { all, guard, insist, one, type Row } from './core'

export const METADATA_KINDS = ['customer', 'subscription', 'price', 'invoice', 'payment', 'credit-note'] as const
export type MetadataKind = typeof METADATA_KINDS[number]
export type Metadata = Record<string, string>
export interface MetadataProjection { metadata: Metadata; metadata_revision: number }

const RECORDS = {
  customer: { table: 'nc_customers', select: 'id,name AS label' },
  subscription: { table: 'nc_subscriptions', select: 'id,COALESCE(external_id,id) AS label' },
  price: { table: 'nc_prices', select: "id,COALESCE(NULLIF(nickname,''),id) AS label,version" },
  invoice: { table: 'nc_invoices', select: "id,COALESCE(number,'Draft invoice') AS label" },
  payment: { table: 'nc_payments', select: 'id,customer_id,reference AS label' },
  'credit-note': { table: 'nc_credit_notes', select: 'id,invoice_id,number AS label' },
} satisfies Record<MetadataKind, { table: string; select: string }>

export function metadataKind(value: string): MetadataKind {
  insist(METADATA_KINDS.some(kind => kind === value), 'invalid_metadata_kind')
  return value as MetadataKind
}

export async function metadataRecord(env: Bindings, actor: Actor, value: string, id: string) {
  requireCapability(actor, 'read')
  const kind = metadataKind(value), source = RECORDS[kind]
  const record = await one(env, `SELECT ${source.select} FROM ${source.table} WHERE id=?`, id)
  insist(record, 'metadata_record_not_found', 404)
  return metadataIdentity(kind,record)
}

/** Recheck existence in the write batch; table names come only from the whitelist. */
export function metadataRecordGuard(env: Bindings, kind: MetadataKind, id: string) {
  return guard(env, 'stale', `EXISTS(SELECT 1 FROM ${RECORDS[kind].table} WHERE id=?)`, id)
}

/** Internal projection: callers must first authorize access to the underlying records. */
export async function metadataFor(env: Bindings, value: string, id: string): Promise<MetadataProjection> {
  const kind = metadataKind(value)
  const row = await one<{ metadata_json: string; revision: number }>(env,
    'SELECT metadata_json,revision FROM nc_metadata_revisions WHERE kind=? AND record_id=? ORDER BY revision DESC LIMIT 1', kind, id)
  return row ? { metadata: JSON.parse(row.metadata_json) as Metadata, metadata_revision: row.revision }
    : { metadata: {}, metadata_revision: 0 }
}

/** Batch projection keeps list and export callers within D1's bound-parameter limit. */
export async function withMetadata<T extends Row>(env: Bindings, value: string, rows: T[], idField = 'id'): Promise<(T & MetadataProjection)[]> {
  const kind = metadataKind(value)
  const ids = [...new Set(rows.map(row => row[idField] as string))]
  const current = new Map<string, MetadataProjection>()
  for (let start = 0; start < ids.length; start += 90) {
    const batch = ids.slice(start, start + 90)
    const revisions = await all<{ record_id: string; metadata_json: string; revision: number }>(env,
      `SELECT m.record_id,m.metadata_json,m.revision FROM nc_metadata_revisions m
       WHERE m.kind=? AND m.record_id IN (${batch.map(() => '?').join(',')})
       AND m.revision=(SELECT MAX(latest.revision) FROM nc_metadata_revisions latest WHERE latest.kind=m.kind AND latest.record_id=m.record_id)`, kind, ...batch)
    for (const row of revisions) current.set(row.record_id, { metadata: JSON.parse(row.metadata_json) as Metadata, metadata_revision: row.revision })
  }
  return rows.map(row => ({ ...row, ...(current.get(row[idField]) ?? { metadata: {}, metadata_revision: 0 }) }))
}

/** Internal table identity for authorized collection adapters. */
export const metadataTable = (kind: string) => RECORDS[metadataKind(kind)].table


/** Build a record link from an already authorized collection row. */
export function metadataIdentity(kind: MetadataKind,record: Row) {
  const id=record.id
  const encoded = encodeURIComponent(id)
  const href = kind === 'customer' ? `/app/customers/${encoded}`
    : kind === 'subscription' ? `/app/subscriptions/${encoded}`
    : kind === 'price' ? `/app/catalog#price-${encoded}`
    : kind === 'invoice' ? `/app/invoices/${encoded}`
    : kind === 'payment' ? `/app/customers/${encodeURIComponent(record.customer_id)}#payment-${encoded}`
    : `/app/invoices/${encodeURIComponent(record.invoice_id)}#credit-${encoded}`
  return { kind, id, href, label: `${kind} ${record.label ?? (kind==='customer'?record.name:kind==='subscription'?record.external_id||id:kind==='price'?record.nickname||id:kind==='payment'?record.reference:record.number||'Draft invoice')}${kind === 'price' ? ` v${record.version}` : ''}` }
}
