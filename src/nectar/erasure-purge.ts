import type { Bindings } from '../auth.server'
import { actorLabel, requireOwner, type Actor } from './actor'
import { all, commit, guard, insist, one, parseJson, stmt, type Row } from './core'
import { clockInstant } from './clock'
import { business } from './business'
import { localDate } from './dates'
import { privacyCheckpoint } from './erasure-checkpoint'
const q = (s:string) => `"${s.replaceAll('"','""')}"`
/** Statutory removal is explicit and owner-authorized. An entire customer's
 * financial group expires together, from its latest issue/payment date. */
export async function purgeErasure(env: Bindings, actor: Actor) {
  requireOwner(actor)
  const b=await business(env),day=localDate(clockInstant(env),b?.timezone??'UTC'),removed=[]
  for(const request of await all(env,"SELECT * FROM nc_erasure_requests WHERE status='complete' AND purged_at IS NULL AND retain_until IS NOT NULL AND retain_until<=?",day)) {
    const tables=await all(env,"SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'nc_*' AND name NOT IN ('nc_remittance_source_keys','nc_erasure_requests','nc_erased_records','nc_erasure_financial','nc_privacy_context','nc_guard','nc_audit')")
    const ids=new Set((await all(env,'SELECT record_id FROM nc_erasure_financial WHERE request_id=?',request.id)).map(r=>r.record_id))
    for(const authorization of await all(env,'SELECT id FROM nc_prepaid_topup_authorizations WHERE customer_id=?',request.customer_id))ids.add(authorization.id)
    const selected=new Map<string,{row:Row;keys:string[]}[]>(),foreign=new Map<string,string[]>()
    const contents=[]
    for(const {name} of tables){const columns=await all(env,`PRAGMA table_info(${q(name)})`);const keys=columns.filter(c=>c.pk).map(c=>c.name);foreign.set(name,(await all(env,`PRAGMA foreign_key_list(${q(name)})`)).map(f=>f.table));for(const row of await all(env,`SELECT * FROM ${q(name)}`))contents.push({name,row,keys})}
    const picked=new Set<Row>()
    for(let changed=true;changed;){changed=false;for(const entry of contents){if(picked.has(entry.row))continue;if((entry.name.startsWith('nc_processor_')&&entry.row.customer_id===request.customer_id)||ids.has(entry.row.id)||Object.entries(entry.row).some(([k,v])=>['receipt_id','invoice_id','payment_id','credit_id','record_id','note_id','correction_id','original_invoice_id','purchase_invoice_id','purchase_line_id','funding_id','grant_id','request_id','allocation_id','authorization_id','refund_id','ledger_id'].includes(k)&&ids.has(v))){picked.add(entry.row);if(entry.row.id)ids.add(entry.row.id);selected.set(entry.name,[...(selected.get(entry.name)??[]),entry]);changed=true}}}
    const order:string[]=[],remaining=new Set(selected.keys())
    while(remaining.size){const leaves=[...remaining].filter(parent=>![...remaining].some(child=>child!==parent&&foreign.get(child)?.includes(parent)));insist(leaves.length,'financial_retention_dependency_cycle',409);leaves.forEach(t=>{order.push(t);remaining.delete(t)})}
    const receipt=parseJson<Row>(request.receipt_json,{})
    receipt.removal={at:clockInstant(env),records:order.map(kind=>({kind,records:selected.get(kind)!.length})),retainedLegalIdentityRemoved:true}
    const statements=[guard(env,'stale',"EXISTS(SELECT 1 FROM nc_erasure_requests WHERE id=? AND status='complete' AND purged_at IS NULL AND retain_until<=?)",request.id,day),guard(env,'authority',"EXISTS(SELECT 1 FROM nc_members m JOIN oa_operators o ON o.email=m.email WHERE m.id=? AND m.role='owner' AND m.status='active' AND o.role='owner' AND o.status='active')",actor.id),stmt(env,'UPDATE nc_erasure_requests SET status=\'verified\' WHERE id=?',request.id),stmt(env,'INSERT INTO nc_privacy_context(request_id) VALUES(?)',request.id),stmt(env,'DELETE FROM nc_erasure_financial WHERE request_id=?',request.id)]
    for(const table of order)for(const {row,keys} of selected.get(table)!)statements.push(stmt(env,`DELETE FROM ${q(table)} WHERE ${keys.map(k=>`${q(k)} IS ?`).join(' AND ')}`,...keys.map(k=>row[k])))
    statements.push(stmt(env,'UPDATE nc_erasure_requests SET status=\'complete\',purged_at=?,receipt_json=? WHERE id=?',clockInstant(env),JSON.stringify(receipt),request.id),stmt(env,'DELETE FROM nc_privacy_context WHERE request_id=?',request.id),...(await privacyCheckpoint(env)).map(s=>stmt(env,s.sql,...(s.params??[]))))
    await commit(env,statements,{actor:actorLabel(actor),action:'erasure.financial.remove',subject:request.id,detail:receipt.removal});removed.push(request.id)
  }
  return {removed}
}

/** The owner's approved retention decision authorizes the daily statutory sweep.
 * An active owner is rechecked in each removal transaction. */
export async function removeExpiredFinancialRecords(env:Bindings) {
  const owner=await one(env,"SELECT m.* FROM nc_members m JOIN oa_operators o ON o.email=m.email WHERE m.role='owner' AND m.status='active' AND o.role='owner' AND o.status='active' ORDER BY m.id LIMIT 1")
  if(!owner)return {removed:[]}
  return purgeErasure(env,{id:owner.id,kind:'member',role:'owner',name:owner.name,email:owner.email,sessionId:null,capabilities:new Set(['read','settings'])})
}
