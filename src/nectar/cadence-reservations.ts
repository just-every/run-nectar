import type { Bindings } from '../auth.server'
import { all, commit, guard, newId, now, one, stmt } from './core'
import { cadenceBasis, CADENCE_STAGES } from './cadence-basis'
import { cadenceSourceGuard, cadenceSourceSequence } from './cadence-policy'
import { clockInstant } from './clock'

/** A reservation can be refreshed only before any provider attempt. Refresh
 * invalidates human approval. The invoice/stage uniqueness survives restarts. */
export async function reserveCadenceStage(env: Bindings, invoiceId: string, stage: number, instant=clockInstant(env)) {
  const seq=await cadenceSourceSequence(env),basis=await cadenceBasis(env,invoiceId,stage,instant)
  if(basis.reason==='paid') {
    const pending=await all(env,"SELECT id FROM nc_cadence_deliveries WHERE invoice_id=? AND status IN ('pending','awaiting_approval') AND claimed_at IS NULL",invoiceId)
    if(pending.length)await commit(env,[cadenceSourceGuard(env,seq),
      stmt(env,"UPDATE nc_cadence_deliveries SET status='superseded',finished_at=? WHERE invoice_id=? AND status IN ('pending','awaiting_approval') AND claimed_at IS NULL",now(),invoiceId)],
      {actor:'system:cadences',action:'cadence.stop.paid',subject:invoiceId,detail:{deliveries:pending.map(row=>row.id)}})
  }
  if(basis.reason)return {held:basis.reason}
  const existing=await one(env,'SELECT * FROM nc_cadence_deliveries WHERE invoice_id=? AND stage=?',invoiceId,stage)
  if(existing&&!['awaiting_approval','pending'].includes(existing.status))return {delivery:existing.id,status:existing.status}
  if(existing&&existing.basis_key===basis.basisKey)return {delivery:existing.id,status:existing.status}
  const id=existing?.id??newId(),human=basis.policy.require_human,status=human?'awaiting_approval':'pending'
  const statements=[cadenceSourceGuard(env,seq)]
  if(existing) {
    statements.push(guard(env,'cadence_already_claimed',"EXISTS(SELECT 1 FROM nc_cadence_deliveries WHERE id=? AND status IN ('awaiting_approval','pending') AND claimed_at IS NULL)",id),
      stmt(env,`UPDATE nc_cadence_deliveries SET status=?,basis_json=?,basis_key=?,policy_revision=?,recipient=?,subject=?,body=?,collectible_cents=?,approved_by=?,approved_at=?,approval_mode=? WHERE id=?`,
        status,JSON.stringify(basis.source),basis.basisKey,basis.policy.revision,basis.recipient,basis.subject,basis.body,basis.invoice.collectibleCents,
        human?null:'system:cadence-policy',human?null:now(),human?null:'policy',id))
  }else {
    statements.push(guard(env,'cadence_already_reserved','NOT EXISTS(SELECT 1 FROM nc_cadence_deliveries WHERE invoice_id=? AND stage=?)',invoiceId,stage),
      stmt(env,`INSERT INTO nc_cadence_deliveries(id,invoice_id,stage,status,basis_json,basis_key,policy_revision,recipient,subject,body,collectible_cents,approved_by,approved_at,approval_mode,reserved_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,invoiceId,stage,status,JSON.stringify(basis.source),basis.basisKey,basis.policy.revision,basis.recipient,basis.subject,basis.body,basis.invoice.collectibleCents,
        human?null:'system:cadence-policy',human?null:now(),human?null:'policy',now()))
  }
  const prior=await all(env,'SELECT stage FROM nc_cadence_deliveries WHERE invoice_id=?',invoiceId)
  const skipped=CADENCE_STAGES.filter(offset=>offset<stage)
  statements.push(stmt(env,"UPDATE nc_cadence_deliveries SET status='superseded',finished_at=? WHERE invoice_id=? AND stage<? AND status IN ('pending','awaiting_approval') AND claimed_at IS NULL",now(),invoiceId,stage))
  for(const offset of skipped.filter(offset=>!prior.some(row=>row.stage===offset))) {
    statements.push(stmt(env,`INSERT INTO nc_cadence_deliveries(id,invoice_id,stage,status,basis_json,basis_key,policy_revision,recipient,subject,body,collectible_cents,reserved_at,finished_at)
      VALUES (?,?,?,'superseded',?,?,?,'','','',?,?,?)`,newId(),invoiceId,offset,JSON.stringify({supersededBy:stage}),`superseded:${stage}`,basis.policy.revision,basis.invoice.collectibleCents,now(),now()))
  }
  // The owner is explicitly assigned in durable custody and in the task title.
  let escalation: {task:string;owner:string;email:string}|null=null
  if(stage===15&&!await one(env,'SELECT 1 FROM nc_cadence_escalations WHERE invoice_id=?',invoiceId)) {
    const owner=await one(env,"SELECT id,name,email FROM nc_members WHERE status='active' AND role='owner' ORDER BY created_at,id LIMIT 1")
    if(!owner)return {held:'owner_unavailable'}
    const task=newId()
    statements.push(guard(env,'cadence_owner_changed',"EXISTS(SELECT 1 FROM nc_members WHERE id=? AND role='owner' AND status='active')",owner.id),
      stmt(env,"INSERT INTO nc_tasks(id,customer_id,invoice_id,title,due_date,status,created_by,created_at) VALUES (?,?,?,?,?,'open','system:cadences',?)",
        task,basis.invoice.customer_id,invoiceId,`Owner ${owner.name} (${owner.email}): resolve overdue invoice ${basis.invoice.number}`,basis.invoice.day,now()),
      stmt(env,'INSERT INTO nc_cadence_escalations(invoice_id,task_id,assigned_member_id,created_at) VALUES (?,?,?,?)',invoiceId,task,owner.id,now()))
    escalation={task,owner:owner.id,email:owner.email}
  }
  await commit(env,statements,[{actor:'system:cadences',action:existing?'cadence.stage.refresh':'cadence.stage.reserve',subject:id,
    detail:{invoice:invoiceId,stage,policyRevision:basis.policy.revision,approval:human?'human-required':'policy',basis:basis.basisKey,recipient:basis.recipient,subject:basis.subject,body:basis.body}},
    ...(skipped.length?[{actor:'system:cadences',action:'cadence.stage.supersede',subject:invoiceId,detail:{stages:skipped,supersededBy:stage}}]:[]),
    ...(escalation?[{actor:'system:cadences',action:'cadence.escalate',subject:invoiceId,detail:escalation}]:[])])
  return {delivery:id,status}
}
