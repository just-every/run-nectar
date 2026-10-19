import type { Bindings } from '../auth.server'
import { requireCapability, type Actor } from './actor'
import { insist, one, parseJson, type Row } from './core'

export async function setupSourceDownload(env:Bindings,actor:Actor,id:string) {
  requireCapability(actor,'read')
  const row=await one(env,'SELECT payload_json FROM nc_proposals WHERE id=?',id)
  insist(row,'proposal_not_found',404)
  const payload=parseJson<Row>(row.payload_json,{})
  insist(payload.setup&&payload.source,'source_not_found',404)
  const source=payload.source,original=source.original
  const bytes=original?Uint8Array.from(atob(original.base64),c=>c.charCodeAt(0)):new TextEncoder().encode(source.text)
  const name=String(original?.filename??source.name).replace(/[\x00-\x1f"\\]/g,'_')
  return new Response(bytes,{headers:{'content-type':'application/octet-stream','content-disposition':`attachment; filename="${name}"`,'cache-control':'no-store','x-content-type-options':'nosniff'}})
}
