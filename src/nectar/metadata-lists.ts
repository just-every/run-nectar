import type { Bindings } from '../auth.server'
import { requireCapability, type Actor } from './actor'
import { all } from './core'
import { metadataIdentity, metadataKind, metadataTable, requireMetadataRead, withMetadata } from './metadata-records'
import { metadataFilter, metadataPredicate } from './metadata-query'

export async function metadataObjects(env: Bindings, actor: Actor, kind: string, url: URL) {
  requireMetadataRead(actor,kind)
  const filter=metadataPredicate(kind,'r.id',metadataFilter(url))
  const rows=await all(env,`SELECT r.* FROM ${metadataTable(kind)} r WHERE ${filter.sql} ORDER BY r.id`,...filter.params)
  const projected=await withMetadata(env,kind,rows)
  return {data:projected.map(row=>({...row,...metadataIdentity(metadataKind(kind),row)}))}
}

export async function metadataCsv(env: Bindings,actor: Actor,kind: string,url: URL) {
  requireCapability(actor,'export')
  const {data}=await metadataObjects(env,actor,kind,url)
  const cell=(v:unknown)=>`"${String(v).replaceAll('"','""')}"`
  const rows=[['kind','record_id','label','metadata_revision','metadata_json'],...data.map(r=>[kind,r.id,r.label,r.metadata_revision,JSON.stringify(r.metadata)])]
  return new Response(rows.map(r=>r.map(cell).join(',')).join('\r\n')+'\r\n',{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="nectar-${kind}-metadata.csv"`,'cache-control':'private, no-store','x-content-type-options':'nosniff'}})
}
