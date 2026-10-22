// Approval narratives and original processor bytes have separate custody from
// the retained, typed financial lifecycle.
import type { Bindings } from '../auth.server'
import { actorLabel, can, type Actor } from './actor'
import { commit, guard, insist, NectarError, one, sha256Hex } from './core'

function authority(actor:Actor){
  return {sql:`EXISTS(SELECT 1 FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id
    JOIN nc_members m ON m.id=? AND m.email=lower(o.email)
    WHERE s.id=? AND s.revoked_at IS NULL AND s.expires_at>CAST(strftime('%s','now') AS INTEGER)*1000
    AND o.version=s.operator_version AND o.status='active' AND m.status='active'
    AND m.role IN ('owner','finance') AND (m.role<>'owner' OR o.role='owner'))`,params:[actor.id,actor.sessionId]}
}
export async function canReadPrepaidRefundPrivate(env:Bindings,actor:Actor){
  if(actor.kind!=='member'||!can(actor,'approve')||!['owner','finance'].includes(actor.role??'')||!actor.sessionId)return false
  const auth=authority(actor)
  return !!(await one(env,`SELECT (${auth.sql}) AS allowed`,...auth.params))?.allowed
}

export async function readPrepaidRefundProof(env:Bindings,actor:Actor,id:string):Promise<Response>{
  // Authorization precedes selector validation and resource lookup.
  insist(await canReadPrepaidRefundPrivate(env,actor),'forbidden',403)
  const auth=authority(actor)
  const row=await one(env,`SELECT r.id,r.revision,r.proof_json FROM nc_prepaid_refunds r
    JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=? AND c.erased_at IS NULL`,id)
  insist(row&&row.proof_json&&row.proof_json!=='{}'&&row.proof_json!=='null','prepaid_refund_proof_unavailable',404)
  const bytes=new TextEncoder().encode(row.proof_json),digest=await sha256Hex(bytes)
  try{
    await commit(env,[guard(env,'forbidden',auth.sql,...auth.params),
      guard(env,'prepaid_refund_proof_unavailable',`EXISTS(SELECT 1 FROM nc_prepaid_refunds r JOIN nc_customers c ON c.id=r.customer_id
        WHERE r.id=? AND r.revision=? AND r.proof_json=? AND c.erased_at IS NULL)`,row.id,row.revision,row.proof_json)],
      {actor:actorLabel(actor),action:'prepaid.refund.proof.download',subject:row.id,detail:{request:row.id,sha256:digest,size:bytes.length}})
  }catch(error){if(error instanceof NectarError&&error.code==='forbidden')throw new NectarError('forbidden',403);throw error}
  return new Response(bytes,{headers:{'content-type':'application/json','content-disposition':'attachment; filename="prepaid-refund-proof.json"',
    'content-length':String(bytes.length),'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"}})
}
