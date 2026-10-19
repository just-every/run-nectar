import type { Bindings } from '../auth.server'
import { actorLabel, requireCapability, requireMember, requireOwner, type Actor } from './actor'
import { all, commit, guard, insist, newId, now, one, stmt, type Row } from './core'
import type { Input } from './input'

export interface CadenceRule { segment: string; minimum_cents: number; subject: string; body: string }
export interface CadencePolicy { enabled: boolean; require_human: boolean; rules: CadenceRule[]; revision: number }
const REVISION = 'COALESCE((SELECT revision FROM nc_cadence_policy WHERE singleton=1),0)'
const OTHER = "SELECT 1 FROM nc_members WHERE status='active' AND role IN ('owner','finance') AND id<>?"
export const activeFinanceGuard = (env: Bindings, actor: Actor) => guard(env, 'forbidden',
  "EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','finance'))", actor.id)
export const cadenceSourceSequence = async (env: Bindings): Promise<number> => (await one(env, 'SELECT COALESCE(MAX(seq),0) AS seq FROM nc_audit'))!.seq
export const cadenceSourceGuard = (env: Bindings, seq: number) => guard(env, 'cadence_source_changed', '(SELECT COALESCE(MAX(seq),0) FROM nc_audit)=?', seq)

export async function currentCadencePolicy(env: Bindings): Promise<CadencePolicy> {
  const row = await one(env, 'SELECT * FROM nc_cadence_policy WHERE singleton=1')
  return row ? { enabled: !!row.enabled, require_human: !!row.require_human, rules: JSON.parse(row.rules_json), revision: row.revision }
    : { enabled: false, require_human: true, rules: [], revision: 0 }
}

function template(value: unknown, max: number, subject=false): string {
  insist(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'invalid_cadence_template')
  insist(!subject || !/[\r\n]/.test(value), 'invalid_cadence_subject')
  insist(!/[{}]/.test(value.replace(/\{(invoice|balance|stage|business)\}/g, '')), 'unknown_cadence_placeholder')
  return value.trim().replace(/\r\n/g, '\n')
}

export async function prepareCadencePolicy(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  const raw = input.json('rules')
  insist(Array.isArray(raw) && raw.length <= 40, 'invalid_cadence_rules')
  const rules: CadenceRule[] = raw.map(row => {
    insist(row && typeof row === 'object' && !Array.isArray(row), 'invalid_cadence_rule')
    insist(Object.keys(row).every(key => ['segment','minimum_cents','subject','body'].includes(key)), 'invalid_cadence_rule')
    insist(typeof row.segment === 'string' && row.segment.trim().length > 0 && row.segment.length <= 80, 'invalid_segment')
    insist(Number.isSafeInteger(row.minimum_cents) && row.minimum_cents >= 0 && row.minimum_cents <= 9_000_000_000_000, 'invalid_minimum_cents')
    return { segment: row.segment.trim(), minimum_cents: row.minimum_cents, subject: template(row.subject,200,true), body: template(row.body,8000) }
  })
  const payload = { enabled: input.flag('enabled'), require_human: input.flag('require_human'), rules }
  insist(!payload.enabled || rules.length > 0, 'cadence_rules_required')
  const policy = await currentCadencePolicy(env), id = newId()
  await commit(env, [guard(env,'owner_required',"EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role='owner')",actor.id), guard(env, 'policy_changed', `${REVISION}=?`, policy.revision),
    stmt(env, 'INSERT INTO nc_cadence_policy_requests(id,payload_json,base_revision,prepared_by_id,prepared_by,prepared_at) VALUES (?,?,?,?,?,?)',
      id, JSON.stringify(payload), policy.revision, actor.id, actorLabel(actor), now())],
    { actor: actorLabel(actor), action: 'cadence.policy.prepare', subject: id, detail: { payload, revision: policy.revision } })
  return { request: id, status: 'pending', payload }
}

export async function decideCadencePolicy(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const row = await one(env, 'SELECT * FROM nc_cadence_policy_requests WHERE id=?', input.text('request',{max:100}))
  insist(row, 'policy_request_not_found',404)
  insist(row.status === 'pending','policy_already_decided',409)
  const decision = input.text('decision',{max:10})
  insist(['approved','rejected'].includes(decision),'invalid_decision')
  const statements = [activeFinanceGuard(env,actor),guard(env,'policy_already_decided',"EXISTS(SELECT 1 FROM nc_cadence_policy_requests WHERE id=? AND status='pending')",row.id)]
  if (decision === 'rejected') {
    statements.push(stmt(env,"UPDATE nc_cadence_policy_requests SET status='rejected',decided_by_id=?,decided_by=?,decided_at=? WHERE id=?",actor.id,actorLabel(actor),now(),row.id))
    await commit(env, statements,{actor:actorLabel(actor),action:'cadence.policy.reject',subject:row.id})
    return {request:row.id,status:'rejected'}
  }
  const single = row.prepared_by_id === actor.id
  if (single) {
    requireOwner(actor)
    insist(!await one(env,OTHER,actor.id),'second_approver_required',409)
    insist(input.flag('confirm_single'),'single_confirmation_required',409)
    statements.push(guard(env,'second_approver_required',`NOT EXISTS(${OTHER})`,actor.id))
  }
  const payload = JSON.parse(row.payload_json), mode = single ? 'single-approver' : 'two-person'
  statements.push(guard(env,'policy_changed',`${REVISION}=?`,row.base_revision),
    guard(env,'policy_preparer_inactive',"EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role='owner')",row.prepared_by_id),
    stmt(env,`INSERT INTO nc_cadence_policy(singleton,enabled,require_human,rules_json,revision,changed_by,changed_at) VALUES (1,?,?,?,1,?,?)
      ON CONFLICT(singleton) DO UPDATE SET enabled=excluded.enabled,require_human=excluded.require_human,rules_json=excluded.rules_json,revision=revision+1,changed_by=excluded.changed_by,changed_at=excluded.changed_at`,
      payload.enabled?1:0,payload.require_human?1:0,JSON.stringify(payload.rules),actorLabel(actor),now()),
    stmt(env,"UPDATE nc_cadence_policy_requests SET status='applied',decided_by_id=?,decided_by=?,decided_at=?,approval_mode=? WHERE id=?",actor.id,actorLabel(actor),now(),mode,row.id))
  await commit(env,statements,{actor:actorLabel(actor),action:'cadence.policy.apply',subject:row.id,detail:{payload,preparedBy:row.prepared_by,mode,revision:row.base_revision+1}})
  return {request:row.id,status:'applied',mode}
}

export async function cadencePolicyRequests(env: Bindings, actor: Actor): Promise<Row[]> {
  requireCapability(actor,'read')
  const rows=await all(env,'SELECT * FROM nc_cadence_policy_requests ORDER BY prepared_at DESC,id DESC')
  const other=await one(env,OTHER,actor.id), policy=await currentCadencePolicy(env)
  return rows.map(row=>({...row,payload:JSON.parse(row.payload_json),stale:row.status==='pending'&&row.base_revision!==policy.revision,
    singleAllowed:actor.kind==='member'&&actor.role==='owner'&&row.prepared_by_id===actor.id&&!other}))
}
