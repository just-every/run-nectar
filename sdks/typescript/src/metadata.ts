import type { CallOptions, NectarTransport, WriteOptions } from './transport.js'

export const METADATA_KINDS = ['customer', 'subscription', 'price', 'invoice', 'payment', 'credit-note'] as const
export type MetadataKind = typeof METADATA_KINDS[number]
export type Metadata = Record<string, string>
export interface MetadataTarget { kind: MetadataKind; record: string }
export interface MetadataIdentity { kind: MetadataKind; id: string; href: string; label: string }
export interface MetadataRevision { revision: number; metadata: Metadata; author: string; created_at: number }
export interface MetadataWrite extends MetadataTarget { revision: number; metadata: Metadata }
export interface MetadataWriteResult extends MetadataIdentity { revision: number; metadata: Metadata }
export interface MetadataView extends MetadataWriteResult { history: MetadataRevision[] }
export interface MetadataFilter { key: string; value: string }
export interface MetadataList {
  kind: MetadataKind
  filter?: MetadataFilter
  limit?: number
  cursor?: string
}
export interface MetadataObject extends MetadataIdentity {
  metadata: Metadata
  metadata_revision: number
  /** Original record fields depend on kind and the caller's authorized projection. */
  [key: string]: unknown
}
export interface MetadataPage {
  data: MetadataObject[]
  next_cursor?: string | null
  /** Original dated version uses this continuation name. */
  nextCursor?: string | null
}

export class MetadataResource {
  constructor(private readonly transport: NectarTransport) {}

  get(input: MetadataTarget, options: CallOptions = {}): Promise<MetadataView> {
    return this.transport.request({ ...options, method: 'GET',
      path: `metadata/${encodeURIComponent(input.kind)}/${encodeURIComponent(input.record)}` })
  }

  write(input: MetadataWrite, options: WriteOptions): Promise<MetadataWriteResult> {
    return this.transport.request({ ...options, method: 'POST', path: 'metadata.write', body: input })
  }

  list(input: MetadataList, options: CallOptions = {}): Promise<MetadataPage> {
    return this.transport.request({ ...options, method: 'GET', path: `objects/${encodeURIComponent(input.kind)}`,
      query: { limit: input.limit, cursor: input.cursor,
        metadata_key: input.filter?.key, metadata_value: input.filter?.value } })
  }
}
