// An owner-reviewed plan is retained evidence only. It executes no rollback or cutover.
import type { Bindings } from '../../auth.server'
import { actorLabel, requireOwner, type Actor } from '../actor'
import { all, commit, fingerprint, guard, insist, newId, now, one, parseJson, stmt, type Row } from '../core'
import { isDate } from '../dates'
import type { Input } from '../input'
import { collectionAuthority, collectionOwner } from './collection-state'
import { moveInvestigationEvidence } from './investigations'
import { historyReference } from './history-reports'

async function snapshot(env: Bindings, subscription: string, cutover: string) {
  const sub = await one(env, `SELECT s.*,c.provider_ref AS customer_ref,c.revision AS customer_revision,c.erased_at
    FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id WHERE s.id=?`,subscription)
  insist(sub && sub.origin==='import' && sub.billing_mode==='shadow' && !sub.erased_at && historyReference(sub.provider_ref) && historyReference(sub.customer_ref), 'shadow_subscription_required',409)
  insist(isDate(cutover) && Number(cutover.slice(8))===sub.anchor_day, 'cutover_must_start_a_period')
  const sources=await all(env,`SELECT i.id,i.provider_ref,i.source_json,i.lines_json,i.revision FROM nc_incumbent_invoices i WHERE i.subscription_id=? ORDER BY i.id`,sub.id)
  const comparisons=(await moveInvestigationEvidence(env)).filter(proof=>proof.subscription===sub.id || ['customer','payment-method'].includes(proof.category)&&proof.customer===sub.customer_id)
  const cases=await all(env,`SELECT a.id,a.owner_id,a.status,a.basis_hash,a.approved_basis,m.status AS owner_status,m.role AS owner_role FROM nc_assurance_cases a LEFT JOIN nc_members m ON m.id=a.owner_id WHERE a.customer_id=? AND a.kind='move_comparison' ORDER BY a.id`,sub.customer_id)
  const bindings=await all(env,'SELECT id,account_ref,stripe_customer_ref,revision FROM nc_stripe_customer_bindings WHERE customer_id=? ORDER BY id',sub.customer_id)
  const basis={subscription:sub.id,customer:sub.customer_id,subscriptionRevision:sub.revision,customerRevision:sub.customer_revision,cutover,
    references:{source:'stripe',customer:sub.customer_ref,subscription:sub.provider_ref,invoices:sources.map(row=>row.provider_ref).filter(historyReference),bindings},
    caseOwnersAvailable:cases.every(row=>row.owner_status==='active'&&['owner','finance'].includes(row.owner_role)),
    sourceBasis:await fingerprint(sources),comparisons:comparisons.map(proof=>({source:proof.source,basis:proof.basis,mismatch:proof.mismatch})),cases}
  return {...basis,hash:await fingerprint(basis)}
}
const unchanged=(env:Bindings,seq:number)=>guard(env,'move_review_source_changed','(SELECT COALESCE(MAX(seq),0) FROM nc_audit)=?',seq)
async function sequence(env:Bindings){return (await one(env,'SELECT COALESCE(MAX(seq),0) AS seq FROM nc_audit'))!.seq}
const view=(row:Row,current:Row):Row=>({...row,snapshot:parseJson(row.snapshot_json,{}),snapshot_json:undefined,
  stale:row.basis_hash!==current.hash,executionAuthority:false})

export async function moveRollbackPlans(env:Bindings,actor:Actor,subscription:string) {
  requireOwner(actor)
  const rows=await all(env,`SELECT r.* FROM nc_move_rollback_plans r JOIN nc_customers c ON c.id=r.customer_id WHERE r.subscription_id=? AND c.erased_at IS NULL ORDER BY r.created_at,r.id`,subscription)
  return Promise.all(rows.map(async row=>view(row,await snapshot(env,subscription,row.cutover_start).catch(()=>({hash:null})))))
}
export async function prepareMoveRollback(env:Bindings,actor:Actor,input:Input) {
  await collectionOwner(env,actor)
  input.only(['subscription','cutover_start','processor_ref','instructions','returnTo'])
  const seq=await sequence(env),source=await snapshot(env,input.text('subscription',{max:100}),input.text('cutover_start',{max:10}))
  insist(source.caseOwnersAvailable,'assurance_owner_unavailable',409)
  const processor=input.text('processor_ref',{max:200}),instructions=input.text('instructions',{max:2000})
  insist(historyReference(processor),'invalid_processor_reference')
  const planHash=await fingerprint([processor,instructions])
  const existing=await one(env,'SELECT * FROM nc_move_rollback_plans WHERE subscription_id=? AND prepared_by=? AND basis_hash=? AND plan_hash=?',source.subscription,actor.id,source.hash,planHash)
  if(existing)return view(existing,source)
  const id=newId(),at=now()
  await commit(env,[collectionAuthority(env,actor),unchanged(env,seq),
    stmt(env,`INSERT INTO nc_move_rollback_plans(id,customer_id,subscription_id,cutover_start,processor_ref,instructions,plan_hash,basis_hash,snapshot_json,prepared_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,id,source.customer,source.subscription,source.cutover,processor,instructions,planHash,source.hash,JSON.stringify(source),actor.id,at)],
    {actor:actorLabel(actor),action:'move.rollback.prepare',subject:id,detail:{subscription:source.subscription,basis:source.hash,executionAuthority:false}})
  return (await moveRollbackPlans(env,actor,source.subscription)).find(row=>row.id===id)!
}
export async function confirmMoveRollback(env:Bindings,actor:Actor,input:Input) {
  await collectionOwner(env,actor)
  input.only(['request','basis','confirm','acknowledge_discrepancies','returnTo'])
  const seq=await sequence(env),row=await one(env,'SELECT * FROM nc_move_rollback_plans WHERE id=?',input.text('request',{max:100}))
  insist(row,'move_review_not_found',404)
  const current=await snapshot(env,row.subscription_id,row.cutover_start)
  insist(current.caseOwnersAvailable,'assurance_owner_unavailable',409)
  insist(row.basis_hash===current.hash && input.text('basis',{max:100})===current.hash,'move_review_source_changed',409)
  insist(input.flag('confirm'),'move_review_confirmation_required')
  insist(!current.comparisons.some((proof:Row)=>proof.mismatch) || input.flag('acknowledge_discrepancies'),'move_review_discrepancies_required',409)
  if(row.confirmed_at)return view(row,current)
  const at=now()
  await commit(env,[collectionAuthority(env,actor),unchanged(env,seq),
    guard(env,'move_review_changed','EXISTS(SELECT 1 FROM nc_move_rollback_plans WHERE id=? AND confirmed_at IS NULL)',row.id),
    stmt(env,'UPDATE nc_move_rollback_plans SET confirmed_by=?,confirmed_at=?,acknowledged_discrepancies=? WHERE id=?',actor.id,at,input.flag('acknowledge_discrepancies')?1:0,row.id)],
    {actor:actorLabel(actor),action:'move.rollback.confirm',subject:row.id,detail:{basis:current.hash,executionAuthority:false}})
  return view({...row,confirmed_by:actor.id,confirmed_at:at,acknowledged_discrepancies:input.flag('acknowledge_discrepancies')?1:0},current)
}
